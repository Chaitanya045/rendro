import { describe, expect, it } from "vitest";
import { IDLE_EXPIRY_MS, IngestCoordinator, WIPE_RESUME_MS, type CoordinatorOptions, type TrackedRepo } from "../src/ingest/orchestrator/coordinator";
import { manifestKey, refKey, trackedKey } from "../src/ingest/orchestrator/keys";
import type { IngestMessage } from "../src/ingest/orchestrator/messages";
import { envelopeKeyId, envelopeSealer, isSealed, unconfiguredSealer } from "../src/ingest/orchestrator/sealing";
import { plaintextSealer, r2Store, type ContentSealer } from "../src/ingest/orchestrator/store";
import { purgeAuditKey, SEARCH_ROWS_PER_BATCH, WIPE_PAGES_PER_STEP, WIPE_PAGE, wipeStep, type WipeProgress } from "../src/ingest/orchestrator/wipe";
import { RENDERER_VERSION } from "../src/ingest/limits";
import { d1SearchIndex } from "../src/search/d1";
import type { SearchIndex } from "../src/search/index";
import { FakeR2Bucket } from "./helpers/fake-storage";
import { ingestFixture, TEST_CONTENT_SEALER } from "./helpers/ingest-fixture";
import { SqliteSearchD1 } from "./helpers/search-sqlite";

/**
 * The coordinator's ownership of a repository's cached content over time
 * (#263): sealing, idle expiry with a coarse last access, and the purge of a
 * removal GitHub confirmed.
 */

const ROTATED = "test-repo-content-key-rotated-0123456789";
const docs = { "README.md": "# Project\n", "docs/index.md": "# Home\n\n## Install\n\nRun the installer.\n", "docs/guide.md": "# Guide\n\nSecret plans.\n" };

function setup(options: { sealer?: ContentSealer; private?: boolean; coordinator?: CoordinatorOptions } = {}) {
  const fixture = ingestFixture({ sealer: options.sealer });
  const db = new SqliteSearchD1();
  const search = d1SearchIndex(db);
  const deps = { ...fixture.deps, search };
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const make = (overrides: Partial<typeof deps> = {}) => new IngestCoordinator({ storage: fixture.storage }, { ...deps, ...overrides }, {
    log: (event, fields) => logs.push({ event, fields }), ...options.coordinator,
  });
  const repo = fixture.github.repo("octo", "docs", { id: 31, private: options.private ?? true });
  let deliveries = 0;
  const message = (sha: string | null, reason: IngestMessage["reason"] = "push", ref = repo.ref): IngestMessage =>
    ({ v: 1, repo: ref, branch: "main", sha, deliveryId: `delivery-${++deliveries}`, reason });
  const stored = (prefix = "gh/v1/repo/31/") => fixture.bucket.keys(prefix);
  const bytes = (key: string) => fixture.bucket.objects.get(key)?.bytes as Uint8Array;
  const rows = async () => {
    await search.migrate();
    return (db.database.prepare("SELECT count(*) AS n FROM sections WHERE repo_id = 31").all()[0] as { n: number }).n;
  };
  return { ...fixture, search, deps, logs, make, coordinator: make(), repo, message, stored, bytes, rows };
}

/** Every content object of the repository is sealed; the pointer and the registry hold only IDs and names. */
function expectSealed(world: ReturnType<typeof setup>, keyId?: string | null) {
  const keys = world.stored();
  expect(keys.length).toBeGreaterThan(3);
  for (const key of keys) {
    if (key.includes("/ref/")) expect(isSealed(world.bytes(key))).toBe(false);
    else {
      expect(isSealed(world.bytes(key))).toBe(true);
      if (keyId !== undefined) expect(envelopeKeyId(world.bytes(key))).toBe(keyId);
    }
  }
}

