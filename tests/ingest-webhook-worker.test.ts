import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptPushWebhook, MAX_WEBHOOK_BYTES, parsePush, verifyWebhookSignature } from "../src/ingest/github/webhook";
import { HttpGitHubSource } from "../src/ingest/github/http-source";
import { RENDERER_VERSION } from "../src/ingest/limits";
import type { DurableObjectNamespaceLike } from "../src/ingest/orchestrator/coordinator-client";
import { refKey } from "../src/ingest/orchestrator/keys";
import type { IngestMessage } from "../src/ingest/orchestrator/messages";
import worker, { ingestDependencies, log, RepoIngestCoordinator, type IngestWorkerEnv } from "../src/ingest/orchestrator/worker";
import { FakeGitHub } from "./helpers/fake-github";
import { FakeDurableStorage, FakeR2Bucket } from "./helpers/fake-storage";
import { rejectWith } from "./helpers/ingest-fixture";

const SECRET = "webhook-secret";
const SHA = "a".repeat(40);
const encoder = new TextEncoder();

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main", before: "0".repeat(40), after: SHA, deleted: false,
    repository: { id: 7, name: "docs", full_name: "octo/docs", private: true, owner: { login: "octo" } },
    installation: { id: 42 },
    ...overrides,
  };
}

function webhook(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://rendro.test/webhooks/github", {
    method: "POST", body,
    headers: { "x-github-event": "push", "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958", "x-hub-signature-256": sign(body), ...headers },
  });
}

describe("webhook signature", () => {
  it("accepts GitHub's HMAC-SHA256 and nothing else", async () => {
    const body = encoder.encode("{}");
    expect(await verifyWebhookSignature(SECRET, body, sign("{}"))).toBe(true);
    expect(await verifyWebhookSignature(SECRET, body, sign("{}", "other"))).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, sign("{} "))).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, sign("{}").toUpperCase())).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, `sha1=${"0".repeat(40)}`)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, body, null)).toBe(false);
    expect(await verifyWebhookSignature("", body, sign("{}", ""))).toBe(false);
  });
});

describe("parsePush", () => {
  it("turns a branch push into an ingest message keyed by the delivery", () => {
    expect(parsePush("push", "d-1", pushPayload())).toEqual({
      kind: "ingest",
      message: { v: 1, repo: { id: 7, owner: "octo", name: "docs", private: true, installationId: 42 }, branch: "main", sha: SHA, deliveryId: "d-1", reason: "push" },
    });
    const { installation: _installation, ...withoutInstallation } = pushPayload({ ref: "refs/heads/feature/x" });
    expect(parsePush("push", "not a valid id!", withoutInstallation)).toMatchObject({ kind: "ingest", message: { branch: "feature/x", deliveryId: null, repo: { installationId: null } } });
    expect(parsePush("push", null, pushPayload())).toMatchObject({ message: { deliveryId: null } });
  });

  it("ignores everything else", () => {
    expect(parsePush("ping", "d", {})).toEqual({ kind: "ignored", reason: "event" });
    expect(parsePush(null, "d", {})).toEqual({ kind: "ignored", reason: "event" });
    expect(parsePush("push", "d", null)).toEqual({ kind: "ignored", reason: "not-a-branch" });
    expect(parsePush("push", "d", pushPayload({ ref: "refs/tags/v1" }))).toEqual({ kind: "ignored", reason: "not-a-branch" });
    expect(parsePush("push", "d", pushPayload({ deleted: true }))).toEqual({ kind: "ignored", reason: "deleted" });
    expect(parsePush("push", "d", pushPayload({ after: "0".repeat(40) }))).toEqual({ kind: "ignored", reason: "deleted" });
    expect(parsePush("push", "d", pushPayload({ after: "nope" }))).toEqual({ kind: "ignored", reason: "deleted" });
    expect(parsePush("push", "d", pushPayload({ repository: { id: "7" } }))).toEqual({ kind: "ignored", reason: "malformed" });
    expect(parsePush("push", "d", pushPayload({ repository: undefined }))).toEqual({ kind: "ignored", reason: "malformed" });
  });
});

