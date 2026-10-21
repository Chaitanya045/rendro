import { describe, expect, it, vi } from "vitest";
import { RateGovernor } from "../src/ingest/github/rate-governor";
import type { GitHubError } from "../src/ingest/github/source";
import { GitHubAccessClient, moderationRoleOf, parseListedRepo } from "../src/repo-access/github";
import { FakeGitHub } from "./helpers/fake-github";
import { FakeClock } from "./helpers/ingest-fixture";

/** The permission endpoints the mirror reads (#243), against the fake GitHub. */

function setup(options: ConstructorParameters<typeof GitHubAccessClient>[0] = {}) {
  const clock = new FakeClock();
  const github = new FakeGitHub();
  github.now = clock.now;
  github.rate.reset = Math.floor(clock.time / 1000) + 3600;
  const client = new GitHubAccessClient({ apiOrigin: github.origin, fetch: github.fetch, clock, ...options });
  const installation = github.install("octo", { id: 71 });
  const reader = github.user("reader", 5001);
  const tokens = github.signIn(reader);
  return { clock, github, client, installation, reader, token: tokens.accessToken };
}

async function failure(promise: Promise<unknown>): Promise<GitHubError> {
  try {
    await promise;
  } catch (error) {
    return error as GitHubError;
  }
  throw new Error("Expected a failure");
}