describe("sealed content", () => {
  it("seals every object of a private repository except its pointer, and remembers the key it used", async () => {
    const world = setup();
    const head = world.repo.commit(docs);
    expect(await world.coordinator.ensure(world.repo.ref, "main")).toMatchObject({ status: "flipped", commit: head });
    expectSealed(world, await TEST_CONTENT_SEALER.currentKeyId());
    expect(new TextDecoder().decode(world.bytes(world.stored().find(key => key.includes("/blob/")) as string))).not.toContain("Secret");
    expect(world.bucket.json<{ commit: string }>(refKey(31, "main"))?.commit).toBe(head);
    expect(world.bucket.json<TrackedRepo>(trackedKey(31))?.repo.private).toBe(true);
    expect(world.storage.data.get("content")).toBe(await TEST_CONTENT_SEALER.currentKeyId());
    expect(world.storage.data.get("private")).toBe(true);
    expect(await world.rows()).toBeGreaterThan(1);
  });

  it("stores public repositories as is, and a public view never wipes them", async () => {
    const world = setup({ private: false });
    world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    for (const key of world.stored()) expect(isSealed(world.bytes(key))).toBe(false);
    expect(world.storage.data.get("content")).toBe("plaintext");
    const deletes = world.bucket.ops.delete;
    expect(await world.coordinator.touch({ id: 31, private: false })).toEqual({ status: "ok" });
    expect(world.bucket.ops.delete).toBe(deletes);
  });

  it("keeps a repository sealed once private, whatever a stale message says", async () => {
    const world = setup();
    world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    // A reconciliation entry or an old redelivery from before the repository was made private.
    const next = world.repo.change({ "docs/guide.md": "# Guide\n\nMore secret plans.\n" });
    expect(await world.coordinator.ingest(world.message(next, "push", { ...world.repo.ref, private: false }))).toMatchObject({ status: "flipped", commit: next });
    expectSealed(world);
    expect(world.bucket.json<TrackedRepo>(trackedKey(31))?.repo.private).toBe(true);
  });

  it("replaces content stored before the repository was made private, then ingests it sealed", async () => {
    const world = setup({ private: false });
    const head = world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    expect(isSealed(world.bytes(manifestKey(31, head, RENDERER_VERSION)))).toBe(false);
    // The read path reports the visibility it granted: private now.
    expect(await world.coordinator.touch({ id: 31, private: true })).toEqual({ status: "ok" });
    expect(world.stored()).toEqual([]);
    expect(world.bucket.json(trackedKey(31))).toBeNull();
    expect(await world.rows()).toBe(0);
    expect(world.logs).toContainEqual({ event: "ingest.wipe", fields: expect.objectContaining({ repoId: 31, reason: "reseal" }) as unknown });
    expect(await world.coordinator.ensure(world.repo.ref, "main")).toMatchObject({ status: "flipped", commit: head });
    expectSealed(world);
  });

  it("replaces private content an earlier version stored as is", async () => {
    const world = setup({ sealer: plaintextSealer });
    world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    // Coordinators from before sealing recorded no content state.
    world.storage.data.delete("content");
    const sealed = world.make({ sealer: TEST_CONTENT_SEALER });
    await sealed.touch({ id: 31, private: true });
    expect(world.stored()).toEqual([]);
    await sealed.ensure(world.repo.ref, "main");
    expectSealed(world);
  });

  it("re-seals under a rotated key, after which the previous key may be dropped", async () => {
    const world = setup();
    world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    const rotated = envelopeSealer(ROTATED, [process.env.REPO_CONTENT_KEY as string]);
    const next = world.make({ sealer: rotated });
    expect(await next.ensure(world.repo.ref, "main")).toMatchObject({ status: "flipped" });
    expectSealed(world, await rotated.currentKeyId());
    const deletes = world.bucket.ops.delete;
    await next.touch({ id: 31, private: true });
    expect(world.bucket.ops.delete).toBe(deletes);
    // A view alone re-seals too.
    const again = world.make({ sealer: envelopeSealer(process.env.REPO_CONTENT_KEY as string, [ROTATED]) });
    await again.touch({ id: 31, private: true });
    expect(world.stored()).toEqual([]);
  });

  it("replaces content that does not open instead of failing on it forever", async () => {
    const world = setup();
    const first = world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    // Someone with write access to the bucket swaps the previous snapshot's manifest.
    const manifest = manifestKey(31, first, RENDERER_VERSION);
    world.bytes(manifest)[30] ^= 0x01;
    const second = world.repo.change({ "docs/index.md": "# Home v2\n" });
    expect(await world.coordinator.ingest(world.message(second))).toMatchObject({ status: "failed", reason: "content-tampered", permanent: false });
    expect(world.storage.data.get("content")).toBe("unreadable");
    expect(world.bucket.json<{ commit: string }>(refKey(31, "main"))?.commit).toBe(first);
    // The queue's retry wipes, then builds from GitHub.
    expect(await world.coordinator.ingest(world.message(second))).toMatchObject({ status: "flipped", commit: second });
    expect(world.stored().some(key => key.includes(`snapshot/${first}`))).toBe(false);
    expectSealed(world);
  });

  it("never writes a private repository without a content key, and keeps public ones working", async () => {
    const world = setup({ sealer: unconfiguredSealer });
    world.repo.commit(docs);
    expect(await world.coordinator.ensure(world.repo.ref, "main")).toMatchObject({ status: "failed", reason: "content-unconfigured", permanent: false });
    expect(world.stored()).toEqual([]);
    // A view cannot decide either: nothing changes.
    expect(await world.coordinator.touch({ id: 31, private: true })).toEqual({ status: "ok" });
    const open = setup({ sealer: unconfiguredSealer, private: false });
    open.repo.commit(docs);
    expect(await open.coordinator.ensure(open.repo.ref, "main")).toMatchObject({ status: "flipped" });
  });
});

