import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signAuthClientIp } from "../../shared/auth-client-ip";
import { assertLoopback, ready } from "../backend";
import { password, pushDocuments } from "../seed";
import type { Mail } from "../services";

/**
 * One-time visual provisioning for #120, run once by the global setup of the visual config: a
 * verified owner ("Crown Turner"), an organization "Crown" with a pushed docs deployment, a
 * second organization "Vault" with none, two teams with the owner, one API key, and comment
 * threads whose earliest creation time pins the shared page clock. Every user-visible string is
 * fixed text, so a pinned clock, theme and viewport render identical pages on any runner. It
 * speaks plain HTTP to the local Worker/Convex exactly like seed.ts — no browser, no per-worker
 * cost, no fixture race between files.
 */

export type VisualSeedCookie = { name: string; value: string };

export type VisualSeed = {
  /** Epoch (ms) every page clock is fixed to: the earliest thread plus five minutes. */
  clockEpoch: number;
  crown: { organizationId: string; projectId: string; teamIds: string[]; docs: string; cookies: VisualSeedCookie[] };
  vaultOrganizationId: string;
};

const email = "visual-owner@example.test";
const anchorHeading = { kind: "element", path: ["main", "h1"] } as const;
const anchorIntro = { kind: "text-range", quote: "quick brown", path: ["main", "p:nth-of-type(1)"], startOffset: 4, endOffset: 15 } as const;

