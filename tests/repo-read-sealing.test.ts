import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "@/worker";
import { RENDERER_VERSION } from "@/ingest/limits";
import { blobKey, manifestKey, renderObjectKey } from "@/ingest/orchestrator/keys";
import { envelopeSealer, isSealed, SealedContentError, unconfiguredSealer } from "@/ingest/orchestrator/sealing";
import { r2Store, type ContentSealer } from "@/ingest/orchestrator/store";
import type { SnapshotManifest } from "@/ingest/orchestrator/snapshot";
import type { RepoRecord } from "@/repo-read/access";
import { clearTouches, TOUCH_INTERVAL_MS, touchRepo } from "@/repo-read/first-view";
import { issueGrant } from "@/repo-read/grant";
import type { SharedCacheReader } from "@/repo-read/shared-cache";
import { clearSnapshotMemory, RepoSnapshots } from "@/repo-read/snapshot";
import { ViewerBackendError } from "@/viewer-backend";
import { FakeR2Bucket } from "./helpers/fake-storage";
import { FakeIngestCoordinator, MemoryEdgeCache, privateRepo, publicRepo, repoReadFixture, sessionCookies, stubSessions } from "./helpers/repo-read-fixture";

/**
 * The read path over sealed content (#263): private bytes open only after
 * authorization, never reach a cache tier unsealed, and anything that does not
 * open is a retryable 503, never served.
 */

const KEY = process.env.REPO_CONTENT_KEY as string;
const ROTATED = "test-repo-content-key-rotated-0123456789";
const sha = "b".repeat(40);
const repo: RepoRecord = { id: 7, owner: "octo", name: "docs", private: true, defaultBranch: "main" };
const open: RepoRecord = { ...repo, id: 8, private: false };
const grant = issueGrant(repo, "user-1", 0);
const publicGrant = issueGrant(open, null, 0);
const secret = new TextEncoder().encode("\x89PNG private logo");