describe("idle expiry", () => {
  it("records last access at most once a day and arms the alarm for the end of the window", async () => {
    const world = setup();
    world.repo.commit(docs);
    const start = world.clock.time;
    await world.coordinator.ensure(world.repo.ref, "main");
    expect(world.storage.data.get("lastAccess")).toBe(start);
    expect(world.storage.alarm).toBe(start + IDLE_EXPIRY_MS);
    world.clock.time += 23 * 60 * 60_000;
    await world.coordinator.touch({ id: 31, private: true });
    expect(world.storage.data.get("lastAccess")).toBe(start);
    world.clock.time += 2 * 60 * 60_000;
    await world.coordinator.touch({ id: 31, private: true });
    expect(world.storage.data.get("lastAccess")).toBe(world.clock.time);
    expect(world.storage.alarm).toBe(world.clock.time + IDLE_EXPIRY_MS);
    // An early alarm (a re-armed one that fired before the window ended) only re-arms.
    await world.coordinator.alarm();
    expect(world.stored().length).toBeGreaterThan(0);
    expect(world.storage.alarm).toBe(world.clock.time + IDLE_EXPIRY_MS);
  });

  it("expires a repository nobody viewed for the window, skips pushes until the next view, then ingests it again", async () => {
    const world = setup();
    const head = world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    world.clock.time += IDLE_EXPIRY_MS;
    await world.coordinator.alarm();
    expect(world.stored()).toEqual([]);
    expect(world.bucket.json(trackedKey(31))).toBeNull();
    expect(await world.rows()).toBe(0);
    expect(world.storage.data.get("expired")).toBe(true);
    expect(world.storage.data.has("lastAccess")).toBe(false);
    expect(world.logs).toContainEqual({ event: "ingest.wipe", fields: expect.objectContaining({ reason: "idle" }) as unknown });

    world.github.resetLog();
    const pushed = world.repo.change({ "docs/index.md": "# Home v2\n" });
    const push = world.message(pushed);
    expect(await world.coordinator.ingest(push)).toEqual({ status: "idle" });
    expect(await world.coordinator.ingest(push)).toEqual({ status: "duplicate" });
    expect(await world.coordinator.ingest(world.message(pushed, "reconcile"))).toEqual({ status: "idle" });
    expect(await world.coordinator.reconcile(world.repo.ref)).toEqual({ stale: [], retryAt: null });
    expect(world.github.requests).toEqual([]);

    // The next view: the read path's first-view path asks the coordinator to ensure the branch.
    expect(await world.coordinator.ensure(world.repo.ref, "main")).toMatchObject({ status: "flipped", commit: pushed });
    expect(head).not.toBe(pushed);
    expectSealed(world);
    expect(world.storage.data.has("expired")).toBe(false);
    const later = world.repo.change({ "docs/guide.md": "# Guide v2\n" });
    expect(await world.coordinator.ingest(world.message(later))).toMatchObject({ status: "flipped", commit: later });
  });

  it("expires content nobody ever viewed a window after its first flip; an installation ingests it again", async () => {
    const world = setup();
    const head = world.repo.commit(docs);
    const start = world.clock.time;
    await world.coordinator.ingest(world.message(head));
    expect(world.storage.data.get("lastAccess")).toBe(start);
    world.clock.time += IDLE_EXPIRY_MS + 1;
    await world.coordinator.alarm();
    expect(world.stored()).toEqual([]);
    expect(await world.coordinator.ingest(world.message(head, "install"))).toMatchObject({ status: "flipped", commit: head });
    expect(world.storage.data.has("expired")).toBe(false);
  });

  it("does nothing on an alarm when nothing was ever recorded", async () => {
    const world = setup();
    await world.coordinator.alarm();
    expect(world.storage.alarm).toBeNull();
    expect(world.bucket.ops.list).toBe(0);
  });

  it("finishes a pending wipe before answering a view, then builds", async () => {
    const world = setup();
    const head = world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    world.storage.data.set("wipe", { reason: "idle", startedAt: world.clock.time, objects: 0, searchRows: 0 } satisfies WipeProgress);
    expect(await world.coordinator.ensure(world.repo.ref, "main")).toMatchObject({ status: "flipped", commit: head });
    expect(world.storage.data.has("wipe")).toBe(false);
    expect(world.storage.data.has("expired")).toBe(false);
  });
});

