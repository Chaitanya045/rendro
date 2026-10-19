import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableObjectNamespaceLike } from "../src/ingest/orchestrator/coordinator-client";
import { serviceRepoPermissions } from "../src/repo-read/access";
import * as entry from "../src/repo-access/entry";
import worker, { directorySource, log, RepoAccessDirectory, type ControlWorkerEnv } from "../src/repo-access/worker";
import { FakeGitHub } from "./helpers/fake-github";
import { FakeDirectoryStorage, FakeEpochKv, TOKEN_KEY } from "./helpers/repo-access-fixture";

/**
 * The control Worker (#243): the read path's permission source over the
 * service binding, the account hand-over P1 will use, and GitHub's permission
 * webhooks. Internal endpoints answer only the internal host.
 */

const SECRET = "test-webhook-secret-0123456789abcdef";
const originalFetch = globalThis.fetch;

// The Worker reaches GitHub through the global fetch; each test that needs it routes it to its fake.
// Its structured log lines are asserted in one test and kept out of the output elsewhere.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function environment(overrides: Partial<ControlWorkerEnv> = {}) {
  const github = new FakeGitHub();
  const storage = new FakeDirectoryStorage();
  const kv = new FakeEpochKv();
  const base = {
    REPO_EPOCHS: kv, GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_TOKEN_KEY: TOKEN_KEY, GITHUB_API_ORIGIN: github.origin, GITHUB_WEB_ORIGIN: github.webOrigin,
    GITHUB_APP_CLIENT_ID: github.clientId, GITHUB_APP_CLIENT_SECRET: github.clientSecret, GITHUB_DEV_TOKEN: github.token, ...overrides,
  };
  let instance: RepoAccessDirectory | null = null;
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name) => name,
    get: () => ({
      fetch: (input, init) => {
        instance ??= new RepoAccessDirectory({ storage }, env);
        return instance.fetch(new Request(input, init));
      },
    }),
  };
  const env: ControlWorkerEnv = { REPO_ACCESS_DIRECTORY: namespace, ...base };
  return { env, github, storage, kv, directory: () => instance as RepoAccessDirectory };
}

const internal = (path: string, body: unknown, method = "POST") =>
  new Request(`https://repo-access.internal${path}`, { method, body: method === "GET" ? undefined : JSON.stringify(body) });

function webhook(github: FakeGitHub, event: string, payload: unknown, options: { secret?: string; delivery?: string; host?: string } = {}) {
  const { body, headers } = github.webhook(options.secret ?? SECRET, event, payload, options.delivery);
  return new Request(`https://${options.host ?? "control.rendro.test"}/v1/github/webhook`, { method: "POST", body, headers });
}

