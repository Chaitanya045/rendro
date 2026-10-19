import { describe, expect, it, vi } from "vitest";
import { HttpWebhookDeliveries, nextCursor, NotConfiguredError, unconfiguredDeliveries, type WebhookDeliveries } from "../src/ingest/github/deliveries";
import { GitHubError } from "../src/ingest/github/source";
import { IngestCoordinator } from "../src/ingest/orchestrator/coordinator";
import type { CoordinatorClient } from "../src/ingest/orchestrator/coordinator-client";
import { REDELIVERY_CHECKPOINT_KEY, trackedKey } from "../src/ingest/orchestrator/keys";
import type { IngestMessage } from "../src/ingest/orchestrator/messages";
import { reconcileHeads, redeliverFailedDeliveries } from "../src/ingest/orchestrator/reconcile";
import { writeJson } from "../src/ingest/orchestrator/store";
import { FakeGitHub, type FakeDelivery } from "./helpers/fake-github";
import { FakeDurableStorage } from "./helpers/fake-storage";
import { ingestFixture, rejectWith } from "./helpers/ingest-fixture";

describe("reconcileHeads", () => {
  it("queues every tracked branch whose head moved without a webhook", async () => {
    const fixture = ingestFixture();
    const coordinators = new Map<number, IngestCoordinator>();
    const clientFor = (repoId: number): CoordinatorClient => {
      let coordinator = coordinators.get(repoId);
      if (!coordinator) {
        coordinator = new IngestCoordinator({ storage: new FakeDurableStorage() }, fixture.deps);
        coordinators.set(repoId, coordinator);
      }
      const target = coordinator;
      return {
        ingest: (message) => target.ingest(message), ensure: (repo, branch) => target.ensure(repo, branch), reconcile: (repo) => target.reconcile(repo),
        touch: (touch) => target.touch(touch), purge: (repoId) => target.purge(repoId),
      };
    };
    const repos = [1, 2, 3].map((id) => fixture.github.repo("octo", `docs-${id}`, { id }));
    for (const repo of repos) {
      repo.commit({ "docs/index.md": `# ${repo.name}\n` });
      await clientFor(repo.id).ensure(repo.ref, "main");
    }
    const missed = repos[1].change({ "docs/index.md": "# missed push\n" });
    // A registry entry that no longer parses is skipped, and a coordinator that fails is logged.
    await writeJson(fixture.store, trackedKey(99), { schema: 1, repo: { id: "x" }, branches: [] });
    await writeJson(fixture.store, trackedKey(98), { schema: 1, repo: { ...repos[0].ref, id: 98 }, branches: ["main"] });
    fixture.bucket.listLimit = 2;
    const sent: IngestMessage[] = [];
    const log = vi.fn();
    const failing = (repoId: number) => (repoId === 98 ? { ...clientFor(repoId), reconcile: () => Promise.reject(new Error("overloaded")) } : clientFor(repoId));
    const totals = await reconcileHeads({ store: fixture.store, coordinator: failing, queue: { send: (body) => { sent.push(body); return Promise.resolve(); } }, log });
    expect(totals).toEqual({ repos: 4, enqueued: 1, rateLimited: 0 });
    expect(sent).toEqual([{ v: 1, repo: repos[1].ref, branch: "main", sha: missed, deliveryId: null, reason: "reconcile" }]);
    expect(log).toHaveBeenCalledWith("reconcile.tracked.invalid", { key: trackedKey(99) });
    expect(log).toHaveBeenCalledWith("reconcile.coordinator.error", { repoId: 98, error: "overloaded" });

    // One token's budget: once GitHub rate-limits a check, the other repositories wait for the next run too.
    fixture.github.fault(/git\/ref/, () => new Response("slow", { status: 429, headers: { "retry-after": "60" } }));
    const before = fixture.github.requests.length;
    const limited = await reconcileHeads({ store: fixture.store, coordinator: (repoId) => (repoId === 98 ? { ...clientFor(1), reconcile: () => rejectWith("odd") } : clientFor(repoId)), queue: { send: () => Promise.resolve() }, log, concurrency: 1 });
    expect(limited.rateLimited).toBe(3);
    expect(fixture.github.requests.length - before).toBe(1);
    expect(log).toHaveBeenCalledWith("reconcile.coordinator.error", { repoId: 98, error: "unknown" });
  });
});