describe("purging a confirmed removal", () => {
  it("deletes the content, the search rows and the coordinator's state, and keeps an audit record", async () => {
    const world = setup();
    world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    const objects = world.stored().length;
    const searchRows = await world.rows();
    const startedAt = world.clock.time;
    expect(await world.coordinator.purge(31)).toEqual({ status: "done" });
    expect(world.stored()).toEqual([]);
    expect(world.bucket.json(trackedKey(31))).toBeNull();
    expect(await world.rows()).toBe(0);
    expect([...world.storage.data.keys()]).toEqual([]);
    expect(world.bucket.json(purgeAuditKey(31, startedAt))).toEqual({
      schema: 1, event: "repository.content-purged", repoId: 31, startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(startedAt).toISOString(), objects, searchRows,
    });
    expect(world.logs).toContainEqual({ event: "ingest.wipe", fields: { repoId: 31, reason: "removed", objects, searchRows } });
    // Idempotent: a repeated purge finds nothing more to delete.
    expect(await world.coordinator.purge(31)).toEqual({ status: "done" });
  });

  it("works in bounded steps and resumes from the alarm in a fresh instance", async () => {
    const world = setup();
    const step = WIPE_PAGE * WIPE_PAGES_PER_STEP;
    for (let index = 0; index < 3 * step + 1_500; index += 1) world.bucket.objects.set(`gh/v1/repo/31/blob/${String(index).padStart(40, "0")}`, { bytes: new Uint8Array(1), etag: "e", contentType: undefined });
    expect(await world.coordinator.purge(31)).toEqual({ status: "accepted" });
    expect(world.stored()).toHaveLength(2 * step + 1_500);
    expect(world.storage.data.get("wipe")).toMatchObject({ reason: "removed", objects: step });
    expect(world.storage.alarm).toBe(world.clock.time + WIPE_RESUME_MS);
    // A view meanwhile keeps the next step's alarm, never the end of the idle window.
    world.clock.time += 10;
    await world.coordinator.touch({ id: 31, private: true });
    expect(world.storage.alarm).toBe(world.clock.time + WIPE_RESUME_MS);
    // A repeated purge continues the same one.
    expect(await world.coordinator.purge(31)).toEqual({ status: "accepted" });
    expect(world.storage.data.get("wipe")).toMatchObject({ reason: "removed", objects: 2 * step });
    // The instance is evicted; the alarm wakes a new one on the same storage, step after step.
    const next = world.make();
    await next.alarm();
    expect(world.stored()).toHaveLength(1_500);
    expect(world.storage.alarm).toBe(world.clock.time + WIPE_RESUME_MS);
    await next.alarm();
    expect(world.stored()).toEqual([]);
    expect(world.bucket.keys("gh/v1/audit/purge/31/")).toHaveLength(1);
    expect([...world.storage.data.keys()]).toEqual([]);
  });

  it("logs nowhere by default", async () => {
    const fixture = ingestFixture();
    fixture.github.repo("octo", "docs", { id: 33 }).commit(docs);
    expect(await fixture.coordinator.purge(33)).toEqual({ status: "done" });
  });

  it("stays recorded when R2 fails mid-step, and the alarm finishes it", async () => {
    const world = setup();
    world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    world.bucket.failDelete = keys => keys.some(key => key.includes("/blob/"));
    await expect(world.coordinator.purge(31)).rejects.toThrow("R2 delete failed");
    expect(world.storage.data.get("wipe")).toMatchObject({ reason: "removed" });
    // Readers already find no pointer: they stop at the first step.
    expect(world.bucket.json(refKey(31, "main"))).toBeNull();
    world.bucket.failDelete = null;
    await world.coordinator.alarm();
    expect(world.stored()).toEqual([]);
  });

  it("a removal outranks a running expiry or reseal", async () => {
    const world = setup();
    world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    world.storage.data.set("wipe", { reason: "idle", startedAt: 5, objects: 3, searchRows: 0 } satisfies WipeProgress);
    expect(await world.coordinator.purge(31)).toEqual({ status: "done" });
    expect(world.bucket.json(purgeAuditKey(31, 5))).toMatchObject({ event: "repository.content-purged" });
    expect([...world.storage.data.keys()]).toEqual([]);
  });

  it("waits for a running ingest, so nothing is written into a purged prefix", async () => {
    const world = setup();
    world.repo.commit(docs);
    let release: () => void = () => {};
    world.github.gateFilter = endpoint => endpoint === "tree";
    world.github.gate = new Promise(resolve => { release = resolve; });
    const ingest = world.coordinator.ensure(world.repo.ref, "main");
    while (world.github.held === 0) await new Promise(resolve => setTimeout(resolve, 1));
    let purged = false;
    const purge = world.coordinator.purge(31).then(outcome => { purged = true; return outcome; });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(purged).toBe(false);
    world.github.gate = null;
    release();
    expect(await ingest).toMatchObject({ status: "flipped" });
    expect(await purge).toEqual({ status: "done" });
    expect(world.stored()).toEqual([]);
  });

  it("refuses another repository's purge or touch, and validates requests", async () => {
    const world = setup();
    world.repo.commit(docs);
    await world.coordinator.ensure(world.repo.ref, "main");
    expect(await world.coordinator.purge(32)).toEqual({ status: "misrouted" });
    expect(await world.coordinator.touch({ id: 32, private: true })).toEqual({ status: "misrouted" });
    expect(world.stored().length).toBeGreaterThan(0);
    const post = (path: string, body: unknown) => world.coordinator.fetch(new Request(`https://coordinator${path}`, { method: "POST", body: JSON.stringify(body) }));
    expect((await post("/touch", { id: 31 })).status).toBe(400);
    expect((await post("/touch", { id: -1, private: true })).status).toBe(400);
    expect((await post("/purge", { repoId: "31" })).status).toBe(400);
    expect(await (await post("/touch", { id: 31, private: true })).json()).toEqual({ status: "ok" });
    expect(await (await post("/purge", { repoId: 31 })).json()).toEqual({ status: "done" });
  });
});