describe("sealed snapshot reads", () => {
  let bucket: FakeR2Bucket;
  let edge: MemoryEdgeCache;
  let pending: Array<Promise<unknown>>;
  const reader = (sealer: ContentSealer = envelopeSealer(KEY), shared: SharedCacheReader | null = null) => new RepoSnapshots({
    store: r2Store(bucket), sealer, edge, origin: "https://rendro.test", shared, waitUntil: promise => void pending.push(promise), now: () => 0,
  });
  const settle = () => Promise.all(pending.splice(0));
  const seal = (record: RepoRecord, key: string, bytes: Uint8Array, sealer = envelopeSealer(KEY)) => sealer.seal({ repoId: record.id, key }, bytes);

  beforeEach(() => {
    bucket = new FakeR2Bucket();
    edge = new MemoryEdgeCache();
    pending = [];
    clearSnapshotMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a private object after authorization and caches only its sealed bytes, under the current key's ID", async () => {
    const key = blobKey(7, sha);
    await bucket.put(key, await seal(repo, key, secret));
    expect(await reader().asset(grant, { sha, size: secret.length })).toEqual(secret);
    await settle();
    const keyId = await envelopeSealer(KEY).currentKeyId();
    const cacheKey = `https://rendro.test/__repo-cache/v1/sealed/${keyId}/${key}`;
    expect(edge.ops.put).toEqual([cacheKey]);
    expect(isSealed(edge.entries.get(cacheKey) as Uint8Array)).toBe(true);
    expect(new TextDecoder().decode(edge.entries.get(cacheKey))).not.toContain("private logo");
    // The next isolate opens the edge copy without R2.
    clearSnapshotMemory();
    const reads = bucket.ops.get;
    expect(await reader().asset(grant, { sha, size: secret.length })).toEqual(secret);
    expect(bucket.ops.get).toBe(reads);
  });

  it("answers 503 for tampered, swapped, foreign or plaintext private bytes, and caches none of them", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const key = blobKey(7, sha);
    const sealed = await seal(repo, key, secret);
    const cases: Array<[string, Uint8Array]> = [
      ["tampered", (() => { const copy = sealed.slice(); copy[30] ^= 1; return copy; })()],
      // Another repository's blob with the same SHA, copied into this repository's prefix.
      ["foreign", await seal(open, blobKey(8, sha), secret)],
      // Another object of the same repository, swapped in.
      ["swapped", await seal(repo, blobKey(7, "c".repeat(40)), secret)],
      ["plaintext", secret],
    ];
    for (const [, bytes] of cases) {
      clearSnapshotMemory();
      await bucket.put(key, bytes);
      await expect(reader().asset(grant, { sha, size: secret.length })).rejects.toBeInstanceOf(ViewerBackendError);
    }
    await settle();
    expect(edge.ops.put).toEqual([]);
    error.mockRestore();
  });

  it("refuses a poisoned edge entry the same way", async () => {
    const key = blobKey(7, sha);
    const keyId = await envelopeSealer(KEY).currentKeyId();
    edge.entries.set(`https://rendro.test/__repo-cache/v1/sealed/${keyId}/${key}`, secret);
    await expect(reader().asset(grant, { sha, size: secret.length })).rejects.toBeInstanceOf(ViewerBackendError);
  });

  it("keeps serving content sealed under a previous key during a rotation, without caching it at the edge", async () => {
    const key = blobKey(7, sha);
    await bucket.put(key, await seal(repo, key, secret));
    const rotating = envelopeSealer(ROTATED, [KEY]);
    expect(await reader(rotating).asset(grant, { sha, size: secret.length })).toEqual(secret);
    await settle();
    expect(edge.ops.put).toEqual([]);
    // Re-sealed under the new key, it is cached again.
    clearSnapshotMemory();
    await bucket.put(key, await seal(repo, key, secret, rotating));
    expect(await reader(rotating).asset(grant, { sha, size: secret.length })).toEqual(secret);
    await settle();
    expect(edge.ops.put).toEqual([`https://rendro.test/__repo-cache/v1/sealed/${await rotating.currentKeyId()}/${key}`]);
  });

  it("serves public content as stored, and opens a sealed object of a repository made public without caching it", async () => {
    const key = blobKey(8, sha);
    await bucket.put(key, secret);
    expect(await reader().asset(publicGrant, { sha, size: secret.length })).toEqual(secret);
    await settle();
    expect(edge.ops.put).toEqual([`https://rendro.test/__repo-cache/v1/${key}`]);
    clearSnapshotMemory();
    edge.entries.clear();
    edge.ops.put.length = 0;
    await bucket.put(key, await seal(open, key, secret));
    expect(await reader().asset(publicGrant, { sha, size: secret.length })).toEqual(secret);
    await settle();
    expect(edge.ops.put).toEqual([]);
  });

  it("keeps sealed bytes out of the shared tier: never asked for a private repository, never trusted or filled with sealed bytes", async () => {
    const asked: string[] = [];
    let answer: Uint8Array | null = null;
    const shared: SharedCacheReader = (_repoId, key) => { asked.push(key); return Promise.resolve(answer); };
    // A private repository never goes through the shared tier.
    const privateKey = blobKey(7, sha);
    await bucket.put(privateKey, await seal(repo, privateKey, secret));
    expect(await reader(envelopeSealer(KEY), shared).asset(grant, { sha, size: secret.length })).toEqual(secret);
    expect(asked).toEqual([]);
    // A public repository's plaintext comes from the shared tier.
    const publicKey = blobKey(8, sha);
    answer = new TextEncoder().encode("shared copy");
    expect(await reader(envelopeSealer(KEY), shared).asset(publicGrant, { sha, size: 11 })).toEqual(answer);
    expect(asked).toEqual([publicKey]);
    // Sealed bytes from the shared tier (a repository made public) are not taken: R2's copy is opened instead.
    clearSnapshotMemory();
    await bucket.put(publicKey, await seal(open, publicKey, secret));
    answer = await seal(open, publicKey, new TextEncoder().encode("stale shared copy"));
    expect(await reader(envelopeSealer(KEY), shared).asset(publicGrant, { sha, size: secret.length })).toEqual(secret);
    // And the shared route never serves them: its raw read refuses sealed objects.
    const snapshots = reader();
    expect(await snapshots.raw(publicKey)).toBeNull();
    await bucket.put(publicKey, secret);
    expect(await snapshots.raw(publicKey)).toEqual(secret);
    expect(await snapshots.raw(blobKey(8, "c".repeat(40)))).toBeNull();
  });

  it("parses opened manifests and pages", async () => {
    const commit = "c".repeat(40);
    const manifest: Partial<SnapshotManifest> = { schema: 1, repoId: 7, commit, files: {}, sidebar: null, docs: null };
    const mKey = manifestKey(7, commit, RENDERER_VERSION);
    await bucket.put(mKey, await seal(repo, mKey, new TextEncoder().encode(JSON.stringify(manifest))));
    const render = `render/v${RENDERER_VERSION}/md/${sha}/d`;
    const rKey = renderObjectKey(7, render);
    await bucket.put(rKey, await seal(repo, rKey, new TextEncoder().encode(JSON.stringify({ html: "<p>Secret</p>", title: "S", headings: [] }))));
    const snapshots = reader();
    expect(await snapshots.manifest(grant, commit, RENDERER_VERSION)).toMatchObject({ commit });
    expect(await snapshots.page(grant, { sha, size: 1, render }, "v", rendered => Promise.resolve(rendered))).toMatchObject({ html: "<p>Secret</p>" });
  });

  it("answers 503 for private reads without a content key, and lets other failures through unchanged", async () => {
    const key = blobKey(7, sha);
    await bucket.put(key, await seal(repo, key, secret));
    await expect(reader(unconfiguredSealer).asset(grant, { sha, size: secret.length })).rejects.toBeInstanceOf(ViewerBackendError);
    const broken: ContentSealer = { ...envelopeSealer(KEY), open: () => Promise.reject(new RangeError("bug")) };
    await expect(reader(broken).asset(grant, { sha, size: secret.length })).rejects.toBeInstanceOf(RangeError);
    // Public content needs no key.
    await bucket.put(blobKey(8, sha), secret);
    expect(await reader(unconfiguredSealer).asset(publicGrant, { sha, size: secret.length })).toEqual(secret);
    expect(new SealedContentError("unconfigured").message).toContain("unconfigured");
  });
});

