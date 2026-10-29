import { loadConfig } from './config.js';
import { buildContainer } from './container.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { seedDemoData } from './db/seed.js';
import { createApp } from './http/app.js';
import { logger } from './infra/logger.js';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, config.databaseSsl);
  // An idle connection dropped by the server (restart, failover, network blip) must not crash the
  // process. The pool discards it and opens a new one on the next request.
  pool.on('error', (err) => logger.error({ err }, 'Idle database connection lost; it will be replaced'));
  if (config.skipMigrations) logger.warn('SKIP_MIGRATIONS is set: starting without applying migrations');
  else await migrate(pool, logger);

  const { deps, services } = buildContainer(config, pool, logger);
  if (config.seedDemoData) await seedDemoData(pool, deps, logger);

  const app = createApp({ config, services, tokens: deps.tokens, pool, log: logger });
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv, version: config.version }, 'SizaniConnect API listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
