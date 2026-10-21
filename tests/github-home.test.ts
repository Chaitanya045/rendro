import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableObjectNamespaceLike } from "../src/ingest/orchestrator/coordinator-client";
import { MAX_HOME_REPOSITORIES, MIRROR_TTL_MS } from "../src/repo-access/directory";
import worker, { RepoAccessDirectory, RepoAccessService, type ControlWorkerEnv } from "../src/repo-access/worker";
import { homeRepositories } from "@/home-repositories";
import authPages from "@/routes/auth-pages";
import { FakeGitHub } from "./helpers/fake-github";
import { FakeDirectoryStorage, FakeEpochKv, TOKEN_KEY } from "./helpers/repo-access-fixture";

/**
 * The reader's home (#338): the repositories their permission mirror lists, never a GitHub call per view, scoped
 * to what GitHub lets them read, with empty, unlinked and failure states.
 */

const SECRET = "test-webhook-secret-0123456789abcdef";
const originalFetch = globalThis.fetch;
beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function control() {
  const github = new FakeGitHub();
  const time = { now: Date.now() };
  github.now = () => time.now;
  vi.spyOn(Date, "now").mockImplementation(() => time.now);
  const storage = new FakeDirectoryStorage();
  let instance: RepoAccessDirectory | null = null;
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name) => name,
    get: () => ({ fetch: (input, init) => (instance ??= new RepoAccessDirectory({ storage }, env)).fetch(new Request(input, init)) }),
  };
  const env: ControlWorkerEnv = {
    REPO_ACCESS_DIRECTORY: namespace, REPO_EPOCHS: new FakeEpochKv(), GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_TOKEN_KEY: TOKEN_KEY,
    GITHUB_API_ORIGIN: github.origin, GITHUB_WEB_ORIGIN: github.webOrigin, GITHUB_APP_CLIENT_ID: github.clientId, GITHUB_APP_CLIENT_SECRET: github.clientSecret,
    GITHUB_APP_ID: github.appId, GITHUB_APP_PRIVATE_KEY: github.appPrivateKey,
  };
  globalThis.fetch = github.fetch;
  const binding = { fetch: (request: Request) => RepoAccessService.fetch(request, env) };
  const internal = (path: string, body: unknown) => RepoAccessService.fetch(new Request(`https://repo-access.internal${path}`, { method: "POST", body: JSON.stringify(body) }), env);
  const deliver = async (event: string, payload: unknown) => {
    const { body, headers } = github.webhook(SECRET, event, payload);
    return (await worker.fetch(new Request("https://control.rendro.test/v1/github/webhook", { method: "POST", body, headers }), env)).status;
  };
  const link = async (userId: string, login: string, id: number) => {
    const user = github.user(login, id);
    expect((await internal("/v1/accounts/link", { userId, githubId: id, login, tokens: github.signIn(user) })).status).toBe(204);
    return user;
  };
  return { github, time, binding, internal, deliver, link };
}

/** octo: the app installed on every repository; a private handbook the reader collaborates on, a private secret they do not. */
async function world() {
  const c = control();
  const reader = await c.link("u-reader", "reader", 5001);
  await c.link("u-outsider", "outsider", 5002);
  const installation = c.github.install("octo", { id: 71 });
  const handbook = c.github.repo("octo", "handbook", { id: 801, private: true });
  const secret = c.github.repo("octo", "secret", { id: 802, private: true });
  const notes = c.github.repo("octo", "notes", { id: 803 });
  handbook.collaborators.add(reader.id);
  notes.collaborators.add(reader.id);
  handbook.pushedAt = Date.parse("2026-10-01T09:30:00Z");
  notes.pushedAt = Date.parse("2026-10-05T12:00:00Z");
  expect(await c.deliver("installation", { action: "created", installation: { id: 71, account: { login: "octo" } }, repositories: [handbook, secret, notes].map(repo => c.github.repoJson(repo)) })).toBe(202);
  return { ...c, reader, installation, handbook, secret, notes };
}

