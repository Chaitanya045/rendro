import { randomBytes } from "node:crypto";
import type { Page, BrowserContext } from "@playwright/test";
import { expect } from "./fixtures";
import { mailLink } from "./auth-helpers";
import { password, type Role, type Seed } from "./seed";

export const desktop = { width: 1440, height: 900 };
export const mobile = { width: 375, height: 812 };

export type Workspace = { email: string };

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

/** Seeded user cookies; read-only tests only (never sign out or mutate). */
export async function signInSeeded(context: BrowserContext, baseURL: string | undefined, seed: Seed, role: Role) {
  await context.addCookies(seed.cookies[role].split("; ").map(pair => {
    const split = pair.indexOf("=");
    return { name: pair.slice(0, split), value: pair.slice(split + 1), url: baseURL ?? "" };
  }));
}

/**
 * Provision a disposable verified user with real signup/verification/sign-in.
 * The label is made unique per call, so repeats and retries within one backend never collide.
 */
export async function provision(page: Page, prefix: string): Promise<Workspace> {
  const label = `${prefix}-${randomBytes(3).toString("hex")}`;
  const email = `${label}@example.test`;
  await page.goto("/sign-in");
  const signUp = await api(page, "/api/auth/sign-up/email", { name: `Shell ${label}`, email, password });
  expect(signUp.status).toBe(200);
  await page.goto(await mailLink(email, /Verify/));
  await page.goto("/sign-in");
  const signIn = await api(page, "/api/auth/sign-in/email", { email, password });
  expect(signIn.status).toBe(200);
  return { email };
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
