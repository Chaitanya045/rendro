import { readFile } from 'node:fs/promises';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import type { Page } from 'playwright';
import { beforeAll, expect, it } from 'vitest';
import authPages from '@/routes/auth-pages';
import { renderLandingPage } from '@/routes/landing';
import { securityHeaders } from '@/middleware/security-headers';
import { createBrowserHarness, waitForSettled } from './helpers/browser';
import { serveFonts } from './helpers/fonts';

// The production landing renderer and inline controller, served with the
// production security headers. The OAuth start endpoint is stubbed per test so
// pending, rejected and malformed responses are deterministic.
const harness = createBrowserHarness();
const ctas = ['hero-start', 'security-start', 'final-start'] as const;
const sections = ['product', 'workflow', 'security'] as const;

beforeAll(async () => {
  const app = new Hono();
  app.use('*', securityHeaders);
  app.get('/fonts/*', serveFonts);
  app.get('/landing-product.webp', async c => c.body(new Uint8Array(await readFile('public/landing-product.webp')), 200, { 'Content-Type': 'image/webp' }));
  app.get('/', c => c.html(renderLandingPage()));
  app.get('/oauth-stub', c => c.html('<h1>Google consent stub</h1>'));
  app.route('/', authPages);
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});

async function open(options: Parameters<typeof harness.newPage>[0] = {}, path = '/') {
  const page = await harness.newPage({ viewport: { width: 1440, height: 900 }, ...options });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(harness.origin + path);
  await page.waitForLoadState('load');
  return Object.assign(page, { errors });
}

/** Hold the OAuth start request until released, answering with the given status/body. */
async function holdOAuth(page: Page) {
  let release!: (response: { status: number; body: string } | 'abort') => void;
  const gate = new Promise<{ status: number; body: string } | 'abort'>(resolve => { release = resolve; });
  const requests: { method: string; contentType: string | null; body: unknown; navigation: boolean }[] = [];
  await page.route('**/api/auth/sign-in/social', async route => {
    const request = route.request();
    requests.push({ method: request.method(), contentType: await request.headerValue('content-type'),
      body: request.postDataJSON() as unknown, navigation: request.isNavigationRequest() });
    const outcome = await gate;
    if (outcome === 'abort') await route.abort('failed');
    else await route.fulfill({ status: outcome.status, contentType: 'application/json', body: outcome.body });
  });
  return { requests, release };
}

const state = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[data-auth]')].map(button => ({
  id: button.dataset.authId, disabled: button.disabled, busy: button.getAttribute('aria-busy'),
  label: button.querySelector('[data-auth-label]')!.textContent,
  error: document.getElementById(`${button.dataset.authId}-error`)!.textContent,
})));

/** Resolves once smooth scrolling lands on the section, or at the bottom when the page is too short to reach it. */
const scrollOffset = (page: Page, id: string) => page.evaluate(target => {
  const top = scrollY + document.getElementById(target)!.getBoundingClientRect().top;
  return scrollY - Math.min(top, document.documentElement.scrollHeight - innerHeight);
}, id);

