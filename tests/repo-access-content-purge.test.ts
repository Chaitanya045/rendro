import { describe, expect, it, vi } from "vitest";
import { IngestCoordinator } from "../src/ingest/orchestrator/coordinator";
import type { DurableObjectNamespaceLike } from "../src/ingest/orchestrator/coordinator-client";
import { blobKey, refKey, trackedKey } from "../src/ingest/orchestrator/keys";
import { coordinatorContentPurge } from "../src/repo-access/content";
import { PURGE_RETRY_MS, REMOVAL_PURGE_DELAY_MS, type CommentAccessSink } from "../src/repo-access/directory";
import { FakeDurableStorage } from "./helpers/fake-storage";
import { ingestFixture } from "./helpers/ingest-fixture";
import { accessFixture, mintedInstallationTokens } from "./helpers/repo-access-fixture";

/**
 * Purging a removed repository's cached R2 content (#263): only after GitHub
 * confirmed the removal through #258's ledger, through the repository's own
 * ingest coordinator, and never for a replayed removal.
 */

const SHA = "a".repeat(40);

/** The ingest Worker's coordinators over one bucket, as the control Worker's REPO_INGEST binding reaches them. */
function ingestNamespace() {
  const ingest = ingestFixture();
  const coordinators = new Map<string, IngestCoordinator>();
  const state = { down: false };
  const namespace: DurableObjectNamespaceLike = {
    idFromName: name => name,
    get: id => ({
      fetch: (url, init) => {
        if (state.down) return Promise.resolve(new Response("unavailable", { status: 503 }));
        let coordinator = coordinators.get(String(id));
        if (!coordinator) coordinators.set(String(id), coordinator = new IngestCoordinator({ storage: new FakeDurableStorage() }, ingest.deps));
        return coordinator.fetch(new Request(url, init));
      },
    }),
  };
  return { ingest, bucket: ingest.bucket, namespace, state };
}

async function world(comments?: CommentAccessSink) {
  const content = ingestNamespace();
  const access = accessFixture({ content: coordinatorContentPurge(content.namespace), comments, installationTokens: mintedInstallationTokens });
  await access.setup();
  const repos = [access.open, access.closed, access.teamDocs];
  // Content as ingest left it: a blob, a pointer and the reconciliation entry per repository.
  for (const repo of repos) {
    for (const key of [blobKey(repo.id, SHA), refKey(repo.id, "main"), trackedKey(repo.id)]) await content.bucket.put(key, new Uint8Array([1]));
  }
  const cached = (id: number) => content.bucket.keys(`gh/v1/repo/${id}/`).length + (content.bucket.objects.has(trackedKey(id)) ? 1 : 0);
  const audits = (id: number) => content.bucket.keys(`gh/v1/audit/purge/${id}/`);
  const fire = async () => {
    for (let round = 0; round < 10; round += 1) {
      const at = access.storage.alarm;
      if (at === null || at > access.clock.time) return;
      access.storage.alarm = null;
      await access.directory.alarm();
    }
    throw new Error("The alarm kept firing");
  };
  const advance = async (ms: number) => {
    access.clock.time += ms;
    await fire();
  };
  const removeOpen = () => {
    access.installation.repositories = new Set([access.closed.id, access.teamDocs.id]);
    return access.deliver("installation_repositories", { action: "removed", repositories_removed: [access.github.repoJson(access.open)] });
  };
  const purges = () => access.logs.filter(entry => entry.event === "access.purge").map(entry => entry.fields);
  return { ...access, content, cached, audits, advance, removeOpen, purges };
}