describe("control Worker", () => {
  it("serves the read path's protocol over the service binding, from GitHub's state", async () => {
    const { env, github } = environment();
    globalThis.fetch = github.fetch;
    github.install("octo", { id: 71 });
    const repo = github.repo("octo", "docs", { id: 801, private: true });
    const reader = github.user("reader", 5001);
    repo.collaborators.add(reader.id);
    const source = serviceRepoPermissions({ fetch: (request) => worker.fetch(request, env) });
    expect(await source.authorize("user-1", "octo", "docs")).toBeNull();
    expect((await worker.fetch(webhook(github, "installation", { action: "created", installation: { id: 71, account: { login: "octo" } }, repositories: [github.repoJson(repo)] }), env)).status).toBe(202);
    const tokens = github.signIn(reader);
    expect((await worker.fetch(internal("/v1/accounts/link", { userId: "user-1", githubId: reader.id, login: "reader", tokens }), env)).status).toBe(204);
    expect(await source.authorize("user-1", "octo", "docs")).toEqual({ id: 801, owner: "octo", name: "docs", private: true, defaultBranch: "main" });
    expect(await source.authorize(null, "octo", "docs")).toBeNull();
    expect((await worker.fetch(internal("/v1/accounts/unlink", { userId: "user-1" }), env)).status).toBe(204);
    expect(await source.authorize("user-1", "octo", "docs")).toBeNull();
  });

  it("verifies, deduplicates and plans webhooks", async () => {
    const { env, github, kv } = environment();
    github.install("octo", { id: 71 });
    const member = { id: 5002, login: "member" };
    const removed = { action: "removed", member, installation: { id: 71 } };
    expect((await worker.fetch(webhook(github, "membership", removed, { delivery: "d-1" }), env)).status).toBe(202);
    expect((await worker.fetch(webhook(github, "membership", removed, { delivery: "d-1" }), env)).status).toBe(200);
    // Forged, unsigned, malformed, irrelevant.
    expect((await worker.fetch(webhook(github, "membership", removed, { secret: "wrong-secret-0123456789abcdef0123" }), env)).status).toBe(401);
    const unsigned = webhook(github, "membership", removed);
    unsigned.headers.delete("x-hub-signature-256");
    expect((await worker.fetch(unsigned, env)).status).toBe(401);
    expect((await worker.fetch(webhook(github, "membership", removed, { delivery: "not a guid!" }), env)).status).toBe(400);
    expect((await worker.fetch(webhook(github, "membership", { action: "removed" }), env)).status).toBe(400);
    expect((await worker.fetch(webhook(github, "push", { ref: "refs/heads/main" }), env)).status).toBe(204);
    expect((await worker.fetch(webhook(github, "ping", { zen: "Keep it simple." }), env)).status).toBe(204);
    expect((await worker.fetch(new Request("https://control.rendro.test/v1/github/webhook"), env)).status).toBe(405);
    expect(kv.puts).toEqual([]);
  });

  it("answers internal endpoints only on the internal host", async () => {
    const { env, github } = environment();
    for (const path of ["/v1/authorize", "/v1/accounts/link", "/v1/accounts/unlink"]) {
      expect((await worker.fetch(new Request(`https://control.rendro.test${path}`, { method: "POST", body: "{}" }), env)).status, path).toBe(404);
    }
    expect((await worker.fetch(internal("/v1/github/webhook", {}), env)).status).toBe(404);
    expect((await worker.fetch(internal("/other", {}), env)).status).toBe(404);
    expect((await worker.fetch(webhook(github, "member", {}, { host: "repo-access.internal" }), env)).status).toBe(404);
  });

  it("validates account hand-overs and never echoes tokens", async () => {
    const { env, github } = environment();
    const reader = github.user("reader", 5001);
    const tokens = github.signIn(reader);
    const link = (body: unknown) => worker.fetch(internal("/v1/accounts/link", body), env);
    expect((await worker.fetch(internal("/v1/accounts/link", null, "GET"), env)).status).toBe(405);
    expect((await worker.fetch(new Request("https://repo-access.internal/v1/accounts/link", { method: "POST", body: "{" }), env)).status).toBe(400);
    for (const bad of [{ githubId: 1, login: "reader", tokens }, { userId: "", githubId: 1, login: "reader", tokens }, { userId: "u", githubId: 0, login: "reader", tokens },
      { userId: "u", githubId: 1, login: "-bad-", tokens }, { userId: "u", githubId: 1, login: "reader", tokens: { accessToken: 5 } }, { userId: "x".repeat(257), githubId: 1, login: "reader", tokens }]) {
      expect((await link(bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    const response = await link({ userId: "u", githubId: 1, login: "reader", tokens });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("fails closed without its secrets", async () => {
    const missingSecret = environment({ GITHUB_WEBHOOK_SECRET: undefined });
    expect((await worker.fetch(webhook(missingSecret.github, "membership", { action: "removed", member: { id: 1 } }), missingSecret.env)).status).toBe(503);
    for (const key of [undefined, "short", SECRET]) {
      const { env, github } = environment({ GITHUB_TOKEN_KEY: key });
      const source = serviceRepoPermissions({ fetch: (request) => worker.fetch(request, env) });
      await expect(source.authorize(null, "octo", "docs")).rejects.toThrow("unavailable");
      expect((await worker.fetch(webhook(github, "membership", { action: "removed", member: { id: 1 }, installation: { id: 71 } }), env)).status).toBe(503);
      expect((await worker.fetch(internal("/v1/accounts/unlink", { userId: "u" }), env)).status).toBe(503);
      await env.REPO_ACCESS_DIRECTORY.get("directory").fetch("https://directory/authorize", { method: "POST", body: "{}" });
    }
    const reused = environment({ GITHUB_TOKEN_KEY: "same-secret-0123456789abcdef012345", GITHUB_APP_CLIENT_SECRET: "same-secret-0123456789abcdef012345" });
    await expect(directorySource(reused.env).authorize(null, "octo", "docs")).rejects.toThrow("unavailable");
    await reused.directory().alarm();
  });

  it("runs the outbox from the alarm, and renews tokens only when the client is configured", async () => {
    for (const configured of [true, false]) {
      const { env, github, kv, storage } = environment(configured ? {} : { GITHUB_APP_CLIENT_ID: undefined });
      globalThis.fetch = github.fetch;
      const reader = github.user("reader", 5001);
      const expired = { ...github.signIn(reader), accessTokenExpiresAt: 1 };
      expect((await worker.fetch(internal("/v1/accounts/link", { userId: "u", githubId: reader.id, login: "reader", tokens: expired }), env)).status).toBe(204);
      expect(storage.alarm).not.toBeNull();
      const directory = new RepoAccessDirectory({ storage }, env);
      await directory.alarm();
      expect(kv.epoch("u")).toBeGreaterThan(0);
      // An expired token is renewed through GitHub's OAuth client; without one the answer is unknown (503), never a grant.
      const response = await directory.fetch(new Request("https://directory/authorize", { method: "POST", body: JSON.stringify({ viewer: "u", owner: "octo", name: "docs" }) }));
      expect(response.status).toBe(configured ? 404 : 503);
      expect(github.count("oauth")).toBe(configured ? 1 : 0);
    }
    // Production defaults: api.github.com, no development token.
    const bare = environment({ GITHUB_API_ORIGIN: undefined, GITHUB_WEB_ORIGIN: undefined, GITHUB_DEV_TOKEN: undefined });
    expect((await new RepoAccessDirectory({ storage: bare.storage }, bare.env).fetch(new Request("https://directory/nowhere", { method: "POST", body: "{}" }))).status).toBe(404);
  });

  it("tells Convex about epochs only where comments are configured (#254)", async () => {
    for (const configured of [true, false]) {
      const convexUrl = "https://convex.rendro.test";
      const { env, github, kv, storage } = environment({ CONVEX_URL: convexUrl, CONVEX_INTERNAL_SECRET: configured ? "convex-internal-secret-0123456789abcdef" : "short" });
      const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
      globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (input !== `${convexUrl}/api/mutation`) return github.fetch(input, init);
        const { path, args: [args] } = JSON.parse(init?.body as string) as { path: string; args: [Record<string, unknown>] };
        calls.push({ path, args });
        return Promise.resolve(Response.json({ status: "success", value: null }));
      }) as typeof fetch;
      const reader = github.user("reader", 5001);
      expect((await worker.fetch(internal("/v1/accounts/link", { userId: "u", githubId: reader.id, login: "reader", tokens: github.signIn(reader) }), env)).status).toBe(204);
      await new RepoAccessDirectory({ storage }, env).alarm();
      expect(calls).toEqual(configured ? [{ path: "repoCommentAccess:revokeUser", args: { userId: "u", epoch: kv.epoch("u"), internalSecret: "convex-internal-secret-0123456789abcdef" } }] : []);
    }
  });

  it("puts removed repositories in the purge ledger only where a purge can run: REPO_INGEST bound (#263)", async () => {
    for (const bound of [true, false]) {
      const ingest: DurableObjectNamespaceLike = { idFromName: (name) => name, get: () => ({ fetch: () => Promise.resolve(Response.json({ status: "done" })) }) };
      const { env, github, storage } = environment(bound ? { REPO_INGEST: ingest } : {});
      globalThis.fetch = github.fetch;
      github.install("octo", { id: 71 });
      const repo = github.repo("octo", "docs", { id: 801 });
      expect((await worker.fetch(webhook(github, "installation", { action: "created", installation: { id: 71, account: { login: "octo" } }, repositories: [github.repoJson(repo)] }), env)).status).toBe(202);
      expect((await worker.fetch(webhook(github, "installation_repositories", { action: "removed", installation: { id: 71 }, repositories_removed: [github.repoJson(repo)] }), env)).status).toBe(202);
      expect((await storage.list({ prefix: "purge:" })).size).toBe(bound ? 1 : 0);
    }
  });

  it("exposes only the handler and the directory class from its main module", () => {
    expect(Object.keys(entry).sort()).toEqual(["RepoAccessDirectory", "default"]);
    expect(entry.default).toBe(worker);
  });

  it("logs one JSON line per event", () => {
    log("access.refresh", { repositories: 3 });
    expect(console.log).toHaveBeenCalledWith('{"event":"access.refresh","repositories":3}');
  });

  it("turns a malformed directory answer into unavailable", async () => {
    const env = { REPO_ACCESS_DIRECTORY: { idFromName: () => "x", get: () => ({ fetch: () => Promise.resolve(Response.json({ repo: { id: "x" } })) }) } } as unknown as ControlWorkerEnv;
    await expect(directorySource(env).authorize("u", "octo", "docs")).rejects.toThrow("unavailable");
  });
});
