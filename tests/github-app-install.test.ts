import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableObjectNamespaceLike } from "../src/ingest/orchestrator/coordinator-client";
import { appJwtSigner, mintedInstallationTokens } from "../src/ingest/github/app-auth";
import { HttpWebhookDeliveries, unconfiguredDeliveries } from "../src/ingest/github/deliveries";
import { HttpGitHubSource } from "../src/ingest/github/http-source";
import { staticTokenProvider } from "../src/ingest/github/token";
import { ingestTokens, webhookDeliveries } from "../src/ingest/orchestrator/worker";
import { serviceRepoPermissions } from "../src/repo-read/access";
import { planEvent } from "../src/repo-access/events";
import { GitHubAccessClient } from "../src/repo-access/github";
import { confirmRemoval } from "../src/repo-access/removal";
import worker, { RepoAccessDirectory, RepoAccessService, type ControlWorkerEnv } from "../src/repo-access/worker";
import githubSetup from "@/routes/github-setup";
import { logger } from "@/logger";
import { FakeGitHub } from "./helpers/fake-github";
import { FakeDirectoryStorage, FakeEpochKv, TOKEN_KEY } from "./helpers/repo-access-fixture";
import { FakeClock } from "./helpers/ingest-fixture";

/**
 * The GitHub App's own credentials in the Workers (#338): installation tokens minted from its key replace
 * GITHUB_DEV_TOKEN, installs reach the installer's mirror at once, and the App's setup URL lists it again.
 */

const SECRET = "test-webhook-secret-0123456789abcdef";
const originalFetch = globalThis.fetch;
beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function control(overrides: Partial<ControlWorkerEnv> = {}) {
  const github = new FakeGitHub();
  const storage = new FakeDirectoryStorage();
  let instance: RepoAccessDirectory | null = null;
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name) => name,
    get: () => ({ fetch: (input, init) => (instance ??= new RepoAccessDirectory({ storage }, env)).fetch(new Request(input, init)) }),
  };
  const env: ControlWorkerEnv = {
    REPO_ACCESS_DIRECTORY: namespace, REPO_EPOCHS: new FakeEpochKv(), GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_TOKEN_KEY: TOKEN_KEY,
    GITHUB_API_ORIGIN: github.origin, GITHUB_WEB_ORIGIN: github.webOrigin, GITHUB_APP_ID: github.appId, GITHUB_APP_PRIVATE_KEY: github.appPrivateKey, ...overrides,
  };
  globalThis.fetch = github.fetch;
  const source = serviceRepoPermissions({ fetch: (request) => RepoAccessService.fetch(request, env) });
  const internal = (path: string, body: unknown) => RepoAccessService.fetch(new Request(`https://repo-access.internal${path}`, { method: "POST", body: JSON.stringify(body) }), env);
  const deliver = async (event: string, payload: unknown) => {
    const { body, headers } = github.webhook(SECRET, event, payload);
    return (await worker.fetch(new Request("https://control.rendro.test/v1/github/webhook", { method: "POST", body, headers }), env)).status;
  };
  return { github, storage, env, source, internal, deliver };
}

