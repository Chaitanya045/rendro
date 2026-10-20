import { describe, expect, it, vi } from "vitest";
import { RateGovernor } from "../src/ingest/github/rate-governor";
import type { GitHubError } from "../src/ingest/github/source";
import { GitHubAccessClient, parseListedRepo } from "../src/repo-access/github";
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
    expect(await client.canRead("installation:71", github.token, "octo", "docs", "reader")).toBe(false);
    repo.collaborators.add(reader.id);
    expect(await client.canRead("installation:71", github.token, "octo", "docs", "reader")).toBe(true);
    expect(await client.canRead("installation:71", github.token, "octo", "docs", "nobody")).toBe(false);
    github.fault(/permission$/, () => Response.json({ role_name: "read" }));
    expect((await failure(client.canRead("installation:71", github.token, "octo", "docs", "reader"))).kind).toBe("invalid-response");
    github.fault(/permission$/, () => new Response("down", { status: 500 }), 2);
    expect((await failure(client.canRead("installation:71", github.token, "octo", "docs", "reader"))).kind).toBe("server");
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
    expect((await failure(client.canRead("installation:9", github.token, "octo", "docs", "reader"))).kind).toBe("forbidden");
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