describe("the home's repositories in the control Worker (#338)", () => {
  it("lists exactly what the reader can read, most recently pushed first, with visibility and the last push", async () => {
    const { binding } = await world();
    expect(await homeRepositories(binding, "u-reader")).toEqual({ kind: "list", truncated: false, repositories: [
      { owner: "octo", name: "notes", private: false, pushedAt: Date.parse("2026-10-05T12:00:00Z") },
      { owner: "octo", name: "handbook", private: true, pushedAt: Date.parse("2026-10-01T09:30:00Z") },
    ] });
    // Another reader never sees a private repository they cannot read, nor its name.
    expect(await homeRepositories(binding, "u-outsider")).toEqual({ kind: "list", truncated: false, repositories: [] });
  });

  it("answers from the mirror while it is fresh, and lists again once it is stale", async () => {
    const { binding, github, time } = await world();
    await homeRepositories(binding, "u-reader");
    github.resetLog();
    await homeRepositories(binding, "u-reader");
    expect(github.requests).toEqual([]);
    time.now += MIRROR_TTL_MS;
    await homeRepositories(binding, "u-reader");
    expect(github.count("user-installations")).toBe(1);
    // An unchanged listing is a 304, which costs no quota.
    expect(github.billable()).toBe(0);
  });

  it("drops a removed repository and a suspended installation's repositories at once", async () => {
    const { binding, deliver, github, notes, handbook, installation } = await world();
    await homeRepositories(binding, "u-reader");
    installation.repositories = new Set([handbook.id]);
    expect(await deliver("installation_repositories", { action: "removed", installation: { id: 71 }, repositories_removed: [github.repoJson(notes)] })).toBe(202);
    expect((await homeRepositories(binding, "u-reader") as { repositories: unknown[] }).repositories).toEqual([expect.objectContaining({ name: "handbook" })]);
    installation.suspended = true;
    expect(await deliver("installation", { action: "suspend", installation: { id: 71, account: { login: "octo" } } })).toBe(202);
    expect(await homeRepositories(binding, "u-reader")).toEqual({ kind: "list", truncated: false, repositories: [] });
  });

  it("is unlinked without GitHub tokens, and unavailable when GitHub cannot list a stale mirror", async () => {
    const { binding, github, time, reader, internal } = await world();
    expect(await homeRepositories(binding, "u-nobody")).toEqual({ kind: "unlinked" });
    await homeRepositories(binding, "u-reader");
    time.now += MIRROR_TTL_MS;
    github.failingUsers.add(reader.id);
    expect(await homeRepositories(binding, "u-reader")).toEqual({ kind: "unavailable" });
    github.failingUsers.delete(reader.id);
    // A revoked authorization forgets the tokens: the reader connects GitHub again.
    time.now += 10_000;
    github.revokeAuthorization(reader);
    expect(await homeRepositories(binding, "u-reader")).toEqual({ kind: "unlinked" });
    expect((await internal("/v1/accounts/repositories", { userId: "" })).status).toBe(400);
    // A body that is not JSON is refused the same way.
    expect((await RepoAccessService.fetch(new Request("https://repo-access.internal/v1/accounts/repositories", { method: "POST", body: "not json" }), {} as ControlWorkerEnv)).status).toBe(400);
    expect((await RepoAccessService.fetch(new Request("https://repo-access.internal/v1/accounts/repositories"), {} as ControlWorkerEnv)).status).toBe(405);
  });

  it("lists at most the 500 most recently pushed repositories", async () => {
    const c = control();
    const reader = await c.link("u-many", "many", 5003);
    c.github.install("many", { id: 72 });
    for (let index = 0; index <= MAX_HOME_REPOSITORIES; index += 1) {
      const repo = c.github.repo("many", `docs-${index}`, { id: 2000 + index });
      repo.pushedAt = Date.parse("2026-01-01T00:00:00Z") + index * 1000;
    }
    void reader;
    const listed = await homeRepositories(c.binding, "u-many");
    expect(listed.kind).toBe("list");
    const { repositories, truncated } = listed as { repositories: Array<{ name: string }>; truncated: boolean };
    expect(truncated).toBe(true);
    expect(repositories).toHaveLength(MAX_HOME_REPOSITORIES);
    expect(repositories[0].name).toBe(`docs-${MAX_HOME_REPOSITORIES}`);
    expect(repositories.some(repo => repo.name === "docs-0")).toBe(false);
  });

  it("orders repositories without a push by name, after those with one", async () => {
    const c = control();
    await c.link("u-names", "names", 5004);
    c.github.install("names", { id: 73 });
    for (const name of ["zeta", "Alpha", "beta"]) c.github.repo("names", name, { id: 3000 + name.length + name.charCodeAt(0) });
    c.github.repos.get("names/beta")!.pushedAt = Date.parse("2026-02-01T00:00:00Z");
    const listed = await homeRepositories(c.binding, "u-names") as { repositories: Array<{ name: string }> };
    expect(listed.repositories.map(repo => repo.name)).toEqual(["beta", "Alpha", "zeta"]);
  });
});

