import { expect, test } from '@playwright/test';
import { ACCOUNTS, PASSWORD, query, signIn, signOut } from './helpers';

/** Task 2 feedback, end to end in the browser: cellphone validation, admin self-recovery, leavers. */

test('cellphone numbers are checked before anything is sent, and stored in one form', async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto('/admin/users');
  await page.getByLabel('Full name').fill('Ayanda Mokoena');
  await page.getByLabel('Email').fill('ayanda.m@sizani.test');
  const phone = page.getByLabel('Cellphone number');
  await phone.fill('011 555 0134');
  await page.getByLabel('Full name').click();
  await expect(page.getByText('That is a landline number. Enter a cellphone number instead.')).toBeVisible();
  await phone.fill('+27 (72) 555-0134');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Account created for Ayanda Mokoena.')).toBeVisible();
  const [row] = await query<{ phone_number: string }>('SELECT phone_number FROM users WHERE email = $1', ['ayanda.m@sizani.test']);
  expect(row.phone_number).toBe('+27725550134');
});

test('an administrator who forgets the password gets back in with a recovery code', async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await expect(page.getByText(/You have no recovery codes/)).toBeVisible();
  await page.getByRole('link', { name: 'Set up recovery codes' }).click();
  await page.getByRole('button', { name: 'Create recovery codes' }).click();
  await page.getByLabel('Enter your password to continue').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create my codes' }).click();
  const codes = await page.getByRole('list', { name: 'Your recovery codes' }).locator('code').allInnerTexts();
  expect(codes).toHaveLength(10);
  await page.getByRole('button', { name: 'I have saved them' }).click();
  await signOut(page);

  // Forgotten password, no email: the recovery-code route from the sign-in page.
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await page.getByRole('link', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel('Email').fill(ACCOUNTS.admin);
  await page.getByLabel('Recovery code').fill(codes[3].toLowerCase());
  await page.getByLabel('New password').fill('Back-In-Business-2026');
  await page.getByLabel('Type it again').fill('Back-In-Business-2026');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByText('You have 9 codes left.')).toBeVisible();
  await signIn(page, ACCOUNTS.admin, 'Back-In-Business-2026');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good day');

  // Put the demo password back for the other tests.
  await page.goto('/account');
  await page.getByLabel('Current password').fill('Back-In-Business-2026');
  await page.getByLabel('New password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Type the new password again').fill(PASSWORD);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText(/Password changed/)).toBeVisible();
});

test('a second administrator can send a reset link, shown on screen when email is off', async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto('/admin/users');
  const row = page.getByRole('row', { name: /Sipho Dlamini|ops@sizani.test/ });
  await row.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/give this link to the person directly/)).toBeVisible();
  await expect(page.locator('code').filter({ hasText: '/reset-password?token=' })).toBeVisible();
});

test('a volunteer who retires is offboarded, then erased by the administrator', async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto('/admin/users');
  const row = page.getByRole('row', { name: /volunteer3@sizani.test/ });
  const name = (await row.locator('td').first().innerText()).trim();
  await row.getByRole('button', { name: 'Offboard' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Why are they leaving?').selectOption('Retired');
  await dialog.getByRole('button', { name: /^Offboard/ }).click();
  await expect(page.getByText(`${name} has been offboarded and signed out everywhere.`)).toBeVisible();

  await page.getByRole('link', { name: 'Data retention' }).first().click();
  const waiting = page.getByRole('row', { name: new RegExp(name) });
  await waiting.getByRole('button', { name: 'Erase personal data' }).click();
  const erase = page.getByRole('dialog');
  await expect(erase.getByRole('button', { name: 'Erase permanently' })).toBeDisabled();
  await erase.getByLabel(/Type .* to confirm/).fill('volunteer3@sizani.test');
  await erase.getByRole('button', { name: 'Erase permanently' }).click();
  await expect(page.getByText(new RegExp(`${name}'s personal data was erased`))).toBeVisible();

  const rows = await query('SELECT full_name, email, phone_number FROM users WHERE email LIKE $1 OR full_name = $2', ['%volunteer3%', name]);
  expect(rows).toEqual([]);
  await signOut(page);
  await page.getByLabel('Email').fill('volunteer3@sizani.test');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
});

test('NFR-16: households archived for 24 months are anonymised from the Data retention screen', async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto('/admin/retention');
  await expect(page.getByText(/3 households are due/)).toBeVisible();
  await page.getByRole('button', { name: 'Anonymise 3 households' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Anonymise now' }).click();
  await expect(page.getByText('3 households were anonymised.')).toBeVisible();
  await expect(page.getByText('No households are due')).toBeVisible();
  const left = await query(`SELECT 1 FROM households WHERE head_of_household IN ('Thabo Mokoena','Zanele Dube','Musa Khoza')`);
  expect(left).toEqual([]);
});
