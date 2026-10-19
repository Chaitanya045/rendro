import { describe, expect, it, vi } from "vitest";
import type { IngestOutcome } from "../src/ingest/orchestrator/coordinator";
import { coordinatorClient, coordinatorName, firstViewEnsurer, type CoordinatorClient, type DurableObjectNamespaceLike } from "../src/ingest/orchestrator/coordinator-client";
import { backoffSeconds, consumeIngestBatch, type QueueMessageLike } from "../src/ingest/orchestrator/consumer";
import type { IngestMessage } from "../src/ingest/orchestrator/messages";
import { ingestFixture, rejectWith } from "./helpers/ingest-fixture";

const repo = { id: 41, owner: "octo", name: "docs", private: false, installationId: null };
const body: IngestMessage = { v: 1, repo, branch: "main", sha: "a".repeat(40), deliveryId: "d1", reason: "push" };

function message(value: unknown, attempts = 1) {
  const calls: Array<["ack"] | ["retry", number | undefined]> = [];
  const queued: QueueMessageLike = {
    id: `m-${attempts}`, body: value, attempts,
    ack: () => { calls.push(["ack"]); },
    retry: (options) => { calls.push(["retry", options?.delaySeconds]); },
  };
  return { queued, calls };
}

async function consume(outcome: IngestOutcome | { reject: unknown }, attempts = 1, now = 0) {
  const { queued, calls } = message(body, attempts);
  const log = vi.fn();
  const client: CoordinatorClient = {
    ingest: () => ("reject" in outcome ? rejectWith(outcome.reject) : Promise.resolve(outcome)),
    ensure: () => Promise.reject(new Error("unused")),
    reconcile: () => Promise.reject(new Error("unused")),
    touch: () => Promise.reject(new Error("unused")),
    purge: () => Promise.reject(new Error("unused")),
  };
  await consumeIngestBatch({ messages: [queued] }, { coordinator: () => client, now: () => now, log });
  return { calls, log };
}

describe("consumeIngestBatch", () => {
  it("acks settled outcomes", async () => {
    for (const outcome of [
      { status: "flipped", commit: "c", previous: null, snapshot: "built", headMoved: false, staleHint: false },
      { status: "current", commit: "c", staleHint: false },
      { status: "no-ref" },
      { status: "duplicate" },
      { status: "failed", reason: "github-not-found", permanent: true, retryAt: null, commit: "c" },
    ] satisfies IngestOutcome[]) {
      expect((await consume(outcome)).calls).toEqual([["ack"]]);
    }
  });

  it("retries transient failures at GitHub's retry time, clamped to what Queues accept", async () => {
    const failed = (retryAt: number | null): IngestOutcome => ({ status: "failed", reason: "github-rate-limited", permanent: false, retryAt, commit: null });
    expect((await consume(failed(90_500), 1, 0)).calls).toEqual([["retry", 91]]);
    expect((await consume(failed(10), 1, 1000)).calls).toEqual([["retry", 1]]);
    expect((await consume(failed(10 ** 12), 1, 0)).calls).toEqual([["retry", 43_200]]);
    expect((await consume(failed(null), 3)).calls).toEqual([["retry", 40]]);
  });

  it("re-checks an unconfirmed push a couple of times, then lets reconciliation take over", async () => {
    const stale: IngestOutcome = { status: "current", commit: "c", staleHint: true };
    expect((await consume(stale, 1)).calls).toEqual([["retry", 15]]);
    expect((await consume(stale, 2)).calls).toEqual([["retry", 15]]);
    expect((await consume(stale, 3)).calls).toEqual([["ack"]]);
    expect((await consume({ status: "flipped", commit: "c", previous: null, snapshot: "existing", headMoved: false, staleHint: true }, 1)).calls).toEqual([["retry", 15]]);
  });

  it("retries when the coordinator itself fails, and drops malformed messages", async () => {
    const { calls, log } = await consume({ reject: new Error("Durable Object reset") }, 2);
    expect(calls).toEqual([["retry", 20]]);
    expect(log).toHaveBeenCalledWith("ingest.coordinator.error", expect.objectContaining({ error: "Durable Object reset", repoId: 41 }));
    expect((await consume({ reject: "weird" })).calls).toEqual([["retry", 10]]);

    const bad = message({ v: 1, repo, branch: "../x" });
    const badLog = vi.fn();
    await consumeIngestBatch({ messages: [bad.queued] }, { coordinator: () => { throw new Error("unreachable"); }, now: () => 0, log: badLog });
    expect(bad.calls).toEqual([["ack"]]);
    expect(badLog).toHaveBeenCalledWith("ingest.message.invalid", { id: "m-1" });
  });

  it("backs off exponentially up to an hour", () => {
    expect([0, 1, 2, 3, 10, 20].map(backoffSeconds)).toEqual([10, 10, 20, 40, 3600, 3600]);
  });
});

describe("coordinator client", () => {
  function namespace(handler: (request: Request) => Promise<Response>) {
    const names: string[] = [];
    const binding: DurableObjectNamespaceLike = {
      idFromName: (name) => { names.push(name); return { name }; },
      get: () => ({ fetch: (input, init) => handler(new Request(input, init)) }),
    };
    return { binding, names };
  }

  it("addresses one Durable Object per repository ID and speaks its HTTP API", async () => {
    const { coordinator, github } = ingestFixture();
    const fake = github.repo("octo", "docs", { id: 41 });
    const head = fake.commit({ "docs/index.md": "# Home\n" });
    const { binding, names } = namespace((request) => coordinator.fetch(request));
    const client = coordinatorClient(binding, 41);
    expect(names).toEqual([coordinatorName(41)]);
    expect(await client.ensure(fake.ref, "main")).toMatchObject({ status: "flipped", commit: head });
    expect(await client.ingest({ ...body, repo: fake.ref, sha: head })).toEqual({ status: "current", commit: head, staleHint: false });
    expect(await client.reconcile(fake.ref)).toEqual({ stale: [], retryAt: null });
  });

  it("throws on a failed call", async () => {
    const { binding } = namespace(() => Promise.resolve(new Response("bad", { status: 400 })));
    await expect(coordinatorClient(binding, 41).reconcile(repo)).rejects.toThrow("Coordinator answered 400");
  });

  it("coalesces first views within an isolate before they reach the Durable Object", async () => {
    let calls = 0;
    const client: CoordinatorClient = {
      ensure: () => { calls += 1; return new Promise((resolve) => setTimeout(() => resolve({ status: "current", commit: "c", staleHint: false }), 2)); },
      ingest: () => Promise.reject(new Error("unused")),
      reconcile: () => Promise.reject(new Error("unused")),
      touch: () => Promise.reject(new Error("unused")),
      purge: () => Promise.reject(new Error("unused")),
    };
    const ensure = firstViewEnsurer(() => client);
    const results = await Promise.all([ensure(repo, "main"), ensure(repo, "main"), ensure(repo, "dev")]);
    expect(results.map((result) => result.status)).toEqual(["current", "current", "current"]);
    expect(calls).toBe(2);
  });
});
