import { getRequestListener } from '@hono/node-server';
import type { User } from 'better-auth/types';
import { Hono } from 'hono';
import type { Page, Route } from 'playwright';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { securityHeaders } from '@/middleware/security-headers';
import organizationPages from '@/routes/organization-pages';
import projectPages from '@/routes/project-pages';
import apiKeyPages from '@/routes/api-key-pages';
import publicationPages from '@/routes/publication-pages';
import { renderScopedDocumentShell } from '@/routes/app';
import { managementPagesSource } from '../scripts/management-pages-source';
import { managementAccessFixture } from './fixtures/management-access';
import { browserStep, buildBrowserBundle, bundleBrowserAsset, createBrowserHarness } from './helpers/browser';

const heldDocuments = new Map<string, { arrived: boolean; ready: Promise<void>; release(): void }>();
afterEach(() => { for (const held of heldDocuments.values()) held.release(); heldDocuments.clear(); });
const harness = createBrowserHarness();
const user = { id: 'user-a', name: 'Owner', email: 'owner@example.test' } as User;
const organization = { id: 'org-a', name: 'Acme', slug: 'acme', members: [{ id: 'member-a', userId: user.id, role: 'owner', user }], teams: [] };
const project = { _id: 'project-a', organizationId: 'org-a', name: 'Docs', slug: 'docs', activeDeploymentId: 'deployment-a' };
const invitation = { id: 'invitation-a', email: user.email, organizationName: 'Acme', role: 'member', status: 'pending', expiresAt: '2099-01-01T00:00:00Z' };
const base = '/organizations/org-a';
const projectBase = `${base}/projects/project-a`;

beforeAll(async () => {
  const access = managementAccessFixture(organization, user);
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(access(input) ?? (url.pathname === '/api/rendro/projects/get'
      ? Response.json({ project }) : url.pathname === '/api/auth/organization/get-invitation' ? Response.json(invitation) : new Response(null, { status: 404 })));
  }));
  const assets = new Map<string, string>([
    ['/management-query.js', await bundleBrowserAsset('src/management-query/browser.ts')],
    ['/select.js', await bundleBrowserAsset('src/ui/select-browser.ts')],
    ['/management-pages.js', (await buildBrowserBundle({ stdin: { contents: managementPagesSource(), sourcefile: 'tests/fixtures/generated-management-pages.js', resolveDir: process.cwd() } })).outputFiles[0].text],
    ['/lazy-tree.js', await bundleBrowserAsset('src/lazy-tree/lazy-tree.ts')],
  ]);
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use('*', securityHeaders);
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const held = heldDocuments.get(url.pathname + url.search);
    if (held) {
      held.arrived = true;
      await held.ready;
      return c.html('<p>Destination loaded</p>');
    }
    await next();
  });
  app.get('/api/rendro/management/access', c => access(c.req.raw)!);
  app.get('/api/auth/organization/get-full-organization', c => c.json(organization));
  app.get('/api/auth/organization/list', c => c.json([organization]));
  app.get('/api/auth/organization/get-invitation', c => c.json(invitation));
  app.get('/api/auth/organization/list-invitations', c => c.json([]));
  app.get('/api/rendro/projects', c => c.json({ projects: [project] }));
  app.get('/api/rendro/projects/get', c => c.json({ project }));
  app.get('/api/rendro/deployments', c => c.json({ deployments: [] }));
  app.get('/api/rendro/credentials', c => c.json({ credentials: [] }));
  app.get('/api/rendro/publications', c => c.json({ publications: [] }));
  app.get('/api/rendro/management/recent-deployment', c => c.json({ deployment: null }));
  app.get(`${projectBase}/docs/tree`, c => c.json({ entries: [] }));
  app.get(`${projectBase}/docs`, c => c.html(renderScopedDocumentShell({
    user, namespace: 'org-a/project-a', title: 'Docs', basePath: `${projectBase}/docs`, selectedPath: '',
    shareConfig: { organizationId: 'org-a', projectId: 'project-a' },
  })));
  app.route('/', organizationPages);
  app.route('/', projectPages);
  app.route('/', apiKeyPages);
  app.route('/', publicationPages);
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); }, assets);
});
afterAll(() => { vi.unstubAllGlobals(); });

