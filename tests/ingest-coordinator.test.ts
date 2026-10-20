import { describe, expect, it } from "vitest";
import {
  FIRST_VIEW_BUDGET, FIRST_VIEW_WINDOW_MS, IngestCoordinator, MISSING_REF_TTL_MS, UNKNOWN_BRANCH_CAP, UNKNOWN_BRANCH_WINDOW_MS, type TrackedRepo,
} from "../src/ingest/orchestrator/coordinator";
import type { RefPointer } from "../src/ingest/orchestrator/ingest";
import { manifestKey, refKey, trackedKey } from "../src/ingest/orchestrator/keys";
import type { IngestMessage } from "../src/ingest/orchestrator/messages";
import { RENDERER_VERSION } from "../src/ingest/limits";
import { docsRepoFiles, ingestFixture } from "./helpers/ingest-fixture";

function setup(options: ConstructorParameters<typeof IngestCoordinator>[2] = {}) {
  const fixture = ingestFixture();
  const repo = fixture.github.repo("octo", "docs", { id: 31 });
  const coordinator = new IngestCoordinator({ storage: fixture.storage }, fixture.deps, options);
  let deliveries = 0;
  const push = (sha: string | null, deliveryId: string | null = `delivery-${++deliveries}`, branch = "main"): IngestMessage =>
    ({ v: 1, repo: repo.ref, branch, sha, deliveryId, reason: "push" });
  const pointer = (branch = "main") => fixture.bucket.json<RefPointer>(refKey(31, branch));
  return { ...fixture, repo, coordinator, push, pointer };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://coordinator${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

/** Hold GitHub responses of one endpoint until released. */
function hold(github: ReturnType<typeof ingestFixture>["github"], endpoint: "tree" | "blob" | "ref") {
  let release: () => void = () => {};
  github.gateFilter = (candidate) => candidate === endpoint;
  github.gate = new Promise((resolve) => { release = resolve; });
  return {
    reached: async () => { while (github.held === 0) await new Promise((resolve) => setTimeout(resolve, 1)); },
    release: () => { github.gate = null; github.gateFilter = null; release(); },
  };
}

describe("IngestCoordinator over HTTP", () => {
  it("routes POST /ingest, /ensure and /reconcile and rejects everything else", async () => {
    const { coordinator, repo, push } = setup();
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    expect((await coordinator.fetch(new Request("https://coordinator/ingest"))).status).toBe(405);
    expect((await coordinator.fetch(post("/ingest", "{"))).status).toBe(400);
    expect((await coordinator.fetch(post("/ingest", { v: 2 }))).status).toBe(400);
    expect((await coordinator.fetch(post("/ensure", { repo: repo.ref, branch: "a..b" }))).status).toBe(400);
    expect((await coordinator.fetch(post("/ensure", { branch: "main" }))).status).toBe(400);
    expect((await coordinator.fetch(post("/reconcile", {}))).status).toBe(400);
    expect((await coordinator.fetch(post("/other", {}))).status).toBe(404);
    // The default-branch flag reaches the admission (#294): an unknown default branch is not counted against the cap.
    expect(await (await coordinator.fetch(post("/ensure", { repo: repo.ref, branch: "gone", defaultBranch: true }))).json()).toEqual({ status: "no-ref" });
    expect(await (await coordinator.fetch(post("/ingest", push(head)))).json()).toMatchObject({ status: "flipped", commit: head });
    expect(await (await coordinator.fetch(post("/ensure", { repo: repo.ref, branch: "main" }))).json()).toEqual({ status: "current", commit: head, staleHint: false });
    expect(await (await coordinator.fetch(post("/reconcile", { repo: repo.ref }))).json()).toEqual({ stale: [], retryAt: null });
  });
});

describe("IngestCoordinator: idempotency and ordering", () => {
  it("processes a webhook delivery once, however often it arrives", async () => {
    const { coordinator, repo, push, github } = setup();
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    const message = push(head, "72d3162e-cc78-11e3-81ab-4c9367dc0958");
    expect(await coordinator.ingest(message)).toMatchObject({ status: "flipped" });
    github.resetLog();
    expect(await coordinator.ingest(message)).toEqual({ status: "duplicate" });
    expect(github.requests).toEqual([]);
    // The same commit under another delivery ID is still cheap: one free 304.
    expect(await coordinator.ingest(push(head))).toEqual({ status: "current", commit: head, staleHint: false });
    expect(github.billable()).toBe(0);
  });

  it("never moves a branch backwards on out-of-order deliveries", async () => {
    const { coordinator, repo, push, pointer, storage } = setup();
    const a = repo.commit({ "docs/index.md": "# A\n" });
    const b = repo.change({ "docs/index.md": "# B\n" });
    // B's delivery arrives first.
    expect(await coordinator.ingest(push(b, "delivery-b"))).toMatchObject({ status: "flipped", commit: b, staleHint: false });
    // A arrives late: GitHub reports B, so nothing moves. A was never served, so the hint stays open for a re-check.
    expect(await coordinator.ingest(push(a, "delivery-a"))).toEqual({ status: "current", commit: b, staleHint: true });
    expect(pointer()?.commit).toBe(b);
    expect(await storage.get("delivery:delivery-a")).toBeUndefined();
    expect(await storage.get("delivery:delivery-b")).toBeDefined();
    // A delivery for a commit that was served before is explained by history.
    const c = repo.change({ "docs/index.md": "# C\n" });
    await coordinator.ingest(push(c));
    expect(await coordinator.ingest(push(b, "delivery-b-redelivered"))).toEqual({ status: "current", commit: c, staleHint: false });
    expect(pointer()).toMatchObject({ commit: c, sequence: 2 });
  });

  it("re-checks a push that GitHub's ref API has not caught up with", async () => {
    const { coordinator, repo, push, pointer, storage } = setup();
    const a = repo.commit({ "docs/index.md": "# A\n" });
    await coordinator.ingest(push(a));
    // The webhook for B arrives before the ref API shows B.
    const b = repo.change({ "docs/index.md": "# B\n" });
    repo.branches.set("main", a);
    expect(await coordinator.ingest(push(b, "lagging"))).toEqual({ status: "current", commit: a, staleHint: true });
    expect(await storage.get("delivery:lagging")).toBeUndefined();
    repo.branches.set("main", b);
    expect(await coordinator.ingest(push(b, "lagging"))).toMatchObject({ status: "flipped", commit: b, staleHint: false });
    expect(pointer()?.commit).toBe(b);
    expect(await storage.get("delivery:lagging")).toBeDefined();
  });

  it("forgets delivery IDs after the redelivery window", async () => {
    const { coordinator, repo, push, storage, clock } = setup({ deliveryRetentionMs: 1000 });
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    await coordinator.ingest(push(head, "old"));
    clock.time += 5000;
    await coordinator.ingest(push(head, "new"));
    expect(await storage.get("delivery:old")).toBeUndefined();
    expect([...storage.data.keys()].filter((key) => key.startsWith("delivery"))).toHaveLength(2);
    expect(await storage.get("delivery:new")).toBe(clock.time);
  });
});

describe("IngestCoordinator: single flight", () => {
  it("coalesces concurrent first views of an unseen branch into one ingest", async () => {
    const { coordinator, repo, github, pointer } = setup();
    const head = repo.commit(docsRepoFiles({ pages: 6 }));
    const gate = hold(github, "tree");
    const views = Array.from({ length: 10 }, () => coordinator.ensure(repo.ref, "main"));
    await gate.reached();
    gate.release();
    const outcomes = await Promise.all(views);
    expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome)))).toEqual(new Set([JSON.stringify({
      status: "flipped", commit: head, previous: null, snapshot: "built", headMoved: false, staleHint: false,
    })]));
    expect(github.count("tree")).toBe(1);
    expect(pointer()?.commit).toBe(head);
    github.resetLog();
    // Later views read the pointer: no GitHub request at all.
    expect(await coordinator.ensure(repo.ref, "main")).toEqual({ status: "current", commit: head, staleHint: false });
    expect(github.requests).toEqual([]);
  });

  it("joins a running job for its own head, and queues one job behind it for anything newer", async () => {
    const { coordinator, repo, github, push, pointer } = setup();
    const first = repo.commit({ "docs/index.md": "# One\n" });
    const gate = hold(github, "tree");
    const running = coordinator.ingest(push(first));
    await gate.reached();
    const same = coordinator.ingest(push(first));
    const second = repo.change({ "docs/index.md": "# Two\n" });
    const newer = [coordinator.ingest(push(second)), coordinator.ingest(push(second))];
    // A request without a hint (a first view) is satisfied by whatever is running.
    const unhinted = coordinator.ingest(push(null));
    gate.release();
    // The running job notices the newer head after its flip and follows it, so its callers get the final state.
    expect(await running).toMatchObject({ status: "flipped", commit: second, previous: first, staleHint: false });
    expect(await same).toEqual(await running);
    expect(await unhinted).toEqual(await running);
    // The job queued behind it finds the branch already current.
    for (const outcome of await Promise.all(newer)) expect(outcome).toEqual({ status: "current", commit: second, staleHint: false });
    expect(github.count("tree")).toBe(2);
    expect(pointer()).toMatchObject({ commit: second, sequence: 2 });
  });

  it("serializes different branches of one repository", async () => {
    const { coordinator, repo, github, push } = setup();
    repo.commit({ "docs/index.md": "# Main\n" });
    repo.commit({ "docs/index.md": "# Dev\n" }, "dev");
    const gate = hold(github, "tree");
    const main = coordinator.ingest(push(null, null, "main"));
    const dev = coordinator.ingest(push(null, null, "dev"));
    await gate.reached();
    // dev waits for main: only one tree request is in flight.
    expect(github.held).toBe(1);
    gate.release();
    expect((await Promise.all([main, dev])).map((outcome) => outcome.status)).toEqual(["flipped", "flipped"]);
  });

  it("follows a head that moves during the build, a bounded number of times", async () => {
    const { coordinator, repo, push, pointer, bucket } = setup({ maxFollowUps: 2 });
    let next = 0;
    repo.commit({ "docs/index.md": "# v0\n" });
    // Every completed snapshot sees a newer push land.
    bucket.beforePut = (key) => { if (key.endsWith("manifest.json") && next < 10) repo.change({ "docs/index.md": `# v${++next}\n` }); };
    const outcome = await coordinator.ingest(push(null, null));
    expect(outcome).toMatchObject({ status: "flipped", headMoved: true });
    // The first build plus two follow-ups.
    expect(pointer()?.sequence).toBe(3);
    expect(next).toBe(3);
  });
});

