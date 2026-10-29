/**
 * Operator commands. Locally: `npm run db -- <command>`. On Azure, from the web app's SSH console
 * (Development Tools > SSH), in /home/site/wwwroot: `node dist/db/cli.js <command>`.
 *
 *   status                  list migrations, whether each is applied and whether it has a down script
 *   migrate                 apply pending migrations (the app also does this when it starts)
 *   rollback --to <file>    undo every migration applied after <file>, newest first
 *   seed [--force]          load the demo data set
 *   recover-admin <email>   print a 30-minute password link for an administrator who is locked out
 *                           and has no email or recovery code (break-glass; the use is audited)
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { buildContainer } from '../container.js';
import { logger } from '../infra/logger.js';
import { createPool } from './pool.js';
import { migrate, migrationStatus, rollback } from './migrate.js';
import { seedDemoData } from './seed.js';

// In the Azure SSH console the app settings are not always in the shell's environment. They are in
// the environment of the container's first process, so take them from there when they are missing.
if (!process.env.DATABASE_URL && existsSync('/proc/1/environ')) {
  for (const entry of readFileSync('/proc/1/environ', 'utf8').split('\0')) {
    const i = entry.indexOf('=');
    if (i > 0 && process.env[entry.slice(0, i)] === undefined) process.env[entry.slice(0, i)] = entry.slice(i + 1);
  }
}

const [command = 'status', ...args] = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseSsl);
const out = (line = '') => process.stdout.write(`${line}\n`);

try {
  switch (command) {
    case 'status': {
      for (const m of await migrationStatus(pool)) {
        out(
          `${m.applied ? 'applied ' : 'PENDING '} ${m.version.padEnd(40)} ${m.appliedAt ? m.appliedAt.toISOString() : ''.padEnd(24)}  ${
            m.hasDownScript ? 'down script: yes' : 'down script: no'
          }`,
        );
      }
      break;
    }
    case 'migrate': {
      const applied = await migrate(pool, logger);
      out(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply.');
      break;
    }
    case 'rollback': {
      const target = option('--to');
      if (!target) throw new Error('Say which migration to roll back to, for example: rollback --to 001_initial_schema.sql');
      const undone = await rollback(pool, logger, target);
      out(undone.length ? `Rolled back: ${undone.join(', ')}` : `Nothing to roll back: ${target} is already the latest.`);
      out('Set SKIP_MIGRATIONS=true on the web app until the previous release is redeployed, or the next restart re-applies them.');
      break;
    }
    case 'seed': {
      await migrate(pool, logger);
      const { deps } = buildContainer(config, pool, logger);
      await seedDemoData(pool, deps, logger, { force: args.includes('--force') });
      break;
    }
    case 'recover-admin': {
      const email = args[0];
      if (!email) throw new Error('Say which administrator, for example: recover-admin admin@sizani.org.za');
      const { services } = buildContainer(config, pool, logger);
      const { link, expiresAt } = await services.auth.issueBreakGlassLink(email);
      out('Single-use link for that administrator. Give it to them in person or by phone, never by email:');
      out();
      out(`  ${link}`);
      out();
      out(`It expires at ${expiresAt.toISOString()}. This use has been recorded in the audit log.`);
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use status, migrate, rollback --to <file>, seed or recover-admin <email>.`);
  }
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
