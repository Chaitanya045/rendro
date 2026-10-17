import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import type { User } from 'better-auth/types';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { sessionCache, sessionMiddleware } from '@/middleware/session';
import { securityHeaders } from '@/middleware/security-headers';
import { createBrowserHarness } from './helpers/browser';
import { serveFonts } from './helpers/fonts';

// The production session middleware and outage page in Chromium, with only the
// upstream session endpoint stubbed.
const harness = createBrowserHarness();
const member = { id: 'member', email: 'member@example.test', name: 'Member', emailVerified: true, image: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
let upstream: 'outage' | 'member' | 'signed-out' = 'member';
let lookups = 0;
afterEach(() => { vi.unstubAllGlobals(); sessionCache.clear(); upstream = 'member'; lookups = 0; });

beforeAll(async () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use('*', securityHeaders);
  app.get('/fonts/*', serveFonts);
  app.get('/sign-in', c => c.html('<h1>Sign in</h1>'));
  app.use('/organizations/*', sessionMiddleware);
  app.get('/organizations/home', c => c.get('user') ? c.html(`<h1>Welcome ${c.get('user')!.name}</h1>`) : c.redirect('/sign-in'));
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});

it('keeps an upstream session outage distinct from signed out, preserves the cookie and recovers on Try again', async () => {
  vi.stubGlobal('fetch', vi.fn(() => {
    lookups++;
    if (upstream === 'outage') return Promise.resolve(new Response('private upstream diagnostic', { status: 503 }));
    return Promise.resolve(Response.json(upstream === 'member' ? { user: member, session: { expiresAt: Date.now() + 60_000 } } : null));
  }));
  const page = await harness.newPage();
  await page.context().addCookies([{ name: 'better-auth.session_token', value: 'opaque-cookie', url: harness.origin }]);
  upstream = 'outage';
  const response = await page.goto(`${harness.origin}/organizations/home`);
  expect(response!.status()).toBe(503);
  expect(response!.headers()['retry-after']).toBe('1');
  await page.getByRole('heading', { name: "We couldn't check your session" }).waitFor();
  expect(await page.getByText("You don't need to sign in again because of this error.").isVisible()).toBe(true);
  expect(await page.locator('body').textContent()).not.toContain('private upstream diagnostic');
  // An outage must neither redirect to sign-in nor clear the credential.
  expect(new URL(page.url()).pathname).toBe('/organizations/home');
  expect((await page.context().cookies()).map(cookie => cookie.name)).toEqual(['better-auth.session_token']);
  // The page works as a sign-in-free retry once the upstream recovers.
  upstream = 'member';
  await Promise.all([page.waitForResponse(response => response.status() === 200 && new URL(response.url()).pathname === '/organizations/home'),
    page.getByRole('link', { name: 'Try again' }).click()]);
  await page.getByRole('heading', { name: 'Welcome Member' }).waitFor();
  expect(new URL(page.url()).pathname).toBe('/organizations/home');
  // An authoritative missing session is a real sign-out: it redirects instead.
  sessionCache.clear();
  upstream = 'signed-out';
  await page.goto(`${harness.origin}/organizations/home`);
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  expect(new URL(page.url()).pathname).toBe('/sign-in');
  expect(lookups).toBeGreaterThanOrEqual(3);
});
