import { getRequestListener } from '@hono/node-server';
import type { User } from 'better-auth/types';
import { Hono } from 'hono';
import type { Page } from 'playwright';
import { beforeAll, expect, it } from 'vitest';
import authPages from '@/routes/auth-pages';
import { securityHeaders } from '@/middleware/security-headers';
import { createBrowserHarness } from './helpers/browser';
import { serveFonts } from './helpers/fonts';

// The production authentication pages and inline controller in real Chromium,
// with the Better Auth endpoints stubbed per test.
const harness = createBrowserHarness();
const password = 'Synthetic password 197!';
beforeAll(async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use('*', securityHeaders);
  app.get('/fonts/*', serveFonts);
  app.get('/oauth-stub', c => c.html('<h1>Google consent stub</h1>'));
  app.use('/account/*', async (c, next) => {
    c.set('user', { id: 'user-a', email: 'person@example.test' } as User);
    await next();
  });
  app.route('/', authPages);
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});

async function open(path: string, options: Parameters<typeof harness.newPage>[0] = {}) {
  const page = await harness.newPage({ viewport: { width: 1440, height: 900 }, ...options });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(harness.origin + path);
  return Object.assign(page, { errors });
}

const returnLinks = (page: Page) => page.evaluate(() => [...document.querySelectorAll('a[data-return-link]')].map(link => link.getAttribute('href')));
it('keeps a safe return destination through every related authentication link', async () => {
  const destination = '/r/acme/handbook';
  const query = `?returnTo=${encodeURIComponent(destination)}`;
  const base = `/sign-in${query}`;
  // Every page that links onwards carries the destination on all of its related links.
  const pages: [string, string[]][] = [
    ['/sign-in', ['/forgot-password', '/sign-up']], ['/sign-up', ['/sign-in', '/sign-in']],
    ['/forgot-password', ['/sign-in']], ['/verify-email', ['/sign-in']],
    ['/verify-email?verified=1', ['/sign-in']], ['/reset-password', ['/forgot-password']],
    ['/reset-password?token=synthetic', ['/sign-in']],
  ];
  for (const [path, targets] of pages) {
    const page = await open(`${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(destination)}`);
    expect(await returnLinks(page), path).toEqual(targets.map(target => `${target}${query}`));
  }
  // Following the links keeps the destination across the whole round trip.
  const page = await open(base);
  const urlParts = () => ({ path: new URL(page.url()).pathname, returnTo: new URL(page.url()).searchParams.get('returnTo') });
  for (const [link, path] of [['Forgot password?', '/forgot-password'], ['Back to sign in', '/sign-in'], ['Create an account', '/sign-up'], ['Sign in', '/sign-in']] as const) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await page.waitForURL(url => url.pathname === path);
    expect(urlParts()).toEqual({ path, returnTo: destination });
  }
  // A path with its own query round-trips unchanged.
  const nested = '/r/acme/handbook?doc=docs%2Fguide.md&x=1';
  const deep = await open(`/sign-in?returnTo=${encodeURIComponent(nested)}`);
  await deep.getByRole('link', { name: 'Create an account' }).click();
  await deep.waitForURL('**/sign-up?**');
  expect(new URL(deep.url()).searchParams.get('returnTo')).toBe(nested);
});

it('drops an unsafe return target from every related link', async () => {
  for (const unsafe of ['https://outside.invalid/r/acme/x', '//outside.invalid/r/acme/x', '/\\outside.invalid', '/r/acme/x\u0001']) {
    for (const path of ['/sign-in', '/sign-up', '/forgot-password', '/verify-email']) {
      const page = await open(`${path}?returnTo=${encodeURIComponent(unsafe)}`);
      const hrefs = await returnLinks(page);
      expect(hrefs.length, `${path} ${unsafe}`).toBeGreaterThan(0);
      for (const href of hrefs) expect(href, `${path} ${unsafe}`).not.toContain('returnTo');
    }
  }
});