describe("purging a removed repository's R2 content (#263)", () => {
  it("never purges R2 for a replayed removal of a repository still installed", async () => {
    const w = await world();
    // A captured removal, replayed: GitHub still lists the repository for the installation.
    await w.deliver("installation_repositories", { action: "removed", repositories_removed: [w.github.repoJson(w.open)] });
    expect(await w.read(null, w.open)).toBeNull();
    await w.advance(REMOVAL_PURGE_DELAY_MS);
    expect(w.cached(w.open.id)).toBe(3);
    expect(w.audits(w.open.id)).toEqual([]);
    expect(w.purges()).toEqual([{ confirmed: 0, content: 0, restored: 1, postponed: 0 }]);
    expect(await w.read(null, w.open)).toMatchObject({ id: w.open.id });
  });

  it("purges R2 once GitHub confirms the removal, after the window and not before, with an audit record", async () => {
    const w = await world();
    await w.removeOpen();
    await w.advance(REMOVAL_PURGE_DELAY_MS - 1);
    expect(w.cached(w.open.id)).toBe(3);
    await w.advance(1);
    expect(w.cached(w.open.id)).toBe(0);
    expect(w.audits(w.open.id)).toHaveLength(1);
    expect(w.content.bucket.json(w.audits(w.open.id)[0])).toMatchObject({ event: "repository.content-purged", repoId: w.open.id, objects: 2 });
    // The repositories still installed keep their content.
    expect(w.cached(w.closed.id)).toBe(3);
    expect(w.purges()).toEqual([{ confirmed: 1, content: 1, restored: 0, postponed: 0 }]);
  });

  it("postpones while the ingest Worker is unreachable, then confirms with GitHub again and purges", async () => {
    const w = await world();
    await w.removeOpen();
    w.content.state.down = true;
    await w.advance(REMOVAL_PURGE_DELAY_MS);
    expect(w.cached(w.open.id)).toBe(3);
    expect(w.purges()).toEqual([{ confirmed: 1, content: 0, restored: 0, postponed: 1 }]);
    w.content.state.down = false;
    w.github.resetLog();
    await w.advance(PURGE_RETRY_MS);
    // GitHub was asked again: an earlier answer is never reused across a delay.
    expect(w.github.count("repository")).toBeGreaterThan(0);
    expect(w.cached(w.open.id)).toBe(0);
  });

  it("purges content and comments together; a failure of either repeats both", async () => {
    const purgeRepos = vi.fn<CommentAccessSink["purgeRepos"]>().mockRejectedValueOnce(new Error("Convex down")).mockResolvedValue({ notDue: [] });
    const sink: CommentAccessSink = { revoke: () => Promise.resolve(), removeRepos: () => Promise.resolve(), restoreRepos: () => Promise.resolve(), purgeRepos };
    const w = await world(sink);
    await w.removeOpen();
    await w.advance(REMOVAL_PURGE_DELAY_MS);
    // Content went (idempotent), comments failed: the entry is postponed and both run again.
    expect(w.cached(w.open.id)).toBe(0);
    expect(w.purges()).toEqual([{ confirmed: 1, content: 1, restored: 0, postponed: 1 }]);
    await w.advance(PURGE_RETRY_MS);
    expect(purgeRepos).toHaveBeenCalledTimes(2);
    expect(w.cached(w.open.id)).toBe(0);
    expect(w.purges().at(-1)).toEqual({ confirmed: 1, content: 1, restored: 0, postponed: 0 });
  });
});

describe("coordinatorContentPurge", () => {
  it("accepts finished and continuing purges and throws for anything else", async () => {
    const answers: Record<string, unknown> = { "repo:1": { status: "done" }, "repo:2": { status: "accepted" }, "repo:3": { status: "misrouted" } };
    const calls: unknown[] = [];
    const namespace: DurableObjectNamespaceLike = {
      idFromName: name => name,
      get: id => ({ fetch: (url, init) => { calls.push([String(id), url, JSON.parse(init?.body as string)]); return Promise.resolve(Response.json(answers[String(id)])); } }),
    };
    const sink = coordinatorContentPurge(namespace);
    await sink.purge([1, 2]);
    expect(calls).toEqual([["repo:1", "https://coordinator/purge", { repoId: 1 }], ["repo:2", "https://coordinator/purge", { repoId: 2 }]]);
    await expect(sink.purge([1, 3])).rejects.toThrow("A content purge was refused");
    await sink.purge([]);
  });
});