describe("acceptPushWebhook", () => {
  function queue() {
    const sent: IngestMessage[] = [];
    return { sent, queue: { send: (body: IngestMessage) => { sent.push(body); return Promise.resolve(); } } };
  }

  it("verifies, queues and answers 202", async () => {
    const { sent, queue: target } = queue();
    const response = await acceptPushWebhook(webhook(JSON.stringify(pushPayload())), { secret: SECRET, queue: target });
    expect(response.status).toBe(202);
    expect(sent).toEqual([expect.objectContaining({ sha: SHA, deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958" }) as unknown]);
  });

  it("rejects bad requests before queueing anything", async () => {
    const { sent, queue: target } = queue();
    const body = JSON.stringify(pushPayload());
    const options = { secret: SECRET, queue: target };
    expect((await acceptPushWebhook(new Request("https://rendro.test/w"), options)).status).toBe(405);
    expect((await acceptPushWebhook(webhook(body, { "x-hub-signature-256": sign(body, "wrong") }), options)).status).toBe(401);
    expect((await acceptPushWebhook(webhook(body, { "content-length": String(MAX_WEBHOOK_BYTES + 1) }), options)).status).toBe(413);
    const big = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    const streamed = new Request("https://rendro.test/w", { method: "POST", body: new Blob([big]).stream(), duplex: "half" } as RequestInit);
    expect((await acceptPushWebhook(streamed, options)).status).toBe(413);
    const cut = new Request("https://rendro.test/w", { method: "POST", body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("{")); controller.error(new Error("reset")); } }), duplex: "half" } as RequestInit);
    expect((await acceptPushWebhook(cut, options)).status).toBe(400);
    expect((await acceptPushWebhook(webhook("{"), options)).status).toBe(400);
    expect((await acceptPushWebhook(webhook(JSON.stringify(pushPayload({ ref: "refs/tags/v1" }))), options)).status).toBe(204);
    expect(sent).toEqual([]);
  });

  it("lets a queue failure surface, so GitHub marks the delivery failed for redelivery", async () => {
    const failing = { send: () => Promise.reject(new Error("queue down")) };
    await expect(acceptPushWebhook(webhook(JSON.stringify(pushPayload())), { secret: SECRET, queue: failing })).rejects.toThrow("queue down");
  });
});

