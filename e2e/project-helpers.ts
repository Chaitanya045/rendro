import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";
import { assertLoopback } from "./backend";
import { pushDocuments } from "./seed";
import { api, shellReady } from "./shell-helpers";

/**
 * Helpers for the project, deployment, API key, share and publication journeys (#113). Setup that is not the
 * journey under test goes through the same authorization paths a user or the CLI would use (session cookie for
 * credentials, Bearer key for deployments); the journey itself is driven through the UI and verified against the
 * server and an actual URL.
 */
export const html = (title: string, body = "", head = "") => `<!doctype html><html><head><title>${title}</title>${head}</head><body><h1>${title}</h1>${body}</body></html>`;
export const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
export const publisherScopes = ["docs:read", "docs:write", "publications:read", "publications:write"];

export type Credential = { keyId: string; keyPrefix: string; name: string; scopes: string[]; projectId?: string; expiresAt?: number };
export type Key = { rawKey: string; credential: Credential };

/** Create a credential with the owner's session, as the key page does. */
export async function createKey(page: Page, organizationId: string, projectId: string | undefined, scopes: string[] = publisherScopes, extra: { name?: string; expiresAt?: number } = {}) {
  const created = await api<Key>(page, "/api/rendro/credentials", { organizationId, projectId, name: extra.name ?? "E2E key", scopes, expiresAt: extra.expiresAt });
  expect(created.status).toBe(201);
  return created.body;
}

/** A call authenticated by a Bearer key alone (no browser cookies), the way the CLI and CI call the Worker. */
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

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type Staging = { deploymentId: string; manifestKey: string; files: Record<string, string> };

/**
 * Start a deployment the way the CLI does (sorted manifest with sizes and hashes), without uploading yet: the deployment
 * stays "staging" until its files are uploaded and committed, or it is failed.
 */
export async function startDeployment(key: string, organizationId: string, projectId: string, files: Record<string, string>, source: { commit?: string; dirty?: boolean } = {}) {
  const manifest = { version: 1, files: Object.keys(files).sort().map(path => ({ path, sha256: sha256(files[path]), size: Buffer.byteLength(files[path]), contentType: path.endsWith(".html") ? "text/html" : "application/octet-stream" })) };
  const manifestSha256 = sha256(JSON.stringify(manifest));
  const started = await withKey<{ deployment: { deploymentId: string; manifestKey: string } }>(key, "/api/rendro/deployments/start", {
    organizationId, projectId, manifest, manifestSha256,
    provenance: { source: { kind: "local", localPathLabel: "e2e-docs", ...source }, execution: { kind: "local" }, cliVersion: "0.0.0-e2e", manifestSha256 },
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { deploymentId: started.body.deployment.deploymentId, manifestKey: started.body.deployment.manifestKey, files } satisfies Staging;
}
const identity = (organizationId: string, projectId: string) => `organizationId=${organizationId}&projectId=${projectId}`;
export async function uploadStaged(key: string, organizationId: string, projectId: string, staging: Staging) {
  for (const [path, content] of Object.entries(staging.files)) {
    const response = await withKey(key, `/api/rendro/deployments/${staging.deploymentId}/files/${path}?${identity(organizationId, projectId)}`, content, "PUT");
    expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
  }
}
export const commitStaged = (key: string, organizationId: string, projectId: string, staging: Staging) =>
  withKey<{ error?: string }>(key, `/api/rendro/deployments/${staging.deploymentId}/commit?${identity(organizationId, projectId)}`, {}, "POST");
export const failStaged = (key: string, organizationId: string, projectId: string, staging: Staging, reason: string) =>
  withKey(key, "/api/rendro/deployments/fail", { organizationId, projectId, deploymentId: staging.deploymentId, reason });

export const deploymentsPath = (organizationId: string, projectId: string) => `/api/rendro/deployments?organizationId=${organizationId}&projectId=${projectId}`;
export type DeploymentRow = { _id: string; status: string; fileCount: number; failureReason?: string; createdAt: number };
export const deploymentsOf = async (key: string, organizationId: string, projectId: string) => (await withKey<{ deployments: DeploymentRow[] }>(key, deploymentsPath(organizationId, projectId)));

/** Write a document tree to a private directory and push it with the real CLI. */
export async function pushSite(baseURL: string | undefined, organizationId: string, projectId: string, key: string, files: Record<string, string>, label = "site") {
  if (!baseURL || !process.env.RENDRO_E2E_DIRECTORY) throw new Error("Missing local E2E state");
  const source = await mkdtemp(join(process.env.RENDRO_E2E_DIRECTORY, `${label}-`));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), content);
  }
  await pushDocuments(source, baseURL, organizationId, projectId, key);
}

/** The CLI's failure, with the key redacted, so a refused push can be asserted without printing credentials. */
export async function pushRefused(baseURL: string | undefined, organizationId: string, projectId: string, key: string) {
  try {
    await pushSite(baseURL, organizationId, projectId, key, { "index.html": html("Refused") }, "refused");
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? "").replaceAll(key, "[key]") + String((error as Error).message).replaceAll(key, "[key]");
  }
  return null;
}

/** Open a management page and wait until its script finished mounting data. */
export async function openManagement(page: Page, path: string) {
  await page.goto(path);
  await shellReady(page);
  await expect(page.locator("#project-content .loading-view, #project-content [aria-busy=true], .loading-view[aria-busy=true]")).toHaveCount(0);
}

/** Walk up to a table row by its visible text. */
export const rowWith = (page: Page, body: string, text: string | RegExp): Locator => page.locator(`${body} tr`, { hasText: text });

/** A page-issued request that completes after every earlier one, so "no request happened" can be asserted without a sleep. */
export const barrier = (page: Page) => page.evaluate(() => fetch("/health", { cache: "no-store" }).then(response => response.status));

/** Count requests whose URL contains the fragment. */
export function watch(page: Page, fragment: string) {
  const seen: string[] = [];
  page.on("request", request => { if (request.url().includes(fragment)) seen.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  return seen;
}
