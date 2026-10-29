import { randomUUID } from 'node:crypto';
import { AppError, badRequest, unauthorized } from '../domain/errors.js';
import type { Actor } from '../domain/roles.js';
import { toPublicUser, type UserRecord } from '../repositories/userRepository.js';
import { passwordPolicyProblem } from '../security/passwords.js';
import { hashRecoveryCode, newRecoveryCodes, normaliseRecoveryCode } from '../security/recoveryCodes.js';
import { newOpaqueToken, sha256 } from '../security/tokens.js';
import { audit, type ServiceDeps } from './context.js';

const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const RECOVERY_MISMATCH = 'That email address and recovery code do not match. Check the code and try again.';
const fieldError = (code: string, field: string, message: string) => badRequest(code, message, { fields: [{ field, message }] });

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

  /** Password change while signed in. Other devices are signed out; this one stays signed in. */
  async changePassword(actor: Actor, currentPassword: string, newPassword: string, refreshToken?: string): Promise<void> {
    const { uow, hasher } = this.deps;
    const user = await this.requirePassword(actor, currentPassword, 'currentPassword');
    const problem = passwordPolicyProblem(newPassword, { email: user.email, name: user.fullName });
    if (problem) throw fieldError('WEAK_PASSWORD', 'newPassword', problem);
    if (await hasher.verify(newPassword, user.passwordHash)) {
      throw fieldError('SAME_PASSWORD', 'newPassword', 'Choose a password that is different from your current one.');
    }
    await uow.run(async (r) => {
      const current = refreshToken ? await r.tokens.findRefreshToken(sha256(refreshToken)) : null;
      await r.users.setPasswordHash(user.id, await hasher.hash(newPassword));
      await r.tokens.revokeAllForUserExceptFamily(user.id, current?.userId === user.id ? current.familyId : null);
      await audit(r, actor, 'User', user.id, 'PASSWORD_CHANGED');
    });
    await this.notifyPasswordChanged(user);
  }

  /**
   * Ten single-use codes for getting back in without email (Task 2 feedback: can an administrator
   * who forgets the password reset it themselves?). Asking for the password again means a session
   * left open on a shared phone cannot be used to mint codes.
   */
  async createRecoveryCodes(actor: Actor, password: string): Promise<{ codes: string[] }> {
    const user = await this.requirePassword(actor, password, 'password');
    const codes = newRecoveryCodes();
    const pepper = this.deps.config.idHashPepper;
    await this.deps.uow.run(async (r) => {
      await r.recoveryCodes.replaceAll(user.id, codes.map((c) => hashRecoveryCode(normaliseRecoveryCode(c)!, pepper)));
      await audit(r, actor, 'User', user.id, 'RECOVERY_CODES_CREATED', { count: codes.length });
    });
    return { codes };
  }

  recoveryCodeStatus(actor: Actor) {
    return this.deps.uow.read((r) => r.recoveryCodes.status(actor.id));
  }

  /** Signed out and forgotten the password: email address + one recovery code + a new password. */
  async recoverWithCode(email: string, code: string, newPassword: string, ip?: string): Promise<{ remainingCodes: number }> {
    const { uow, config, hasher } = this.deps;
    // The same password rules are checked before anything else, so the reply does not reveal whether the account exists.
    const early = passwordPolicyProblem(newPassword, { email });
    if (early) throw fieldError('WEAK_PASSWORD', 'newPassword', early);

    const user = await uow.read((r) => r.users.findByEmail(email));
    if (!user || !user.isActive) {
      await uow.run((r) => audit(r, null, 'User', user?.id ?? null, 'RECOVERY_FAILED', { reason: user ? 'inactive' : 'unknown-email', ip }));
      throw badRequest('RECOVERY_FAILED', RECOVERY_MISMATCH);
    }
    if (user.lockedUntil && user.lockedUntil > this.deps.clock()) throw this.locked();
    const problem = passwordPolicyProblem(newPassword, { email: user.email, name: user.fullName });
    if (problem) throw fieldError('WEAK_PASSWORD', 'newPassword', problem);

    const normalised = normaliseRecoveryCode(code);
    const newHash = await hasher.hash(newPassword);
    const outcome = await uow.run(async (r) => {
      const ok = normalised !== null && (await r.recoveryCodes.consume(user.id, hashRecoveryCode(normalised, config.idHashPepper)));
      if (!ok) {
        // A wrong code counts towards the same lockout as a wrong password.
        const { locked } = await r.users.recordFailedLogin(user.id, config.lockoutThreshold, config.lockoutMinutes);
        await audit(r, null, 'User', user.id, locked ? 'ACCOUNT_LOCKED' : 'RECOVERY_FAILED', { ip });
        return { ok: false as const, locked };
      }
      await r.users.setPasswordHash(user.id, newHash);
      await r.users.clearFailedLogins(user.id);
      await r.tokens.revokeAllForUser(user.id);
      const { remaining } = await r.recoveryCodes.status(user.id);
      await audit(r, null, 'User', user.id, 'PASSWORD_RECOVERED', { method: 'recovery-code', remainingCodes: remaining, ip });
      return { ok: true as const, remaining };
    });
    if (!outcome.ok) throw outcome.locked ? this.locked() : badRequest('RECOVERY_FAILED', RECOVERY_MISMATCH);
    await this.notifyPasswordChanged(user);
    return { remainingCodes: outcome.remaining };
  }

  /**
   * Last resort for an administrator when email is down and no recovery code is left: someone with
   * access to the Azure portal runs `node dist/db/cli.js recover-admin <email>` in the web app's SSH
   * console and gets a single-use link that expires in 30 minutes. Only administrators qualify.
   */
  async issueBreakGlassLink(email: string): Promise<{ link: string; expiresAt: Date }> {
    const { uow, config } = this.deps;
    const user = await uow.read((r) => r.users.findByEmail(email));
    if (!user || !user.isActive || user.role !== 'Admin') {
      throw badRequest('NOT_AN_ADMIN', 'No active administrator account has that email address.');
    }
    const expiresAt = new Date(this.deps.clock().getTime() + 30 * 60_000);
    const token = await uow.run(async (r) => {
      const t = newOpaqueToken();
      await r.tokens.insertResetToken({ userId: user.id, hash: t.hash, purpose: 'reset', expiresAt });
      await r.users.clearFailedLogins(user.id);
      await audit(r, null, 'User', user.id, 'BREAK_GLASS_RESET', { via: 'server console' });
      return t.token;
    });
    return { link: `${config.appBaseUrl}/reset-password?token=${token}`, expiresAt };
  }

  async me(actor: Actor) {
    const user = await this.deps.uow.read((r) => r.users.findById(actor.id));
    if (!user || !user.isActive) throw unauthorized();
    return toPublicUser(user);
  }

  /** Re-checks the signed-in user's password before a sensitive change. A wrong one counts towards lockout. */
  private async requirePassword(actor: Actor, password: string, field: string): Promise<UserRecord> {
    const { uow, hasher, config } = this.deps;
    const user = await uow.read((r) => r.users.findById(actor.id));
    if (!user || !user.isActive) throw unauthorized();
    if (!(await hasher.verify(password, user.passwordHash))) {
      await uow.run(async (r) => {
        const { locked } = await r.users.recordFailedLogin(user.id, config.lockoutThreshold, config.lockoutMinutes);
        await audit(r, actor, 'User', user.id, locked ? 'ACCOUNT_LOCKED' : 'PASSWORD_CHECK_FAILED');
      });
      throw fieldError('WRONG_PASSWORD', field, 'That is not your current password.');
    }
    return user;
  }

  private locked() {
    return new AppError(
      423,
      'ACCOUNT_LOCKED',
      `Too many failed attempts. Try again after ${this.deps.config.lockoutMinutes} minutes.`,
    );
  }

  private async notifyPasswordChanged(user: UserRecord): Promise<void> {
    await this.deps.email.send({
      to: user.email,
      subject: 'Your SizaniConnect password was changed',
      text:
        `Hello ${user.fullName},\n\nThe password for your SizaniConnect account was just changed.\n\n` +
        'If this was you, there is nothing else to do. If it was not, contact your administrator straight away.',
    });
  }

  private actorFor(user: UserRecord): Omit<Actor, 'ip'> {
    return { id: user.id, role: user.role, name: user.fullName, siteId: user.siteId, donorId: user.donorId };
  }

  private refreshExpiry(): Date {
    return new Date(this.deps.clock().getTime() + this.deps.config.refreshTokenTtlDays * 86_400_000);
  }
}