async function open(path: string, emptyOrganizations = false) {
  const page = await harness.newPage();
  await page.route(url => ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.tailwindcss.com'].includes(url.hostname), route => route.fulfill({ body: '' }));
  if (emptyOrganizations) await page.route('**/api/auth/organization/list', route => route.fulfill({ json: [] }));
  await browserStep(`open ${path}`, () => page.goto(harness.origin + path));
  return page;
}

// Hold writes at the network boundary; exercise real controllers, scopes and native dialogs.
async function writes(page: Page, endpoint: string) {
  const pending: Route[] = [];
  const bodies: Record<string, unknown>[] = [];
  await page.route(url => url.pathname === endpoint, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    pending.push(route);
  });
  return {
    bodies,
    async settle(body: unknown, status = 200) {
      await expect.poll(() => pending.length).toBe(1);
      await pending.shift()!.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    },
  };
}

// Hold the destination response at the fixture server while the old form is visible.
function holdDocument(page: Page, path: string) {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const held = { arrived: false, ready, release };
  heldDocuments.set(path, held);
  return {
    async wait() { await expect.poll(() => held.arrived).toBe(true); },
    async release() {
      held.release();
      await page.waitForURL(harness.origin + path);
      await page.getByText('Destination loaded', { exact: true }).waitFor();
      heldDocuments.delete(path);
    },
  };
}

const dialogs: Array<{
  name: string; path: string; trigger: string; id: string; endpoint: string;
  fields: Record<string, string>; result: unknown;
}> = [
  { name: 'invitations', path: `${base}/people`, trigger: '#organization-page-action', id: 'invite', endpoint: '/api/auth/organization/invite-member', fields: { email: 'one@example.test' }, result: {} },
  { name: 'team', path: `${base}/teams`, trigger: '#organization-page-action', id: 'team', endpoint: '/api/auth/organization/create-team', fields: { name: 'Documentation' }, result: { id: 'team-a' } },
  { name: 'project', path: `${base}/projects`, trigger: '#project-create', id: 'project', endpoint: '/api/rendro/projects', fields: { name: 'Documentation' }, result: { project } },
  { name: 'API key', path: `${base}/api-keys`, trigger: '#api-key-create', id: 'key', endpoint: '/api/rendro/credentials', fields: { name: 'CI' }, result: { rawKey: 'synthetic-test-key' } },
  { name: 'publication', path: `${projectBase}/publications`, trigger: '#publication-create', id: 'publication', endpoint: '/api/rendro/publications', fields: { slug: 'docs', title: 'Documentation' }, result: { publication: { _id: 'publication-a', slug: 'docs', title: 'Docs', trackingMode: 'track_active' } } },
];

async function fill(page: Page, id: string, fields: Record<string, string>) {
  for (const [name, value] of Object.entries(fields)) await page.locator(`#${id}-form [name="${name}"]`).fill(value);
}

async function finishSecret(page: Page) {
  await page.locator('#secret-dialog[open]').waitFor();
  await page.keyboard.press('Escape');
  expect(await page.locator('#secret-dialog').getAttribute('open')).not.toBeNull();
  expect(await page.locator('#secret-done').isDisabled()).toBe(true);
  await page.locator('#secret-confirmed').check();
  expect(await page.locator('#secret-done').isEnabled()).toBe(true);
  await page.locator('#secret-done').click();
  await expect.poll(() => page.locator('#raw-key').textContent()).toBe('');
}