describe("reading the home's repositories in the serving Worker (#338)", () => {
  const answering = (status: number, body: unknown) => ({ fetch: () => Promise.resolve(new Response(JSON.stringify(body), { status })) });

  it("accepts only a well-formed answer", async () => {
    const repo = { owner: "octo", name: "docs", private: true, pushedAt: null };
    expect(await homeRepositories(answering(200, { linked: true, repositories: [repo], truncated: false }), "u")).toEqual({ kind: "list", repositories: [repo], truncated: false });
    expect(await homeRepositories(answering(200, { linked: false }), "u")).toEqual({ kind: "unlinked" });
    for (const body of [null, {}, { linked: true }, { linked: true, repositories: [], truncated: "no" }, { linked: true, repositories: {}, truncated: false },
      ...[{ owner: "-bad" }, { name: "../x" }, { private: "yes" }, { pushedAt: 0 }, { pushedAt: 1.5 }, null].map(change => ({ linked: true, repositories: [change === null ? null : { ...repo, ...change }], truncated: false }))]) {
      expect(await homeRepositories(answering(200, body), "u"), JSON.stringify(body)).toEqual({ kind: "unavailable" });
    }
    expect(await homeRepositories(answering(503, { error: "Unavailable" }), "u")).toEqual({ kind: "unavailable" });
    expect(await homeRepositories({ fetch: () => Promise.reject(new Error("binding down")) }, "u")).toEqual({ kind: "unavailable" });
    expect(await homeRepositories({ fetch: () => Promise.resolve(new Response("not json")) }, "u")).toEqual({ kind: "unavailable" });
  });
});