describe("installation tokens in the control Worker (#338)", () => {
  it("mints them from the App's key instead of a development token, and keeps them sealed in its storage", async () => {
    const { github, storage, source, internal, deliver } = control();
    const reader = github.user("reader", 5001);
    github.install("octo", { id: 71 });
    const repo = github.repo("octo", "docs", { id: 801, private: true });
    repo.collaborators.add(reader.id);
    expect(await deliver("installation", { action: "created", installation: { id: 71, account: { login: "octo" } }, repositories: [github.repoJson(repo)] })).toBe(202);
    expect((await internal("/v1/accounts/link", { userId: "u1", githubId: reader.id, login: "reader", tokens: github.signIn(reader) })).status).toBe(204);
    expect(await source.authorize("u1", "octo", "docs")).toMatchObject({ id: 801 });
    // The installation check after `created` used a minted, installation-scoped token, never the shared one.
    expect(github.count("app-token")).toBe(1);
    expect(github.requests.filter(request => request.endpoint === "installation" || request.endpoint === "repository").every(request => request.authorization?.startsWith("Bearer ghs_71_"))).toBe(true);
    const sealed = await storage.get<string>("installation-token:71");
    expect(sealed).toMatch(/^v1\./);
    const minted = github.requests.find(request => request.endpoint === "installation")!.authorization!.slice("Bearer ".length);
    expect(sealed).not.toContain(minted);
  });

  it("falls back to GITHUB_DEV_TOKEN only without the App", async () => {
    const { github, source, deliver } = control({ GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined, GITHUB_DEV_TOKEN: "fake-installation-token" });
    github.install("octo", { id: 71 });
    const repo = github.repo("octo", "docs", { id: 801 });
    expect(await deliver("installation", { action: "created", installation: { id: 71, account: { login: "octo" } }, repositories: [github.repoJson(repo)] })).toBe(202);
    expect(await source.authorize(null, "octo", "docs")).toMatchObject({ id: 801 });
    expect(github.count("app-token")).toBe(0);
    expect(github.requests.some(request => request.authorization === `Bearer ${github.token}`)).toBe(true);
  });

  it("defaults to api.github.com in production, where no API origin is set", async () => {
    const { github, storage, env } = control({ GITHUB_API_ORIGIN: undefined });
    const directory = new RepoAccessDirectory({ storage }, env);
    expect((await directory.fetch(new Request("https://directory/nowhere", { method: "POST", body: "{}" }))).status).toBe(404);
    expect(webhookDeliveries({ GITHUB_APP_ID: github.appId, GITHUB_APP_PRIVATE_KEY: github.appPrivateKey } as never)).toBeInstanceOf(HttpWebhookDeliveries);
  });

  it("confirms an uninstall from the minted token's 404", async () => {
    const clock = new FakeClock();
    const github = new FakeGitHub();
    github.now = clock.now;
    github.install("octo", { id: 71 });
    github.repo("octo", "docs", { id: 801 });
    const installationTokens = mintedInstallationTokens({ app: appJwtSigner({ appId: github.appId, privateKey: github.appPrivateKey }, clock.now), apiOrigin: github.origin, fetch: github.fetch, now: clock.now });
    const check = { github: new GitHubAccessClient({ apiOrigin: github.origin, fetch: github.fetch, clock }), installationTokens };
    const target = { id: 801, owner: "octo", name: "docs", installation: 71 };
    expect(await confirmRemoval(check, target)).toMatchObject({ kind: "accessible" });
    github.installations.delete(71);
    installationTokens.invalidate(71);
    expect(await confirmRemoval(check, target)).toEqual({ kind: "removed" });
  });
});