it('loads the landing page and resolves the sign-in, get-started, logo and Google call-to-action links', async () => {
  const page = await open();
  expect(await page.title()).toContain('Documentation that ships with your code');
  expect(await page.getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href')).toBe('/sign-in');
  expect(await page.getByRole('link', { name: 'Get started', exact: true }).getAttribute('href')).toBe('/sign-up');
  expect(await page.getByRole('link', { name: 'Rendro home' }).getAttribute('href')).toBe('/');
  // Hero, security panel and final panel each own one Google call-to-action.
  expect(await state(page)).toEqual(ctas.map(id => ({ id, disabled: false, busy: null, label: 'Start with Google', error: '' })));
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/sign-in');
  expect(await page.getByRole('heading', { name: 'Sign in to Rendro' }).isVisible()).toBe(true);
  await page.goBack();
  await page.getByRole('link', { name: 'Get started', exact: true }).click();
  await page.waitForURL('**/sign-up');
  expect(await page.getByRole('heading', { name: 'Start shipping docs' }).isVisible()).toBe(true);
  await page.getByRole('link', { name: /^Rendro/ }).first().click();
  await page.waitForURL(`${harness.origin}/`);
  expect(await page.getByRole('heading', { name: 'Your docs should ship with your code.' }).isVisible()).toBe(true);
  expect(page.errors).toEqual([]);
});

it('scrolls the Product, Workflow and Security anchors below the sticky header without adding history or fragments', async () => {
  const page = await open();
  const entries = await page.evaluate(() => history.length);
  const links = [
    ...sections.map(id => page.locator(`.nav-links a[data-scroll-section="${id}"]`)),
    page.getByRole('link', { name: /Explore the workspace/ }),
  ];
  for (const link of links) {
    const id = (await link.getAttribute('data-scroll-section'))!;
    await link.click();
    await expect.poll(() => scrollOffset(page, id), { message: id }).toBeCloseTo(0, 0);
    const headerBottom = await page.locator('.site-header').evaluate(header => header.getBoundingClientRect().bottom);
    // The sticky header must not cover the section heading it navigated to.
    expect(await page.locator(`#${id} h2`).evaluate(heading => heading.getBoundingClientRect().top)).toBeGreaterThanOrEqual(headerBottom);
    expect(await page.evaluate(() => ({ hash: location.hash, length: history.length }))).toEqual({ hash: '', length: entries });
  }
  expect(page.errors).toEqual([]);
});

it('removes legacy section fragments on load without adding history and keeps the query', async () => {
  const baseline = await (await open({}, '/?campaign=docs')).evaluate(() => history.length);
  const fresh = await open({}, '/?campaign=docs#security');
  expect(await fresh.evaluate(() => ({ url: location.pathname + location.search + location.hash, scrollY, length: history.length })))
    .toEqual({ url: '/?campaign=docs', scrollY: 0, length: baseline });
  // An unrelated fragment is not a legacy section anchor and is left alone.
  const unrelated = await open({}, '/#not-a-section');
  expect(await unrelated.evaluate(() => location.hash)).toBe('#not-a-section');
  for (const id of sections) {
    const page = await open({}, `/#${id}`);
    expect(await page.evaluate(() => ({ hash: location.hash, scrollY }))).toEqual({ hash: '', scrollY: 0 });
  }
});

it('resolves the footer links without leaving the page and opens GitHub in a protected new tab', async () => {
  const page = await open();
  const footer = page.getByRole('navigation', { name: 'Footer navigation' });
  expect(await page.locator('.footer-brand').getAttribute('href')).toBe('/');
  const github = footer.getByRole('link', { name: 'GitHub' });
  expect(await github.getAttribute('href')).toBe('https://github.com/Chaitanya045/rendro');
  expect(await github.getAttribute('target')).toBe('_blank');
  expect(await github.getAttribute('rel')).toContain('noreferrer');
  for (const id of sections) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await footer.locator(`a[data-scroll-section="${id}"]`).click();
    await expect.poll(() => scrollOffset(page, id), { message: id }).toBeCloseTo(0, 0);
    expect(await page.evaluate(() => location.hash)).toBe('');
  }
  expect(page.errors).toEqual([]);
});

it.each([320, 375, 430, 1440])('keeps the product screenshot proportional, unfiltered and inside the viewport at %ipx', async width => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await open({ viewport: { width, height: 900 }, colorScheme });
    const image = page.getByRole('img', { name: /Rendro workspace with an organization file tree/ });
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth)).toBe(1280);
    const box = await image.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const figure = element.closest('figure')!.getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, figureWidth: figure.width,
        filter: style.filter, opacity: style.opacity, fit: style.objectFit,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(box.width).toBeCloseTo(box.figureWidth - 2, 0);
    expect(box.right).toBeLessThanOrEqual(width);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.width / box.height).toBeCloseTo(1280 / 577, 1);
    // The authored screenshot is shown unmodified in both appearances.
    expect(box).toMatchObject({ filter: 'none', opacity: '1', fit: 'cover', overflow: 0 });
  }
});

it('reveals below-the-fold content once as it enters view, including when focused first', async () => {
  const page = await open();
  expect(await page.evaluate(() => document.documentElement.classList.contains('motion-ready'))).toBe(true);
  const hidden = page.locator('#workflow .section-header');
  const opacity = () => hidden.evaluate(element => getComputedStyle(element).opacity);
  expect(await hidden.evaluate(element => element.classList.contains('is-visible'))).toBe(false);
  expect(await opacity()).toBe('0');
  // Staggered group items carry their capped delay until their transition ends.
  expect(await page.locator('.proof').nth(2).evaluate(element => element.style.getPropertyValue('--reveal-delay'))).toBe('90ms');
  await hidden.scrollIntoViewIfNeeded();
  await expect.poll(() => hidden.evaluate(element => element.classList.contains('is-visible'))).toBe(true);
  await expect.poll(opacity).toBe('1');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await waitForSettled(page);
  // Once revealed, content does not hide again when it leaves the viewport.
  expect(await hidden.evaluate(element => element.classList.contains('is-visible'))).toBe(true);
  expect(await opacity()).toBe('1');
  // Keyboard focus reveals content that has not been scrolled to yet.
  const panel = page.locator('.cta-panel');
  expect(await panel.evaluate(element => element.classList.contains('is-visible'))).toBe(false);
  await page.locator('[data-auth-id="final-start"]').evaluate(button => (button as HTMLElement).focus({ preventScroll: true }));
  await expect.poll(() => panel.evaluate(element => element.classList.contains('is-visible'))).toBe(true);
  expect(page.errors).toEqual([]);
});

