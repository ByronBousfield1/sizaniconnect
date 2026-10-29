import { expect, test } from '@playwright/test';
import { ACCOUNTS, eligibleHousehold, signIn } from './helpers';

/** Task 2 feedback: what people see when the connection drops or the TLS handshake times out. */

test('going offline shows a banner straight away, and it clears itself when the connection is back @phone', async ({ page, context }) => {
  await signIn(page, ACCOUNTS.coordinator);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good day');
  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'You are offline' })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('You are offline')).toHaveCount(0);
});

test('a save lost to a failed connection can be repeated safely: a household is never recorded twice', async ({ page }) => {
  const hh = await eligibleHousehold();
  await signIn(page, ACCOUNTS.volunteer);
  await page.goto('/desk');
  await page.getByLabel('Household reference code').fill(hh.reference_code);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText(/Eligible for a/)).toBeVisible();

  // The request reaches the server and is saved, but the answer never comes back (signal lost).
  await page.route('**/api/v1/collections', async (route) => {
    await route.fetch(); // the server receives and saves it
    await route.abort('connectionfailed');
  });
  await page.getByRole('button', { name: 'Record collection' }).click();
  await expect(page.getByText(/may or may not have been saved/)).toBeVisible();
  await expect(page.getByText(/Press Record collection again/)).toBeVisible();
  await expect(page.getByText(/can't be reached right now/)).toBeVisible();

  // Signal is back. Pressing again does not create a second collection.
  await page.unroute('**/api/v1/collections');
  await page.getByRole('button', { name: 'Record collection' }).click();
  await expect(page.getByText(/your first try was saved before the connection dropped/)).toBeVisible();
  await expect(page.getByText(/can't be reached right now/)).toHaveCount(0);
});

test('a request that hangs (for example a stalled TLS handshake) is given up after 20 seconds with a clear message', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, ACCOUNTS.coordinator);
  await page.goto('/overview');
  // Hold every request to the households list for longer than the client will wait.
  await page.route('**/api/v1/households?**', () => new Promise(() => undefined));
  await page.getByRole('link', { name: 'Households' }).first().click();
  await expect(page.getByText(/The server took too long to answer/)).toBeVisible({ timeout: 60_000 });
});