describe("redeliverFailedDeliveries", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function setup(deliveries: Array<Partial<FakeDelivery> & { guid: string; ageMs: number }>) {
    const fixture = ingestFixture();
    const github = fixture.github;
    const now = fixture.clock.time;
    let id = 1000;
    // Newest first, as GitHub lists them.
    for (const delivery of [...deliveries].sort((a, b) => a.ageMs - b.ageMs)) {
      github.deliveries.push({ id: ++id, guid: delivery.guid, delivered_at: new Date(now - delivery.ageMs).toISOString(), status_code: delivery.status_code === undefined ? 500 : delivery.status_code, event: "push" });
    }
    const client = new HttpWebhookDeliveries({ jwt: () => Promise.resolve(github.appJwt) }, { fetch: github.fetch, apiOrigin: github.origin, now: fixture.clock.now });
    const log = vi.fn();
    const run = (options: Partial<Parameters<typeof redeliverFailedDeliveries>[0]> = {}) =>
      redeliverFailedDeliveries({ store: fixture.store, deliveries: client, now: fixture.clock.now, log, ...options });
    return { ...fixture, client, log, run };
  }

  it("redelivers deliveries whose latest attempt failed, oldest first, and moves the checkpoint", async () => {
    const fixture = setup([
      { guid: "ok", ageMs: 1000, status_code: 202 },
      { guid: "failed-then-fixed", ageMs: 5000 }, { guid: "failed-then-fixed", ageMs: 2000, status_code: 204 },
      { guid: "failed", ageMs: 3000 },
      { guid: "timed-out", ageMs: 4000, status_code: null },
      { guid: "hopeless", ageMs: 6000 }, { guid: "hopeless", ageMs: 7000 }, { guid: "hopeless", ageMs: 8000 },
      { guid: "too-old", ageMs: 4 * DAY },
    ]);
    const byGuid = (guid: string) => fixture.github.deliveries.find((delivery) => delivery.guid === guid)?.id;
    const expected = [byGuid("timed-out"), byGuid("failed")];
    expect(await fixture.run()).toEqual({ redelivered: 2, complete: true, skipped: null });
    expect(fixture.github.redelivered).toEqual(expected);
    expect(fixture.log).toHaveBeenCalledWith("redelivery.gave-up", expect.objectContaining({ guid: "hopeless", attempts: 3 }));
    expect(fixture.bucket.json(REDELIVERY_CHECKPOINT_KEY)).toEqual({ since: fixture.clock.time });

    // The next run only looks back to the checkpoint (minus an hour of overlap).
    fixture.clock.time += 2 * 60 * 60 * 1000;
    fixture.github.resetLog();
    expect(await fixture.run()).toEqual({ redelivered: 0, complete: true, skipped: null });
  });

  it("pages through deliveries, stops at the page limit and keeps the checkpoint until a run completes", async () => {
    const failures = Array.from({ length: 250 }, (_, index) => ({ guid: `g${index}`, ageMs: 1000 + index }));
    const fixture = setup(failures);
    expect(await fixture.run({ maxPages: 2, maxRedeliveries: 500 })).toEqual({ redelivered: 200, complete: false, skipped: null });
    expect(fixture.bucket.json(REDELIVERY_CHECKPOINT_KEY)).toBeNull();
    expect(fixture.github.count("deliveries")).toBe(2);
    // A capped batch also leaves the checkpoint where it was.
    const capped = setup(failures);
    expect(await capped.run({ maxRedeliveries: 5 })).toEqual({ redelivered: 5, complete: true, skipped: null });
    expect(capped.bucket.json(REDELIVERY_CHECKPOINT_KEY)).toBeNull();
    expect(capped.github.count("deliveries")).toBe(3);
  });

  it("stops at an empty page and skips when the app is not configured", async () => {
    const fixture = setup([]);
    expect(await fixture.run()).toEqual({ redelivered: 0, complete: true, skipped: null });
    expect(await fixture.run({ deliveries: unconfiguredDeliveries })).toEqual({ redelivered: 0, complete: false, skipped: "not-configured" });
    await expect(unconfiguredDeliveries.redeliver(1)).rejects.toBeInstanceOf(NotConfiguredError);
    const broken: WebhookDeliveries = { list: () => Promise.reject(new Error("boom")), redeliver: () => Promise.resolve() };
    await expect(fixture.run({ deliveries: broken })).rejects.toThrow("boom");
  });

  it("judges a delivery by its newest attempt, whatever the listing order", async () => {
    const fixture = setup([]);
    const now = fixture.clock.time;
    const redeliver = vi.fn(() => Promise.resolve());
    const unsorted: WebhookDeliveries = {
      list: () => Promise.resolve({ deliveries: [
        { id: 1, guid: "g", deliveredAt: now - 5000, statusCode: 500 },
        { id: 2, guid: "g", deliveredAt: now - 1000, statusCode: 200 },
        { id: 3, guid: "h", deliveredAt: now - 5000, statusCode: 200 },
        { id: 4, guid: "h", deliveredAt: now - 1000, statusCode: 500 },
      ], next: null }),
      redeliver,
    };
    expect(await fixture.run({ deliveries: unsorted })).toMatchObject({ redelivered: 1 });
    expect(redeliver).toHaveBeenCalledWith(4);
  });

  it("an empty page with a next link still ends the scan", async () => {
    const fixture = setup([]);
    const empty: WebhookDeliveries = { list: () => Promise.resolve({ deliveries: [], next: "more" }), redeliver: () => Promise.resolve() };
    expect(await fixture.run({ deliveries: empty })).toMatchObject({ complete: true });
  });
});