it.each(dialogs)('$name resets after success and can reopen and submit exactly once again', async spec => {
  const page = await open(spec.path);
  const requests = await writes(page, spec.endpoint);
  for (let round = 0; round < 2; round++) {
    await page.locator(spec.trigger).click();
    const button = page.locator(`#${spec.id}-form button[type=submit]`);
    expect(await button.isEnabled()).toBe(true);
    expect(await button.getAttribute('aria-busy')).not.toBe('true');
    await fill(page, spec.id, spec.fields);
    await button.click();
    await expect.poll(() => requests.bodies.length).toBe(round + 1);
    await requests.settle(spec.id === 'key' ? { rawKey: `synthetic-key-${round}` } : spec.result);
    if (spec.id === 'key') {
      await expect.poll(() => page.locator('#raw-key').textContent()).toBe(`synthetic-key-${round}`);
      await finishSecret(page);
      expect(await page.locator('#key-form [name=name]').inputValue()).toBe('');
    }
    else if (spec.id === 'project') {
      await page.waitForURL(harness.origin + projectBase);
      await page.locator(`.cp-nav-link[href="${base}/projects"]`).click();
      await page.waitForURL(harness.origin + spec.path);
    } else await page.locator(`#${spec.id}-dialog`).waitFor({ state: 'hidden' });
    // Wait for invitation/team refresh to finish before reusing the persistent dialog.
    if (spec.id === 'invite') await page.getByText('No pending invitations.', { exact: true }).waitFor();
    if (spec.id === 'team') {
      await page.getByRole('heading', { name: 'No teams yet' }).waitFor();
      expect(await page.locator('#team-form [name=name]').inputValue()).toBe('');
    }
    if (spec.id === 'publication') {
      expect(await page.locator('#publication-form [name=title]').inputValue()).toBe('');
      expect(await page.locator('#publication-list tr').count()).toBe(round + 1);
    }
  }
  expect(requests.bodies).toHaveLength(2);
  if (spec.id === 'invite') {
    await page.locator(spec.trigger).click();
    await page.locator('#add-invite-row').click();
    expect(await page.locator('.invite-entry').count()).toBe(2);
  }
});

it.each(dialogs)('$name blocks Cancel and Escape while pending, restores drafts after denial, and retries', async spec => {
  const page = await open(spec.path);
  const requests = await writes(page, spec.endpoint);
  await page.locator(spec.trigger).click();
  await fill(page, spec.id, spec.fields);
  const dialog = page.locator(`#${spec.id}-dialog`);
  const button = page.locator(`#${spec.id}-form button[type=submit]`);
  await button.click();
  await expect.poll(() => requests.bodies.length).toBe(1);
  if (['project', 'team'].includes(spec.id)) await page.locator(`#${spec.id}-form`).evaluate(form => (form as HTMLFormElement).requestSubmit());
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.keyboard.press('Escape');
  expect(await dialog.getAttribute('open')).not.toBeNull();
  expect(await button.getAttribute('aria-busy')).toBe('true');
  expect(await button.isDisabled()).toBe(true);
  // Programmatic navigation uses the same pending-write guard as clicked links.
  expect(await page.evaluate(path => (window as unknown as { RendroUI: { navigate(path: string): Promise<boolean> } }).RendroUI.navigate(path), base)).toBe(false);
  expect(requests.bodies).toHaveLength(1);
  await requests.settle({ message: 'Permission denied' }, 403);
  await expect.poll(() => button.getAttribute('aria-busy')).toBe('false');
  expect(await button.isEnabled()).toBe(true);
  expect(await page.locator(`#${spec.id}-error`).textContent()).toContain('Permission denied');
  for (const [name, value] of Object.entries(spec.fields)) expect(await page.locator(`#${spec.id}-form [name="${name}"]`).inputValue()).toBe(value);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.locator(spec.trigger).click();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.locator(spec.trigger).click();
  await button.click();
  await expect.poll(() => requests.bodies.length).toBe(2);
  await requests.settle(spec.result);
  if (spec.id === 'key') await finishSecret(page);
  else await dialog.waitFor({ state: 'hidden' });
});

