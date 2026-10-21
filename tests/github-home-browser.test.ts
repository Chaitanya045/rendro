import { getRequestListener } from '@hono/node-server';
import type { User } from 'better-auth/types';
import { Hono } from 'hono';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import authPages from '@/routes/auth-pages';
import { securityHeaders } from '@/middleware/security-headers';
import { createBrowserHarness } from './helpers/browser';
import { serveFonts } from './helpers/fonts';

// The home's repository list (#338) in real Chromium: the production page and controller, with the control
// Worker's answer chosen per test.
const harness = createBrowserHarness();
const reader = { id: 'u-reader', name: 'Ada Reader', email: 'ada@example.test' } as User;
let answer: unknown = { linked: false };
beforeAll(async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use('*', securityHeaders);
  app.get('/fonts/*', serveFonts);
  app.use('*', async (c, next) => { c.set('user', reader); await next(); });
  app.get('/r/*', c => c.html('<!doctype html><title>Docs</title><h1>Repository docs</h1>'));
  const binding = { fetch: () => Promise.resolve(answer === 503 ? new Response(null, { status: 503 }) : Response.json(answer)) };
  app.route('/', authPages);
  const listener = getRequestListener(request => app.fetch(request, { REPO_ACCESS: binding }));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});
afterEach(() => { vi.unstubAllEnvs(); });

async function open(state: unknown, width = 1440) {
  vi.stubEnv('GITHUB_APP_CLIENT_ID', 'Iv1.fixture');
  vi.stubEnv('GITHUB_APP_SLUG', 'rendro-docs');
  answer = state;
  const page = await harness.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>GitHub</title><h1>GitHub</h1>' }));
  await page.goto(`${harness.origin}/home`);
  return Object.assign(page, { errors });
}

const listed = { linked: true, truncated: false, repositories: [
  { owner: 'octo', name: 'handbook', private: true, pushedAt: Date.parse('2026-10-01T09:30:00Z') },
  { owner: 'octo', name: 'notes', private: false, pushedAt: null },
] };

it('lists the repositories as links, reachable by keyboard with a visible focus ring, each opening its docs', async () => {
  const page = await open(listed);
  const links = page.getByRole('list').getByRole('link');
  expect(await links.evaluateAll(nodes => nodes.map(node => [node.textContent, node.getAttribute('href')]))).toEqual([
    ['octo/handbookPrivateUpdated Oct 1, 2026', '/r/octo/handbook'], ['octo/notes', '/r/octo/notes'],
  ]);
  await page.getByRole('heading', { name: 'Your repositories', exact: true }).click();
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe('Install the app on more repositories');
  await page.keyboard.press('Tab');
  const first = links.first();
  expect(await first.evaluate(node => node === document.activeElement)).toBe(true);
  expect(await first.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  await page.waitForURL(`${harness.origin}/r/octo/handbook`);
  expect(page.errors).toEqual([]);
});

it('stacks a row on a phone without overflowing the card', async () => {
  const page = await open(listed, 375);
  const row = page.locator('.repo-link').first();
  expect(await row.evaluate(node => getComputedStyle(node).flexDirection)).toBe('column');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

it('connects GitHub from the home and returns there', async () => {
  const page = await open({ linked: false });
  let body: unknown;
  await page.route('**/api/auth/link-social', route => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { url: 'https://github.com/login/oauth/authorize?state=s', redirect: true } });
  });
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await page.waitForURL('https://github.com/**');
  expect(body).toEqual({ provider: 'github', callbackURL: `${harness.origin}/home` });
});

it('explains a failure to connect GitHub with fixed copy and lets the reader try again', async () => {
  const page = await open({ linked: false });
  await page.route('**/api/auth/link-social', route => route.fulfill({ status: 400, json: { message: 'internal detail' } }));
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect.poll(() => page.locator('#github-error').textContent()).toBe("GitHub can't be connected right now. Please try again.");
  expect(await page.getByRole('button', { name: 'Connect GitHub', exact: true }).isEnabled()).toBe(true);
});

it('offers the install link on an empty list, and a retry that loads the list once the mirror answers', async () => {
  const empty = await open({ linked: true, truncated: false, repositories: [] });
  expect(await empty.getByRole('link', { name: 'Install the app', exact: true }).getAttribute('href')).toBe('https://github.com/apps/rendro-docs/installations/new');
  const failed = await open(503);
  expect(await failed.getByRole('alert').textContent()).toBe("We couldn't load your repositories right now. Please try again.Try again");
  answer = listed;
  await failed.getByRole('link', { name: 'Try again' }).click();
  await expect.poll(() => failed.locator('.repo-link').count()).toBe(2);
});
