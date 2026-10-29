import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end and accessibility tests. Playwright starts the real API (serving the built React app)
 * against a freshly reset, seeded PostgreSQL database, then drives Chromium like a user would.
 * Tests run one at a time because they share that database.
 */
const PORT = 8090;
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://sizani:sizani@localhost:5432/sizani_e2e';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    // NFR-11 and NFR-12: a low-cost Android phone with a 360 px screen.
    { name: 'phone', use: { ...devices['Galaxy S9+'], viewport: { width: 360, height: 740 } }, grep: /@phone/ },
  ],
  webServer: {
    command: 'node scripts/reset-db.mjs && node ../api/dist/server.js',
    url: `http://localhost:${PORT}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      DATABASE_URL,
      STATIC_DIR: path.join(__dirname, '..', 'web', 'dist'), // the SPA fallback needs an absolute path
      APP_BASE_URL: `http://localhost:${PORT}`,
      SEED_DEMO_DATA: 'true',
      PBKDF2_ITERATIONS: '1000',
      AUTH_RATE_LIMIT_PER_MINUTE: '1000',
      RATE_LIMIT_PER_MINUTE: '100000',
      LOG_LEVEL: 'warn',
    },
  },
});