it('invitations reset before refresh and preserve a reopened draft when the held list arrives', async () => {
  const page = await open(`${base}/people`);
  await page.getByText('No pending invitations.', { exact: true }).waitFor();
  const requests = await writes(page, '/api/auth/organization/invite-member');
  const refreshes: Route[] = [];
  await page.route('**/api/auth/organization/list-invitations?*', route => { refreshes.push(route); });
  await page.locator('#organization-page-action').click();
  await page.locator('[name=email]').fill('sent@example.test');
  await page.locator('#invite-form button[type=submit]').click();
  await requests.settle({});
  await page.locator('#invite-dialog').waitFor({ state: 'hidden' });
  await expect.poll(() => refreshes.length).toBe(1);
  await page.locator('#organization-page-action').click();
  expect(await page.locator('[name=email]').count()).toBe(1);
  expect(await page.locator('[name=email]').inputValue()).toBe('');
  expect(await page.locator('#invite-form button[type=submit]').isEnabled()).toBe(true);
  await page.locator('[name=email]').fill('draft@example.test');
  await page.locator('#add-invite-row').click();
  await page.locator('[name=email]').nth(1).fill('second@example.test');
  await page.locator('[name=role]').nth(1).selectOption('admin');
  await refreshes.shift()!.fulfill({ json: [{ ...invitation, email: 'sent@example.test' }] });
  await page.locator('#invitation-list').getByText('sent@example.test', { exact: true }).waitFor();
  expect(await page.locator('[name=email]').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value))).toEqual(['draft@example.test', 'second@example.test']);
  expect(await page.locator('[name=role]').nth(1).inputValue()).toBe('admin');
  expect(await page.locator('#invite-dialog').getAttribute('open')).not.toBeNull();
  await page.locator('#invite-form button[type=submit]').click();
  await requests.settle({});
  await requests.settle({});
  await page.locator('#invite-dialog').waitFor({ state: 'hidden' });
  await expect.poll(() => refreshes.length).toBe(1);
  await refreshes.shift()!.fulfill({ json: [{ ...invitation, email: 'second@example.test' }] });
  await page.locator('#invitation-list').getByText('second@example.test', { exact: true }).waitFor();
  expect(requests.bodies.map(body => [body.email, body.role])).toEqual([
    ['sent@example.test', 'member'], ['draft@example.test', 'member'], ['second@example.test', 'admin'],
  ]);
});

it('invitations retain only failed rows and do not resend successful rows on retry', async () => {
  const page = await open(`${base}/people`);
  const requests = await writes(page, '/api/auth/organization/invite-member');
  await page.locator('#organization-page-action').click();
  await page.locator('[name=email]').fill('sent@example.test');
  await page.locator('#add-invite-row').click();
  await page.locator('[name=email]').nth(1).fill('retry@example.test');
  const button = page.locator('#invite-form button[type=submit]');
  await button.click();
  // Guard duplicate form submission even when Enter/requestSubmit bypasses disabled-button activation.
  await page.locator('#invite-form').evaluate(form => (form as HTMLFormElement).requestSubmit());
  await requests.settle({});
  await expect.poll(() => requests.bodies.length).toBe(2);
  await requests.settle({ message: 'Try later' }, 500);
  await expect.poll(() => button.getAttribute('aria-busy')).toBe('false');
  expect(await page.locator('#cp-toasts').textContent()).toContain('1 invitation sent; retry the highlighted rows.');
  expect(await page.locator('[name=email]').count()).toBe(1);
  expect(await page.locator('[name=email]').inputValue()).toBe('retry@example.test');
  expect(await page.locator('[name=email]').getAttribute('aria-invalid')).toBe('true');
  await page.route('**/api/auth/organization/list-invitations?*', route => route.fulfill({ json: [{ ...invitation, email: 'retry@example.test' }] }));
  await button.click();
  await requests.settle({});
  await page.locator('#invite-dialog').waitFor({ state: 'hidden' });
  await page.locator('#invitation-list').getByText('retry@example.test', { exact: true }).waitFor();
  expect(requests.bodies.map(body => body.email)).toEqual(['sent@example.test', 'retry@example.test', 'retry@example.test']);
});

it('navigation disposal clears busy controls and ignores late invitation success or failure', async () => {
  for (const status of [200, 500]) {
    const page = await open(`${base}/people`);
    const requests = await writes(page, '/api/auth/organization/invite-member');
    await page.locator('#organization-page-action').click();
    await page.locator('[name=email]').fill('pending@example.test');
    const button = page.locator('#invite-form button[type=submit]');
    await button.click();
    await expect.poll(() => requests.bodies.length).toBe(1);
    // A forced owner teardown (e.g. sign-out) can dispose even while a write is pending.
    await page.evaluate(() => window.dispatchEvent(new Event('commentor-sign-out')));
    expect(await button.getAttribute('aria-busy')).toBe('false');
    expect(await button.isEnabled()).toBe(true);
    await requests.settle({ message: 'Late failure' }, status);
    expect(await page.locator('#invite-dialog').getAttribute('open')).toBeNull();
    expect(await page.locator('[name=email]').inputValue()).toBe('pending@example.test');
    expect(await page.locator('#invite-error').textContent()).toBe('');
    await page.close();
  }
});