describe("the home page (#338)", () => {
  const reader = { id: "u-reader", name: "Ada Reader", email: "ada@example.test" } as User;
  function home(binding: { fetch(request: Request): Promise<Response> } | null, user: User | null = reader) {
    const pages = new Hono<{ Variables: { user?: User } }>();
    pages.use("*", async (c, next) => { if (user) c.set("user", user); await next(); });
    pages.route("/", authPages);
    return async (path = "/home") => {
      const response = await pages.request(path, {}, binding ? { REPO_ACCESS: binding } : {});
      return { response, html: await response.text() };
    };
  }
  const listing = (body: unknown) => ({ fetch: () => Promise.resolve(Response.json(body)) });
  const github = () => { vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.fixture"); vi.stubEnv("GITHUB_APP_SLUG", "rendro-docs"); };

  it("lists the reader's repositories, each a link to its docs, with the install link", async () => {
    github();
    const { html } = await home(listing({ linked: true, truncated: false, repositories: [
      { owner: "octo", name: "handbook", private: true, pushedAt: Date.parse("2026-10-01T09:30:00Z") },
      { owner: "octo", name: "notes", private: false, pushedAt: null },
    ] }))();
    expect(html).toContain('<a class="repo-link" href="/r/octo/handbook"><span class="repo-name">octo/<strong>handbook</strong></span><span class="repo-meta"><span class="repo-badge">Private</span><span class="repo-updated">Updated <time datetime="2026-10-01T09:30:00.000Z">Oct 1, 2026</time></span></span></a>');
    expect(html).toContain('<a class="repo-link" href="/r/octo/notes"><span class="repo-name">octo/<strong>notes</strong></span><span class="repo-meta"></span></a>');
    expect(html).toContain('<a class="home-install" href="https://github.com/apps/rendro-docs/installations/new">Install the app on more repositories</a>');
    expect(html).toContain('class="card wide"');
    expect(html).not.toContain("home-open-title");
  });

  it("explains an empty list, offers to connect GitHub, and offers to try again", async () => {
    github();
    const empty = (await home(listing({ linked: true, truncated: false, repositories: [] }))()).html;
    expect(empty).toContain("No repositories yet.");
    expect(empty).toContain('<a class="button primary" href="https://github.com/apps/rendro-docs/installations/new">Install the app</a>');
    const unlinked = (await home(listing({ linked: false }))()).html;
    expect(unlinked).toContain("Connect your GitHub account to see the repositories you can read.");
    expect(unlinked).toContain('<form id="github-form" class="github-form" novalidate="" data-action="link" data-callback="/home">');
    const failed = (await home({ fetch: () => Promise.resolve(new Response(null, { status: 503 })) })()).html;
    expect(failed).toContain('<div class="repo-state" role="alert"><p>We couldn&#39;t load your repositories right now. Please try again.</p><a class="button secondary" href="/home">Try again</a></div>');
    const truncated = (await home(listing({ linked: true, truncated: true, repositories: [{ owner: "o", name: "r", private: false, pushedAt: null }] }))()).html;
    expect(truncated).toContain("Showing the 500 most recently updated repositories.");
  });

  it("shows the notice of the setup URL it came from, and no install link without the App's slug", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.fixture");
    const visit = home(listing({ linked: true, truncated: false, repositories: [] }));
    expect((await visit("/home?github=installed")).html).toContain('<p class="home-notice" role="status">GitHub updated the app&#39;s installation. Your repositories are listed again.</p>');
    expect((await visit("/home?github=requested")).html).toContain("An organization owner has to approve the installation.");
    const plain = (await visit("/home?github=other")).html;
    expect(plain).not.toContain(`class="home-notice"`);
    expect(plain).not.toContain("installations/new");
  });

  it("keeps the home of an install without GitHub sign-in or without the permission mirror", async () => {
    const fetch = vi.fn();
    const without = (await home({ fetch })()).html;
    expect(without).toContain("home-open-title");
    expect(fetch).not.toHaveBeenCalled();
    github();
    expect((await home(null)()).html).toContain("home-open-title");
    expect((await home(listing({}), null)()).response.headers.get("location")).toBe("/sign-in?returnTo=%2Fhome");
  });
});

describe("the home's repositories, against storage (#338)", () => {
  it("leaves out what the registry no longer backs, and is unavailable when refreshes never settle or fail outright", async () => {
    const { accessFixture } = await import("./helpers/repo-access-fixture");
    const world = accessFixture();
    await world.setup();
    const names = async () => (await world.directory.repositories(world.userIds.reader)).repositories.map(repo => repo.name).sort();
    // The reader collaborates on closed-docs; open-docs is public but not theirs, so their listing names closed-docs alone.
    expect(await names()).toEqual(["closed-docs"]);
    const entry = await world.storage.get<Record<string, unknown>>("repo:802");
    for (const broken of [{ ...entry, removed: true }, { ...entry, installation: null }, { ...entry, installation: 99 }, undefined]) {
      if (broken) await world.storage.put("repo:802", broken);
      else await world.storage.delete(["repo:802"]);
      expect(await names(), JSON.stringify(broken)).toEqual([]);
    }
    await world.storage.put("repo:802", entry);
    expect(await names()).toEqual(["closed-docs"]);
    // A refresh that never commits (webhooks keep changing the reader): unknown, after a bounded number of tries.
    const directory = world.directory as unknown as { refreshMirror(): Promise<null> };
    const stuck = vi.spyOn(directory, "refreshMirror").mockResolvedValue(null);
    await world.storage.delete([`mirror:${world.userIds.reader}`]);
    await expect(world.directory.repositories(world.userIds.reader)).rejects.toThrow("unavailable");
    expect(stuck).toHaveBeenCalledTimes(6);
    stuck.mockRejectedValue(new Error("storage failed"));
    await expect(world.directory.repositories(world.userIds.reader)).rejects.toThrow("unavailable");
    expect(world.logs.at(-1)).toEqual({ event: "access.unavailable", fields: { reason: "error" } });
  });
});