export async function seedVisualWorkspace(input: {
  /** The Convex site proxy: Better Auth and the management HTTP router (`/api/auth/*`, `/api/rendro/*`). */
  site: string;
  /** The Convex function API (`/api/query`, `/api/mutation`). */
  convex: string;
  /** The local Worker origin, where the visual site and the comment tokens belong. */
  worker: string;
  /** The internal signing secret of the local backend (auth ingress signatures). */
  secret: string;
  mail: Mail[];
  directory: string;
  fetch: typeof fetch;
}): Promise<VisualSeed> {
  assertLoopback(input.site);
  assertLoopback(input.convex);
  assertLoopback(input.worker);
  const jar: VisualSeedCookie[] = [];
  async function call<T>(path: string, data?: unknown): Promise<T> {
    const request = new Request(`${input.site}${path}`, { method: data === undefined ? "GET" : "POST",
      headers: { Origin: input.worker, "Content-Type": "application/json", Cookie: cookieHeader(jar) },
      body: data === undefined ? undefined : JSON.stringify(data) });
    const signed = await signAuthClientIp(request, "192.0.2.9", input.secret);
    signed.forEach((value, name) => request.headers.set(name, value));
    const response = await input.fetch(request, { redirect: "manual" });
    if (response.status >= 400) throw new Error(`Visual seed ${path} failed (${response.status}): ${await response.text()}`);
    const issued = response.headers.getSetCookie().map(value => value.split(";", 1)[0]);
    for (const pair of issued) {
      const split = pair.indexOf("=");
      upsert(jar, pair.slice(0, split), pair.slice(split + 1));
    }
    return await response.json() as T;
  }

  await call("/api/auth/sign-up/email", { name: "Crown Turner", email, password });
  await ready(() => input.mail.some(message => message.to === email), `Visual seed mail for ${email}`, 10_000);
  const message = input.mail.find(item => item.to === email && item.subject.includes("Verify"));
  const link = message?.text.match(/http:\/\/[^\s]+/)?.[0] as string;
  if (!link) throw new Error("Visual seed verification mail is missing");
  const verified = new URL(link);
  await input.fetch(`${input.site}${verified.pathname}${verified.search}`, { redirect: "manual" });
  const signedIn = await call<{ user: { id: string } }>("/api/auth/sign-in/email", { email, password });
  const userId = signedIn.user.id;

  const crown = await call<{ id: string }>("/api/auth/organization/create", { name: "Crown", slug: "visual-crown" });
  const vault = await call<{ id: string }>("/api/auth/organization/create", { name: "Vault", slug: "visual-vault" });
  const { project } = await call<{ project: { _id: string } }>("/api/rendro/projects", { organizationId: crown.id, name: "Crown docs", slug: "docs" });
  const teamIds: string[] = [];
  for (const name of ["Crown editors", "Crown reviewers"]) {
    const created = await call<{ id: string }>("/api/auth/organization/create-team", { name, organizationId: crown.id });
    teamIds.push(created.id);
    await call("/api/auth/organization/add-team-member", { teamId: created.id, organizationId: crown.id, userId });
  }
  const credential = await call<{ rawKey: string }>("/api/rendro/credentials", { organizationId: crown.id, projectId: project._id,
    name: "Crown publisher", scopes: ["docs:read", "docs:write", "publications:read", "publications:write"] });

  const source = join(input.directory, "visual-site");
  await mkdir(source);
  await mkdir(join(source, "guide"));
  const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  await writeFile(join(source, "index.html"), page("Crown platform overview", "\n<main><h1 id=\"title\">Crown platform overview</h1><p id=\"intro\">The quick brown fox jumps over the lazy dog.</p><p id=\"second\">Second paragraph for element comments.</p></main>\n"));
  await writeFile(join(source, "guide", "start.html"), page("Getting started", "\n<main><h1 id=\"title\">Getting started</h1><p id=\"intro\">Run pnpm install before anything else.</p></main>\n"));
  await writeFile(join(source, "guide", "advanced.html"), page("Advanced", "\n<main><h1 id=\"title\">Advanced</h1><p id=\"intro\">Call the API when ready.</p></main>\n"));
  await pushDocuments(source, input.worker, crown.id, project._id, credential.rawKey, 8, 180_000);

  // The comment widget renders each comment's age from the server's creation timestamp; every
  // rendered age is pinned to "five minutes" by fixing the page clock five minutes past the
  // earliest thread this seeding created.
  const token = (await call<{ token?: string }>("/api/auth/convex/token")).token;
  if (!token) throw new Error("Visual seed could not obtain a Convex token");
  const scope = { organizationId: crown.id, projectId: project._id, documentPath: "index.html" };
  const api = async <T>(kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<T> => {
    // The write functions are idempotent by clientOperationId, so a retry after a transient
    // backend timeout (a loaded host can exceed the 1s function budget) cannot duplicate data.
    for (let attempt = 1; ; attempt++) {
      const response = await input.fetch(`${input.convex}/api/${kind}`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ path, args, format: "json" }) });
      const body = await response.json() as { status: string; value?: T; errorMessage?: string };
      if (response.ok && body.status === "success" && body.value !== undefined) return body.value;
      if (attempt >= 5 || !/timed out|Request failed|fetch failed|ECONN/i.test(body.errorMessage ?? "")) {
        throw new Error(`Visual seed ${kind} ${path} failed: ${JSON.stringify(body)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  };
  const first = await api<string>("mutation", "documentThreads:create", { ...scope, body: "Ship the Crown overview with the release", anchor: { ...anchorHeading }, clientOperationId: "visual-thread-overview" });
  await api<string>("mutation", "documentReplies:add", { ...scope, threadId: first, body: "The deployment window still needs a date", clientOperationId: "visual-reply-overview" });
  await api<string>("mutation", "documentThreads:create", { ...scope, body: "Lock the pricing table before launch", anchor: { ...anchorIntro }, clientOperationId: "visual-thread-pricing" });
  const list = await api<{ page?: Array<{ _creationTime?: number }> }>("query", "documentThreads:list", { ...scope, paginationOpts: { numItems: 20, cursor: null } });
  const threads = list.page ?? [];
  const created = threads.map(thread => thread._creationTime).filter((value): value is number => typeof value === "number");
  if (created.length !== threads.length || created.length === 0) throw new Error("Visual seed threads arrived without timestamps");

  // The thread states of #268 live on their own page so the baselines above keep exactly their threads: an active
  // thread with a reply, one to resolve and one to delete. Created right away, they round to the same "5m" age.
  const advanced = { ...scope, documentPath: "guide/advanced.html" };
  const advancedHeading = { kind: "element", path: ["main", "h1"] } as const;
  const advancedIntro = { kind: "text-range", quote: "the API", path: ["main", "p:nth-of-type(1)"], startOffset: 5, endOffset: 12 } as const;
  const retry = await api<string>("mutation", "documentThreads:create", { ...advanced, body: "Confirm the retry budget before release", anchor: { ...advancedHeading }, clientOperationId: "visual-thread-retry" });
  await api<string>("mutation", "documentReplies:add", { ...advanced, threadId: retry, body: "The budget is three attempts", clientOperationId: "visual-reply-retry" });
  const rename = await api<string>("mutation", "documentThreads:create", { ...advanced, body: "Rename the endpoint section", anchor: { ...advancedIntro }, clientOperationId: "visual-thread-rename" });
  await api<string>("mutation", "documentThreads:resolve", { ...advanced, threadId: rename, resolved: true, clientOperationId: "visual-resolve-rename" });
  const more = await api<{ page?: Array<{ _creationTime?: number }> }>("query", "documentThreads:list", { ...advanced, paginationOpts: { numItems: 20, cursor: null } });
  const moreCreated = (more.page ?? []).map(thread => thread._creationTime).filter((value): value is number => typeof value === "number");
  // A thread older than 30 seconds past the first would render "4m" or "5m" depending on the run.
  if (moreCreated.length === 0 || Math.max(...moreCreated) - Math.min(...created) > 25_000) throw new Error("Visual seed threads were created too far apart for a stable age");

  return {
    clockEpoch: Math.min(...created) + 300_000,
    crown: { organizationId: crown.id, projectId: project._id, teamIds, docs: `/organizations/${crown.id}/projects/${project._id}/docs`, cookies: [...jar] },
    vaultOrganizationId: vault.id,
  };
}

function cookieHeader(jar: VisualSeedCookie[]) {
  return jar.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
}

function upsert(jar: VisualSeedCookie[], name: string, value: string) {
  const existing = jar.findIndex(cookie => cookie.name === name);
  if (existing === -1) jar.push({ name, value });
  else jar[existing] = { name, value };
}