it('settings restores the save control after success and denial and permits another save', async () => {
  const page = await open(`${base}/settings`);
  const requests = await writes(page, '/api/auth/organization/update');
  const button = page.locator('#settings-form button[type=submit]');
  for (const status of [200, 403, 200]) {
    await page.locator('#settings-form [name=name]').fill(`Changed ${status}`);
    await button.click();
    await expect.poll(() => button.getAttribute('aria-busy')).toBe('true');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(path => (window as unknown as { RendroUI: { navigate(path: string): Promise<boolean> } }).RendroUI.navigate(path), `${base}/people`)).toBe(false);
    await requests.settle(status === 200 ? { ...organization, name: 'Saved' } : { message: 'Permission denied' }, status);
    await expect.poll(() => button.getAttribute('aria-busy')).toBe('false');
    expect(await button.isEnabled()).toBe(true);
    expect(await page.locator('#settings-form [name=name]').inputValue()).toBe(status === 200 ? 'Saved' : 'Changed 403');
    if (status === 200) expect(await page.locator('[data-org-name]').first().textContent()).toBe('Saved');
  }
  expect(requests.bodies).toHaveLength(3);
});

it.each([
  { name: 'first organization', path: '/organizations', form: 'organization', endpoint: '/api/auth/organization/create', result: { id: 'org-a' }, destination: `${base}/onboarding` },
  { name: 'organization creation', path: '/organizations?choose=1', form: 'organization', endpoint: '/api/auth/organization/create', result: { id: 'org-a' }, destination: base },
  { name: 'onboarding project', path: `${base}/onboarding`, form: 'project', endpoint: '/api/rendro/projects', result: { project }, destination: `${base}/onboarding?projectId=project-a` },
])('$name stays completed during delayed navigation and supports a fresh submission', async spec => {
  const page = await open(spec.path, spec.name === 'first organization');
  const requests = await writes(page, spec.endpoint);
  for (let round = 0; round < 2; round++) {
    if (round) await page.goto(harness.origin + spec.path);
    if (spec.name === 'organization creation') await page.locator('#show-create').click();
    await fill(page, spec.form, { name: `Docs ${round}` });
    const button = page.locator(`#${spec.form}-form button[type=submit]`);
    await button.click();
    await expect.poll(() => requests.bodies.length).toBe(round * 2 + 1);
    await page.keyboard.press('Escape');
    expect(await button.getAttribute('aria-busy')).toBe('true');
    await requests.settle({ message: 'Permission denied' }, 403);
    await expect.poll(() => button.getAttribute('aria-busy')).toBe('false');
    expect(await button.isEnabled()).toBe(true);
    expect(await page.locator(`#${spec.form}-form [name=name]`).inputValue()).toBe(`Docs ${round}`);
    expect(await page.locator(`#${spec.form}-form [name=slug]`).inputValue()).toBe(`docs-${round}`);
    const box = (await button.boundingBox())!;
    await page.evaluate(formId => {
      window.addEventListener('beforeunload', () => {
        const form = document.getElementById(`${formId}-form`) as HTMLFormElement;
        const button = form.querySelector('button[type=submit]') as HTMLButtonElement;
        sessionStorage.setItem('completed-controls', JSON.stringify([{ disabled: button.disabled, busy: button.getAttribute('aria-busy') }]));
        // Re-enter after success even though native activation is disabled.
        form.requestSubmit();
      }, { once: true });
    }, spec.form);
    const destination = holdDocument(page, spec.destination);
    await button.click();
    await requests.settle(spec.result);
    await destination.wait();
    await browserStep('native click during delayed navigation', () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2));
    await browserStep('release destination', () => destination.release());
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('completed-controls')!) as unknown)).toEqual([{ disabled: true, busy: 'false' }]);
    expect(requests.bodies).toHaveLength(round * 2 + 2);
  }
  expect(requests.bodies).toHaveLength(4);
});

