import { randomBytes } from "node:crypto";
import type { Page, BrowserContext, Route } from "@playwright/test";
import { expect } from "./fixtures";
import { mailLink } from "./auth-helpers";
import { password, type Role, type Seed } from "./seed";

export const desktop = { width: 1440, height: 900 };
export const mobile = { width: 375, height: 812 };

export type Workspace = {
  email: string;
  organizations: Array<{ id: string; name: string; slug: string }>;
  projects: Array<{ id: string; organizationId: string }>;
};

/** Same-origin JSON call from the page, so cookies, Origin and ingress headers match a real browser. */
export async function api<T = unknown>(page: Page, path: string, data?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ path, data }) => {
    const response = await fetch(path, {
      method: data === undefined ? "GET" : "POST",
      headers: data === undefined ? undefined : { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: response.status, body: body as never };
  }, { path, data });
}

/** Seeded owner/admin/member cookies; read-only tests only (never sign out or mutate). */
export async function signInSeeded(context: BrowserContext, baseURL: string | undefined, seed: Seed, role: Role) {
  await context.addCookies(seed.cookies[role].split("; ").map(pair => {
    const split = pair.indexOf("=");
    return { name: pair.slice(0, split), value: pair.slice(split + 1), url: baseURL ?? "" };
  }));
}

/**
 * Provision a disposable verified user with real signup/verification/sign-in plus organizations and projects.
 * The label is made unique per call, so repeats and retries within one backend never collide.
 */
export async function provision(page: Page, prefix: string, options: { organizations?: string[]; project?: boolean } = {}): Promise<Workspace> {
  const label = `${prefix}-${randomBytes(3).toString("hex")}`;
  const email = `${label}@example.test`;
  await page.goto("/sign-in");
  const signUp = await api(page, "/api/auth/sign-up/email", { name: `Shell ${label}`, email, password });
  expect(signUp.status).toBe(200);
  await page.goto(await mailLink(email, /Verify/));
  await page.goto("/sign-in");
  const signIn = await api(page, "/api/auth/sign-in/email", { email, password });
  expect(signIn.status).toBe(200);
  const workspace: Workspace = { email, organizations: [], projects: [] };
  for (const name of options.organizations ?? []) {
    const slug = `${label}-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    const created = await api<{ id: string }>(page, "/api/auth/organization/create", { name, slug });
    expect(created.status).toBe(200);
    workspace.organizations.push({ id: created.body.id, name, slug });
    if (options.project) {
      const project = await api<{ project: { _id: string } }>(page, "/api/rendro/projects", { organizationId: created.body.id, name: `${name} docs`, slug: "docs" });
      expect(project.status).toBe(201);
      workspace.projects.push({ id: project.body.project._id, organizationId: created.body.id });
    }
  }
  return workspace;
}

/** Wait until the management shell finished mounting (switcher upgraded and page content ready). */
export async function shellReady(page: Page) {
  await expect(page.locator("button#cp-org-switcher")).toBeVisible();
  await expect(page.locator(".cp-content[aria-busy=true]")).toHaveCount(0);
}

export const heading = (page: Page) => page.locator(".cp-page-heading");

/** Hold only the first matching request; later requests continue untouched. Release resolves the first. */
export async function holdFirst(page: Page, glob: string) {
  let release!: () => void, finish!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delivered = new Promise<void>(resolve => { finish = resolve; });
  let held = 0, seen = 0;
  const handler = async (route: Route) => {
    seen++;
    if (held++ > 0) { await route.continue(); return; }
    await gate;
    await route.continue().catch(() => undefined);
    // Resolve once the page has received the whole response, so "it must not repaint" checks start after delivery.
    await route.request().response().then(response => response?.finished()).catch(() => undefined);
    finish();
  };
  await page.route(glob, handler);
  return {
    release, held: () => held, seen: () => seen,
    /** Resolves after the released request's response reached the page. */
    delivered: () => delivered,
    async close() { release(); if (held) await delivered; await page.unroute(glob, handler); },
  };
}

/** Let promise callbacks and two rendered frames that follow an event run, without guessing a duration. */
export async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
}

/** Replace the async clipboard so success, delay and rejection are deterministic in every engine. */
export async function fakeClipboard(page: Page) {
  await page.addInitScript(() => {
    const state = { mode: "ok" as "ok" | "reject", delay: 250, writes: [] as string[] };
    (window as unknown as { clipboardState: typeof state }).clipboardState = state;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => new Promise<void>((resolve, reject) => setTimeout(() => {
          if (state.mode === "reject") reject(new DOMException("denied", "NotAllowedError"));
          else { state.writes.push(value); resolve(); }
        }, state.delay)),
      },
    });
  });
}
export const clipboard = (page: Page) => page.evaluate(() => (window as unknown as { clipboardState: { writes: string[] } }).clipboardState.writes);
