import { describe, expect, it, vi } from "vitest";
import { HttpGitHubSource, parseTree, readBytes } from "../src/ingest/github/http-source";
import { RateGovernor, systemClock } from "../src/ingest/github/rate-governor";
import { GitHubError } from "../src/ingest/github/source";
import { staticTokenProvider, type InstallationTokenProvider } from "../src/ingest/github/token";
import { FakeGitHub } from "./helpers/fake-github";
import { FakeClock, ingestFixture, rejectWith } from "./helpers/ingest-fixture";
import { readTar } from "../src/ingest/github/tar";

const SHA = "a".repeat(40);

async function rejection(promise: Promise<unknown>): Promise<GitHubError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(GitHubError);
  return error as GitHubError;
}

function setup(options: Parameters<typeof ingestFixture>[0] = {}) {
  const fixture = ingestFixture(options);
  const repo = fixture.github.repo("octo", "docs", { id: 9, private: true });
  return { ...fixture, repo };
}

describe("RateGovernor", () => {
  it("paces each endpoint to its sustained rate after the burst", async () => {
    const clock = new FakeClock();
    const governor = new RateGovernor({ clock, ratePerSecond: 2, burst: 2 });
    for (let index = 0; index < 4; index += 1) (await governor.acquire("blob"))();
    // Two from the burst, then one every 500 ms.
    expect(clock.sleeps).toEqual([500, 500]);
    // Other endpoints have their own bucket.
    (await governor.acquire("tree"))();
    expect(clock.sleeps).toHaveLength(2);
  });

  it("bounds concurrency and hands a freed slot to the next waiter", async () => {
    const governor = new RateGovernor({ clock: new FakeClock(), maxConcurrent: 1 });
    const first = await governor.acquire("ref");
    let second: (() => void) | null = null;
    const waiting = governor.acquire("ref").then((release) => { second = release; });
    await Promise.resolve();
    expect(second).toBeNull();
    first();
    first(); // releasing twice is harmless
    await waiting;
    expect(second).not.toBeNull();
  });

  it("stops sending once primary quota runs out, until the window resets", async () => {
    const clock = new FakeClock();
    const governor = new RateGovernor({ clock });
    const reset = Math.floor(clock.time / 1000) + 600;
    governor.observe(new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }));
    expect(governor.snapshot()).toEqual({ remaining: 0, resetAt: reset * 1000, blockedUntil: reset * 1000 });
    const error = await rejection(governor.acquire("ref"));
    expect(error).toMatchObject({ kind: "rate-limited", retryAt: reset * 1000 });
    expect(error.transient).toBe(true);
    // Headers without numbers change nothing.
    governor.observe(new Headers({ "x-ratelimit-remaining": "lots" }));
    expect(governor.snapshot().remaining).toBe(0);
  });

  it("waits out short limits in place", async () => {
    const clock = new FakeClock();
    const governor = new RateGovernor({ clock, maxInlineWaitMs: 2000 });
    expect(governor.limited(429, new Headers({ "retry-after": "1" }), "")).toBe(clock.time + 1000);
    (await governor.acquire("ref"))();
    expect(clock.sleeps).toEqual([1000]);
  });

  it("classifies 403/429 responses and backs off secondary limits exponentially", () => {
    const clock = new FakeClock();
    const governor = new RateGovernor({ clock, secondaryBackoffMs: 1000, maxSecondaryBackoffMs: 3000 });
    expect(governor.limited(403, new Headers(), "Resource not accessible by integration")).toBeNull();
    expect(governor.limited(403, new Headers(), "You have exceeded a secondary rate limit")).toBe(clock.time + 1000);
    expect(governor.limited(429, new Headers(), "")).toBe(clock.time + 2000);
    expect(governor.limited(403, new Headers(), "abuse detection mechanism")).toBe(clock.time + 3000);
    governor.succeeded();
    expect(governor.limited(429, new Headers(), "")).toBe(clock.time + 1000);
    // Out of primary quota with the reset already past: retry in a second, not in the past.
    governor.observe(new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(clock.time / 1000) - 10) }));
    expect(governor.limited(403, new Headers(), "API rate limit exceeded")).toBe(clock.time + 1000);
  });

  it("uses real time by default", async () => {
    const started = Date.now();
    await systemClock.sleep(5);
    expect(systemClock.now()).toBeGreaterThanOrEqual(started);
    (await new RateGovernor().acquire("ref"))();
  });
});

