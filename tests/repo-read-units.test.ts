import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RENDERER_VERSION } from "@/ingest/limits";
import { blobKey, manifestKey, refKey, sidebarKey } from "@/ingest/orchestrator/keys";
import { plaintextSealer, r2Store, type ContentSealer, type ObjectStore } from "@/ingest/orchestrator/store";
import type { SidebarIndex } from "@/ingest/sidebar";
import {
  kvRevocationEpochs, parseRepoRecord, repoAccessHandler, RepoAccessUnavailable, serviceRepoPermissions, type RepoRecord,
} from "@/repo-read/access";
import { authorizeRepo, authorizeTicket, clearAuthorizationMemory, mintTicket, type AuthorizeDependencies, type Viewer } from "@/repo-read/authorize";
import { mintCapability, peekCapability, sessionBinding, verifyCapability, type CapabilityClaims } from "@/repo-read/capability";
import { failureBody, frameBody, relativeUrl } from "@/repo-read/frame";
import { imageProxyPath, verifyImageProxyPath } from "@/image-proxy";
import { issueGrant } from "@/repo-read/grant";
import { encodeRepoPath, parseRepoPath, repoBase } from "@/repo-read/paths";
import { clearSnapshotMemory, isPagePath, manifestFile, readDeadline, RepoSnapshots } from "@/repo-read/snapshot";
import { treePage, TREE_PAGE_SIZE } from "@/repo-read/tree";
import { sessionViewer } from "@/middleware/session";
import { sessionCache } from "@/session-cache";
import { ViewerBackendError } from "@/viewer-backend";
import { readFileSync } from "node:fs";
import { HIGHLIGHT_CSS } from "@/ingest/highlight-theme";
import { styleManifest } from "@/routes/style-manifest";
import { FakeR2Bucket } from "./helpers/fake-storage";
import { InMemoryRepoAccess, MemoryEdgeCache, sessionCookies, stubSessions, users } from "./helpers/repo-read-fixture";

const secret = "unit-repo-capability-secret-0123456789";
const now = Math.floor(Date.now() / 1000);
const claims: CapabilityClaims = { u: "user-1", r: 7, n: "octo/docs", p: true, b: "main", e: 3, s: "binding", i: now, x: now + 300 };
const repo: RepoRecord = { id: 7, owner: "octo", name: "docs", private: true, defaultBranch: "main" };
const commit = "c".repeat(40);
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Signs an arbitrary payload exactly as the codec does (documented derivation), to reach checks past the signature. */
async function signRaw(purpose: "cookie" | "ticket", payload: string): Promise<string> {
  const hmac = async (key: Uint8Array<ArrayBuffer>, message: string) => new Uint8Array(await crypto.subtle.sign("HMAC",
    await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), encoder.encode(message)));
  const derived = await hmac(encoder.encode(secret), `rendro-repo-capability:v1:${purpose}`);
  return `v1.${payload}.${base64url(await hmac(derived, `v1.${payload}`))}`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("capability tokens", () => {
  it("round-trips claims for their own purpose only", async () => {
    const cookie = await mintCapability(secret, "cookie", claims);
    expect(await verifyCapability(secret, "cookie", cookie, now)).toEqual(claims);
    expect(await verifyCapability(secret, "ticket", cookie, now)).toBeNull();
    expect(await verifyCapability("another-secret-0123456789-abcdefghij", "cookie", cookie, now)).toBeNull();
    expect(peekCapability(cookie)).toEqual({ n: "octo/docs" });
    const { s: _s, ...ticketClaims } = claims;
    const ticket = await mintCapability(secret, "ticket", { ...ticketClaims, c: commit });
    expect(await verifyCapability(secret, "ticket", ticket, now)).toMatchObject({ c: commit });
  });

  it("refuses expired, future-dated, malformed and oversized tokens", async () => {
    const cookie = await mintCapability(secret, "cookie", claims);
    expect(await verifyCapability(secret, "cookie", cookie, now + 300)).toBeNull();
    expect(await verifyCapability(secret, "cookie", cookie, now - 61)).toBeNull();
    expect(await verifyCapability(secret, "cookie", cookie, now - 60)).not.toBeNull();
    for (const token of ["", "v1.a", "v2.a.b", `x${cookie}`, `${cookie}.x`, "a".repeat(2049), `v1.${"A".repeat(2045)}`]) {
      expect(await verifyCapability(secret, "cookie", token, now)).toBeNull();
    }
    for (const token of ["v1.a", "v1.***.x", "v1.A.x", `v1.${base64url(encoder.encode("{"))}.x`, `v1.${base64url(encoder.encode("null"))}.x`, "x".repeat(2049)]) {
      expect(peekCapability(token)).toBeNull();
    }
  });

  it("checks the claims only after the signature, and requires the purpose's binding", async () => {
    expect(await verifyCapability(secret, "cookie", await signRaw("cookie", base64url(encoder.encode("{"))), now)).toBeNull();
    expect(await verifyCapability(secret, "cookie", await signRaw("cookie", "***"), now)).toBeNull();
    const variants: Array<Record<string, unknown>> = [
      { u: "" }, { u: "x".repeat(257) }, { r: 0 }, { r: 1.5 }, { n: "" }, { p: "yes" }, { b: "" }, { e: -1 }, { i: "now" }, { x: null },
      { s: undefined }, { s: "" }, { c: commit },
    ];
    for (const change of variants) {
      const token = await signRaw("cookie", base64url(encoder.encode(JSON.stringify({ ...claims, ...change }))));
      expect(await verifyCapability(secret, "cookie", token, now), JSON.stringify(change)).toBeNull();
    }
    const { s: _s, ...rest } = claims;
    for (const change of [{}, { c: "" }, { c: commit, s: "x" }]) {
      const token = await signRaw("ticket", base64url(encoder.encode(JSON.stringify({ ...rest, ...change }))));
      expect(await verifyCapability(secret, "ticket", token, now), JSON.stringify(change)).toBeNull();
    }
    expect(await verifyCapability(secret, "cookie", await signRaw("cookie", base64url(encoder.encode("null"))), now)).toBeNull();
  });

  it("derives a stable session binding that differs per session", async () => {
    expect(await sessionBinding(secret, "a")).toBe(await sessionBinding(secret, "a"));
    expect(await sessionBinding(secret, "a")).not.toBe(await sessionBinding(secret, "b"));
    expect(await sessionBinding(secret, "a")).toMatch(/^[\w-]{22}$/);
  });
});

