import { expect, test } from '@playwright/test';
import { ACCOUNTS, expectAccessible, expectNoSideways, signIn } from './helpers';

/**
 * NFR-10 (WCAG 2.1 AA) checked by axe-core on every main screen, as each role sees it, on a laptop
 * and on a 360 px phone. NFR-12 (no sideways scrolling at 360 px) is checked on the same pages.
 */
const screens: Record<keyof typeof ACCOUNTS, string[]> = {
  coordinator: ['/overview', '/desk', '/households', '/households/new', '/events', '/shifts', '/stock', '/account'],
  ops: ['/overview', '/reports', '/donations', '/stock'],
  admin: ['/overview', '/admin/users', '/admin/sites', '/admin/audit', '/admin/retention'],
  volunteer: ['/shifts', '/desk'],
  donor: ['/donor'],
};

test('sign-in, forgotten-password and recovery pages @phone', async ({ page }) => {
  for (const path of ['/login', '/forgot-password', '/recover']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
    await expectAccessible(page, path);
    await expectNoSideways(page);
  }
});

for (const [role, paths] of Object.entries(screens)) {
  test(`${role} screens @phone`, async ({ page }) => {
    await signIn(page, ACCOUNTS[role as keyof typeof ACCOUNTS]);
    for (const path of paths) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectAccessible(page, `${role} ${path}`);
      await expectNoSideways(page);
    }
  });
}

test('a household page and its printable card', async ({ page }) => {
  await signIn(page, ACCOUNTS.coordinator);
  await page.goto('/households');
  await page.locator('table a').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectAccessible(page, 'household detail');
  await page.getByRole('link', { name: 'Print household card' }).click();
  await expect(page.getByRole('img', { name: /QR code for SZN-/ })).toBeVisible();
  await expectAccessible(page, 'household card');
});
