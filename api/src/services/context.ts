import type { Config } from '../config.js';
import { forbidden } from '../domain/errors.js';
import type { ReferenceCodeGenerator } from '../domain/referenceCode.js';
import type { Actor, Role } from '../domain/roles.js';
import type { EventBus } from '../events/eventBus.js';
import type { EmailSender } from '../infra/email.js';
import type { Logger } from '../infra/logger.js';
import type { Repositories, UnitOfWork } from '../repositories/index.js';
import type { PasswordHasher } from '../security/passwords.js';
import type { TokenService } from '../security/tokens.js';

/** Everything a service may depend on, resolved once at startup (dependency injection). */
export interface ServiceDeps {
  config: Config;
  uow: UnitOfWork;
  bus: EventBus;
  email: EmailSender;
  hasher: PasswordHasher;
  tokens: TokenService;
  referenceCodes: ReferenceCodeGenerator;
  clock: () => Date;
  log: Logger;
}

export function audit(
  repos: Repositories,
  actor: Actor | null,
  entityName: string,
  entityId: string | null,
  action: string,
  details?: Record<string, unknown>,
) {
  return repos.audit.write({
    userId: actor?.id ?? null,
    entityName,
    entityId,
    action,
    details: details ?? null,
    ipAddress: actor?.ip ?? null,
  });
}

export function hasRole(actor: Actor, ...roles: Role[]): boolean {
  return roles.includes(actor.role);
}

/**
 * Resource-level authorisation (Task 1, Section 10.2). Role checks say what kind of user may act;
 * this says whether this user may act on this site. Site coordinators are confined to their own.
 */
export function assertSiteScope(actor: Actor, siteId: string): void {
  if (actor.role === 'SiteCoordinator' && actor.siteId !== siteId) {
    throw forbidden('You can only manage events at your own site.');
  }
}

export function page(input: { page?: number; pageSize?: number }) {
  const pageSize = Math.min(Math.max(input.pageSize ?? 25, 1), 100);
  const pageNo = Math.max(input.page ?? 1, 1);
  return { limit: pageSize, offset: (pageNo - 1) * pageSize, page: pageNo, pageSize };
}