describe("HttpWebhookDeliveries", () => {
  const github = new FakeGitHub();
  const client = (fetcher: typeof fetch) => new HttpWebhookDeliveries({ jwt: () => Promise.resolve(github.appJwt) }, { fetch: fetcher, apiOrigin: github.origin, now: () => 1000 });

  it("keeps only well-formed deliveries", async () => {
    const page = [
      { id: 1, guid: "a", delivered_at: "2026-10-18T00:00:00Z", status_code: 200 },
      { id: 2, guid: "b", delivered_at: "not a date", status_code: 500 },
      { id: "3", guid: "c", delivered_at: "2026-10-18T00:00:00Z", status_code: 500 },
      { id: 4, guid: 4, delivered_at: "2026-10-18T00:00:00Z", status_code: 500 },
      { id: 5, guid: "e", delivered_at: 5, status_code: 500 },
      null,
    ];
    const result = await client(() => Promise.resolve(Response.json(page, { headers: { link: '<https://api.github.test/app/hook/deliveries?cursor=abc>; rel="next"' } }))).list("start");
    expect(result).toEqual({ deliveries: [{ id: 1, guid: "a", deliveredAt: Date.parse("2026-10-18T00:00:00Z"), statusCode: 200 }], next: "abc" });
  });

  it("maps failures", async () => {
    const cases: Array<[Response, string, number | null]> = [
      [new Response("{", { status: 200 }), "invalid-response", null],
      [Response.json({ not: "an array" }), "invalid-response", null],
      [new Response("x".repeat(2 * 1024 * 1024)), "too-large", null],
      [new Response("no", { status: 403 }), "rate-limited", 61_000],
      [new Response("slow", { status: 429, headers: { "retry-after": "5" } }), "rate-limited", 6000],
      [new Response("gone", { status: 404 }), "not-found", null],
      [new Response("down", { status: 502 }), "server", null],
      [new Response("bad", { status: 400 }), "invalid-response", null],
    ];
    for (const [response, kind, retryAt] of cases) {
      const error = await client(() => Promise.resolve(response)).list(null).catch((reason: unknown) => reason);
      expect(error, kind).toBeInstanceOf(GitHubError);
      expect(error).toMatchObject({ kind, ...(retryAt === null ? {} : { retryAt }) });
    }
  });

  it("parses Link headers", () => {
    expect(nextCursor(null)).toBeNull();
    expect(nextCursor('<https://x.test/a?cursor=1>; rel="prev"')).toBeNull();
    expect(nextCursor('<https://x.test/a?cursor=1>; rel="prev", <https://x.test/a?cursor=2>; rel="next"')).toBe("2");
    expect(nextCursor('<https://x.test/a>; rel="next"')).toBeNull();
    expect(nextCursor('<not a url>; rel="next"')).toBeNull();
  });

  it("uses GitHub and the global fetch by default", async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (input) => { seen.push(input instanceof Request ? input.url : input.toString()); return Promise.resolve(Response.json([])); };
    try {
      await new HttpWebhookDeliveries({ jwt: () => Promise.resolve("jwt") }).list(null);
      expect(seen).toEqual(["https://api.github.com/app/hook/deliveries?per_page=100"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