describe("a new installation reaches its installer at once (#338)", () => {
  async function linkedReader() {
    const world = control();
    const reader = world.github.user("reader", 5001);
    expect((await world.internal("/v1/accounts/link", { userId: "u1", githubId: reader.id, login: "reader", tokens: world.github.signIn(reader) })).status).toBe(204);
    // A fresh mirror with nothing in it yet.
    expect(await world.source.authorize("u1", "reader", "notes")).toBeNull();
    return { ...world, reader };
  }

  it("through the installation event's sender", async () => {
    const { github, source, deliver, reader } = await linkedReader();
    github.install("reader", { id: 72 });
    const repo = github.repo("reader", "notes", { id: 802, private: true });
    expect(await deliver("installation", { action: "created", installation: { id: 72, account: { login: "reader" } }, repositories: [github.repoJson(repo)], sender: { id: reader.id, login: "reader" } })).toBe(202);
    expect(await source.authorize("u1", "reader", "notes")).toMatchObject({ id: 802 });
  });

  it("through the repositories-added event's sender", async () => {
    const { github, source, deliver, reader } = await linkedReader();
    const installation = github.install("reader", { id: 72, repositories: [] });
    const repo = github.repo("reader", "notes", { id: 802, private: true });
    expect(await deliver("installation", { action: "created", installation: { id: 72, account: { login: "reader" } }, repositories: [] })).toBe(202);
    expect(await source.authorize("u1", "reader", "notes")).toBeNull();
    installation.repositories = new Set([802]);
    expect(await deliver("installation_repositories", { action: "added", installation: { id: 72 }, repositories_added: [github.repoJson(repo)], sender: { id: reader.id } })).toBe(202);
    expect(await source.authorize("u1", "reader", "notes")).toMatchObject({ id: 802 });
  });

  it("through the setup URL's refresh, even when no event arrived", async () => {
    const { github, source, internal } = await linkedReader();
    github.install("reader", { id: 72 });
    github.repo("reader", "notes", { id: 802, private: true });
    expect(await source.authorize("u1", "reader", "notes")).toBeNull();
    expect((await internal("/v1/accounts/refresh", { userId: "u1" })).status).toBe(204);
    expect(await source.authorize("u1", "reader", "notes")).toMatchObject({ id: 802 });
    // An unknown user changes nothing; a malformed request is refused.
    expect((await internal("/v1/accounts/refresh", { userId: "nobody" })).status).toBe(204);
    expect((await internal("/v1/accounts/refresh", { userId: "" })).status).toBe(400);
  });

  it("revokes on a repository's removal and on the uninstall, with minted tokens", async () => {
    const { github, source, deliver, reader } = await linkedReader();
    const installation = github.install("reader", { id: 72 });
    const notes = github.repo("reader", "notes", { id: 802, private: true });
    const guide = github.repo("reader", "guide", { id: 803, private: true });
    expect(await deliver("installation", { action: "created", installation: { id: 72, account: { login: "reader" } }, repositories: [github.repoJson(notes), github.repoJson(guide)], sender: { id: reader.id } })).toBe(202);
    expect(await source.authorize("u1", "reader", "notes")).toMatchObject({ id: 802 });
    expect(await source.authorize("u1", "reader", "guide")).toMatchObject({ id: 803 });
    installation.repositories = new Set([803]);
    expect(await deliver("installation_repositories", { action: "removed", installation: { id: 72 }, repositories_removed: [github.repoJson(notes)], sender: { id: reader.id } })).toBe(202);
    expect(await source.authorize("u1", "reader", "notes")).toBeNull();
    expect(await source.authorize("u1", "reader", "guide")).toMatchObject({ id: 803 });
    github.installations.delete(72);
    expect(await deliver("installation", { action: "deleted", installation: { id: 72, account: { login: "reader" } }, sender: { id: reader.id } })).toBe(202);
    expect(await source.authorize("u1", "reader", "guide")).toBeNull();
  });

  it("plans the sender only for permissive installation events", () => {
    const installation = { id: 72, account: { login: "reader" } };
    expect(planEvent("installation", { action: "created", installation, sender: { id: 9 } })).toMatchObject({ users: [9], revoke: false });
    expect(planEvent("installation", { action: "created", installation })).not.toHaveProperty("users");
    expect(planEvent("installation", { action: "created", installation, sender: { id: "9" } })).not.toHaveProperty("users");
    expect(planEvent("installation", { action: "deleted", installation, sender: { id: 9 } })).not.toHaveProperty("users");
    expect(planEvent("installation_repositories", { action: "added", installation, repositories_added: [], sender: { id: 9 } })).toMatchObject({ users: [9] });
    expect(planEvent("installation_repositories", { action: "removed", installation, repositories_removed: [], sender: { id: 9 } })).not.toHaveProperty("users");
  });
});

