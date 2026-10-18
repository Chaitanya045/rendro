import { getRequestListener } from '@hono/node-server';
import type { User } from 'better-auth/types';
import { Hono } from 'hono';
import type { Page } from 'playwright';
import { beforeAll, expect, it } from 'vitest';
import authPages from '@/routes/auth-pages';
import { securityHeaders } from '@/middleware/security-headers';
import { createBrowserHarness } from './helpers/browser';
import { serveFonts } from './helpers/fonts';

const harness = createBrowserHarness();
const password = 'Synthetic password 146!';
beforeAll(async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use('*', securityHeaders);
  app.get('/fonts/*', serveFonts);
  app.use('/account/*', async (c, next) => {
    c.set('user', { id: 'user-a', email: 'person@example.test' } as User);
    await next();
  });
  app.route('/', authPages);
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});

async function open(path: string, width = 1440) {
  const page = await harness.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(harness.origin + path);
  return page;
}

async function hidden(page: Page, selector: string) {
  const node = page.locator(selector);
  expect(await node.count()).toBe(1);
  expect(await node.evaluate(element => getComputedStyle(element).display)).toBe('none');
  expect(await node.isVisible()).toBe(false);
}

it.each([375, 1440])('signup hides alternatives, focuses success and restores a fresh form at %ipx', async width => {
  const page = await open('/sign-up?returnTo=%2Faccept-invitation%2Finv-146', width);
  await hidden(page, '#success-panel');
  let writes = 0;
  await page.route('**/api/auth/sign-up/email', route => {
    writes++;
    return route.fulfill({ status: writes === 1 ? 503 : 200, json: writes === 1 ? { message: 'Try again' } : {} });
  });
  await page.getByLabel('Full name').fill('Synthetic User');
  await page.getByLabel('Work email').fill('person@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect.poll(() => page.getByRole('alert').textContent()).toBe('Try again');
  await hidden(page, '#success-panel');
  expect(await page.locator('#google-auth').isVisible()).toBe(true);
  expect(await page.locator('#google-auth').isEnabled()).toBe(true);
  // A rejected request keeps everything typed so the retry needs no re-entry.
  expect(await page.locator('#name').inputValue()).toBe('Synthetic User');
  expect(await page.locator('#email').inputValue()).toBe('person@example.test');
  expect(await page.locator('#password').inputValue()).toBe(password);
  expect(await page.getByRole('button', { name: 'Create account' }).isEnabled()).toBe(true);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect.poll(() => page.locator('#success-panel').evaluate(node => node === document.activeElement)).toBe(true);
  for (const selector of ['#google-auth', '.divider', '#auth-form']) await hidden(page, selector);
  await page.locator('#email').evaluate(input => input.focus());
  expect(await page.locator('#success-panel').evaluate(node => node === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.getByRole('link', { name: 'Back to sign in' }).evaluate(node => node === document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await hidden(page, '#success-panel');
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/accept-invitation/inv-146');
  for (const selector of ['#google-auth', '.divider', '#auth-form']) expect(await page.locator(selector).isVisible()).toBe(true);
  expect(await page.locator('#google-auth').isEnabled()).toBe(true);
  expect(writes).toBe(2);
});

it('reset success focuses its confirmation while failure retains the form', async () => {
  const page = await open('/reset-password?token=synthetic');
  await hidden(page, '#success-panel');
  let writes = 0;
  await page.route('**/api/auth/reset-password', route => route.fulfill({ status: ++writes === 1 ? 400 : 200, json: { message: 'Invalid reset link' } }));
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect.poll(() => page.getByRole('alert').textContent()).toBe('Invalid reset link');
  await hidden(page, '#success-panel');
  expect(await page.locator('#password').inputValue()).toBe(password);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect.poll(() => page.locator('#success-panel').evaluate(node => node === document.activeElement)).toBe(true);
  await hidden(page, '#auth-form');
  await page.keyboard.press('Tab');
  expect(await page.getByRole('link', { name: 'Sign in', exact: true }).evaluate(node => node === document.activeElement)).toBe(true);
});

it.each(['credential', 'google'])('security hides inactive password controls before loading and after %s recovery', async providerId => {
  const page = await open('/sign-in');
  await page.route('**/api/auth/list-accounts', route => route.fulfill({ status: 503, json: {} }));
  await page.goto(harness.origin + '/account/security');
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  await hidden(page, '#initial-password-section');
  await hidden(page, '#change-password-section');
  await page.route('**/api/auth/list-accounts', route => route.fulfill({ json: [{ providerId }] }));
  await page.getByRole('button', { name: 'Try again' }).click();
  const shown = providerId === 'credential' ? '#change-password-section' : '#initial-password-section';
  await page.locator(shown).waitFor();
  await hidden(page, providerId === 'credential' ? '#initial-password-section' : '#change-password-section');
});

it.each([
  '?error=INVALID_TOKEN',
  '?verified=1&error=token_expired',
  '?verified=1&error=a_code_we_have_never_seen',
])('an invalid verification link (%s) focuses its heading, announces the problem and keeps the resend form working', async query => {
  const page = await open(`/verify-email${query}&returnTo=%2Faccept-invitation%2Finv-205`, 375);
  const heading = page.getByRole('heading', { name: 'Verification link unavailable' });
  expect(await heading.evaluate(node => node === document.activeElement)).toBe(true);
  expect(await page.getByRole('alert').textContent()).toContain('This verification link is invalid or has expired.');
  expect(await page.getByRole('heading', { name: 'Email verified' }).count()).toBe(0);
  expect(await page.getByRole('link', { name: 'Continue to sign in' }).count()).toBe(0);
  let body = '';
  await page.route('**/api/auth/send-verification-email', route => { body = route.request().postData() ?? ''; return route.fulfill({ json: {} }); });
  await page.getByRole('button', { name: 'Resend verification email' }).click();
  expect(await page.getByLabel('Work email').evaluate(node => node === document.activeElement)).toBe(true);
  await page.getByLabel('Work email').fill('person@example.test');
  await page.getByRole('button', { name: 'Resend verification email' }).click();
  await expect.poll(() => page.getByRole('status').textContent()).toBe('If the address is eligible, a new verification email is on its way.');
  expect(JSON.parse(body).callbackURL).toBe(`${harness.origin}/verify-email?verified=1&returnTo=%2Faccept-invitation%2Finv-205`);
  expect(await page.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe('/sign-in?returnTo=%2Faccept-invitation%2Finv-205');
});

it('a plain verification page leaves focus alone and a clean link still confirms', async () => {
  const plain = await open('/verify-email');
  expect(await plain.getByRole('alert').count()).toBe(0);
  expect(await plain.evaluate(() => document.activeElement === document.body)).toBe(true);
  const verified = await open('/verify-email?verified=1');
  expect(await verified.getByRole('heading', { name: 'Email verified' }).isVisible()).toBe(true);
  expect(await verified.getByRole('alert').count()).toBe(0);
});