it('onboarding credentials recover from denial and protect the one-time secret after each success', async () => {
  const path = `${base}/onboarding?projectId=project-a`;
  const page = await open(path);
  const requests = await writes(page, '/api/rendro/credentials');
  for (let round = 0; round < 2; round++) {
    if (round) await page.goto(harness.origin + path);
    const button = page.locator('#key-form button[type=submit]');
    await page.locator('#key-form [name=name]').fill(`Credential draft ${round}`);
    await page.locator('#key-form [name=expiry]').selectOption('30');
    await page.locator('#key-form [name=scope][value="docs:write"]').uncheck();
    const draft = await page.locator('#key-form').evaluate(form => Array.from(new FormData(form as HTMLFormElement).entries()));
    await button.click();
    await expect.poll(() => button.getAttribute('aria-busy')).toBe('true');
    await page.keyboard.press('Escape');
    expect(await button.isDisabled()).toBe(true);
    await requests.settle({ message: 'Permission denied' }, 403);
    await expect.poll(() => button.getAttribute('aria-busy')).toBe('false');
    expect(await button.isEnabled()).toBe(true);
    expect(await page.locator('#key-form').evaluate(form => Array.from(new FormData(form as HTMLFormElement).entries()))).toEqual(draft);
    await button.click();
    await requests.settle({ rawKey: `synthetic-onboarding-${round}` });
    await page.locator('#onboarding-key').waitFor();
    expect(await button.getAttribute('aria-busy')).toBe('false');
    expect(await button.isEnabled()).toBe(true);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
    await page.locator('#onboarding-key-confirmed').check();
  }
  expect(requests.bodies).toHaveLength(4);
});

it('private share creation can repeat after success and denial without retaining pending state', async () => {
  const page = await open(`${projectBase}/docs`);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } });
    (window as unknown as { RENDRO_CURRENT_DOC: string }).RENDRO_CURRENT_DOC = 'org-a/project-a/index.html';
  });
  const requests = await writes(page, '/api/rendro/shares');
  const button = page.locator('#share-btn');
  for (const status of [200, 403, 200]) {
    await button.click();
    await expect.poll(() => button.getAttribute('aria-busy')).toBe('true');
    // Sharing is a toolbar action, not a dialog: Escape must not start another write.
    await page.keyboard.press('Escape');
    await button.click();
    await requests.settle(status === 200 ? { url: '/s/synthetic-share' } : { message: 'Permission denied' }, status);
    await expect.poll(() => button.getAttribute('aria-busy')).toBeNull();
    expect(await button.isEnabled()).toBe(true);
    expect(await button.getAttribute('aria-label')).toBe(status === 200 ? 'Share link copied!' : 'Share document');
    const notice = page.locator('#share-error');
    if (status === 200) expect(await notice.isVisible()).toBe(false);
    else {
      expect(await notice.isVisible()).toBe(true);
      expect(await notice.innerText()).toContain('The share link could not be created. Please try again.');
      expect(await notice.innerText()).not.toContain('Permission denied');
    }
  }
  expect(requests.bodies).toHaveLength(3);
  expect(requests.bodies.every(body => body.expiresInSeconds === 604800)).toBe(true);
  await expect.poll(() => button.getAttribute('aria-label')).toBe('Share document');
});

it('a share failure notice is cleared when navigation changes the document', async () => {
  const page = await open(`${projectBase}/docs`);
  await page.evaluate(() => {
    (window as unknown as { RENDRO_CURRENT_DOC: string }).RENDRO_CURRENT_DOC = 'org-a/project-a/index.html';
  });
  const requests = await writes(page, '/api/rendro/shares');
  await page.locator('#share-btn').click();
  await requests.settle({ message: 'Permission denied' }, 403);
  await page.locator('#share-error').waitFor({ state: 'visible' });
  // Real lazy-tree navigation (back/forward) assigns the current document.
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate', { state: { docPath: 'org-a/project-a/other.html' } })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { RENDRO_CURRENT_DOC: string }).RENDRO_CURRENT_DOC)).toBe('org-a/project-a/other.html');
  expect(await page.locator('#share-error').isVisible()).toBe(false);
});

