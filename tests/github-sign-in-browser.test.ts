import { getRequestListener } from '@hono/node-server';
import type { User } from 'better-auth/types';
import { Hono } from 'hono';
import type { Page, Route } from 'playwright';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import authPages from '@/routes/auth-pages';
import { renderLandingPage } from '@/routes/landing';
import { securityHeaders } from '@/middleware/security-headers';
import { createBrowserHarness } from './helpers/browser';
import { serveFonts } from './helpers/fonts';

// GitHub sign-in on the production sign-in and sign-up pages (#338), in real Chromium.
// Better Auth's endpoint is stubbed per test, and GitHub's authorize page is a fixture.
const harness = createBrowserHarness();
const authorize = 'https://github.com/login/oauth/authorize?client_id=fixture&state=s';
beforeAll(async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use('*', securityHeaders);
  app.get('/fonts/*', serveFonts);
  app.route('/', authPages);
  app.get('/', c => c.html(renderLandingPage({ github: true })));
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});
afterEach(() => { vi.unstubAllEnvs(); });

async function open(path: string, email: 'on' | 'off' = 'on') {
  vi.stubEnv('GITHUB_APP_CLIENT_ID', 'Iv1.fixture');
  vi.stubEnv('AUTH_EMAIL_SIGN_IN', email);
  const page = await harness.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>GitHub</title><h1>Authorize Rendro</h1>' }));
  await page.goto(harness.origin + path);
  return Object.assign(page, { errors });
}

const button = (page: Page, name = 'Sign in with GitHub') => page.getByRole('button', { name, exact: true });

it('starts GitHub sign-in with the return destination, shows it is busy, then follows GitHub\'s authorize URL', async () => {
  const page = await open('/sign-in?returnTo=%2Fr%2Facme%2Fhandbook');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let body: unknown;
  await page.route('**/api/auth/sign-in/social', async route => {
    body = route.request().postDataJSON();
    await held;
    await route.fulfill({ json: { url: authorize, redirect: true } });
  });
  await button(page).click();
  await expect.poll(() => button(page).getAttribute('aria-busy')).toBe('true');
  expect(await button(page).isDisabled()).toBe(true);
  // A second click while it is in flight sends nothing more.
  await page.locator('#github-form').evaluate(form => (form as HTMLFormElement).requestSubmit());
  release();
  await page.waitForURL('https://github.com/login/oauth/authorize**');
  expect(body).toEqual({ provider: 'github', callbackURL: `${harness.origin}/r/acme/handbook` });
  expect(page.errors).toEqual([]);
});

it('keeps GitHub sign-in inside this origin whatever return target is requested', async () => {
  for (const unsafe of ['https://outside.invalid/phish', '//outside.invalid/phish', '/\\outside.invalid']) {
    const page = await open(`/sign-in?returnTo=${encodeURIComponent(unsafe)}`);
    let callbackURL: unknown;
    await page.route('**/api/auth/sign-in/social', route => {
      callbackURL = (route.request().postDataJSON() as { callbackURL: string }).callbackURL;
      return route.fulfill({ json: { url: authorize } });
    });
    await button(page).click();
    await page.waitForURL('https://github.com/**');
    expect(callbackURL, unsafe).toBe(`${harness.origin}/`);
  }
});

it('explains a failure to start with fixed copy, never the upstream text, and lets the reader try again', async () => {
  for (const reply of [{ status: 500, json: { message: '<b>internal detail</b>' } }, { status: 200, json: { redirect: true } }, { status: 200, body: 'not json' }]) {
    const page = await open('/sign-in');
    let answer: Parameters<Route['fulfill']>[0] = reply;
    await page.route('**/api/auth/sign-in/social', route => route.fulfill(answer));
    await button(page).click();
    const alert = page.locator('#github-error');
    await expect.poll(() => alert.textContent()).toBe('GitHub sign-in is unavailable right now. Please try again.');
    expect(await button(page).isEnabled()).toBe(true);
    expect(await button(page).getAttribute('aria-busy')).toBe('false');
    expect(await page.locator('#github-error b').count()).toBe(0);
    // Trying again works.
    answer = { json: { url: authorize } };
    await button(page).click();
    await page.waitForURL('https://github.com/**');
    expect(page.errors).toEqual([]);
  }
});

it('re-enables the button when the browser restores the page from its back-forward cache', async () => {
  const page = await open('/sign-in');
  await page.route('**/api/auth/sign-in/social', () => { /* never answers: the page is about to leave */ });
  await button(page).click();
  await expect.poll(() => button(page).isDisabled()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })));
  expect(await button(page).isDisabled()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(await button(page).isEnabled()).toBe(true);
});

it('offers GitHub alone when email sign-in is off, with its error beside it and the button first in tab order', async () => {
  const page = await open('/sign-in?error=access_denied', 'off');
  expect(await page.locator('#auth-form').count()).toBe(0);
  expect(await page.getByRole('link', { name: 'Create an account' }).count()).toBe(0);
  expect(await page.getByRole('alert').textContent()).toBe('Sign-in was canceled. Try again when you are ready.');
  expect(await button(page).getAttribute('class')).toContain('primary');
  await page.locator('h1').click();
  await page.keyboard.press('Tab');
  expect(await button(page).evaluate(node => node === document.activeElement)).toBe(true);
});

it('shows a GitHub failure beside the GitHub button while the email form stays usable', async () => {
  const page = await open('/sign-in?error=email_not_found');
  expect(await page.locator('#github-error').textContent()).toBe('Your GitHub account has no verified email address. Verify one on GitHub, then try again.');
  expect(await page.locator('#form-error').textContent()).toBe('');
  expect(await page.locator('#auth-form button[type=submit]').isEnabled()).toBe(true);
  expect(await button(page).getAttribute('class')).toContain('secondary');
});

it('signs up with GitHub from the sign-up page', async () => {
  const page = await open('/sign-up?returnTo=%2Fhome');
  let body: unknown;
  await page.route('**/api/auth/sign-in/social', route => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { url: authorize } });
  });
  await button(page, 'Sign up with GitHub').click();
  await page.waitForURL('https://github.com/**');
  expect(body).toEqual({ provider: 'github', callbackURL: `${harness.origin}/home` });
});

it('turns every landing call to action into Sign in with GitHub, which opens the sign-in page with the GitHub button', async () => {
  const page = await open('/');
  const actions = await page.locator('a.header-get-started, a[data-action-id$="-start"]').evaluateAll(links => links.map(link => ({ label: link.textContent, href: link.getAttribute('href') })));
  expect(actions).toEqual(Array.from({ length: 4 }, () => ({ label: 'Sign in with GitHub', href: '/sign-in' })));
  expect(await page.locator('a.header-signin').count()).toBe(0);
  expect(await page.getByText('GitHub sign-in is coming soon').count()).toBe(0);
  await page.locator('a[data-action-id="hero-start"]').click();
  await page.waitForURL(`${harness.origin}/sign-in`);
  expect(await button(page).isVisible()).toBe(true);
  expect(page.errors).toEqual([]);
});
