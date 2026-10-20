import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import { assertLoopback } from "./backend";
import { api, shellReady } from "./shell-helpers";

/**
 * Helpers for the project and API key journeys (#113). Setup that is not the journey under test goes through the same
 * authorization paths a user or a CI job would use (session cookie for credentials, Bearer key for the credential
 * check); the journey itself is driven through the UI and verified against the server.
 */
export const publisherScopes = ["docs:read", "docs:write", "publications:read", "publications:write"];

export type Credential = { keyId: string; keyPrefix: string; name: string; scopes: string[]; projectId?: string; expiresAt?: number };
export type Key = { rawKey: string; credential: Credential };

/** Create a credential with the owner's session, as the key page does. */
export async function createKey(page: Page, organizationId: string, projectId: string | undefined, scopes: string[] = publisherScopes, extra: { name?: string; expiresAt?: number } = {}) {
  const created = await api<Key>(page, "/api/rendro/credentials", { organizationId, projectId, name: extra.name ?? "E2E key", scopes, expiresAt: extra.expiresAt });
  expect(created.status).toBe(201);
  return created.body;
}

/** A call authenticated by a Bearer key alone (no browser cookies), the way CI calls the Worker. */
export async function withKey<T = unknown>(key: string | undefined, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<{ status: number; body: T }> {
  const origin = process.env.RENDRO_E2E_ORIGIN;
  if (!origin) throw new Error("Missing local Worker origin");
  assertLoopback(origin);
  const raw = typeof body === "string";
  const response = await fetch(`${origin}${path}`, {
    method, redirect: "manual", body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined || raw ? {} : { "Content-Type": "application/json" }) },
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: response.status, body: parsed as T };
}

/** Open a management page and wait until its script finished mounting data. */
export async function openManagement(page: Page, path: string) {
  await page.goto(path);
  await shellReady(page);
  await expect(page.locator("#project-content .loading-view, #project-content [aria-busy=true], .loading-view[aria-busy=true]")).toHaveCount(0);
}

/** A page-issued request that completes after every earlier one, so "no request happened" can be asserted without a sleep. */
export const barrier = (page: Page) => page.evaluate(() => fetch("/health", { cache: "no-store" }).then(response => response.status));

/** Count requests whose URL contains the fragment. */
export function watch(page: Page, fragment: string) {
  const seen: string[] = [];
  page.on("request", request => { if (request.url().includes(fragment)) seen.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  return seen;
}