describe("repository access protocol", () => {
  const record: RepoRecord = { id: 9, owner: "Octo", name: "docs", private: false, defaultBranch: "main" };

  it("validates repository records", () => {
    expect(parseRepoRecord(record)).toEqual(record);
    for (const value of [null, "x", { ...record, id: 0 }, { ...record, owner: "-x" }, { ...record, name: ".." }, { ...record, private: 1 }, { ...record, defaultBranch: "a..b" }]) {
      expect(parseRepoRecord(value)).toBeNull();
    }
  });

  it("answers through the control Worker handler: grant, denial and outage", async () => {
    const access = new InMemoryRepoAccess().addRepo(record);
    const client = serviceRepoPermissions({ fetch: repoAccessHandler(access) });
    expect(await client.authorize(null, "octo", "DOCS")).toEqual(record);
    expect(await client.authorize("u", "octo", "missing")).toBeNull();
    access.unavailable = true;
    await expect(client.authorize(null, "octo", "docs")).rejects.toBeInstanceOf(RepoAccessUnavailable);
  });

  it("treats a malformed, mismatched, failed or slow answer as unavailable", async () => {
    const answers = [
      () => Response.json({ repo: { ...record, id: "9" } }),
      () => Response.json({ repo: { ...record, name: "other" } }),
      () => new Response("{", { status: 200 }),
      () => Response.json(null),
      () => new Response("", { status: 500 }),
      () => { throw new TypeError("fetch failed"); },
    ];
    for (const answer of answers) {
      const client = serviceRepoPermissions({ fetch: () => Promise.resolve().then(answer) });
      await expect(client.authorize(null, "octo", "docs")).rejects.toBeInstanceOf(RepoAccessUnavailable);
    }
    const slow = serviceRepoPermissions({ fetch: request => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason as Error))) }, 5);
    await expect(slow.authorize(null, "octo", "docs")).rejects.toBeInstanceOf(RepoAccessUnavailable);
  });

  it("validates requests on the control Worker side", async () => {
    const handler = repoAccessHandler(new InMemoryRepoAccess().addRepo(record));
    const call = (body: string, init: RequestInit = {}, path = "/v1/authorize") =>
      handler(new Request(`https://repo-access.internal${path}`, { method: "POST", body, ...init }));
    expect((await call("", { method: "GET", body: undefined })).status).toBe(404);
    expect((await call("{}", {}, "/v2/authorize")).status).toBe(404);
    expect((await call("{")).status).toBe(400);
    for (const body of ["null", { viewer: 1, owner: "octo", name: "docs" }, { viewer: "", owner: "octo", name: "docs" }, { viewer: null, owner: "o/x", name: "docs" }, { viewer: null, owner: "octo", name: "" }]) {
      const response = await call(JSON.stringify(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(await (await call(JSON.stringify({ viewer: "u", owner: "octo", name: "docs" }))).json()).toEqual({ repo: record });
  });

  it("reads epochs from KV: absent is 0, malformed and failures are unavailable", async () => {
    const values = new Map<string, string>([["epoch:a", "1792000000000"], ["epoch:b", "-1"], ["epoch:c", "1".repeat(16)]]);
    const get = vi.fn((key: string, _options: { cacheTtl: number }) => Promise.resolve(values.get(key) ?? null));
    const epochs = kvRevocationEpochs({ get });
    expect(await epochs.currentEpoch("a")).toBe(1792000000000);
    expect(await epochs.currentEpoch("z")).toBe(0);
    expect(get).toHaveBeenCalledWith("epoch:a", { cacheTtl: 60 });
    await expect(epochs.currentEpoch("b")).rejects.toBeInstanceOf(RepoAccessUnavailable);
    await expect(epochs.currentEpoch("c")).rejects.toBeInstanceOf(RepoAccessUnavailable);
    await expect(kvRevocationEpochs({ get: () => Promise.reject(new Error("KV down")) }).currentEpoch("a")).rejects.toBeInstanceOf(RepoAccessUnavailable);
  });
});

describe("URL grammar", () => {
  it("parses shells, frames, trees, tickets and renewals", () => {
    expect(parseRepoPath("/r/octo/docs")).toEqual({ owner: "octo", name: "docs", ref: { kind: "default" }, target: { kind: "shell" } });
    expect(parseRepoPath("/r/octo/docs/~feature%2Fx/tree")).toMatchObject({ ref: { kind: "branch", branch: "feature/x" }, target: { kind: "tree" } });
    expect(parseRepoPath(`/r/octo/docs/@${commit}/files/a%20b/c.md`)).toMatchObject({ ref: { kind: "commit", commit }, target: { kind: "files", path: "a b/c.md" } });
    expect(parseRepoPath(`/r/octo/docs/@${commit}/view/v1.a-b_c/files/x.png`)).toMatchObject({ target: { kind: "ticket-files", ticket: "v1.a-b_c", path: "x.png" } });
    expect(parseRepoPath(`/r/octo/docs/@${commit}/viewer-ticket`)).toMatchObject({ target: { kind: "viewer-ticket" } });
  });

  it.each([
    "/x/octo/docs", "/r/octo", "/r/-octo/docs", "/r/octo/./x", "/r/octo/docs/@" + "C".repeat(40), "/r/octo/docs/~%", "/r/octo/docs/~a b",
    "/r/octo/docs/files/a%2Fb", "/r/octo/docs/files/", "/r/octo/docs/tree/x", "/r/octo/docs/viewer-ticket",
    `/r/octo/docs/@${commit}/view/x/files/a%2Fb`, `/r/octo/docs/@${commit}/view/x/other/a`, `/r/octo/docs/@${commit}/view/x/files`,
    `/r/octo/docs/@${commit}/view//files/a`, `/r/octo/docs/@${commit}/viewer-ticket/x`,
  ])("rejects %s", (path) => {
    expect(parseRepoPath(path)).toBeNull();
  });

  it("builds bases and encodes paths one segment at a time", () => {
    expect(repoBase("o", "r", { kind: "default" })).toBe("/r/o/r");
    expect(repoBase("o", "r", { kind: "branch", branch: "feature/x" })).toBe("/r/o/r/~feature%2Fx");
    expect(repoBase("o", "r", { kind: "commit", commit })).toBe(`/r/o/r/@${commit}`);
    expect(encodeRepoPath("a b/c#d.md")).toBe("a%20b/c%23d.md");
  });
});

describe("document frames", () => {
  it.each([
    ["/docs/x.md", "docs/a.md", "../docs/x.md"],
    ["/docs/x.md", "a.md", "docs/x.md"],
    ["/", "a.md", "./"],
    ["/?q", "a.md", "./?q"],
    ["/#top", "a.md", "./#top"],
    ["/img/a%20b.png?x#y", "docs/guide/a.md", "../../img/a%20b.png?x#y"],
    ["#frag", "docs/a.md", "#frag"],
    ["https://example.com/x", "docs/a.md", "https://example.com/x"],
    ["//cdn.example/x", "docs/a.md", "//cdn.example/x"],
    ["mailto:a@example.com", "a.md", "mailto:a@example.com"],
    ["/docs/%2e%2e/secret", "a.md", null],
    ["/./x", "a.md", null],
    ["/%E0/x", "a.md", null],
  ])("maps %s from %s to %s", (value, documentPath, expected) => {
    expect(relativeUrl(value, documentPath)).toBe(expected);
  });

  it("rewrites only href and src, drops unusable ones and keeps everything else byte for byte", async () => {
    const html = '<p title="/x"><a href="/docs/b.md" class="c">b</a> <img src="/docs/i.png" alt="/i"> <a href="/a/../b">x</a> /docs/text</p>';
    expect(await frameBody(html, "docs/a.md", () => Promise.resolve(false)))
      .toBe('<p title="/x"><a href="../docs/b.md" class="c">b</a> <img src="../docs/i.png" alt="/i"> <a>x</a> /docs/text</p>');
  });

  it("keeps only verified image proxy paths absolute, checking each once", async () => {
    const proxySecret = process.env.IMAGE_PROXY_SECRET as string;
    const signed = await imageProxyPath(proxySecret, "https://example.com/badge.svg") as string;
    const forged = `/img/${"A".repeat(43)}/${signed.split("/").pop()}`;
    const check = vi.fn(async (src: string) => await verifyImageProxyPath(proxySecret, src) !== null);
    const html = `<p><img src="${signed}" alt="a"><img src="${signed}" alt="b"><img src="${forged}" alt="c"><img src="/img/logo.png" alt="d"><a href="${signed}">e</a></p>`;
    expect(await frameBody(html, "docs/a.md", check)).toBe(`<p><img src="${signed}" alt="a"><img src="${signed}" alt="b"><img src="..${forged}" alt="c">`
      + `<img src="../img/logo.png" alt="d"><a href="..${signed}">e</a></p>`);
    expect(check.mock.calls.map(([src]) => src)).toEqual([signed, forged, "/img/logo.png"]);
  });

  it("ships the ingest highlight palette byte for byte in the frame stylesheet", () => {
    const stylesheet = readFileSync(`public/styles/${styleManifest["repo-doc"]}`, "utf8");
    expect(stylesheet).toContain(HIGHLIGHT_CSS);
    expect(stylesheet).toBe(readFileSync("src/styles/repo-doc.css", "utf8"));
  });

  it("explains pages that could not be rendered", () => {
    expect(failureBody("too-large")).toContain("too large to display");
    expect(failureBody("missing")).toContain("missing from the snapshot");
    expect(failureBody("unstable")).toContain("could not be rendered safely");
  });
});

describe("sidebar tree pages", () => {
  const sidebar = (nodes: SidebarIndex["nodes"]): SidebarIndex => ({ rendererVersion: 1, root: "site/docs", entry: "site/docs/index.md", nodes, truncated: false });
  const pages = new Set(["site/docs/index.md", "site/docs/a.md", "site/docs/guide/README.md", "site/docs/guide/b.md", "site/docs/guide/b.md"]);
  const isPage = (path: string) => pages.has(path);

  it("adds the folders above the docs root, titles folders and puts a landing page first", () => {
    const index = sidebar([
      { type: "page", path: "site/docs/index.md", title: "Home" },
      { type: "directory", path: "site/docs/guide", title: "", page: null, children: [] },
      { type: "directory", path: "site/docs/guide", title: "The guide", page: "site/docs/guide/README.md", children: [
        { type: "page", path: "site/docs/guide/b.md", title: "" },
        { type: "page", path: "site/docs/guide/b.md", title: "Duplicate" },
      ] },
      { type: "page", path: "site/docs/a.md", title: "A" },
      { type: "page", path: "site/docs/not-listed.md", title: "Gone" },
      { type: "page", path: "site/docs/../escape.md", title: "Escape" },
      { type: "directory", path: "site//bad", title: "Bad", page: null, children: [{ type: "page", path: "site/docs/a.md", title: "A" }] },
    ]);
    expect(treePage(index, isPage, "", 0)).toEqual({ children: [{ name: "site", type: "folder", title: "Site" }], more: false });
    expect(treePage(index, isPage, "site/docs/", 0)?.children).toEqual([
      { name: "index.md", type: "file", title: "Home" },
      { name: "guide", type: "folder", title: "The guide" },
      { name: "a.md", type: "file", title: "A" },
    ]);
    expect(treePage(index, isPage, "site/docs/guide/", 0)?.children).toEqual([
      { name: "README.md", type: "file", title: "The guide" },
      { name: "b.md", type: "file", title: "B" },
    ]);
    expect(treePage(index, isPage, "nowhere/", 0)).toBeNull();
  });

  it(`pages directories in ${TREE_PAGE_SIZE}s`, () => {
    const many = Array.from({ length: TREE_PAGE_SIZE + 1 }, (_, index) => `p${index}.md`);
    const index = sidebar(many.map(path => ({ type: "page" as const, path, title: path })));
    expect(treePage(index, () => true, "", 0)).toMatchObject({ more: true });
    expect(treePage(index, () => true, "", 1)).toEqual({ children: [{ name: `p${TREE_PAGE_SIZE}.md`, type: "file", title: `p${TREE_PAGE_SIZE}.md` }], more: false });
  });
});

describe("snapshot reader", () => {
  let bucket: FakeR2Bucket;
  let pending: Array<Promise<unknown>>;
  let clock: number;
  const grant = issueGrant(repo, "user-1", 0);
  const put = (key: string, value: unknown) => bucket.put(key, encoder.encode(typeof value === "string" ? value : JSON.stringify(value)));
  const reader = (overrides: Partial<ConstructorParameters<typeof RepoSnapshots>[0]> = {}) => new RepoSnapshots({
    store: r2Store(bucket), sealer: plaintextSealer, edge: null, origin: "https://rendro.test",
    waitUntil: promise => void pending.push(promise), now: () => clock, ...overrides,
  });
  const manifest = (overrides: Record<string, unknown> = {}) => ({ schema: 1, repoId: 7, commit, tree: "t", rendererVersion: RENDERER_VERSION, createdAt: "", docs: null, docSets: [], files: {}, sidebar: null, assetsTruncated: false, ...overrides });

  beforeEach(() => {
    bucket = new FakeR2Bucket();
    pending = [];
    clock = 1_000_000;
    clearSnapshotMemory();
  });

  it("serves a pointer fresh for five seconds, then stale while one refresh runs, then blocks", async () => {
    await put(refKey(7, "main"), { repoId: 7, commit, rendererVersion: 1 });
    const snapshots = reader();
    expect((await snapshots.pointer(grant, "main"))?.commit).toBe(commit);
    const next = "d".repeat(40);
    await put(refKey(7, "main"), { repoId: 7, commit: next, rendererVersion: 1 });
    clock += 4_000;
    expect((await snapshots.pointer(grant, "main"))?.commit).toBe(commit);
    clock += 2_000;
    expect((await snapshots.pointer(grant, "main"))?.commit).toBe(commit);
    expect((await snapshots.pointer(grant, "main"))?.commit).toBe(commit);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toBe(pending[1]);
    await Promise.all(pending);
    expect((await snapshots.pointer(grant, "main"))?.commit).toBe(next);
    clock += 61_000;
    expect(await snapshots.pointer(grant, "other")).toBeNull();
  });

  it("keeps a stale pointer when its refresh fails, and refreshes again later", async () => {
    await put(refKey(7, "main"), { repoId: 7, commit, rendererVersion: 1 });
    const snapshots = reader();
    await snapshots.pointer(grant, "main");
    clock += 6_000;
    const get = vi.spyOn(bucket, "get").mockRejectedValueOnce(new Error("R2 down"));
    expect((await snapshots.pointer(grant, "main"))?.commit).toBe(commit);
    await Promise.all(pending);
    expect((await snapshots.pointer(grant, "main"))?.commit).toBe(commit);
    await Promise.all(pending);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("bounds the pointer memory", async () => {
    const snapshots = reader();
    for (let index = 0; index <= 1_024; index += 1) await snapshots.pointer(grant, `b${index}`);
    const reads = bucket.ops.get;
    await snapshots.pointer(grant, "b0");
    expect(bucket.ops.get).toBe(reads + 1);
    await snapshots.pointer(grant, "b1024");
    expect(bucket.ops.get).toBe(reads + 1);
  });

  it.each([
    ["another repository's pointer", { repoId: 8, commit, rendererVersion: 1 }],
    ["a pointer without a commit", { repoId: 7, commit: "x", rendererVersion: 1 }],
    ["a pointer with a bad renderer version", { repoId: 7, commit, rendererVersion: -1 }],
    ["a null pointer", null],
  ])("refuses %s as unavailable", async (_case, value) => {
    await put(refKey(7, "main"), value);
    await expect(reader().pointer(grant, "main")).rejects.toBeInstanceOf(ViewerBackendError);
  });

  it("falls back to the previous renderer's snapshot for a commit, and validates manifests", async () => {
    const snapshots = reader();
    expect(await snapshots.manifest(grant, commit)).toBeNull();
    await put(manifestKey(7, commit, RENDERER_VERSION - 1), manifest({ rendererVersion: RENDERER_VERSION - 1 }));
    expect(await snapshots.manifest(grant, commit)).toMatchObject({ rendererVersion: RENDERER_VERSION - 1 });
    for (const bad of [manifest({ schema: 2 }), manifest({ repoId: 8 }), manifest({ commit: "e".repeat(40) }), manifest({ files: [] }), manifest({ files: null }),
      manifest({ sidebar: 1 }), manifest({ docs: { entry: 1 } }), "null", "[]"]) {
      clearSnapshotMemory();
      await put(manifestKey(7, commit, 3), bad);
      await expect(snapshots.manifest(grant, commit, 3)).rejects.toBeInstanceOf(ViewerBackendError);
    }
  });

  it("refuses a sidebar outside the repository, missing or malformed", async () => {
    const snapshots = reader();
    const valid = manifest({ sidebar: sidebarKey(7, commit, 1) }) as never;
    expect(await snapshots.sidebar(grant, manifest() as never)).toBeNull();
    await expect(snapshots.sidebar(grant, manifest({ sidebar: sidebarKey(8, commit, 1) }) as never)).rejects.toBeInstanceOf(ViewerBackendError);
    await expect(snapshots.sidebar(grant, valid)).rejects.toBeInstanceOf(ViewerBackendError);
    await put(sidebarKey(7, commit, 1), { nodes: {} });
    clearSnapshotMemory();
    await expect(snapshots.sidebar(grant, valid)).rejects.toBeInstanceOf(ViewerBackendError);
  });

  it("refuses a missing or malformed rendered page, and reports a lost blob as null", async () => {
    const snapshots = reader();
    const file = { sha: "b".repeat(40), size: 1, render: "render/v1/markdown/x/y" };
    const same = (rendered: unknown) => Promise.resolve(rendered);
    await expect(snapshots.page(grant, file, "v", same)).rejects.toBeInstanceOf(ViewerBackendError);
    for (const value of ["null", { html: 1 }, 5]) {
      clearSnapshotMemory();
      await put(`gh/v1/repo/7/${file.render}`, value);
      await expect(snapshots.page(grant, file, "v", same)).rejects.toBeInstanceOf(ViewerBackendError);
    }
    clearSnapshotMemory();
    await put(`gh/v1/repo/7/${file.render}`, { error: "too-complex" });
    expect(await snapshots.page(grant, file, "v", same)).toEqual({ error: "too-complex" });
    // Derived once per variant, then served from memory.
    const derive = vi.fn((rendered: unknown) => Promise.resolve({ derived: rendered }));
    await snapshots.page(grant, file, "w", derive);
    await snapshots.page(grant, file, "w", derive);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(await snapshots.asset(grant, file)).toBeNull();
  });

  it("opens private bytes through the sealer and public ones as stored", async () => {
    const open = vi.fn((_scope: unknown, stored: Uint8Array) => Promise.resolve(stored.map(byte => byte ^ 1)));
    const sealer: ContentSealer = { seal: vi.fn(), open };
    await bucket.put(blobKey(7, "b".repeat(40)), new Uint8Array([2, 3]));
    await bucket.put(blobKey(6, "b".repeat(40)), new Uint8Array([2, 3]));
    const snapshots = reader({ sealer });
    expect(await snapshots.asset(grant, { sha: "b".repeat(40), size: 2 })).toEqual(new Uint8Array([3, 2]));
    expect(open).toHaveBeenCalledWith({ repoId: 7, key: blobKey(7, "b".repeat(40)) }, new Uint8Array([2, 3]));
    expect(await snapshots.asset(issueGrant({ ...repo, id: 6, private: false }, null, 0), { sha: "b".repeat(40), size: 2 })).toEqual(new Uint8Array([2, 3]));
  });

  it("reads the colo cache before R2 and never caches a miss", async () => {
    const edge = new MemoryEdgeCache();
    const snapshots = reader({ edge });
    expect(await snapshots.asset(grant, { sha: "b".repeat(40), size: 2 })).toBeNull();
    expect(edge.ops.put).toEqual([]);
    edge.entries.set(`https://rendro.test/__repo-cache/v1/${blobKey(7, "b".repeat(40))}`, new Uint8Array([9]));
    clearSnapshotMemory();
    expect(await snapshots.asset(grant, { sha: "b".repeat(40), size: 2 })).toEqual(new Uint8Array([9]));
  });

  it("classifies paths and never returns inherited manifest properties", () => {
    expect(["a.md", "a.MARKDOWN", "a.mdx", "a.html", "a.htm"].every(isPagePath)).toBe(true);
    expect(["a.png", "a.md.png", "md"].some(isPagePath)).toBe(false);
    const value = manifest({ files: { "a.md": { sha: "x", size: 1 } } }) as never;
    expect(manifestFile(value, "a.md")).toEqual({ sha: "x", size: 1 });
    expect(manifestFile(value, "__proto__")).toBeNull();
    expect(manifestFile(value, "toString")).toBeNull();
  });

  it("bounds every storage read with a deadline", async () => {
    vi.useFakeTimers();
    const store = { get: vi.fn(() => new Promise<never>(() => {})), has: vi.fn(), put: vi.fn(), list: vi.fn() } as unknown as ObjectStore;
    const bounded = readDeadline(store, 50);
    const read = bounded.get("k");
    const settled = expect(read).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(50);
    await settled;
    const quick = readDeadline({ ...store, get: () => Promise.resolve(null) }, 50);
    expect(await quick.get("k")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // Only reads are bounded; the other operations are the store's own.
    expect(Object.is(Reflect.get(bounded, "has"), Reflect.get(store, "has"))).toBe(true);
  });
});

describe("authorization edge cases", () => {
  let access: InMemoryRepoAccess;
  let pending: Array<Promise<unknown>>;
  let viewer: Viewer;
  let clock: number;
  const deps = (): AuthorizeDependencies => ({
    secret, permissions: access, epochs: access, identity: () => Promise.resolve(viewer), now: () => clock, waitUntil: promise => void pending.push(promise),
  });
  const request = (cookie = "") => new Request("https://rendro.test/r/octo/docs", { headers: { cookie } });
  const session = "better-auth.session_token=t";

  beforeEach(() => {
    clearAuthorizationMemory();
    access = new InMemoryRepoAccess().addRepo(repo, ["user-1"]);
    pending = [];
    viewer = { kind: "user", id: "user-1" };
    clock = Date.now();
  });

  async function cookieFor(): Promise<string> {
    const result = await authorizeRepo(deps(), request(session), "octo", "docs");
    if (result.kind !== "granted") throw new Error(result.kind);
    return `${session}; ${result.cookies[0].split(";", 1)[0]}`;
  }

  it("never grants a private repository to an anonymous reader, even if the source does", async () => {
    vi.spyOn(access, "authorize").mockResolvedValue(repo);
    viewer = { kind: "anonymous" };
    expect(await authorizeRepo(deps(), request(session), "octo", "docs")).toEqual({ kind: "denied", cookies: [] });
  });

  it("decides afresh when a refresh finds the name now belongs to another repository, or became public", async () => {
    for (const changed of [{ ...repo, id: 8 }, { ...repo, private: false }]) {
      clearAuthorizationMemory();
      clock = Date.now();
      const cookie = await cookieFor();
      access.addRepo(changed, ["user-1"]);
      clock += 200_000;
      expect((await authorizeRepo(deps(), request(cookie), "octo", "docs")).kind).toBe("granted");
      await Promise.all(pending.splice(0));
      const result = await authorizeRepo(deps(), request(cookie), "octo", "docs");
      expect(result).toMatchObject({ kind: "granted", grant: { repo: changed } });
      access.addRepo(repo, ["user-1"]);
    }
  });

  it("re-checks a refresh older than the cookie and ignores one past a minute", async () => {
    const cookie = await cookieFor();
    clock += 200_000;
    await authorizeRepo(deps(), request(cookie), "octo", "docs");
    await Promise.all(pending.splice(0));
    clock += 61_000;
    await authorizeRepo(deps(), request(cookie), "octo", "docs");
    expect(pending).toHaveLength(1);
  });

  it("keeps the cookie when the background refresh cannot reach the source", async () => {
    const cookie = await cookieFor();
    access.unavailable = true;
    clock += 200_000;
    await authorizeRepo(deps(), request(cookie), "octo", "docs");
    await Promise.all(pending.splice(0));
    expect((await authorizeRepo(deps(), request(cookie), "octo", "docs")).kind).toBe("granted");
  });

  it("keeps a refresh result to the session that ran it", async () => {
    const other = "better-auth.session_token=other";
    const first = await cookieFor();
    const second = await authorizeRepo(deps(), request(other), "octo", "docs");
    if (second.kind !== "granted") throw new Error(second.kind);
    const secondCookie = `${other}; ${second.cookies[0].split(";", 1)[0]}`;
    // The first session signs out; its background refresh finds no reader.
    viewer = { kind: "anonymous" };
    clock += 200_000;
    await authorizeRepo(deps(), request(first), "octo", "docs");
    await Promise.all(pending.splice(0));
    expect((await authorizeRepo(deps(), request(first), "octo", "docs")).kind).toBe("denied");
    viewer = { kind: "user", id: "user-1" };
    expect((await authorizeRepo(deps(), request(secondCookie), "octo", "docs")).kind).toBe("granted");
  });

  it("treats a refresh by another signed-in user as a denial", async () => {
    const cookie = await cookieFor();
    viewer = { kind: "user", id: "user-2" };
    clock += 200_000;
    await authorizeRepo(deps(), request(cookie), "octo", "docs");
    await Promise.all(pending.splice(0));
    expect((await authorizeRepo(deps(), request(cookie), "octo", "docs")).kind).toBe("denied");
  });

  it("runs one background refresh per reader and repository at a time", async () => {
    const cookie = await cookieFor();
    let release: (value: Viewer) => void = () => {};
    const identity = vi.fn(() => new Promise<Viewer>(resolve => { release = resolve; }));
    clock += 200_000;
    for (let index = 0; index < 3; index += 1) await authorizeRepo({ ...deps(), identity }, request(cookie), "octo", "docs");
    expect(identity).toHaveBeenCalledTimes(1);
    release(viewer);
    await Promise.all(pending.splice(0));
  });

  it("remembers at most 1,024 anonymous denials", async () => {
    viewer = { kind: "anonymous" };
    for (let index = 0; index <= 1_024; index += 1) await authorizeRepo(deps(), request(), "octo", `missing-${index}`);
    const calls = access.calls.authorize.length;
    await authorizeRepo(deps(), request(), "octo", "missing-0");
    await authorizeRepo(deps(), request(), "octo", "missing-1024");
    expect(access.calls.authorize.length).toBe(calls + 1);
  });

  it("skips malformed cookie pairs and unrelated cookies", async () => {
    const result = await authorizeRepo(deps(), request(`${session}; rendro-repo.x=1; junk; __Host-rendro-repo.7`), "octo", "docs");
    expect(result.kind).toBe("granted");
  });

  it("refuses tickets for another repository, a public grant or an unknown epoch", async () => {
    const grant = issueGrant(repo, "user-1", 0);
    const ticket = await mintTicket(deps(), grant, commit);
    expect((await authorizeTicket(deps(), ticket, "octo", "docs", commit)).kind).toBe("granted");
    expect((await authorizeTicket(deps(), ticket, "octo", "other", commit)).kind).toBe("denied");
    const { s: _s, ...rest } = claims;
    const publicTicket = await mintCapability(secret, "ticket", { ...rest, e: 0, p: false, c: commit });
    expect((await authorizeTicket(deps(), publicTicket, "octo", "docs", commit)).kind).toBe("denied");
    access.epochsUnavailable = true;
    expect(await authorizeTicket(deps(), ticket, "octo", "docs", commit)).toEqual({ kind: "unavailable", retryAfter: "1" });
  });
});

describe("session viewer for routes before the session middleware", () => {
  beforeEach(() => sessionCache.clear());

  it("is anonymous without a session cookie, a user with one, and unavailable when the backend fails", async () => {
    const lookups = stubSessions({ "reader-token.sig": users.reader, "gone.sig": "", "down.sig": "down" });
    const request = (cookie: string) => new Request("https://rendro.test/r/o/r", { headers: { cookie } });
    expect(await sessionViewer(new Request("https://rendro.test/r/o/r"))).toEqual({ kind: "anonymous" });
    expect(await sessionViewer(request("other=1"))).toEqual({ kind: "anonymous" });
    expect(lookups).toEqual([]);
    expect(await sessionViewer(request(sessionCookies.reader))).toEqual({ kind: "user", id: users.reader });
    expect(await sessionViewer(request("better-auth.session_token=gone.sig"))).toEqual({ kind: "anonymous" });
    expect(await sessionViewer(request("better-auth.session_token=down.sig"))).toEqual({ kind: "unavailable", retryAfter: "1" });
  });

  it("carries the session backend's Retry-After into the unavailable answer", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("busy", { status: 503, headers: { "Retry-After": "7" } }))) as typeof fetch;
    const request = new Request("https://rendro.test/r/o/r", { headers: { cookie: "better-auth.session_token=busy.sig" } });
    expect(await sessionViewer(request)).toEqual({ kind: "unavailable", retryAfter: "7" });
  });
});
