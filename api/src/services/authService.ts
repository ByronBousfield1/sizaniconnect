import { randomUUID } from 'node:crypto';
import { AppError, badRequest, unauthorized } from '../domain/errors.js';
import type { Actor } from '../domain/roles.js';
import { toPublicUser, type UserRecord } from '../repositories/userRepository.js';
import { passwordPolicyProblem } from '../security/passwords.js';
import { newOpaqueToken, sha256 } from '../security/tokens.js';
import { audit, type ServiceDeps } from './context.js';

const INVALID_CREDENTIALS = 'Email or password is incorrect.';

export class AuthService {
  private dummyHash: Promise<string>;

  constructor(private readonly deps: ServiceDeps) {
    // Unknown emails are checked against a real hash so response time does not reveal which
    // addresses have accounts.
    this.dummyHash = deps.hasher.hash(randomUUID());
  }

  async login(email: string, password: string, ip?: string) {
    const { uow, hasher, config } = this.deps;
    const user = await uow.read((r) => r.users.findByEmail(email));

    if (!user || !user.isActive) {
      await hasher.verify(password, await this.dummyHash);
      await uow.run((r) =>
        audit(r, null, 'User', user?.id ?? null, 'LOGIN_FAILED', { reason: user ? 'inactive' : 'unknown-email' }),
      );
      throw unauthorized(INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > this.deps.clock()) {
      throw new AppError(
        423,
        'ACCOUNT_LOCKED',
        `Too many failed sign-in attempts. Try again after ${config.lockoutMinutes} minutes, or reset your password.`,
      );
    }

    if (!(await hasher.verify(password, user.passwordHash))) {
      const { locked } = await uow.run(async (r) => {
        const result = await r.users.recordFailedLogin(user.id, config.lockoutThreshold, config.lockoutMinutes);
        await audit(r, null, 'User', user.id, result.locked ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', { ip });
        return result;
      });
      if (locked) {
        throw new AppError(
          423,
          'ACCOUNT_LOCKED',
          `Too many failed sign-in attempts. Try again after ${config.lockoutMinutes} minutes, or reset your password.`,
        );
      }
      throw unauthorized(INVALID_CREDENTIALS);
    }

    return uow.run(async (r) => {
      await r.users.clearFailedLogins(user.id);
      if (hasher.needsRehash(user.passwordHash)) {
        await r.users.setPasswordHash(user.id, await hasher.hash(password));
      }
      await audit(r, { ...this.actorFor(user), ip }, 'User', user.id, 'LOGIN_SUCCESS');
      const refresh = newOpaqueToken();
      await r.tokens.insertRefreshToken({
        userId: user.id,
        familyId: randomUUID(),
        hash: refresh.hash,
        expiresAt: this.refreshExpiry(),
      });
      return {
        accessToken: this.deps.tokens.issueAccessToken(this.actorFor(user)),
        refreshToken: refresh.token,
        user: toPublicUser(user),
      };
    });
  }

  /**
   * Refresh tokens rotate on every use. Presenting a token that was already rotated means it was
   * copied: the whole family is revoked, which signs out both the thief and the real user.
   */
  async refresh(refreshToken: string | undefined) {
    if (!refreshToken) throw unauthorized();
    const outcome = await this.deps.uow.run(async (r) => {
      const row = await r.tokens.findRefreshToken(sha256(refreshToken));
      if (!row) return { ok: false as const, message: undefined };
      if (row.revokedAt) {
        // Committed before the error is raised: the revocation must survive the failed request.
        await r.tokens.revokeFamily(row.familyId);
        await audit(r, null, 'User', row.userId, 'TOKEN_REUSE_DETECTED');
        return { ok: false as const, message: 'Your session was ended for security reasons. Sign in again.' };
      }
      if (row.expiresAt <= this.deps.clock()) {
        return { ok: false as const, message: 'Your session has expired. Sign in again.' };
      }

      const user = await r.users.findById(row.userId);
      if (!user || !user.isActive) return { ok: false as const, message: undefined };

      await r.tokens.revokeRefreshToken(row.id);
      const next = newOpaqueToken();
      await r.tokens.insertRefreshToken({ userId: user.id, familyId: row.familyId, hash: next.hash, expiresAt: this.refreshExpiry() });
      return {
        ok: true as const,
        accessToken: this.deps.tokens.issueAccessToken(this.actorFor(user)),
        refreshToken: next.token,
        user: toPublicUser(user),
      };
    });
    if (!outcome.ok) throw unauthorized(outcome.message);
    return outcome;
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.deps.uow.run(async (r) => {
      const row = await r.tokens.findRefreshToken(sha256(refreshToken));
      if (row) await r.tokens.revokeFamily(row.familyId);
    });
  }

  /** Always succeeds from the caller's point of view, so it cannot be used to find accounts. */
  async forgotPassword(email: string): Promise<void> {
    const { uow, config } = this.deps;
    const user = await uow.read((r) => r.users.findByEmail(email));
    if (!user || !user.isActive) return;
    const link = await uow.run(async (r) => {
      const { token, hash } = newOpaqueToken();
      await r.tokens.insertResetToken({
        userId: user.id,
        hash,
        purpose: 'reset',
        expiresAt: new Date(this.deps.clock().getTime() + 30 * 60_000),
      });
      await audit(r, null, 'User', user.id, 'PASSWORD_RESET_REQUESTED');
      return `${config.appBaseUrl}/reset-password?token=${token}`;
    });
    await this.deps.email.send({
      to: user.email,
      subject: 'Reset your SizaniConnect password',
      text:
        `Hello ${user.fullName},\n\nUse this link to choose a new password. It works once and expires in 30 minutes:\n\n${link}\n\n` +
        'If you did not ask for this, ignore this email. Your password has not changed.',
    });
  }

  /** Used for both password resets and first-time activation of accounts created by an admin. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    await this.deps.uow.run(async (r) => {
      const row = await r.tokens.consumeResetToken(sha256(token));
      if (!row) throw badRequest('INVALID_RESET_LINK', 'This link has expired or has already been used. Request a new one.');
      const user = await r.users.findById(row.userId);
      if (!user) throw badRequest('INVALID_RESET_LINK', 'This link is no longer valid.');
      const problem = passwordPolicyProblem(newPassword, { email: user.email, name: user.fullName });
      if (problem) throw badRequest('WEAK_PASSWORD', problem);
      await r.users.setPasswordHash(user.id, await this.deps.hasher.hash(newPassword));
      await r.users.clearFailedLogins(user.id);
      await r.tokens.revokeAllForUser(user.id);
      await audit(r, null, 'User', user.id, row.purpose === 'activation' ? 'ACCOUNT_ACTIVATED' : 'PASSWORD_RESET');
    });
  }

  async me(actor: Actor) {
    const user = await this.deps.uow.read((r) => r.users.findById(actor.id));
    if (!user || !user.isActive) throw unauthorized();
    return toPublicUser(user);
  }

  private actorFor(user: UserRecord): Omit<Actor, 'ip'> {
    return { id: user.id, role: user.role, name: user.fullName, siteId: user.siteId, donorId: user.donorId };
  }

  private refreshExpiry(): Date {
    return new Date(this.deps.clock().getTime() + this.deps.config.refreshTokenTtlDays * 86_400_000);
  }
}
