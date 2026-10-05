import type pg from 'pg';
import type { Config } from './config.js';
import { RandomReferenceCodeGenerator, type ReferenceCodeGenerator } from './domain/referenceCode.js';
import { EventBus } from './events/eventBus.js';
import { LogEmailSender, SmtpEmailSender, type EmailSender } from './infra/email.js';
import type { Logger } from './infra/logger.js';
import { UnitOfWork } from './repositories/index.js';
import { PasswordHasher } from './security/passwords.js';
import { TokenService } from './security/tokens.js';
import type { ServiceDeps } from './services/context.js';
import { createServices, type Services } from './services/index.js';

export interface Container {
  deps: ServiceDeps;
  services: Services;
}

/**
 * Composition root: the one place concrete classes are chosen. Tests pass overrides (a fixed clock,
 * an in-memory mail sender) without touching production code.
 */
export function buildContainer(
  config: Config,
  pool: pg.Pool,
  log: Logger,
  overrides: Partial<{ email: EmailSender; clock: () => Date; referenceCodes: ReferenceCodeGenerator }> = {},
): Container {
  const clock = overrides.clock ?? (() => new Date());
  const deps: ServiceDeps = {
    config,
    log,
    clock,
    uow: new UnitOfWork(pool),
    bus: new EventBus(log),
    email:
      overrides.email ??
      (config.smtpUrl ? new SmtpEmailSender(config.smtpUrl, config.mailFrom) : new LogEmailSender(log, !config.isProduction)),
    hasher: new PasswordHasher(config.pbkdf2Iterations),
    tokens: new TokenService(config.jwtSecret, config.accessTokenTtlSeconds),
    referenceCodes: overrides.referenceCodes ?? new RandomReferenceCodeGenerator(clock),
  };
  registerSubscribers(deps);
  return { deps, services: createServices(deps) };
}

/** Observers for domain events. Each reacts independently; none can fail the original operation. */
function registerSubscribers({ bus, uow, email, log }: ServiceDeps) {
  bus.subscribe('CollectionRecorded', async (e) => {
    await uow.run((r) => r.households.setLastCollected(e.householdId, e.collectedAt));
  });

  bus.subscribe('ShiftWithdrawn', async (e) => {
    const recipients = await uow.read((r) => r.users.coordinatorEmailsForSite(e.siteId));
    const when = new Date(e.startsAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' });
    for (const to of recipients) {
      await email.send({
        to,
        subject: 'A volunteer withdrew from a shift',
        text: `${e.volunteerName} withdrew from the shift starting ${when}. The place is open again on the shift board.`,
      });
    }
  });

  bus.subscribe('DonationCaptured', async (e) => {
    const donor = await uow.read((r) => r.donations.findDonor(e.donorId));
    if (!donor?.contactEmail) return;
    await email.send({
      to: donor.contactEmail,
      subject: `Thank you — receipt ${e.receiptNumber}`,
      text: `Thank you for supporting Sizani Community Food Network. Your donation is recorded under receipt ${e.receiptNumber}.`,
    });
    log.info({ receipt: e.receiptNumber }, 'Donation receipt emailed');
  });
}