it('explains each Google callback failure with fixed recovery copy and keeps every control usable', async () => {
  const expectations: [string, RegExp][] = [
    ['access_denied', /Google sign-in was canceled\. Try again or sign in with your email and password\./],
    ['state_mismatch', /attempt expired or could not be verified/],
    ['state_security_mismatch', /attempt expired or could not be verified/],
    ['state_not_found', /attempt expired or could not be verified/],
    ['invalid_state', /attempt expired or could not be verified/],
    ['unable_to_link_account', /couldn't connect this Google account/],
    ['account_not_linked', /couldn't connect this Google account/],
    ['account_already_linked_to_different_user', /couldn't connect this Google account/],
    ["email_doesn't_match", /couldn't connect this Google account/],
    ['email_not_verified', /verify your email/],
    ['ACCESS_DENIED', /was canceled/],
    ['server_error', /couldn't complete sign-in\. Please try again or use your email and password/],
    ['<img src=x onerror=alert(1)>', /couldn't complete sign-in/],
  ];
  for (const [code, message] of expectations) {
    const page = await open(`/sign-in?error=${encodeURIComponent(code)}`);
    const alert = page.getByRole('alert');
    expect(await alert.textContent(), code).toMatch(message);
    // The upstream code is never echoed or interpreted as markup.
    expect(await alert.textContent(), code).not.toContain(code.startsWith('<') ? 'onerror' : '\u0000');
    expect(await page.locator('#form-error img').count()).toBe(0);
    expect(await page.locator('#google-auth').isEnabled()).toBe(true);
    expect(await page.locator('#auth-form button[type=submit]').isEnabled()).toBe(true);
    expect(page.errors).toEqual([]);
  }
});

it('starts Google sign-in only for a callback inside this origin, whatever return target is requested', async () => {
  const cases: [string, string][] = [
    ['/r/acme/handbook', '/r/acme/handbook'],
    ['https://outside.invalid/phish', '/'], ['//outside.invalid/phish', '/'], ['/\\outside.invalid', '/'],
  ];
  for (const page of ['/sign-in', '/sign-up']) {
    for (const [requested, expected] of cases) {
      const tab = await open(`${page}?returnTo=${encodeURIComponent(requested)}`);
      let callbackURL: unknown;
      await tab.route('**/api/auth/sign-in/social', route => {
        callbackURL = (route.request().postDataJSON() as { callbackURL: string }).callbackURL;
        return route.fulfill({ json: { url: `${harness.origin}/oauth-stub` } });
      });
      await tab.locator('#google-auth').click();
      await tab.waitForURL('**/oauth-stub');
      expect(callbackURL, `${page} ${requested}`).toBe(`${harness.origin}${expected}`);
    }
  }
});

it('reveals, scrolls to and focuses the initial-password form, jumping instead of animating under reduced motion', async () => {
  for (const reducedMotion of ['reduce', 'no-preference'] as const) {
    const page = await harness.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion });
    await page.addInitScript(() => {
      const scrolls: { id: string; options: unknown }[] = [];
      Object.assign(window, { scrolls });
      const prototype = Element.prototype as { scrollIntoView(this: Element, options?: ScrollIntoViewOptions | boolean): void };
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with the element receiver below
      const original = prototype.scrollIntoView;
      prototype.scrollIntoView = function (this: Element, options) { scrolls.push({ id: this.id, options }); original.call(this, options); };
    });
    await page.route('**/api/auth/list-accounts', route => route.fulfill({ json: [{ providerId: 'google' }] }));
    await page.goto(`${harness.origin}/account/security`);
    const section = page.locator('#initial-password-section');
    await page.getByRole('button', { name: 'Add below' }).waitFor();
    // The action must reveal the form itself, not rely on it being shown already.
    await section.evaluate(element => { (element as HTMLElement).hidden = true; });
    expect(await section.isVisible()).toBe(false);
    await page.getByRole('button', { name: 'Add below' }).click();
    await section.waitFor();
    expect(await page.locator('#password').evaluate(input => document.activeElement === input)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { scrolls: unknown[] }).scrolls)).toEqual([
      { id: 'initial-password-section', options: { behavior: reducedMotion === 'reduce' ? 'auto' : 'smooth', block: 'nearest' } },
    ]);
  }
});

it('excludes duplicate reset submissions while pending, then recovers from a rejection and completes on retry', async () => {
  const page = await open('/reset-password?token=synthetic&returnTo=%2Faccount%2Fsecurity');
  let release!: (status: number) => void;
  let requests = 0;
  await page.route('**/api/auth/reset-password', async route => {
    requests++;
    const status = requests === 1 ? await new Promise<number>(resolve => { release = resolve; }) : 200;
    await route.fulfill({ status, json: status === 200 ? {} : { message: 'Invalid or expired token' } });
  });
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  const submit = page.getByRole('button', { name: 'Update password' });
  await submit.click();
  await expect.poll(() => requests).toBe(1);
  expect(await submit.isDisabled()).toBe(true);
  expect(await submit.getAttribute('aria-busy')).toBe('true');
  await page.locator('#auth-form').dispatchEvent('submit');
  await page.locator('#confirmPassword').press('Enter');
  release(400);
  await expect.poll(() => page.getByRole('alert').textContent()).toBe('Invalid or expired token');
  await expect.poll(() => submit.isEnabled()).toBe(true);
  expect(await submit.getAttribute('aria-busy')).toBe('false');
  expect(requests).toBe(1);
  expect(await page.locator('#password').inputValue()).toBe(password);
  await submit.click();
  await page.locator('#success-panel').waitFor();
  expect(requests).toBe(2);
  expect(await page.getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href')).toBe('/sign-in?returnTo=%2Faccount%2Fsecurity');
});