describe("IngestCoordinator: failures", () => {
  it("refuses work for another repository", async () => {
    const { coordinator, repo, push, github } = setup();
    repo.commit({ "docs/index.md": "# Home\n" });
    await coordinator.ingest(push(null));
    const other = github.repo("octo", "other", { id: 32 });
    const misrouted = { status: "failed", reason: "misrouted", permanent: true, retryAt: null, commit: null };
    expect(await coordinator.ingest({ ...push(null), repo: other.ref })).toEqual(misrouted);
    expect(await coordinator.ensure(other.ref, "main")).toEqual(misrouted);
    expect(await coordinator.reconcile(other.ref)).toEqual({ stale: [], retryAt: null });
  });

  it("records a permanent failure, skips that head in reconciliation, and clears it once the head moves", async () => {
    const { coordinator, repo, push, github, storage, pointer } = setup();
    const good = repo.commit({ "docs/index.md": "# Good\n" });
    await coordinator.ingest(push(good));
    const bad = repo.change({ "docs/index.md": "# Bad\n" });
    github.fault(/git\/blobs/, () => new Response("gone", { status: 404 }));
    const failed = await coordinator.ingest(push(bad, "bad-delivery"));
    expect(failed).toEqual({ status: "failed", reason: "github-not-found", permanent: true, retryAt: null, commit: bad });
    expect(pointer()?.commit).toBe(good);
    expect(await storage.get("failure:main")).toMatchObject({ commit: bad, reason: "github-not-found", rendererVersion: RENDERER_VERSION });
    expect(await storage.get("delivery:bad-delivery")).toBeDefined();
    expect((await coordinator.reconcile(repo.ref)).stale).toEqual([]);
    const fixed = repo.change({ "docs/index.md": "# Fixed\n" });
    expect((await coordinator.reconcile(repo.ref)).stale).toEqual([{ branch: "main", sha: fixed }]);
    expect(await coordinator.ingest(push(fixed))).toMatchObject({ status: "flipped", commit: fixed });
    expect(await storage.get("failure:main")).toBeUndefined();
  });

  it("leaves transient failures retryable: nothing recorded, the delivery processed again", async () => {
    const { coordinator, repo, push, github, storage, pointer } = setup();
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    github.fault(/git\/blobs/, () => new Response("down", { status: 503 }), 3);
    expect(await coordinator.ingest(push(head, "flaky"))).toEqual({ status: "failed", reason: "github-server", permanent: false, retryAt: null, commit: head });
    expect(await storage.get("failure:main")).toBeUndefined();
    expect(await storage.get("delivery:flaky")).toBeUndefined();
    expect(pointer()).toBeNull();
    expect(await coordinator.ingest(push(head, "flaky"))).toMatchObject({ status: "flipped", commit: head });
  });

  it("passes rate limits through with their retry time", async () => {
    const { coordinator, repo, push, github, clock } = setup();
    repo.commit({ "docs/index.md": "# Home\n" });
    github.fault(/git\/ref/, () => new Response("slow", { status: 429, headers: { "retry-after": "120" } }));
    expect(await coordinator.ingest(push(null))).toEqual({ status: "failed", reason: "github-rate-limited", permanent: false, retryAt: clock.time + 120_000, commit: null });
  });

  it("survives a crash mid-ingest: a fresh instance on the same storage finishes the job, never serving a partial snapshot", async () => {
    const { repo, push, bucket, storage, deps, pointer, github } = setup();
    const head = repo.commit(docsRepoFiles({ pages: 10, images: 2 }));
    let puts = 0;
    bucket.failPut = () => ++puts > 6;
    const crashed = new IngestCoordinator({ storage }, deps);
    expect(await crashed.ingest(push(head, "crash"))).toMatchObject({ status: "failed", reason: "internal", permanent: false, commit: head });
    expect(pointer()).toBeNull();
    expect(bucket.objects.has(manifestKey(31, head, RENDERER_VERSION))).toBe(false);
    const fetched = github.count("blob");
    bucket.failPut = null;
    github.resetLog();
    const restarted = new IngestCoordinator({ storage }, deps);
    expect(await restarted.ingest(push(head, "crash"))).toMatchObject({ status: "flipped", commit: head });
    expect(github.count("blob")).toBeLessThanOrEqual(14 - fetched + 6);
    expect(pointer()?.commit).toBe(head);
  });

  it("keeps serving later requests after its own storage fails", async () => {
    const { coordinator, repo, push, storage, github } = setup();
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    const put = storage.put.bind(storage);
    // Recording a permanent failure fails too: the request errors (the queue retries it).
    storage.put = (key, value) => (key.startsWith("failure:") ? Promise.reject(new Error("storage down")) : put(key, value));
    github.fault(/git\/blobs/, () => new Response("gone", { status: 404 }));
    await expect(coordinator.ingest(push(head))).rejects.toThrow("storage down");
    storage.put = put;
    expect(await coordinator.ingest(push(head))).toMatchObject({ status: "flipped", commit: head });
  });

  it("answers for a branch another instance already flipped, and reconciles with nothing tracked", async () => {
    const { coordinator, repo, push, deps } = setup();
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    await coordinator.ingest(push(head));
    const fresh = new IngestCoordinator({ storage: new (await import("./helpers/fake-storage")).FakeDurableStorage() }, deps);
    expect(await fresh.reconcile(repo.ref)).toEqual({ stale: [], retryAt: null });
    expect(await fresh.ingest(push(head))).toEqual({ status: "current", commit: head, staleHint: false });
  });
});

