import { getRequestListener } from '@hono/node-server';
import type { User } from 'better-auth/types';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { securityHeaders } from '@/middleware/security-headers';
import organizationPages from '@/routes/organization-pages';
import { managementAccessFixture } from './fixtures/management-access';
import { browserStep, bundleBrowserAsset } from './helpers/browser';

const user = { id: 'user-a', name: 'Owner', email: 'owner@example.test' } as User;
const organization = { id: 'org-a', name: 'Acme', slug: 'acme', members: [{ id: 'member-a', userId: user.id, role: 'owner', user }], teams: [] };
const invitation = { id: 'invitation-a', email: user.email, organizationName: 'Acme', role: 'member', status: 'pending', expiresAt: '2099-01-01T00:00:00Z' };
const base = '/organizations/org-a';
const forms = [
  { name: 'first organization', path: '/organizations', form: 'organization', endpoint: '/api/auth/organization/create', result: { id: 'org-a' }, destination: `${base}/onboarding`, message: 'Created. Continue to project setup.' },
  { name: 'another organization', path: '/organizations?choose=1', form: 'organization', endpoint: '/api/auth/organization/create', result: { id: 'org-a' }, destination: base, message: 'Created. Continue to your organization.' },
  { name: 'first project', path: `${base}/onboarding`, form: 'project', endpoint: '/api/rendro/projects', result: { project: { _id: 'project-a' } }, destination: `${base}/onboarding?projectId=project-a`, message: 'Created. Continue to deployment setup.' },
  { name: 'accept invitation', path: '/accept-invitation/invitation-a', action: 'accept', endpoint: '/api/auth/organization/accept-invitation', result: { member: { organizationId: 'org-a' } }, destination: base, message: 'Invitation accepted. Continue to your organization.' },
  { name: 'decline invitation', path: '/accept-invitation/invitation-a', action: 'reject', endpoint: '/api/auth/organization/reject-invitation', result: {}, destination: '/organizations', message: 'Invitation declined. Continue to your organizations.' },
];
let browser: Browser;
let context: BrowserContext | undefined;
let server: Server;
let origin: string;
let current: typeof forms[number];
let mutationCount = 0;
let destinationCount = 0;
let destinationStatus = 200;
let release: (() => void) | undefined;
let held: Promise<void> | undefined;

