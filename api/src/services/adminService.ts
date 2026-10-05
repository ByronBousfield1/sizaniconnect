import { isUniqueViolation } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../domain/errors.js';
import type { Actor, Role } from '../domain/roles.js';
import { PasswordHasher } from '../security/passwords.js';
import { newOpaqueToken } from '../security/tokens.js';
import { toPublicUser } from '../repositories/userRepository.js';
import { audit, page, type ServiceDeps } from './context.js';

export interface CreateUserInput {
  fullName: string;
  email: string;
  phoneNumber?: string | null;
  role: Role;
  siteId?: string | null;
  donorId?: string | null;
}

export class AdminService {
  constructor(private readonly deps: ServiceDeps) {}

  async listUsers(filter: { q?: string; role?: Role }) {
    const users = await this.deps.uow.read((r) => r.users.list(filter));
    return users.map(toPublicUser);
  }

  /**
   * US-18: accounts start with an unusable password and an activation link. When no mail server
   * is configured the link is returned to the administrator to hand over in person instead.
   */
  async createUser(actor: Actor, input: CreateUserInput) {
    this.assertRoleLinks(input.role, input.siteId ?? null, input.donorId ?? null);
    try {
      const { id, token } = await this.deps.uow.run(async (r) => {
        const userId = await r.users.insert({ ...input, email: input.email.trim(), passwordHash: PasswordHasher.unusable() });
        const t = newOpaqueToken();
        await r.tokens.insertResetToken({
          userId,
          hash: t.hash,
          purpose: 'activation',
          expiresAt: new Date(this.deps.clock().getTime() + 72 * 3_600_000),
        });
        await audit(r, actor, 'User', userId, 'CREATE', { role: input.role });
        return { id: userId, token: t.token };
      });
      const activationLink = `${this.deps.config.appBaseUrl}/reset-password?token=${token}&activate=1`;
      await this.deps.email.send({
        to: input.email,
        subject: 'Your SizaniConnect account',
        text:
          `Hello ${input.fullName},\n\nAn account has been created for you on SizaniConnect.\n` +
          `Choose your password here (the link expires in 72 hours):\n\n${activationLink}\n`,
      });
      return { id, activationLink: this.deps.email.configured ? undefined : activationLink };
    } catch (err) {
      if (isUniqueViolation(err, 'ux_users_email')) {
        throw conflict('EMAIL_IN_USE', 'Another account already uses that email address.');
      }
      throw err;
    }
  }

  async updateUser(
    actor: Actor,
    id: string,
    patch: { fullName?: string; phoneNumber?: string | null; role?: Role; siteId?: string | null; isActive?: boolean },
  ) {
    return this.deps.uow.run(async (r) => {
      const user = await r.users.findById(id);
      if (!user) throw notFound('User');
      if (id === actor.id && (patch.isActive === false || (patch.role && patch.role !== 'Admin'))) {
        throw conflict('SELF_LOCKOUT', 'You cannot deactivate your own account or remove your own admin role.');
      }
      const role = patch.role ?? user.role;
      const siteId = patch.siteId !== undefined ? patch.siteId : user.siteId;
      this.assertRoleLinks(role, siteId, user.donorId, true);
      if (user.role === 'Admin' && (patch.isActive === false || (patch.role && patch.role !== 'Admin'))) {
        if ((await r.users.countActiveAdmins()) <= 1) {
          throw conflict('LAST_ADMIN', 'At least one active administrator must remain.');
        }
      }
      await r.users.update(id, patch);
      if (patch.isActive === false) await r.tokens.revokeAllForUser(id);
      await audit(r, actor, 'User', id, 'UPDATE', { fields: Object.keys(patch), role: patch.role });
      return { id };
    });
  }

  listSites() {
    return this.deps.uow.read((r) => r.events.listSites());
  }

  async createSite(actor: Actor, input: { siteName: string; suburb: string; capacityPerEvent: number }) {
    try {
      return await this.deps.uow.run(async (r) => {
        const id = await r.events.insertSite({ ...input, siteName: input.siteName.trim(), suburb: input.suburb.trim() });
        await audit(r, actor, 'DistributionSite', id, 'CREATE', { siteName: input.siteName });
        return { id };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('SITE_EXISTS', 'A site with that name already exists.');
      throw err;
    }
  }

  async updateSite(
    actor: Actor,
    id: string,
    patch: { siteName?: string; suburb?: string; capacityPerEvent?: number; isActive?: boolean },
  ) {
    return this.deps.uow.run(async (r) => {
      if (!(await r.events.findSite(id))) throw notFound('Site');
      await r.events.updateSite(id, patch);
      await audit(r, actor, 'DistributionSite', id, 'UPDATE', { fields: Object.keys(patch) });
      return { id };
    });
  }

  async auditLog(filter: { entityName?: string; userId?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
    const p = page(filter);
    const result = await this.deps.uow.read((r) => r.audit.list({ ...filter, limit: p.limit, offset: p.offset }));
    return { ...result, page: p.page, pageSize: p.pageSize };
  }

  private assertRoleLinks(role: Role, siteId: string | null, donorId: string | null, existing = false) {
    if (role === 'SiteCoordinator' && !siteId) {
      throw badRequest('SITE_REQUIRED', 'A site coordinator must be assigned to a site.');
    }
    if (role === 'Donor' && !donorId) {
      throw badRequest('DONOR_REQUIRED', 'A donor account must be linked to a donor record.');
    }
    if (role !== 'Donor' && donorId) {
      throw badRequest(
        existing ? 'ROLE_CHANGE_NOT_ALLOWED' : 'DONOR_NOT_ALLOWED',
        existing ? 'Donor accounts cannot be changed to staff roles. Create a separate staff account.' : 'Only donor accounts are linked to a donor.',
      );
    }
  }
}