it.each(['accept', 'reject'])('invitation %s locks both response controls during delayed navigation and remains retryable', async action => {
  const path = '/accept-invitation/invitation-a';
  const page = await open(path);
  const requests = await writes(page, `/api/auth/organization/${action}-invitation`);
  const otherResponse = await writes(page, `/api/auth/organization/${action === 'accept' ? 'reject' : 'accept'}-invitation`);
  for (let round = 0; round < 2; round++) {
    if (round) await page.goto(harness.origin + path);
    const button = page.locator(`#${action}`);
    await button.click();
    await requests.settle({ message: 'Permission denied' }, 403);
    await expect.poll(() => button.getAttribute('aria-busy')).toBe('false');
    expect(await page.locator('#accept').isEnabled()).toBe(true);
    expect(await page.locator('#reject').isEnabled()).toBe(true);
    const boxes = await Promise.all(['#accept', '#reject'].map(selector => page.locator(selector).boundingBox()));
    await page.evaluate(() => {
      window.addEventListener('beforeunload', () => {
        const controls = Array.from(document.querySelectorAll<HTMLButtonElement>('.invitation-actions button'));
        sessionStorage.setItem('completed-controls', JSON.stringify(controls.map(button => ({ disabled: button.disabled, busy: button.getAttribute('aria-busy') }))));
        controls.forEach(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      }, { once: true });
    });
    const destination = holdDocument(page, action === 'accept' ? base : '/organizations');
    await button.click();
    await requests.settle({ member: { organizationId: 'org-a' } });
    await destination.wait();
    for (const box of boxes) await browserStep('native response click during delayed navigation', () => page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2));
    await browserStep('release destination', () => destination.release());
    const controls = await page.evaluate(() => JSON.parse(sessionStorage.getItem('completed-controls')!) as { disabled: boolean; busy: string | null }[]);
    expect(controls.every(button => button.disabled)).toBe(true);
    expect(controls.filter(button => button.busy === 'true')).toHaveLength(0);
    expect(otherResponse.bodies).toHaveLength(0);
    expect(requests.bodies).toHaveLength(round * 2 + 2);
  }
  expect(requests.bodies).toHaveLength(4);
});

it('shared destructive confirmation can cancel, escape and confirm repeatedly without retaining busy state', async () => {
  const page = await open(`${base}/people`);
  for (const action of ['cancel', 'escape', 'accept', 'accept']) {
    await page.evaluate(() => {
      const ui = (window as unknown as { RendroUI: { confirm(options: object): Promise<boolean> } }).RendroUI;
      void ui.confirm({ title: 'Remove fixture?', confirmLabel: 'Remove' }).then(value => { document.body.dataset.confirmResult = String(value); });
    });
    const dialog = page.locator('#cp-confirm-dialog');
    await dialog.waitFor();
    expect(await dialog.locator('[data-confirm-accept]').isEnabled()).toBe(true);
    expect(await dialog.locator('[aria-busy=true]').count()).toBe(0);
    if (action === 'escape') await page.keyboard.press('Escape');
    else await dialog.locator(`[data-confirm-${action}]`).click();
    await dialog.waitFor({ state: 'hidden' });
    expect(await page.locator('body').getAttribute('data-confirm-result')).toBe(String(action === 'accept'));
  }
});

it('management hidden controls stay out of layout through role and publication-mode changes', async () => {
  const page = await open(`${projectBase}/publications`);
  await page.locator('#publication-create').waitFor();
  await page.locator('#publication-create').click();
  const pin = page.locator('#pin-field');
  expect(await pin.evaluate(node => getComputedStyle(node).display)).toBe('none');
  await page.locator('[name=trackingMode]').selectOption('pinned');
  await pin.waitFor();
  await page.locator('[name=trackingMode]').selectOption('track_active');
  expect(await pin.evaluate(node => getComputedStyle(node).display)).toBe('none');
  await page.keyboard.press('Escape');

  const member = { ...organization.members[0], role: 'member' };
  await page.route('**/api/rendro/management/access?*', route => route.fulfill({ json: { ...organization, userId: user.id, member } }));
  await page.reload();
  await page.locator('#publication-access-note').waitFor();
  expect(await page.locator('#publication-create').evaluate(node => getComputedStyle(node).display)).toBe('none');
  expect(await page.getByRole('button', { name: 'Create publication', exact: true }).count()).toBe(0);
  await page.route('**/api/rendro/management/access?*', route => route.fulfill({ json: { ...organization, userId: user.id, member: organization.members[0] } }));
  await page.reload();
  await page.locator('#publication-create').waitFor();
  expect(await page.locator('#publication-create').isEnabled()).toBe(true);
  expect(await page.locator('#publication-access-note').evaluate(node => getComputedStyle(node).display)).toBe('none');
});
