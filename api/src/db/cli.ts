/**
 * Operator commands. Locally: `npm run db -- <command>`. On Azure, from the web app's SSH console
 * (Development Tools > SSH), in /home/site/wwwroot: `node dist/db/cli.js <command>`.
 *
 *   status                  list migrations, whether each is applied and whether it has a down script
 *   migrate                 apply pending migrations (the app also does this when it starts)
 *   rollback --to <file>    undo every migration applied after <file>, newest first
 *   seed [--force]          load the demo data set
 */
import { loadConfig } from '../config.js';
import { buildContainer } from '../container.js';
import { logger } from '../infra/logger.js';
import { createPool } from './pool.js';
import { migrate, migrationStatus, rollback } from './migrate.js';
import { seedDemoData } from './seed.js';

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
    default:
      throw new Error(`Unknown command "${command}". Use status, migrate, rollback --to <file> or seed.`);
  }
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
