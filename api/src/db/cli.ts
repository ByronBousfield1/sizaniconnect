import { loadConfig } from '../config.js';
import { buildContainer } from '../container.js';
import { logger } from '../infra/logger.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import { seedDemoData } from './seed.js';

const command = process.argv[2];
const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databaseSsl);

try {
  await migrate(pool, logger);
  if (command === 'seed') {
    const { deps } = buildContainer(config, pool, logger);
    await seedDemoData(pool, deps, logger, { force: process.argv.includes('--force') });
  }
} finally {
  await pool.end();
}