describe("ingest Worker entry", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function environment(overrides: Partial<IngestWorkerEnv> = {}) {
    const github = new FakeGitHub();
    const bucket = new FakeR2Bucket();
    const sent: IngestMessage[] = [];
    const objects = new Map<string, RepoIngestCoordinator>();
    const env: IngestWorkerEnv = {
      INGEST_BUCKET: bucket,
      INGEST_QUEUE: { send: (body) => { sent.push(body); return Promise.resolve(); } },
      INGEST_COORDINATOR: null as unknown as DurableObjectNamespaceLike,
      GITHUB_API_ORIGIN: github.origin,
      GITHUB_ARCHIVE_ORIGINS: ` ${github.archiveOrigin} ,`,
      GITHUB_DEV_TOKEN: github.token,
      IMAGE_PROXY_SECRET: process.env.IMAGE_PROXY_SECRET as string,
      ...overrides,
    };
    env.INGEST_COORDINATOR = {
      idFromName: (name) => name,
      get: (id) => ({ fetch: (input, init) => {
        let object = objects.get(String(id));
        if (!object) {
          object = new RepoIngestCoordinator({ storage: new FakeDurableStorage() }, env);
          objects.set(String(id), object);
        }
        return object.fetch(new Request(input, init));
      } }),
    };
    return { github, bucket, sent, env };
  }

  it("builds its dependencies from the environment", () => {
    const deps = ingestDependencies({ INGEST_BUCKET: new FakeR2Bucket() } as unknown as IngestWorkerEnv);
    expect(deps.source).toBeInstanceOf(HttpGitHubSource);
    expect(deps.pipeline.rendererVersion).toBe(RENDERER_VERSION);
    expect(deps.now()).toBeGreaterThan(0);
    expect(ingestDependencies({ INGEST_BUCKET: new FakeR2Bucket(), GITHUB_ARCHIVE_ORIGINS: " , " } as unknown as IngestWorkerEnv).source).toBeInstanceOf(HttpGitHubSource);
  });

  it("serves no routes", () => {
    expect(worker.fetch().status).toBe(404);
  });

  it("consumes queue batches through the per-repository coordinator", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { github, bucket, env } = environment();
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(github.fetch);
    const repo = github.repo("octo", "docs", { id: 7, private: true });
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    const acked: string[] = [];
    await worker.queue({ messages: [{ id: "m1", attempts: 1, body: { v: 1, repo: repo.ref, branch: "main", sha: head, deliveryId: "d1", reason: "push" }, ack: () => { acked.push("m1"); }, retry: () => {} }] }, env);
    expect(acked).toEqual(["m1"]);
    expect(bucket.json<{ commit: string }>(refKey(7, "main"))?.commit).toBe(head);
    expect(github.requests[0].authorization).toBe(`Bearer ${github.token}`);
    expect(globalFetch).toHaveBeenCalled();
  });

  it("delays a rate-limited message until GitHub's retry time", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { github, env } = environment();
    vi.spyOn(globalThis, "fetch").mockImplementation(github.fetch);
    const repo = github.repo("octo", "docs", { id: 8 });
    repo.commit({ "docs/index.md": "# Home\n" });
    github.fault(/git\/ref/, () => new Response("slow", { status: 429, headers: { "retry-after": "120" } }));
    const delays: Array<number | undefined> = [];
    await worker.queue({ messages: [{ id: "m2", attempts: 1, body: { v: 1, repo: repo.ref, branch: "main", sha: null, deliveryId: null, reason: "reconcile" }, ack: () => {}, retry: (options) => { delays.push(options?.delaySeconds); } }] }, env);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(119);
    expect(delays[0]).toBeLessThanOrEqual(121);
  });

  it("reconciles on the cron and logs both steps", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(line); });
    const { github, env, sent } = environment();
    vi.spyOn(globalThis, "fetch").mockImplementation(github.fetch);
    const repo = github.repo("octo", "docs", { id: 7 });
    repo.commit({ "docs/index.md": "# Home\n" });
    const stub = env.INGEST_COORDINATOR.get(env.INGEST_COORDINATOR.idFromName("repo:7"));
    await stub.fetch("https://coordinator/ensure", { method: "POST", body: JSON.stringify({ repo: repo.ref, branch: "main" }) });
    const moved = repo.change({ "docs/index.md": "# Moved\n" });
    await worker.scheduled(null, env);
    expect(sent).toEqual([expect.objectContaining({ sha: moved, reason: "reconcile" }) as unknown]);
    const events = lines.map((line) => JSON.parse(line) as { event: string });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "reconcile.heads", enqueued: 1 }),
      expect.objectContaining({ event: "reconcile.redelivery", skipped: "not-configured" }),
    ]) as unknown);

    // A broken bucket fails both steps; the cron logs and returns.
    lines.length = 0;
    const broken = { ...env, INGEST_BUCKET: { ...new FakeR2Bucket(), list: () => Promise.reject(new Error("R2 down")), get: () => rejectWith("odd") } as unknown as IngestWorkerEnv["INGEST_BUCKET"] };
    await worker.scheduled(null, broken);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: "reconcile.heads.error", error: "R2 down" },
      { event: "reconcile.redelivery.error", error: "unknown" },
    ]);
  });

  it("logs structured JSON lines", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("ingest.outcome", { repoId: 7 });
    expect(spy).toHaveBeenCalledWith('{"event":"ingest.outcome","repoId":7}');
  });
});