describe("IngestCoordinator: tracking and reconciliation", () => {
  it("registers tracked branches for the cron, writing the registry only when it changes", async () => {
    const { coordinator, repo, push, bucket, github } = setup();
    repo.commit({ "docs/index.md": "# Home\n" });
    let writes = 0;
    bucket.beforePut = (key) => { if (key === trackedKey(31)) writes += 1; };
    await coordinator.ingest(push(null));
    repo.change({ "docs/index.md": "# Home 2\n" });
    await coordinator.ingest(push(null));
    expect(writes).toBe(1);
    expect(bucket.json<TrackedRepo>(trackedKey(31))).toEqual({ schema: 1, repo: repo.ref, branches: ["main"] });
    repo.commit({ "docs/index.md": "# Dev\n" }, "dev");
    await coordinator.ingest(push(null, null, "dev"));
    // A rename is picked up with the next flip (the repository ID is unchanged).
    const renamed = github.rename(repo, "octo", "renamed-docs");
    renamed.change({ "docs/index.md": "# Dev 2\n" }, "dev");
    await coordinator.ingest({ ...push(null, null, "dev"), repo: renamed.ref });
    expect(writes).toBe(3);
    expect(bucket.json<TrackedRepo>(trackedKey(31))).toMatchObject({ repo: { name: "renamed-docs" }, branches: ["dev", "main"] });
  });

  it("re-checks tracked heads with ETags and lists the ones that moved", async () => {
    const { coordinator, repo, push, github, storage } = setup();
    repo.commit({ "docs/index.md": "# Home\n" });
    repo.commit({ "docs/index.md": "# Dev\n" }, "dev");
    repo.commit({ "docs/index.md": "# Gone\n" }, "gone");
    for (const branch of ["main", "dev", "gone"]) await coordinator.ingest(push(null, null, branch));
    github.resetLog();
    expect(await coordinator.reconcile(repo.ref)).toEqual({ stale: [], retryAt: null });
    expect(github.billable()).toBe(0);
    const moved = repo.change({ "docs/index.md": "# Moved\n" }, "dev");
    repo.branches.delete("gone");
    expect(await coordinator.reconcile(repo.ref)).toEqual({ stale: [{ branch: "dev", sha: moved }], retryAt: null });
    // A failing branch is skipped; the others are still checked.
    github.fault(({ url }) => url.pathname.endsWith("/dev"), () => new Response("down", { status: 500 }), 3);
    expect((await coordinator.reconcile(repo.ref)).stale).toEqual([]);
    // Once rate limited, the rest waits for the next run.
    github.fault(/git\/ref/, () => new Response("slow", { status: 429, headers: { "retry-after": "60" } }));
    const limited = await coordinator.reconcile(repo.ref);
    expect(limited.stale).toEqual([]);
    expect(limited.retryAt).toBeGreaterThan(0);
    expect(await storage.get("branches")).toEqual(["dev", "gone", "main"]);
  });

  it("flags every tracked branch after a renderer change", async () => {
    const fixture = setup();
    const head = fixture.repo.commit({ "docs/index.md": "# Home\n" });
    await fixture.coordinator.ingest(fixture.push(null));
    const bumped = new IngestCoordinator({ storage: fixture.storage }, { ...fixture.deps, pipeline: { ...fixture.deps.pipeline, rendererVersion: RENDERER_VERSION + 1 } });
    expect((await bumped.reconcile(fixture.repo.ref)).stale).toEqual([{ branch: "main", sha: head }]);
  });

});

