import { badRequest, conflict, forbidden, notFound } from '../domain/errors.js';
import type { Actor } from '../domain/roles.js';
import { addMonthsUtc } from '../domain/time.js';
import { toPublicUser, type DeactivationReason } from '../repositories/userRepository.js';
import { PasswordHasher } from '../security/passwords.js';
import { audit, type ServiceDeps } from './context.js';

/**
 * What happens when someone leaves, and when beneficiary data has been kept long enough.
 *
 * Lecturer feedback on Task 2: "What happens if the user retires? How are they removed from the
 * database completely? Now think of the admin managing the process." The administrator does it in
 * two deliberate steps:
 *
 *   1. Offboard: the account stops working at once. Sessions, reset links and recovery codes are
 *      cancelled and future shift places are freed. Reversible for a grace period (30 days).
 *   2. Erase: personal data is removed for good. An account that never did anything is deleted
 *      outright. One that did (signed in, recorded collections, worked shifts) keeps an anonymous
 *      row, because those records and the append-only audit trail must still point at something;
 *      the row says "Former user" and holds no name, email, cellphone or password.
 *
 * NFR-16 works the same way for households: archived for 24 months, then anonymised.
 */
export class RetentionService {
  constructor(private readonly deps: ServiceDeps) {}

  async offboardUser(actor: Actor, id: string, reason: DeactivationReason) {
    const now = this.deps.clock();
    return this.deps.uow.run(async (r) => {
      const user = await r.users.findById(id);
      if (!user || user.erasedAt) throw notFound('User');
      if (id === actor.id) throw conflict('SELF_LOCKOUT', 'You cannot offboard your own account. Ask another administrator.');
      if (!user.isActive) throw conflict('ALREADY_OFFBOARDED', `${user.fullName} has already been offboarded.`);
      if (user.role === 'Admin' && (await r.users.countActiveAdmins()) <= 1) {
        throw conflict('LAST_ADMIN', 'At least one active administrator must remain. Create or reactivate another administrator first.');
      }

      await r.users.offboard(id, reason, now);
      await r.tokens.revokeAllForUser(id);
      await r.tokens.retireResetTokens(id);
      await r.recoveryCodes.deleteAll(id);
      const shiftsReleased = await r.shifts.withdrawFutureForUser(id, now);
      const siteLeftWithoutCoordinator =
        user.role === 'SiteCoordinator' && user.siteId && (await r.users.countActiveCoordinators(user.siteId, id)) === 0
          ? user.siteName
          : null;
      await audit(r, actor, 'User', id, 'OFFBOARD', { reason, shiftsReleased });

      const erasureDue = new Date(now.getTime() + this.deps.config.userErasureGraceDays * 86_400_000);
      return { id, shiftsReleased, siteLeftWithoutCoordinator, erasureDueOn: erasureDue.toISOString().slice(0, 10) };
    });
  }

  async eraseUser(actor: Actor, id: string, confirmEmail: string) {
    const now = this.deps.clock();
    return this.deps.uow.run(async (r) => {
      const user = await r.users.findById(id);
      if (!user) throw notFound('User');
      if (user.erasedAt) throw conflict('ALREADY_ERASED', 'This account has already been erased.');
      if (id === actor.id) throw forbidden('You cannot erase your own account.');
      if (user.isActive) {
        throw conflict('STILL_ACTIVE', 'Offboard the account first. Only accounts that have been offboarded can be erased.');
      }
      if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
        const message = `Type ${user.email} exactly to confirm.`;
        throw badRequest('CONFIRMATION_MISMATCH', message, { fields: [{ field: 'confirmEmail', message }] });
      }

      const references = await r.users.referenceCount(id);
      let outcome: 'Deleted' | 'Anonymised';
      if (references === 0) {
        await r.users.deleteCompletely(id); // tokens and recovery codes go with it (ON DELETE CASCADE)
        outcome = 'Deleted';
      } else {
        await r.tokens.deleteAllForUser(id);
        await r.recoveryCodes.deleteAll(id);
        await r.users.anonymise(id, PasswordHasher.unusable(), now);
        outcome = 'Anonymised';
      }
      // The audit entry names the role and outcome only: it must not keep what was just removed.
      await audit(r, actor, 'User', id, 'ERASE', { outcome, role: user.role });
      return { id, outcome };
    });
  }

  async overview() {
    const { config } = this.deps;
    const now = this.deps.clock();
    const graceMs = config.userErasureGraceDays * 86_400_000;
    return this.deps.uow.read(async (r) => {
      const waiting = await r.users.awaitingErasure();
      const households = await r.households.retentionDue(addMonthsUtc(now, -config.householdRetentionMonths), 50);
      return {
        policy: { userErasureGraceDays: config.userErasureGraceDays, householdRetentionMonths: config.householdRetentionMonths },
        usersAwaitingErasure: waiting.map((u) => {
          const due = new Date((u.deactivatedAt ?? now).getTime() + graceMs);
          return { ...toPublicUser(u), erasureDueOn: due.toISOString().slice(0, 10), isDue: due <= now };
        }),
        erasedUserCount: await r.users.countErased(),
        householdsDue: households,
        anonymisedHouseholdCount: await r.households.countAnonymised(),
      };
    });
  }

  /** NFR-16, run by an administrator from the Data retention screen. */
  async anonymiseDueHouseholds(actor: Actor) {
    const now = this.deps.clock();
    const cutoff = addMonthsUtc(now, -this.deps.config.householdRetentionMonths);
    return this.deps.uow.run(async (r) => {
      const ids = await r.households.anonymiseArchivedBefore(cutoff, now);
      for (const id of ids) await audit(r, actor, 'Household', id, 'ANONYMISE', { policy: 'NFR-16' });
      return { anonymised: ids.length };
    });
  }
}
