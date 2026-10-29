import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import pg from '../../api/node_modules/pg/lib/index.js';
import { DATABASE_URL } from '../playwright.config';

export const PASSWORD = 'Sizani-Demo-2026';
export const ACCOUNTS = {
  admin: 'admin@sizani.test',
  ops: 'ops@sizani.test',
  coordinator: 'coordinator@sizani.test',
  volunteer: 'volunteer@sizani.test',
  donor: 'donor@sizani.test',
} as const;

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

export async function signOut(page: Page) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** NFR-10: WCAG 2.1 AA, checked by axe-core on the page as it stands. */
export async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);
  expect(summary, `accessibility problems on ${label}`).toEqual([]);
}

/** NFR-12: nothing wider than the screen. */
export async function expectNoSideways(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, 'page scrolls sideways').toBeLessThanOrEqual(width);
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    return (await db.query(sql, params)).rows as T[];
  } finally {
    await db.end();
  }
}

/** An active household at the coordinator's site that has not collected at today's open event. */
export async function eligibleHousehold(): Promise<{ id: string; reference_code: string; head_of_household: string }> {
  const rows = await query<{ id: string; reference_code: string; head_of_household: string }>(
    `SELECT h.household_id AS id, h.reference_code, h.head_of_household
     FROM households h JOIN distribution_sites s ON s.site_id = h.home_site_id
     WHERE h.status = 'Active' AND s.site_name = 'Diepsloot Extension 2 Hall'
       AND NOT EXISTS (SELECT 1 FROM collections c JOIN distribution_events e ON e.event_id = c.event_id
                       WHERE c.household_id = h.household_id AND e.status = 'Open')
     ORDER BY h.reference_code LIMIT 1`,
  );
  if (!rows[0]) throw new Error('No eligible household left in the seeded data');
  return rows[0];
}