beforeAll(async () => {
  const access = managementAccessFixture(organization, user);
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => Promise.resolve(access(input) ?? Response.json(invitation))));
  const assets = new Map([
    ['/management-query.js', await bundleBrowserAsset('src/management-query/browser.ts')],
    ['/select.js', await bundleBrowserAsset('src/ui/select-browser.ts')],
  ]);
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use('*', securityHeaders);
  app.use('*', async (c, next) => {
    c.set('user', user);
    const url = new URL(c.req.url);
    if (c.req.method === 'POST') {
      mutationCount++;
      expect(url.pathname).toBe(current.endpoint);
      return c.json(current.result);
    }
    if (mutationCount && url.pathname + url.search === current.destination) {
      destinationCount++;
      await held;
      return c.html('<h1>Destination response</h1>', destinationStatus as 200 | 500);
    }
    const asset = assets.get(url.pathname);
    if (asset) return c.body(asset, 200, { 'Content-Type': 'application/javascript' });
    await next();
  });
  app.get('/api/auth/organization/list', c => c.json(current.name === 'first organization' ? [] : [organization]));
  app.get('/api/rendro/management/access', c => access(c.req.raw)!);
  app.get('/api/auth/organization/get-full-organization', c => c.json(organization));
  app.get('/api/auth/organization/get-invitation', c => c.json(invitation));
  app.route('/', organizationPages);
  const listener = getRequestListener(request => app.fetch(request));
  server = createServer((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  // Playwright disables bfcache by default; request interception also prevents
  // restoration. Use real loopback responses and explicitly enable it here.
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ?? (!process.env.CI && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
});
afterEach(async () => {
  release?.();
  release = undefined;
  held = undefined;
  await context?.close();
  context = undefined;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await browser?.close();
  server?.closeAllConnections();
  await new Promise<void>(resolve => server?.close(() => resolve()));
});

it.each(forms.flatMap(form => ['stop', '500'].map(failure => ({ ...form, failure }))))('$name retains a completed recovery link after $failure without another POST', async spec => {
  current = spec;
  mutationCount = 0;
  destinationCount = 0;
  destinationStatus = spec.failure === '500' ? 500 : 200;
  held = new Promise<void>(resolve => { release = resolve; });
  context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  await browserStep('open form', () => page.goto(origin + spec.path));
  if (spec.name === 'another organization') await page.locator('#show-create').click();
  if (spec.form) await page.locator(`#${spec.form}-form [name=name]`).fill('Created docs');
  await page.evaluate(() => {
    document.body.dataset.originalDocument = 'true';
    window.addEventListener('pageshow', event => { document.body.dataset.restored = String(event.persisted); });
    window.addEventListener('beforeunload', () => {
      const link = Array.from(document.querySelectorAll('a')).find(link => link.textContent === 'Continue');
      document.body.dataset.recoveryBeforeNavigation = String(Boolean(link && link.getBoundingClientRect().height > 0));
      const controls = Array.from(document.querySelectorAll<HTMLButtonElement>('.invitation-actions button, #organization-form button[type=submit], #project-form button[type=submit]'));
      document.body.dataset.completedBeforeNavigation = String(controls.length > 0 && controls.every(button => button.disabled && button.getAttribute('aria-busy') !== 'true'));
    });
  });
  const button = page.locator(spec.form ? `#${spec.form}-form button[type=submit]` : `#${spec.action}`);
  await button.click({ noWaitAfter: true });
  await expect.poll(() => destinationCount).toBe(1);
  // The affordance exists before either a stopped load or an error response.
  const link = page.getByRole('link', { name: 'Continue', exact: true });
  if (spec.failure === 'stop') {
    // Locator/evaluate calls can wait for the pending navigation. Browser Stop
    // operates on the current document directly, so use its DevTools equivalent.
    const session = await context.newCDPSession(page);
    await browserStep('stop pending destination', () => session.send('Page.stopLoading'));
    await session.detach();
    release!();
  } else {
    const response = page.waitForResponse(response => response.url() === origin + spec.destination);
    release!();
    expect((await response).status()).toBe(500);
    await page.getByRole('heading', { name: 'Destination response' }).waitFor();
    await page.goBack({ waitUntil: 'commit' });
    // Assert genuine bfcache restoration rather than silently accepting a new form.
    expect(await page.locator('body').getAttribute('data-restored')).toBe('true');
  }
  expect(await page.locator('body').getAttribute('data-original-document')).toBe('true');
  expect(await page.locator('body').getAttribute('data-recovery-before-navigation')).toBe('true');
  expect(await page.locator('body').getAttribute('data-completed-before-navigation')).toBe('true');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(await link.isVisible()).toBe(true);
  expect(await link.getAttribute('href')).toBe(spec.destination);
  expect(await page.getByRole('status').filter({ hasText: spec.message }).textContent()).toBe(spec.message);
  expect(await button.isDisabled()).toBe(true);
  expect(await button.getAttribute('aria-busy')).toBe('false');
  if (spec.form) await page.locator(`#${spec.form}-form`).evaluate(form => (form as HTMLFormElement).requestSubmit());
  else await page.locator('.invitation-actions button').evaluateAll(buttons => buttons.forEach(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true }))));
  await link.focus();
  expect(await link.evaluate(link => document.activeElement === link && (link as HTMLAnchorElement).tabIndex === 0)).toBe(true);
  destinationStatus = 200;
  await browserStep('Continue with the keyboard', () => link.press('Enter'));
  await page.getByRole('heading', { name: 'Destination response' }).waitFor();
  expect(page.url()).toBe(origin + spec.destination);
  expect(destinationCount).toBe(2);
  expect(mutationCount).toBe(1);
});