describe("the ingest Worker's GitHub credentials (#338)", () => {
  it("mints installation tokens once per isolate and App, and uses the development token only without the App", async () => {
    const github = new FakeGitHub();
    const env = { GITHUB_APP_ID: github.appId, GITHUB_APP_PRIVATE_KEY: github.appPrivateKey, GITHUB_API_ORIGIN: github.origin } as never;
    const minted = ingestTokens(env);
    expect(ingestTokens(env)).toBe(minted);
    expect(ingestTokens({ ...(env as object), GITHUB_API_ORIGIN: undefined } as never)).not.toBe(minted);
    expect(typeof minted.installationOf).toBe("function");
    const fallback = ingestTokens({ GITHUB_DEV_TOKEN: "dev" } as never);
    expect(await fallback.token(1)).toBe("dev");
    expect(await ingestTokens({} as never).token(1)).toBeNull();
    expect(webhookDeliveries(env)).toBeInstanceOf(HttpWebhookDeliveries);
    expect(webhookDeliveries({} as never)).toBe(unconfiguredDeliveries);
  });

  it("reads the App's webhook deliveries with its JWT", async () => {
    const github = new FakeGitHub();
    globalThis.fetch = github.fetch;
    const deliveries = webhookDeliveries({ GITHUB_APP_ID: github.appId, GITHUB_APP_PRIVATE_KEY: github.appPrivateKey, GITHUB_API_ORIGIN: github.origin } as never);
    expect(await deliveries.list(null)).toEqual({ deliveries: [], next: null });
  });

  it("resolves the installation of a first view's repository, which its reference does not name", async () => {
    const github = new FakeGitHub();
    github.install("octo", { id: 71 });
    const secret = github.repo("octo", "secret", { id: 801, private: true });
    secret.commit({ "README.md": "# Secret\n" });
    const open = github.repo("solo", "open", { id: 802 });
    open.commit({ "README.md": "# Open\n" });
    const tokens = mintedInstallationTokens({ app: appJwtSigner({ appId: github.appId, privateKey: github.appPrivateKey }), apiOrigin: github.origin, fetch: github.fetch });
    const source = new HttpGitHubSource({ tokens, fetch: github.fetch, apiOrigin: github.origin, clock: new FakeClock() });
    expect(await source.getRef({ ...secret.ref, installationId: null }, "main")).toMatchObject({ sha: secret.head() });
    expect(github.requests.find(request => request.endpoint === "ref")?.authorization).toMatch(/^Bearer ghs_71_/);
    // Not installed: read without a token, as before.
    expect(await source.getRef({ ...open.ref, installationId: null }, "main")).toMatchObject({ sha: open.head() });
    expect(github.requests.filter(request => request.endpoint === "ref").at(-1)?.authorization).toBeNull();
    // A static provider names no installation: the reference's own is used.
    const plain = new HttpGitHubSource({ tokens: staticTokenProvider(null), fetch: github.fetch, apiOrigin: github.origin, clock: new FakeClock() });
    expect(await plain.getRef({ ...open.ref, installationId: null }, "main")).toMatchObject({ sha: open.head() });
  });
});

describe("the GitHub App's setup URL (#338)", () => {
  function app(user: User | null, binding: { fetch(request: Request): Promise<Response> } | null) {
    const pages = new Hono<{ Variables: { user?: User } }>();
    pages.use("*", async (c, next) => { if (user) c.set("user", user); await next(); });
    pages.route("/", githubSetup);
    return (path: string) => pages.request(path, {}, binding ? { REPO_ACCESS: binding } : {});
  }
  const reader = { id: "u1", name: "Reader", email: "reader@example.test" } as User;

  it("lists the installer's repositories again and returns them home, whatever installation the URL names", async () => {
    const calls: unknown[] = [];
    const binding = { fetch: async (request: Request) => { calls.push({ url: request.url, body: await request.json() }); return new Response(null, { status: 204 }); } };
    const response = await app(reader, binding)("/github/setup?installation_id=999&setup_action=install");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/home?github=installed");
    expect(calls).toEqual([{ url: "https://repo-access.internal/v1/accounts/refresh", body: { userId: "u1" } }]);
    expect((await app(reader, binding)("/github/setup?setup_action=request")).headers.get("location")).toBe("/home?github=requested");
  });

  it("sends a signed-out installer to sign in first, and still returns home without the binding or when the refresh fails", async () => {
    expect((await app(null, null)("/github/setup?installation_id=1")).headers.get("location")).toBe("/sign-in?returnTo=%2Fhome");
    expect((await app(reader, null)("/github/setup")).headers.get("location")).toBe("/home?github=installed");
    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});
    const failing = { fetch: () => Promise.resolve(new Response(null, { status: 503 })) };
    expect((await app(reader, failing)("/github/setup")).headers.get("location")).toBe("/home?github=installed");
    expect(errors).toHaveBeenCalledWith({ category: "GitHubHandOff", outcome: "refresh-unavailable" }, "GitHub account was not refreshed");
  });
});