describe("GitHubAccessClient", () => {
  it("lists installations and repositories in pages, with ETags", async () => {
    const { github, client, token, reader } = setup();
    github.install("reader", { id: 72, suspended: true });
    for (let index = 0; index < 150; index += 1) github.repo("octo", `docs-${index}`, { id: 1000 + index, private: true }).collaborators.add(reader.id);
    const installations = await client.userInstallations("user:u", token, 1, null);
    expect(installations).toEqual({ items: [{ id: 71, account: "octo", suspended: false }, { id: 72, account: "reader", suspended: true }], etag: expect.stringMatching(/^W\//) as string, next: false });
    const first = await client.installationRepositories("user:u", token, 71, 1, null);
    expect(first?.items).toHaveLength(100);
    expect(first?.items[0]).toEqual({ id: 1000, owner: "octo", name: "docs-0", private: true, defaultBranch: "main" });
    expect(first?.next).toBe(true);
    const second = await client.installationRepositories("user:u", token, 71, 2, null);
    expect(second?.items).toHaveLength(50);
    expect(second?.next).toBe(false);
    // Unchanged pages answer 304, which costs nothing.
    github.resetLog();
    expect(await client.userInstallations("user:u", token, 1, installations?.etag ?? null)).toBeNull();
    expect(await client.installationRepositories("user:u", token, 71, 1, first?.etag ?? null)).toBeNull();
    expect(github.billable()).toBe(0);
    expect(client.requests).toBe(5);
  });

  it("lists the reader's moderation role per repository, and a role change is a changed page (#259)", async () => {
    const { github, client, token, reader } = setup();
    const docs = github.repo("octo", "docs", { id: 801, private: true });
    const guide = github.repo("octo", "guide", { id: 802, private: true });
    const plain = github.repo("octo", "plain", { id: 803, private: true });
    docs.roles.set(reader.id, "admin");
    guide.roles.set(reader.id, "maintain");
    plain.roles.set(reader.id, "write");
    const listed = await client.installationRepositories("user:u", token, 71, 1, null);
    expect(listed?.items.map((repo) => [repo.name, repo.role])).toEqual([["docs", "admin"], ["guide", "maintain"], ["plain", undefined]]);
    // Demoted: the same request is not a 304, so a conditional refresh cannot keep a role GitHub withdrew.
    guide.roles.set(reader.id, "triage");
    const demoted = await client.installationRepositories("user:u", token, 71, 1, listed?.etag ?? null);
    expect(demoted?.items.map((repo) => repo.role)).toEqual(["admin", undefined, undefined]);
    // A listing that states nothing about permissions gives no role.
    github.fault(/\/user\/installations\/71\/repositories/, () => Response.json({ repositories: [{ id: 801, name: "docs", owner: { login: "octo" }, private: true, default_branch: "main", pushed_at: "2026-01-01T00:00:00Z" }] }));
    expect((await client.installationRepositories("user:u", token, 71, 1, null))?.items).toEqual([{ id: 801, owner: "octo", name: "docs", private: true, defaultBranch: "main", pushedAt: Date.parse("2026-01-01T00:00:00Z") }]);
  });

  it("reads an installation the user cannot reach, or a suspended one, as empty", async () => {
    const { github, client, token } = setup();
    github.install("other", { id: 73, suspended: true });
    github.repo("other", "docs", { id: 900, private: true }).collaborators.add(5001);
    expect(await client.installationRepositories("user:u", token, 99, 1, null)).toEqual({ items: [], etag: null, next: false });
    expect(await client.installationRepositories("user:u", token, 73, 1, null)).toEqual({ items: [], etag: null, next: false });
  });

  it("confirms repositories and installations with an installation token", async () => {
    const { github, client, installation } = setup();
    const repo = github.repo("octo", "docs", { id: 801, private: true });
    const first = await client.repository("installation:71", github.token, "octo", "docs");
    expect(first).toEqual({ id: 801, owner: "octo", name: "docs", private: true, defaultBranch: "main", etag: expect.stringMatching(/^W\/"/) });
    // Conditional with the earlier answer: unchanged is a 304 that answers it again, changed is the new state and validator.
    github.resetLog();
    expect(await client.repository("installation:71", github.token, "octo", "docs", first)).toBe(first);
    expect(github.count("repository", { status: 304 })).toBe(1);
    repo.isPrivate = false;
    const changed = await client.repository("installation:71", github.token, "octo", "docs", first);
    expect(changed).toMatchObject({ private: false });
    expect(changed?.etag).not.toBe(first?.etag);
    repo.isPrivate = true;
    expect(await client.repository("installation:71", github.token, "octo", "missing")).toBeNull();
    expect(await client.repository("installation:71", null, "octo", "docs")).toBeNull();
    // A renamed repository redirects within the API origin.
    github.rename(repo, "octo", "handbook");
    expect(await client.repository("installation:71", github.token, "octo", "docs")).toMatchObject({ name: "handbook" });
    expect(await client.installationActive("installation:71", github.token)).toBe(true);
    const scoped = github.installationToken(installation);
    installation.suspended = true;
    expect(await client.installationActive("installation:71", scoped)).toBe(false);
    expect((await failure(client.installationActive("installation:71", null))).kind).toBe("unauthorized");
    github.fault(/\/installation\/repositories/, () => new Response("", { status: 404 }));
    expect(await client.installationActive("installation:71", github.token)).toBe(false);
  });

  it("asks whether one person may read one repository", async () => {
    const { github, client, reader } = setup();
    const repo = github.repo("octo", "docs", { id: 801, private: true });
    const access = (login = "reader") => client.collaboratorAccess("installation:71", github.token, "octo", "docs", login);
    expect(await access()).toEqual({ read: false, role: null });
    repo.collaborators.add(reader.id);
    expect(await access()).toEqual({ read: true, role: null });
    expect(await access("nobody")).toEqual({ read: false, role: null });
    github.fault(/permission$/, () => Response.json({ role_name: "read" }));
    expect((await failure(access())).kind).toBe("invalid-response");
    github.fault(/permission$/, () => new Response("down", { status: 500 }), 2);
    expect((await failure(access())).kind).toBe("server");
  });

  it("reads the moderation role from role_name, and only an admin from the legacy permission when it is missing (#259)", async () => {
    const { github, client, reader } = setup();
    const repo = github.repo("octo", "docs", { id: 801, private: true });
    const access = () => client.collaboratorAccess("installation:71", github.token, "octo", "docs", "reader");
    // The legacy `permission` calls maintain "write" and triage "read": role_name tells them apart.
    for (const [role, expected] of [["read", null], ["triage", null], ["write", null], ["maintain", "maintain"], ["admin", "admin"]] as const) {
      repo.roles.set(reader.id, role);
      expect(await access()).toEqual({ read: true, role: expected });
    }
    // No role_name (older servers): the legacy admin is an admin, write cannot be told from maintain, so it is none.
    github.fault(/permission$/, () => Response.json({ permission: "admin" }));
    expect(await access()).toEqual({ read: true, role: "admin" });
    github.fault(/permission$/, () => Response.json({ permission: "write" }));
    expect(await access()).toEqual({ read: true, role: null });
    // A custom role is none, and so is any role GitHub names for someone who cannot read at all.
    github.fault(/permission$/, () => Response.json({ permission: "read", role_name: "docs-editor" }));
    expect(await access()).toEqual({ read: true, role: null });
    github.fault(/permission$/, () => Response.json({ permission: "none", role_name: "admin" }));
    expect(await access()).toEqual({ read: false, role: null });
    github.fault(/permission$/, () => Response.json({ permission: "admin", role_name: 7 }));
    expect(await access()).toEqual({ read: true, role: "admin" });
  });

  it("takes a listed repository's role only from a literal true (#259)", () => {
    expect(moderationRoleOf({ admin: true, maintain: true, push: true, triage: true, pull: true })).toBe("admin");
    expect(moderationRoleOf({ admin: false, maintain: true })).toBe("maintain");
    for (const unknown of [undefined, null, "admin", 1, [], {}, { admin: "true", maintain: 1 }, { admin: false, maintain: false, push: true }]) {
      expect(moderationRoleOf(unknown)).toBeUndefined();
    }
  });

  it("classifies failures and rejects unexpected shapes", async () => {
    const { github, client, token } = setup();
    github.repo("octo", "docs", { id: 801 });
    github.fault(/\/user\/installations/, () => Response.json({ message: "Bad credentials" }, { status: 401 }));
    expect((await failure(client.userInstallations("user:u", token, 1, null))).kind).toBe("unauthorized");
    github.fault(/\/user\/installations/, () => Response.json({ installations: "nope" }));
    expect((await failure(client.userInstallations("user:u", token, 1, null))).kind).toBe("invalid-response");
    github.fault(/\/user\/installations/, () => Response.json({ installations: [{ id: 1 }] }));
    expect((await failure(client.userInstallations("user:u", token, 1, null))).kind).toBe("invalid-response");
    github.fault(/\/user\/installations\/71/, () => Response.json({ repositories: [{ id: 1, name: "x" }] }));
    expect((await failure(client.installationRepositories("user:u", token, 71, 1, null))).kind).toBe("invalid-response");
    github.fault(/\/user\/installations\/71/, () => new Response("{", { status: 200 }));
    expect((await failure(client.installationRepositories("user:u", token, 71, 1, null))).kind).toBe("invalid-response");
    github.fault(/\/user\/installations\/71/, () => new Response("down", { status: 500 }), 2);
    expect((await failure(client.installationRepositories("user:u", token, 71, 1, null))).kind).toBe("server");
    github.fault(/\/repos\/octo\/docs$/, () => Response.json({ id: 801 }));
    expect((await failure(client.repository("i", github.token, "octo", "docs"))).kind).toBe("invalid-response");
    github.fault(/\/repos\/octo\/docs$/, () => Response.json({ message: "Validation failed" }, { status: 422 }));
    expect((await failure(client.repository("i", github.token, "octo", "docs"))).kind).toBe("invalid-response");
    github.fault(/\/repos\/octo\/docs$/, () => new Response(null, { status: 301, headers: { location: "https://evil.test/repos/octo/docs" } }));
    expect((await failure(client.repository("i", github.token, "octo", "docs"))).kind).toBe("invalid-response");
    // A 304 to a request that sent no ETag is not a cache hit.
    github.fault(/\/user\/installations/, () => new Response(null, { status: 304 }));
    expect((await failure(client.userInstallations("user:u", token, 1, null))).kind).toBe("invalid-response");
    github.fault(/\/installation\/repositories/, () => new Response("down", { status: 503 }), 2);
    expect((await failure(client.installationActive("i", github.token))).kind).toBe("server");
    // A redirect loop ends.
    github.fault(/\/repos\/octo\/loop$/, () => new Response(null, { status: 307, headers: { location: "/repos/octo/loop" } }), 4);
    expect((await failure(client.repository("i", github.token, "octo", "loop"))).kind).toBe("invalid-response");
    github.fault(/\/repos\/octo\/odd$/, () => new Response(null, { status: 302, headers: { location: "/repos/octo/docs" } }));
    expect((await failure(client.repository("i", github.token, "octo", "odd"))).kind).toBe("invalid-response");
  });

  it("retries network failures and 5xx once, then gives up", async () => {
    const { github, client, clock, token } = setup();
    github.fault(/\/user\/installations/, () => Promise.reject(new TypeError("fetch failed")));
    expect((await client.userInstallations("user:u", token, 1, null))?.items).toEqual([]);
    github.fault(/\/user\/installations/, () => Promise.reject(new TypeError("fetch failed")), 2);
    expect((await failure(client.userInstallations("user:u", token, 1, null))).kind).toBe("network");
    github.fault(/\/user\/installations/, () => new Response("down", { status: 502 }));
    expect(await client.userInstallations("user:u", token, 1, null)).not.toBeNull();
    expect(clock.sleeps.length).toBe(3);
    // An error body that cannot be read is still classified by status.
    github.fault(/\/user\/installations/, () => new Response(new ReadableStream({ pull: (controller) => controller.error(new Error("cut")) }), { status: 401 }));
    expect((await failure(client.userInstallations("user:u", token, 1, null))).kind).toBe("unauthorized");
  });

  it("paces per budget and stops at GitHub's limits", async () => {
    const { github, client, token } = setup();
    github.rate.remaining = 0;
    const limited = await failure(client.userInstallations("user:a", token, 1, null));
    expect(limited.kind).toBe("rate-limited");
    expect(limited.retryAt).toBe(github.rate.reset * 1000);
    github.rate.remaining = 5000;
    // The same user's budget stays closed until the reset; another user's does not.
    expect((await failure(client.userInstallations("user:a", token, 1, null))).kind).toBe("rate-limited");
    expect(await client.userInstallations("user:b", token, 1, null)).not.toBeNull();
    github.fault(/\/user\/installations/, () => Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 403 }));
    expect((await failure(client.userInstallations("user:c", token, 1, null))).kind).toBe("rate-limited");
    github.fault(/\/repos\//, () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }));
    expect((await failure(client.collaboratorAccess("installation:9", github.token, "octo", "docs", "reader"))).kind).toBe("forbidden");
    github.fault(/\/repos\//, () => new Response("", { status: 429 }));
    expect((await failure(client.repository("installation:8", github.token, "octo", "docs"))).kind).toBe("rate-limited");
  });

  it("keeps a bounded set of budgets", () => {
    const governors: string[] = [];
    const client = new GitHubAccessClient({ maxBudgets: 2, governor: (budget) => {
      governors.push(budget);
      return new RateGovernor();
    } });
    const first = client.governor("user:a");
    client.governor("user:b");
    expect(client.governor("user:a")).toBe(first);
    client.governor("user:c");
    // "b" was least recently used and is dropped; "a" survives.
    expect(client.governor("user:a")).toBe(first);
    client.governor("user:b");
    expect(governors).toEqual(["user:a", "user:b", "user:c", "user:b"]);
  });

  it("defaults to api.github.com and the global fetch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ installations: [] }));
    try {
      expect(await new GitHubAccessClient().userInstallations("user:u", "t", 1, null)).toEqual({ items: [], etag: null, next: false });
      expect(fetch.mock.calls[0][0] as string).toBe("https://api.github.com/user/installations?per_page=100&page=1");
    } finally {
      fetch.mockRestore();
    }
  });

  it("parses only well-formed repositories", () => {
    expect(parseListedRepo({ id: 1, name: "docs", owner: { login: "octo" }, private: false, default_branch: "main" })).toEqual({ id: 1, owner: "octo", name: "docs", private: false, defaultBranch: "main" });
    expect(parseListedRepo(null)).toBeNull();
    expect(parseListedRepo({ id: 1, name: "docs", owner: { login: "octo" }, private: "no", default_branch: "main" })).toBeNull();
    expect(parseListedRepo({ id: 1, name: "docs", owner: { login: "octo" }, private: false, default_branch: "../x" })).toBeNull();
  });
});