describe("the read path over sealed content", () => {
  let fixture: Awaited<ReturnType<typeof repoReadFixture>>;
  const priv = `/r/${privateRepo.owner}/${privateRepo.name}`;
  const pub = `/r/${publicRepo.owner}/${publicRepo.name}`;
  const get = (path: string, headers: Record<string, string> = {}) => app.request(`https://rendro.test${path}`, { headers }, fixture.env, fixture.ctx);

  beforeEach(async () => {
    fixture = await repoReadFixture();
    stubSessions();
  });

  it("stores the private snapshot sealed, serves it to its reader, and a signed-out reader gets the plain 404", async () => {
    const page = fixture.bucket.keys(`gh/v1/repo/${privateRepo.id}/render/`)[0];
    expect(isSealed(fixture.bucket.objects.get(page)?.bytes as Uint8Array)).toBe(true);
    const response = await get(`${priv}/@${fixture.commits.private}/files/docs/index.md`, { cookie: sessionCookies.reader });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Secret home");
    expect((await get(`${priv}/@${fixture.commits.private}/files/docs/index.md`)).status).toBe(404);
  });

  it("answers a tampered private page with the retryable 503, never its bytes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const manifest = fixture.bucket.keys(`gh/v1/repo/${privateRepo.id}/snapshot/`).find(key => key.endsWith("manifest.json")) as string;
    expect(manifest).toBe(manifestKey(privateRepo.id, fixture.commits.private, RENDERER_VERSION));
    (fixture.bucket.objects.get(manifest)?.bytes as Uint8Array)[40] ^= 1;
    const response = await get(priv, { cookie: sessionCookies.reader });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("Secret home");
    error.mockRestore();
  });

  it("reports views to the coordinator at most once an hour per repository and visibility", async () => {
    const coordinator = new FakeIngestCoordinator();
    fixture.env.REPO_INGEST = coordinator.namespace;
    expect((await get(pub)).status).toBe(200);
    expect((await get(`${pub}/tree?dir=`)).status).toBe(200);
    expect((await get(priv, { cookie: sessionCookies.reader })).status).toBe(200);
    await fixture.settle();
    expect(coordinator.touches).toEqual([{ id: publicRepo.id, private: false }, { id: privateRepo.id, private: true }]);
    // Denied and unknown requests report nothing.
    expect((await get(priv)).status).toBe(404);
    await fixture.settle();
    expect(coordinator.touches).toHaveLength(2);
  });
});

describe("touchRepo", () => {
  const grantFor = (record: RepoRecord) => issueGrant(record, null, 0);

  beforeEach(() => clearTouches());

  it("throttles per isolate, reports a visibility change at once, and swallows failures", async () => {
    const touches: unknown[] = [];
    const waited: Array<Promise<unknown>> = [];
    let fail = false;
    const view = {
      ensure: () => Promise.reject(new Error("unused")),
      touch: (touch: unknown) => { touches.push(touch); return fail ? Promise.reject(new Error("down")) : Promise.resolve({ status: "ok" }); },
    };
    const wait = (promise: Promise<unknown>) => void waited.push(promise);
    touchRepo(view, grantFor(open), 0, wait);
    touchRepo(view, grantFor(open), TOUCH_INTERVAL_MS - 1, wait);
    expect(touches).toEqual([{ id: 8, private: false }]);
    // Made private: the coordinator hears it now, not an hour later.
    touchRepo(view, grantFor({ ...open, private: true }), 1, wait);
    fail = true;
    touchRepo(view, grantFor(open), TOUCH_INTERVAL_MS, wait);
    expect(touches).toEqual([{ id: 8, private: false }, { id: 8, private: true }, { id: 8, private: false }]);
    await expect(Promise.all(waited)).resolves.toBeDefined();
    // Without the binding there is nothing to tell.
    touchRepo(null, grantFor(repo), 0, wait);
    expect(waited).toHaveLength(3);
  });

  it("remembers a bounded number of repositories", () => {
    const touches: number[] = [];
    const view = { ensure: () => Promise.reject(new Error("unused")), touch: ({ id }: { id: number }) => { touches.push(id); return Promise.resolve(); } };
    for (let id = 1; id <= 4_097; id += 1) touchRepo(view, grantFor({ ...open, id }), 0, () => {});
    // The first one was forgotten, so it is reported again.
    touchRepo(view, grantFor({ ...open, id: 1 }), 0, () => {});
    touchRepo(view, grantFor({ ...open, id: 4_097 }), 0, () => {});
    expect(touches).toHaveLength(4_098);
  });
});