it('marks exactly the section in view in the primary navigation', async () => {
  const page = await open();
  const current = () => page.evaluate(() => [...document.querySelectorAll('[data-section-link][aria-current]')].map(link => link.getAttribute('data-scroll-section')));
  expect(await current()).toEqual([]);
  for (const id of ['workflow', 'security', 'product'] as const) {
    await page.locator(`.nav-links a[data-scroll-section="${id}"]`).click();
    await expect.poll(current, { message: id }).toEqual([id]);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  expect(page.errors).toEqual([]);
});

it('keeps content, navigation and sign-in usable when IntersectionObserver is unavailable', async () => {
  const page = await harness.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().addInitScript(() => { Reflect.deleteProperty(window, 'IntersectionObserver'); });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(harness.origin + '/');
  expect(await page.evaluate(() => 'IntersectionObserver' in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.classList.contains('motion-ready'))).toBe(false);
  const opacities = await page.evaluate(() => [...document.querySelectorAll('[data-reveal], [data-reveal-item]')].map(element => getComputedStyle(element).opacity));
  expect(opacities.length).toBeGreaterThan(10);
  expect([...new Set(opacities)]).toEqual(['1']);
  expect(await page.evaluate(() => document.querySelectorAll('[aria-current]').length)).toBe(0);
  await page.locator('.nav-links a[data-scroll-section="security"]').click();
  await expect.poll(() => scrollOffset(page, 'security')).toBeCloseTo(0, 0);
  // The submit controller is registered after the observer branches.
  expect(await state(page)).toHaveLength(3);
  const held = await holdOAuth(page);
  await page.locator('[data-auth-id="security-start"]').click();
  await expect.poll(() => held.requests.length).toBe(1);
  held.release({ status: 503, body: '{}' });
  await expect.poll(async () => (await state(page)).every(item => !item.disabled)).toBe(true);
  expect(errors).toEqual([]);
});

it('shows all content without motion under reduced-motion, print and no-JavaScript rendering', async () => {
  const reduced = await open({ reducedMotion: 'reduce' });
  expect(await reduced.evaluate(() => document.documentElement.classList.contains('motion-ready'))).toBe(false);
  expect(await reduced.evaluate(() => [...new Set([...document.querySelectorAll('[data-reveal], [data-reveal-item]')].map(element => getComputedStyle(element).opacity))])).toEqual(['1']);
  expect(await reduced.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
  await reduced.locator('.nav-links a[data-scroll-section="workflow"]').click();
  // Reduced motion jumps directly instead of animating.
  expect(await scrollOffset(reduced, 'workflow')).toBeCloseTo(0, 0);
  expect(reduced.errors).toEqual([]);

  const motion = await open();
  const unrevealed = motion.locator('#security .security-copy');
  expect(await unrevealed.evaluate(element => getComputedStyle(element).opacity)).toBe('0');
  await motion.emulateMedia({ media: 'print' });
  // Print overrides the hidden state; the property may still be transitioning for a frame.
  await expect.poll(() => unrevealed.evaluate(element => ({ opacity: getComputedStyle(element).opacity, transform: getComputedStyle(element).transform })))
    .toEqual({ opacity: '1', transform: 'none' });

  const noScript = await open({ javaScriptEnabled: false });
  expect(await noScript.evaluate(() => document.documentElement.classList.contains('motion-ready'))).toBe(false);
  expect(await noScript.locator('#security .security-copy').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
  expect(await noScript.getByRole('heading', { name: 'Private by default. Scoped by organization.' }).isVisible()).toBe(true);
});

it('restores ready authentication buttons after Back and after a persisted page restore', async () => {
  const page = await open();
  const held = await holdOAuth(page);
  await page.locator('[data-auth-id="hero-start"]').click();
  await expect.poll(() => held.requests.length).toBe(1);
  expect((await state(page)).every(item => item.disabled)).toBe(true);
  // A restored page runs no load handlers, so pageshow is the only recovery path.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(await state(page)).toEqual(ctas.map(id => ({ id, disabled: false, busy: null, label: 'Start with Google', error: '' })));
  held.release({ status: 200, body: JSON.stringify({ url: `${harness.origin}/oauth-stub` }) });
  await page.waitForURL('**/oauth-stub');
  await page.goBack();
  await page.getByRole('heading', { name: 'Your docs should ship with your code.' }).waitFor();
  expect(await state(page)).toEqual(ctas.map(id => ({ id, disabled: false, busy: null, label: 'Start with Google', error: '' })));
});

it('starts Google sign-in with a JSON request only, from the originating call-to-action', async () => {
  const page = await open();
  for (const id of ctas) {
    const held = await holdOAuth(page);
    const url = page.url();
    await page.locator(`[data-auth-id="${id}"]`).click();
    await expect.poll(() => held.requests.length).toBe(1);
    expect(held.requests[0]).toEqual({ method: 'POST', contentType: 'application/json', body: { provider: 'google', callbackURL: url }, navigation: false });
    expect(page.url()).toBe(url);
    held.release({ status: 503, body: '{}' });
    await expect.poll(async () => (await state(page)).every(item => !item.disabled)).toBe(true);
    await page.unrouteAll({ behavior: 'wait' });
  }
});

it('guards every authentication action while a request is pending and gives feedback only on the originating call-to-action', async () => {
  const page = await open();
  for (const id of ctas) {
    const held = await holdOAuth(page);
    await page.locator(`[data-auth-id="${id}"]`).click();
    await expect.poll(() => held.requests.length).toBe(1);
    expect(await state(page)).toEqual(ctas.map(other => ({ id: other, disabled: true,
      busy: other === id ? 'true' : null, label: other === id ? 'Redirecting…' : 'Start with Google', error: '' })));
    // Neither another submission path nor a programmatic submit starts a second request.
    await page.evaluate(() => (document.getElementById('sign-in-form') as HTMLFormElement).requestSubmit());
    await page.locator(`[data-auth-id="${id}"]`).dispatchEvent('click');
    expect(held.requests).toHaveLength(1);
    held.release({ status: 503, body: '{}' });
    await expect.poll(async () => (await state(page)).find(item => item.id === id)!.error).toContain('Google sign-in could not start');
    expect(await state(page)).toEqual(ctas.map(other => ({ id: other, disabled: false, busy: null, label: 'Start with Google',
      error: other === id ? 'Google sign-in could not start. Try again, or sign in with email.' : '' })));
    await page.unrouteAll({ behavior: 'wait' });
  }
});

it('restores controls, focus and an email sign-in link after a rejected, malformed or missing OAuth response', async () => {
  const page = await open();
  const failures: { status: number; body: string }[] = [
    { status: 503, body: '{}' }, { status: 200, body: '{}' }, { status: 200, body: JSON.stringify({ url: 42 }) },
    { status: 200, body: 'not json' }, { status: 200, body: 'null' },
  ];
  let attempt = 0;
  for (const failure of [...failures, 'abort' as const]) {
    const id = ctas[attempt++ % ctas.length];
    const held = await holdOAuth(page);
    await page.locator(`[data-auth-id="${id}"]`).click();
    await expect.poll(() => held.requests.length).toBe(1);
    held.release(failure);
    await expect.poll(async () => (await state(page)).find(item => item.id === id)!.error, { message: JSON.stringify(failure) }).not.toBe('');
    expect(await state(page)).toEqual(ctas.map(other => ({ id: other, disabled: false, busy: null, label: 'Start with Google',
      error: other === id ? 'Google sign-in could not start. Try again, or sign in with email.' : '' })));
    expect(await page.locator(`[data-auth-id="${id}"]`).evaluate(button => document.activeElement === button)).toBe(true);
    expect(await page.locator(`#${id}-error a`).getAttribute('href')).toBe('/sign-in');
    await page.unrouteAll({ behavior: 'wait' });
  }
  await page.locator('#final-start-error a').click();
  await page.waitForURL('**/sign-in');
  expect(page.errors).toEqual([]);
});

it('navigates to the returned authorization URL and starts over from a clean state on the next attempt', async () => {
  const page = await open();
  const held = await holdOAuth(page);
  await page.locator('[data-auth-id="security-start"]').click();
  await expect.poll(() => held.requests.length).toBe(1);
  held.release({ status: 503, body: '{}' });
  await expect.poll(async () => (await state(page))[1].error).not.toBe('');
  await page.unrouteAll({ behavior: 'wait' });
  const retry = await holdOAuth(page);
  await page.locator('[data-auth-id="security-start"]').click();
  // Starting again clears the previous failure before the new request settles.
  await expect.poll(() => retry.requests.length).toBe(1);
  expect((await state(page))[1]).toMatchObject({ error: '', busy: 'true', label: 'Redirecting…' });
  retry.release({ status: 200, body: JSON.stringify({ url: `${harness.origin}/oauth-stub?state=ok` }) });
  await page.waitForURL(`${harness.origin}/oauth-stub?state=ok`);
  expect(await page.getByRole('heading', { name: 'Google consent stub' }).isVisible()).toBe(true);
  expect(page.errors).toEqual([]);
});