describe("HttpGitHubSource against the fake GitHub", () => {
  it("reads a branch head, then revalidates it with a free 304", async () => {
    const { source, github, repo } = setup();
    const head = repo.commit({ "README.md": "# Hi\n" });
    const first = await source.getRef(repo.ref, "main");
    expect(first).toMatchObject({ sha: head, notModified: false });
    const again = await source.getRef(repo.ref, "main", { etag: first?.etag as string, sha: head });
    expect(again).toEqual({ sha: head, etag: first?.etag, notModified: true });
    expect(source.notModified).toBe(1);
    expect(github.requests.map((request) => request.status)).toEqual([200, 304]);
    expect(github.requests[0].authorization).toBe(`Bearer ${github.token}`);
    expect(github.rate.remaining).toBe(4999);
  });

  it("encodes branch names with slashes and treats missing branches and empty repositories as no head", async () => {
    const { source, github, repo } = setup();
    const empty = github.repo("octo", "empty");
    expect(await source.getRef(empty.ref, "main")).toBeNull();
    const head = repo.commit({ "a.md": "a" }, "feature/x y");
    expect((await source.getRef(repo.ref, "feature/x y"))?.sha).toBe(head);
    expect(github.requests[1].path).toBe("/repos/octo/docs/git/ref/heads/feature/x%20y");
    expect(await source.getRef(repo.ref, "main")).toBeNull();
  });

  it("follows a renamed repository's redirect within the API origin only", async () => {
    const { source, github, repo } = setup();
    const head = repo.commit({ "a.md": "a" });
    const stale = repo.ref;
    github.rename(repo, "new-owner", "new-name");
    expect((await source.getRef(stale, "main"))?.sha).toBe(head);
    expect((await source.getTree(stale, head, true)).entries).toHaveLength(1);
    expect(github.requests.map((request) => request.status)).toEqual([301, 200, 301, 200]);
    // The token is never sent elsewhere, and redirect loops end.
    github.fault(/git\/ref/, () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/x" } }));
    expect((await rejection(source.getRef(stale, "main"))).kind).toBe("invalid-response");
    github.fault(/git\/ref/, () => new Response(null, { status: 307 }));
    expect((await rejection(source.getRef(stale, "main"))).kind).toBe("invalid-response");
    github.fault(/git\/ref/, () => new Response(null, { status: 308, headers: { location: "/repos/new-owner/new-name/git/ref/heads/main" } }), 4);
    expect((await rejection(source.getRef(stale, "main"))).kind).toBe("invalid-response");
  });

  it("rejects ref responses that do not match the request", async () => {
    const { source, github, repo } = setup();
    repo.commit({ "a.md": "a" });
    github.fault(/git\/ref/, () => Response.json({ ref: "refs/heads/other", object: { sha: SHA, type: "commit" } }));
    github.fault(/git\/ref/, () => Response.json({ ref: "refs/heads/main", object: { sha: SHA, type: "tag" } }));
    github.fault(/git\/ref/, () => Response.json({ ref: "refs/heads/main", object: { sha: "zz", type: "commit" } }));
    github.fault(/git\/ref/, () => Response.json(null));
    github.fault(/git\/ref/, () => new Response(null, { status: 304 }));
    github.fault(/git\/ref/, () => new Response("{", { headers: { "content-type": "application/json" } }));
    for (let index = 0; index < 6; index += 1) expect((await rejection(source.getRef(repo.ref, "main"))).kind).toBe("invalid-response");
  });

  it("lists trees, resolving a commit to its root tree", async () => {
    const { source, repo, github } = setup();
    const head = repo.commit({ "docs/a.md": "a", "docs/b/c.md": "c", "link": { symlink: "docs/a.md" }, "vendor/lib": { submodule: SHA } });
    const tree = await source.getTree(repo.ref, head, true);
    expect(tree.truncated).toBe(false);
    expect(tree.sha).toBe(github.commits.get(head)?.tree);
    expect(tree.entries.map((entry) => [entry.path, entry.type, entry.mode])).toEqual([
      ["docs", "tree", "040000"], ["docs/a.md", "blob", "100644"], ["docs/b", "tree", "040000"], ["docs/b/c.md", "blob", "100644"],
      ["link", "blob", "120000"], ["vendor", "tree", "040000"], ["vendor/lib", "commit", "160000"],
    ]);
    expect(tree.entries[1].size).toBe(1);
    const top = await source.getTree(repo.ref, tree.sha, false);
    expect(top.entries.map((entry) => entry.path)).toEqual(["docs", "link", "vendor"]);
    repo.truncateAt = 2;
    expect(await source.getTree(repo.ref, head, true)).toMatchObject({ truncated: true });
    await expect(source.getTree(repo.ref, "HEAD", true)).rejects.toThrow(TypeError);
  });

  it("validates every tree entry it is given", () => {
    const entry = { path: "a.md", mode: "100644", type: "blob", sha: SHA, size: 1 };
    expect(parseTree({ sha: SHA, tree: [entry] }, false).entries).toEqual([entry]);
    expect(parseTree({ sha: SHA, tree: [{ ...entry, size: undefined }], truncated: true }, true)).toEqual({ sha: SHA, entries: [{ path: "a.md", mode: "100644", type: "blob", sha: SHA }], truncated: true });
    for (const body of [null, { sha: "x", tree: [] }, { sha: SHA, tree: {} }]) expect(() => parseTree(body, true)).toThrow(GitHubError);
    for (const bad of [null, { ...entry, path: 5 }, { ...entry, mode: 5 }, { ...entry, type: 5 }, { ...entry, type: "tag" }, { ...entry, sha: "x" }, { ...entry, size: 1.5 },
      { ...entry, path: "../a" }, { ...entry, path: "a/./b" }, { ...entry, path: "/a" }, { ...entry, path: "a//b" }, { ...entry, path: "a\\b" }, { ...entry, path: "a\nb" }]) {
      expect(() => parseTree({ sha: SHA, tree: [bad] }, true), JSON.stringify(bad)).toThrow(GitHubError);
    }
    // A non-recursive listing holds names only.
    expect(() => parseTree({ sha: SHA, tree: [{ ...entry, path: "a/b" }] }, false)).toThrow(GitHubError);
  });

  it("downloads blobs as raw bytes and checks them against their ID", async () => {
    const { source, repo, github } = setup();
    repo.commit({ "a.md": "hello\n" });
    const sha = "ce013625030ba8dba906f756967f9e9ca394464a";
    expect(new TextDecoder().decode(await source.getBlob(repo.ref, sha, 100))).toBe("hello\n");
    expect((await rejection(source.getBlob(repo.ref, sha, 3))).kind).toBe("too-large");
    github.fault(/git\/blobs/, () => new Response("tampered"));
    expect((await rejection(source.getBlob(repo.ref, sha, 100))).kind).toBe("invalid-response");
    // Without a Content-Length the limit applies while streaming.
    github.fault(/git\/blobs/, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(50)); controller.enqueue(new Uint8Array(60)); controller.close(); } })));
    expect((await rejection(source.getBlob(repo.ref, sha, 100))).kind).toBe("too-large");
    github.fault(/git\/blobs/, () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.error(new Error("reset")); } })));
    expect((await rejection(source.getBlob(repo.ref, sha, 100))).kind).toBe("network");
    expect((await rejection(source.getBlob(repo.ref, "b".repeat(40), 100))).kind).toBe("not-found");
    await expect(source.getBlob(repo.ref, "x", 1)).rejects.toThrow(TypeError);
  });

  it("follows the archive redirect at once, without the token, and only to an allowed origin", async () => {
    const { source, repo, github } = setup();
    const head = repo.commit({ "a.md": "archived" });
    const entries = [];
    for await (const entry of readTar(await source.getTarball(repo.ref, head), { want: () => true, maxEntryBytes: 100 })) entries.push(entry.path);
    expect(entries).toContain(`octo-docs-${head.slice(0, 7)}/a.md`);
    const archive = github.requests.find((request) => request.endpoint === "archive");
    expect(archive?.authorization).toBeNull();

    for (const location of ["https://evil.test/x", "not a url"]) {
      github.fault(/tarball/, () => new Response(null, { status: 302, headers: { location } }));
      expect((await rejection(source.getTarball(repo.ref, head))).kind).toBe("invalid-response");
    }
    github.fault(/tarball/, () => new Response(null, { status: 302 }));
    expect((await rejection(source.getTarball(repo.ref, head))).kind).toBe("invalid-response");
    github.fault(/legacy\.tar\.gz/, () => new Response(null, { status: 302, headers: { location: `${github.archiveOrigin}/again` } }));
    expect((await rejection(source.getTarball(repo.ref, head))).kind).toBe("invalid-response");
    github.fault(/tarball/, () => new Response(null, { status: 200 }));
    expect((await rejection(source.getTarball(repo.ref, head))).kind).toBe("invalid-response");
    // Some servers answer the archive directly.
    github.fault(/tarball/, async () => new Response(await (await github.fetch(`${github.origin}/repos/octo/docs/tarball/${head}`, { headers: { authorization: `Bearer ${github.token}` }, redirect: "follow" })).arrayBuffer()));
    expect(await source.getTarball(repo.ref, head)).toBeInstanceOf(ReadableStream);
    // An expired link is a not-found at the archive host.
    let calls = 0;
    github.now = () => Date.now() + (calls++ === 0 ? 0 : 10 * 60 * 1000);
    expect((await rejection(source.getTarball(repo.ref, head))).kind).toBe("not-found");
    await expect(source.getTarball(repo.ref, "x")).rejects.toThrow(TypeError);
  });

  it("retries 5xx and network errors with backoff, then gives up", async () => {
    const { source, repo, github, clock } = setup();
    const head = repo.commit({ "a.md": "a" });
    github.fault(/git\/ref/, () => new Response("busy", { status: 502 }), 2);
    expect((await source.getRef(repo.ref, "main"))?.sha).toBe(head);
    expect(clock.sleeps).toHaveLength(2);
    expect(clock.sleeps[1]).toBeGreaterThanOrEqual(500);
    github.fault(/git\/ref/, () => new Response("down", { status: 500 }), 3);
    expect(await rejection(source.getRef(repo.ref, "main"))).toMatchObject({ kind: "server", status: 500 });
    github.fault(/git\/ref/, () => Promise.reject(new TypeError("fetch failed")), 3);
    expect(await rejection(source.getRef(repo.ref, "main"))).toMatchObject({ kind: "network", message: "GitHub request failed: TypeError" });
    github.fault(/git\/ref/, () => rejectWith("odd"), 3);
    expect((await rejection(source.getRef(repo.ref, "main"))).message).toBe("GitHub request failed: unknown error");
    expect(source.requests.ref).toBe(3 + 3 + 3 + 3);
  });

  it("refreshes a rejected token once", async () => {
    const token = vi.fn(() => Promise.resolve("stale"));
    const invalidate = vi.fn();
    const tokens: InstallationTokenProvider = { token, invalidate };
    const github = new FakeGitHub();
    const repo = github.repo("octo", "docs", { private: true });
    repo.commit({ "a.md": "a" });
    const source = new HttpGitHubSource({ tokens, fetch: github.fetch, apiOrigin: github.origin, clock: new FakeClock() });
    expect(await rejection(source.getRef(repo.ref, "main"))).toMatchObject({ kind: "unauthorized", status: 401 });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(42);
    expect(token).toHaveBeenCalledTimes(2);
    const fixed = new HttpGitHubSource({ tokens: staticTokenProvider("wrong"), fetch: github.fetch, apiOrigin: github.origin, clock: new FakeClock() });
    expect((await rejection(fixed.getRef(repo.ref, "main"))).kind).toBe("unauthorized");
  });

  it("sends no Authorization header without a token (public repositories)", async () => {
    const { source, github } = setup({ token: null });
    const open = github.repo("octo", "open");
    open.commit({ "a.md": "a" });
    expect(await source.getRef(open.ref, "main")).not.toBeNull();
    expect(github.requests[0].authorization).toBeNull();
    // A private repository is invisible without one.
    const hidden = github.repo("octo", "hidden", { private: true });
    hidden.commit({ "a.md": "a" });
    expect(await source.getRef(hidden.ref, "main")).toBeNull();
  });

  it("honours rate limits: short waits in place, long ones surface with retryAt, and nothing is sent meanwhile", async () => {
    const { source, repo, github, clock } = setup({ governor: { maxInlineWaitMs: 5_000 } });
    const head = repo.commit({ "a.md": "a" });
    github.fault(/git\/ref/, () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }));
    expect((await source.getRef(repo.ref, "main"))?.sha).toBe(head);
    expect(clock.sleeps).toContain(2000);

    github.fault(/git\/ref/, () => Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 403 }));
    const secondary = await rejection(source.getRef(repo.ref, "main"));
    expect(secondary).toMatchObject({ kind: "rate-limited", status: 403, retryAt: clock.time + 60_000 });
    const before = github.requests.length;
    expect((await rejection(source.getRef(repo.ref, "main"))).kind).toBe("rate-limited");
    expect(github.requests.length).toBe(before);

    clock.time += 61_000;
    github.rate.remaining = 0;
    const primary = await rejection(source.getRef(repo.ref, "main"));
    expect(primary).toMatchObject({ kind: "rate-limited", retryAt: github.rate.reset * 1000 });
  });

  it("maps other statuses", async () => {
    const { source, repo, github } = setup();
    repo.commit({ "a.md": "a" });
    github.fault(/git\/ref/, () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }));
    expect(await rejection(source.getRef(repo.ref, "main"))).toMatchObject({ kind: "forbidden", transient: false });
    github.fault(/git\/ref/, () => new Response("x".repeat(20_000), { status: 403 }));
    expect((await rejection(source.getRef(repo.ref, "main"))).kind).toBe("forbidden");
    github.fault(/git\/trees/, () => new Response("gone", { status: 410 }));
    expect((await rejection(source.getTree(repo.ref, SHA, true))).kind).toBe("not-found");
    github.fault(/git\/trees/, () => new Response("bad", { status: 422 }));
    expect((await rejection(source.getTree(repo.ref, SHA, true))).kind).toBe("invalid-response");
  });

  it("reads empty bodies and uses the global fetch by default", async () => {
    expect(await readBytes(new Response(null), 10)).toEqual(new Uint8Array());
    const original = globalThis.fetch;
    const github = new FakeGitHub();
    github.repo("octo", "open").commit({ "a.md": "a" });
    globalThis.fetch = github.fetch;
    try {
      const source = new HttpGitHubSource({ tokens: staticTokenProvider(null), apiOrigin: github.origin });
      expect(await source.getRef(github.repos.get("octo/open")?.ref as never, "main")).not.toBeNull();
      expect(new HttpGitHubSource({ tokens: staticTokenProvider(null) })).toBeInstanceOf(HttpGitHubSource);
    } finally {
      globalThis.fetch = original;
    }
  });
});
