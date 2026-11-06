import { describe, expect, it } from "vitest";
import { readPointer } from "../src/ingest/orchestrator/ingest";
import { ingestFixture } from "./helpers/ingest-fixture";

/**
 * Public repositories the App is not installed on (#354) have no webhooks: they are ingested on first view and kept
 * fresh by the reconciliation cron's conditional head polling, both with Rendro's public-read token (the fixture's only
 * credential here), which the fake GitHub accepts for public repositories alone.
 */
const PUBLIC_READ_TOKEN = "fake-public-read-token";

describe("ingest and freshness of a public repository without an installation", () => {
  it("builds it on first view with the public-read token, then polls its head with an ETag", async () => {
    const { github, coordinator, store } = ingestFixture({ token: PUBLIC_READ_TOKEN });
    const repo = github.repo("lib-org", "docs", { id: 901 });
    const first = repo.commit({ "docs/index.md": "# Library\n" });
    // A first view names no installation: the read path cannot know one.
    const ref = { ...repo.ref, installationId: null };
    expect(await coordinator.ensure(ref, "main")).toMatchObject({ status: "flipped", commit: first });
    expect((await readPointer(store, repo.id, "main"))?.value.commit).toBe(first);
    // Every request carried the public-read token, and nothing else.
    expect(new Set(github.requests.filter(request => request.endpoint !== "archive").map(request => request.authorization))).toEqual(new Set([`Bearer ${PUBLIC_READ_TOKEN}`]));

    // Unchanged: the cron's check is a conditional 304 and queues nothing.
    for (let poll = 0; poll < 2; poll += 1) {
      github.resetLog();
      expect(await coordinator.reconcile(ref)).toEqual({ stale: [], retryAt: null });
      expect(github.requests.map(request => [request.endpoint, request.status, request.authorization])).toEqual([["ref", 304, `Bearer ${PUBLIC_READ_TOKEN}`]]);
    }

    // A push no webhook announced: the next poll finds the new head.
    const moved = repo.change({ "docs/index.md": "# Library, updated\n" });
    expect(await coordinator.reconcile(ref)).toEqual({ stale: [{ branch: "main", sha: moved }], retryAt: null });
    // The queued message brings it up to date.
    expect(await coordinator.ingest({ v: 1, repo: ref, branch: "main", sha: moved, deliveryId: null, reason: "reconcile" })).toMatchObject({ status: "flipped", commit: moved });
    expect(await coordinator.reconcile(ref)).toEqual({ stale: [], retryAt: null });
  });

  it("keeps serving what it has when the repository turns private or disappears, and polls it quietly", async () => {
    const { github, coordinator } = ingestFixture({ token: PUBLIC_READ_TOKEN });
    const repo = github.repo("lib-org", "docs", { id: 902 });
    repo.commit({ "docs/index.md": "# Library\n" });
    const ref = { ...repo.ref, installationId: null };
    await coordinator.ensure(ref, "main");
    repo.isPrivate = true;
    // The public-read token cannot see it any more: the poll finds nothing to queue (the read path's confirmation hides it).
    expect(await coordinator.reconcile(ref)).toEqual({ stale: [], retryAt: null });
  });
});