describe("IngestCoordinator: first-view admission (#294)", () => {
  const docs = { "docs/index.md": "# Home\n" };

  it("answers an unknown branch from the negative cache: repeats make no GitHub call until the entry expires", async () => {
    const { coordinator, repo, github, clock } = setup();
    repo.commit(docs);
    github.resetLog();
    expect(await coordinator.ensure(repo.ref, "no-such-branch")).toEqual({ status: "no-ref" });
    expect(github.count("ref")).toBe(1);
    for (let repeat = 0; repeat < 5; repeat += 1) expect(await coordinator.ensure(repo.ref, "no-such-branch")).toEqual({ status: "no-ref" });
    clock.time += MISSING_REF_TTL_MS - 1;
    expect(await coordinator.ensure(repo.ref, "no-such-branch")).toEqual({ status: "no-ref" });
    expect(github.requests).toHaveLength(1);
    clock.time += 1;
    expect(await coordinator.ensure(repo.ref, "no-such-branch")).toEqual({ status: "no-ref" });
    expect(github.count("ref")).toBe(2);
  });

  it("counts concurrent readers of one unknown branch as one GitHub call and one miss", async () => {
    const { coordinator, repo, github, storage } = setup();
    repo.commit(docs);
    github.resetLog();
    const gate = hold(github, "ref");
    const readers = Array.from({ length: 5 }, () => coordinator.ensure(repo.ref, "typo"));
    await gate.reached();
    gate.release();
    expect(await Promise.all(readers)).toEqual(Array(5).fill({ status: "no-ref" }));
    expect(github.count("ref")).toBe(1);
    expect(await storage.get("first-views")).toMatchObject({ unknown: 1, jobs: 1, missing: { typo: expect.any(Number) } });
  });

  it("holds the cap for unknown branches requested together: jobs still in flight count as possible misses", async () => {
    const { coordinator, repo, github, storage } = setup();
    repo.commit(docs);
    github.resetLog();
    const outcomes = await Promise.all(Array.from({ length: 25 }, (_, index) => coordinator.ensure(repo.ref, `y${index}`)));
    expect(outcomes.filter(outcome => outcome.status === "no-ref")).toHaveLength(UNKNOWN_BRANCH_CAP);
    expect(outcomes.filter(outcome => outcome.status === "throttled")).toHaveLength(25 - UNKNOWN_BRANCH_CAP);
    expect(github.count("ref")).toBe(UNKNOWN_BRANCH_CAP);
    expect(await storage.get("first-views")).toMatchObject({ jobs: UNKNOWN_BRANCH_CAP, unknown: UNKNOWN_BRANCH_CAP });
  });

  it("frees an in-flight slot when a first-view job turns out to be real, or fails", async () => {
    const { coordinator, repo, storage } = setup();
    repo.commit(docs);
    for (let index = 0; index < UNKNOWN_BRANCH_CAP + 3; index += 1) repo.commit(docs, `real${index}`);
    const outcomes = await Promise.all(Array.from({ length: UNKNOWN_BRANCH_CAP + 3 }, (_, index) => coordinator.ensure(repo.ref, `real${index}`)));
    expect(outcomes.filter(outcome => outcome.status === "flipped")).toHaveLength(UNKNOWN_BRANCH_CAP);
    // Every slot is free again once those builds answered.
    expect(await coordinator.ensure(repo.ref, `real${UNKNOWN_BRANCH_CAP}`)).toMatchObject({ status: "flipped" });
    // A first view whose miss cannot be recorded still gives its slot back.
    const put = storage.put.bind(storage);
    storage.put = (key: string, value: unknown) =>
      key === "first-views" && Object.keys((value as { missing: object }).missing).length > 0 ? Promise.reject(new Error("storage down")) : put(key, value);
    for (let attempt = 0; attempt < UNKNOWN_BRANCH_CAP; attempt += 1) await expect(coordinator.ensure(repo.ref, `gone${attempt}`)).rejects.toThrow("storage down");
    storage.put = put;
    expect(await coordinator.ensure(repo.ref, `real${UNKNOWN_BRANCH_CAP + 1}`)).toMatchObject({ status: "flipped" });
    expect(await storage.get("first-views")).toMatchObject({ unknown: 0 });
  });

  it("asks GitHub about at most the cap's worth of distinct unknown branches per window, then refuses other new branches until it ends", async () => {
    const { coordinator, repo, github, clock, pointer } = setup();
    repo.commit(docs);
    github.resetLog();
    const started = clock.time;
    const outcomes = [];
    for (let name = 1; name <= 25; name += 1) outcomes.push(await coordinator.ensure(repo.ref, `x${name}`));
    expect(github.count("ref")).toBe(UNKNOWN_BRANCH_CAP);
    expect(outcomes.slice(0, UNKNOWN_BRANCH_CAP)).toEqual(Array(UNKNOWN_BRANCH_CAP).fill({ status: "no-ref" }));
    expect(outcomes.slice(UNKNOWN_BRANCH_CAP)).toEqual(Array(25 - UNKNOWN_BRANCH_CAP).fill({ status: "throttled", retryAt: started + UNKNOWN_BRANCH_WINDOW_MS }));
    // Branches already known to be missing are still answered from the cache, not refused.
    expect(await coordinator.ensure(repo.ref, "x1")).toEqual({ status: "no-ref" });
    // The default branch is exempt and still builds.
    expect(await coordinator.ensure(repo.ref, "main", true)).toMatchObject({ status: "flipped" });
    // A real new branch waits for the window, then prepares and flips.
    const feature = repo.commit({ "docs/index.md": "# Feature\n" }, "feature");
    expect(await coordinator.ensure(repo.ref, "feature")).toMatchObject({ status: "throttled" });
    clock.time = started + UNKNOWN_BRANCH_WINDOW_MS;
    expect(await coordinator.ensure(repo.ref, "feature")).toMatchObject({ status: "flipped", commit: feature });
    expect(pointer("feature")?.commit).toBe(feature);
    expect(await coordinator.ensure(repo.ref, "feature")).toEqual({ status: "current", commit: feature, staleHint: false });
  });

  it("budgets first-view jobs per repository and window; readers joining a queued job and served branches spend nothing", async () => {
    const { coordinator, repo, github, clock } = setup();
    repo.commit(docs);
    for (let index = 0; index < FIRST_VIEW_BUDGET; index += 1) repo.commit(docs, `b${index}`);
    const started = clock.time;
    // Ten concurrent readers of one new branch are one job.
    const gate = hold(github, "tree");
    const readers = Array.from({ length: 10 }, () => coordinator.ensure(repo.ref, "b0"));
    await gate.reached();
    gate.release();
    expect(new Set((await Promise.all(readers)).map(outcome => outcome.status))).toEqual(new Set(["flipped"]));
    for (let index = 1; index < FIRST_VIEW_BUDGET; index += 1) expect(await coordinator.ensure(repo.ref, `b${index}`)).toMatchObject({ status: "flipped" });
    // Served branches answer from their pointer.
    expect(await coordinator.ensure(repo.ref, "b0")).toMatchObject({ status: "current" });
    repo.commit(docs, "late");
    expect(await coordinator.ensure(repo.ref, "late")).toEqual({ status: "throttled", retryAt: started + FIRST_VIEW_WINDOW_MS });
    clock.time = started + FIRST_VIEW_WINDOW_MS;
    expect(await coordinator.ensure(repo.ref, "late")).toMatchObject({ status: "flipped" });
  });

  it("forgets a missing branch once a push builds it, and never counts the default branch against the cap", async () => {
    const { coordinator, repo, github, push, storage } = setup();
    repo.commit(docs);
    for (let index = 0; index < UNKNOWN_BRANCH_CAP + 2; index += 1) expect(await coordinator.ensure(repo.ref, "main-to-be", true)).toEqual({ status: "no-ref" });
    expect(await coordinator.ensure(repo.ref, "new")).toEqual({ status: "no-ref" });
    expect(github.count("ref")).toBe(2);
    // The branch is created and pushed: the push builds it and the negative entry goes.
    const head = repo.commit(docs, "new");
    expect(await coordinator.ingest(push(head, "created", "new"))).toMatchObject({ status: "flipped", commit: head });
    expect((await storage.get<{ missing: Record<string, number> }>("first-views"))?.missing).toEqual({ "main-to-be": expect.any(Number) });
    expect(await coordinator.ensure(repo.ref, "new")).toEqual({ status: "current", commit: head, staleHint: false });
    // A push for a branch with no entry leaves the record as it is.
    await coordinator.ingest(push(repo.change({ "docs/index.md": "# Changed\n" }), "changed", "main"));
    expect(Object.keys((await storage.get<{ missing: Record<string, number> }>("first-views"))?.missing ?? {})).toEqual(["main-to-be"]);
  });
});
