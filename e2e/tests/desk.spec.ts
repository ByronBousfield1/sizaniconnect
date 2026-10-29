import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { ACCOUNTS, eligibleHousehold, expectNoSideways, signIn } from './helpers';

/**
 * US-09 acceptance criteria at the event desk, including the edge cases asked for in the Task 1
 * feedback: invalid or corrupted QR payloads, on low-end hardware.
 */
test.describe('event desk', () => {
  test('AC-09.1: records an eligible household and shows what to hand over @phone', async ({ page }) => {
    const hh = await eligibleHousehold();
    await signIn(page, ACCOUNTS.volunteer);
    await page.goto('/desk');
    await page.getByLabel('Household reference code').fill(hh.reference_code);
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByText(/Eligible for a (small|medium|large) parcel/)).toBeVisible();
    await expectNoSideways(page);
    await page.getByRole('button', { name: 'Record collection' }).click();
    await expect(page.getByText(/Recorded\. Hand over a/)).toBeVisible();

    // AC-09.2: the same household again is stopped.
    await page.getByLabel('Household reference code').fill(hh.reference_code);
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByText(/Already collected at/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record collection' })).toHaveCount(0);
  });

  test('AC-09.3 to 09.6: damaged, foreign, over-long and half-typed scans are explained and never sent', async ({ page }) => {
    await signIn(page, ACCOUNTS.volunteer);
    await page.goto('/desk');
    const lookups: string[] = [];
    page.on('request', (r) => r.url().includes('/households/by-ref/') && lookups.push(r.url()));
    const input = page.getByLabel('Household reference code');

    const cases: [string, RegExp][] = [
      ['SZN1:SZN-2026-7K2Q', /could not be read correctly/], // a creased card: the end of the payload is lost
      ['SZN1:SZN-2026-7K2QX9:0', /could not be read correctly/], // wrong check character
      ['https://wa.me/27825550134', /not a SizaniConnect household card/], // somebody else's QR code
      ['SZN1:' + 'X'.repeat(90), /far too long/],
      ['SZN-20', /not a complete reference code/],
    ];
    for (const [raw, message] of cases) {
      await input.fill(raw);
      await input.press('Enter'); // what a USB or Bluetooth scanner does after the payload
      await expect(page.getByRole('alert')).toContainText(message);
    }
    await expect(page.getByText(/Type the reference code printed under the QR code/)).toBeVisible();
    expect(lookups).toEqual([]);
  });

  test('AC-09.7: a card is read by the camera on a simulated low-end phone within 5 seconds', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'fake camera input is a Chromium feature');
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch {
      test.skip(true, 'ffmpeg is needed to turn the printed card into a fake camera feed');
    }

    // 1. Print a real card for an eligible household and photograph it.
    const hh = await eligibleHousehold();
    await signIn(page, ACCOUNTS.coordinator);
    await page.goto(`/households/${hh.id}/card`);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'szn-card-'));
    const png = path.join(dir, 'card.png');
    await page.locator('.household-card').screenshot({ path: png, scale: 'css' });

    // 2. Turn the photo into a 640x480 camera feed, card in the middle of a grey table.
    const y4m = path.join(dir, 'camera.y4m');
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-loop', '1', '-i', png, '-t', '3', '-r', '15',
      '-vf', 'scale=460:-1,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=0x6e6a64', '-pix_fmt', 'yuv420p', y4m,
    ]);

    // 3. A phone-sized browser with that feed as its camera, CPU slowed six times.
    const browser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
    });
    const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, baseURL: test.info().project.use.baseURL });
    const p = await phone.newPage();
    const cdp = await phone.newCDPSession(p);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await signIn(p, ACCOUNTS.volunteer);
    await p.goto('/desk');
    const started = Date.now();
    await p.getByRole('button', { name: 'Scan card with camera' }).click();
    await expect(p.getByText(hh.head_of_household)).toBeVisible({ timeout: 15_000 });
    const seconds = (Date.now() - started) / 1000;
    test.info().annotations.push({ type: 'scan time', description: `${seconds.toFixed(1)} s at 6x CPU slowdown` });
    expect(seconds).toBeLessThan(5);
    await expect(p.getByText(/Eligible for a/)).toBeVisible();
    await browser.close();
  });
});