describe("wipeStep", () => {
  const progress = (): WipeProgress => ({ reason: "removed", startedAt: 0, objects: 0, searchRows: 0 });

  it("deletes pointers before anything else, then the rest, then search rows in batches", async () => {
    const bucket = new FakeR2Bucket();
    const order: string[] = [];
    const store = r2Store(bucket);
    const deleting = { ...store, delete: (keys: string[]) => { order.push(...keys); return store.delete(keys); } };
    for (const key of ["gh/v1/repo/9/blob/a", "gh/v1/repo/9/ref/main.json", "gh/v1/repo/9/tree/t.json", "gh/v1/repo/90/blob/a", "gh/v1/tracked/9.json"]) await bucket.put(key, new Uint8Array(1));
    let rows = SEARCH_ROWS_PER_BATCH + 7;
    const search = { deleteRepo: (_repoId: number, limit: number) => { const deleted = Math.min(rows, limit); rows -= deleted; return Promise.resolve(deleted); } } as unknown as SearchIndex;
    const state = progress();
    expect(await wipeStep(deleting, search, 9, state)).toBe(true);
    expect(order).toEqual(["gh/v1/tracked/9.json", "gh/v1/repo/9/ref/main.json", "gh/v1/repo/9/blob/a", "gh/v1/repo/9/tree/t.json"]);
    expect(bucket.keys()).toEqual(["gh/v1/repo/90/blob/a"]);
    expect(state).toMatchObject({ objects: 3, searchRows: SEARCH_ROWS_PER_BATCH + 7 });
    expect(await wipeStep(store, undefined, 9, progress())).toBe(true);
  });

  it("stops at its budget: object pages, pointer pages and search batches", async () => {
    const pages = (prefix: string) => ({
      get: () => Promise.resolve(null), has: () => Promise.resolve(false), put: () => Promise.resolve(true),
      list: (listed: string) => Promise.resolve({ keys: listed.startsWith(prefix) ? Array.from({ length: WIPE_PAGE }, (_, index) => `${listed}${index}`) : [], cursor: null }),
      delete: () => Promise.resolve(),
    });
    expect(await wipeStep(pages("gh/v1/repo/9/ref/"), undefined, 9, progress())).toBe(false);
    expect(await wipeStep(pages("gh/v1/repo/9/"), undefined, 9, progress())).toBe(false);
    const endless = { deleteRepo: () => Promise.resolve(SEARCH_ROWS_PER_BATCH) } as unknown as SearchIndex;
    const state = progress();
    expect(await wipeStep(r2Store(new FakeR2Bucket()), endless, 9, state)).toBe(false);
    expect(state.searchRows).toBe(SEARCH_ROWS_PER_BATCH * 20);
  });

  it("deletes a repository's search rows through D1 in bounded statements", async () => {
    const db = new SqliteSearchD1();
  const search = d1SearchIndex(db);
    await search.putBlob(9, "a".repeat(40), [{ slug: "one", title: "One", text: "alpha" }, { slug: "two", title: "Two", text: "beta" }]);
    await search.putBlob(10, "a".repeat(40), [{ slug: "one", title: "One", text: "alpha" }]);
    expect(await search.deleteRepo(9, 1)).toBe(1);
    expect(await search.deleteRepo(9, 5)).toBe(1);
    expect(await search.deleteRepo(9, 5)).toBe(0);
    expect(await search.hasBlob(10, "a".repeat(40))).toBe(true);
    expect(await search.query(9, '"alpha"', 10)).toEqual([]);
  });
});
