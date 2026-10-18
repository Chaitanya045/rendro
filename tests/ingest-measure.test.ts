import { describe, expect, it } from "vitest";
import type { IngestMessage } from "../src/ingest/orchestrator/messages";
import { docsRepoFiles, ingestFixture } from "./helpers/ingest-fixture";

/**
 * Ingest cost for a fixture repository: 300 docs pages, 40 images and 1,500
 * source files (about 1,850 blobs). Request counts are exact and asserted. Wall
 * times are Node against the in-process fake GitHub (no network latency), and
 * pacedMs is the minimum real time the client's own rate pacing adds; both are
 * printed for the PR, not asserted.
 */

interface Row {
  scenario: string;
  billable: number;
  notModified: number;
  archive: number;
  blobs: number;
  ms: number;
  /** Time the client spends pacing itself below GitHub's per-endpoint limit (10 requests/s after a burst of 10). */
  pacedMs: number;
}

const FILES = docsRepoFiles({ pages: 300, images: 40, sources: 1500, pageBytes: 2000 });

async function measure(scenario: string, fixture: ReturnType<typeof ingestFixture>, run: () => Promise<unknown>): Promise<Row> {
  fixture.github.resetLog();
  fixture.clock.sleeps.length = 0;
  const started = performance.now();
  await run();
  const ms = performance.now() - started;
  return {
    scenario, billable: fixture.github.billable(), notModified: fixture.github.count(undefined, { status: 304 }),
    archive: fixture.github.count("archive"), blobs: fixture.github.count("blob"), ms: Math.round(ms),
    pacedMs: fixture.clock.sleeps.reduce((total, sleep) => total + sleep, 0),
  };
}

describe("ingest cost", () => {
  it("first import vs incremental push", async () => {
    const rows: Row[] = [];
    let delivery = 0;
    const message = (fixture: ReturnType<typeof ingestFixture>, repoId: number): IngestMessage => ({
      v: 1, repo: [...fixture.github.repos.values()].find((repo) => repo.id === repoId)?.ref as IngestMessage["repo"],
      branch: "main", sha: null, deliveryId: `measure-${++delivery}`, reason: "push",
    });

    const archived = ingestFixture();
    const repo = archived.github.repo("octo", "big-docs", { id: 51 });
    repo.commit(FILES);
    rows.push(await measure("first import (archive)", archived, () => archived.coordinator.ingest(message(archived, 51))));

    const perBlob = ingestFixture({ snapshot: { tarball: { minMissingBlobs: Number.POSITIVE_INFINITY } } });
    perBlob.github.repo("octo", "big-docs", { id: 51 }).commit(FILES);
    rows.push(await measure("first import (per-blob)", perBlob, () => perBlob.coordinator.ingest(message(perBlob, 51))));

    repo.change({ "docs/page-1.md": "# One\n", "docs/section-1/page-5.md": "# Five\n", "docs/img/new.png": "png" });
    rows.push(await measure("push: 2 pages + 1 image changed", archived, () => archived.coordinator.ingest(message(archived, 51))));

    repo.change({ "src/module-1.ts": "export const changed = true;\n" });
    rows.push(await measure("push: outside the docs", archived, () => archived.coordinator.ingest(message(archived, 51))));

    const duplicate = message(archived, 51);
    repo.change({ "docs/page-2.md": "# Two\n" });
    await archived.coordinator.ingest(duplicate);
    rows.push(await measure("duplicate delivery", archived, () => archived.coordinator.ingest(duplicate)));

    rows.push(await measure("reconcile, nothing moved", archived, () => archived.coordinator.reconcile(repo.ref)));

    console.table(rows);
    const byName = Object.fromEntries(rows.map((row) => [row.scenario, row]));
    // ref + tree + tarball; the archive download and the post-flip 304 are free.
    expect(byName["first import (archive)"]).toMatchObject({ billable: 3, archive: 1, blobs: 0, notModified: 1 });
    // ref + tree + one request per docs blob (301 pages, 40 images).
    expect(byName["first import (per-blob)"]).toMatchObject({ billable: 2 + 341, archive: 0, blobs: 341 });
    expect(byName["push: 2 pages + 1 image changed"]).toMatchObject({ billable: 2 + 3, blobs: 3, archive: 0 });
    expect(byName["push: outside the docs"]).toMatchObject({ billable: 2, blobs: 0 });
    expect(byName["duplicate delivery"]).toMatchObject({ billable: 0, notModified: 0 });
    expect(byName["reconcile, nothing moved"]).toMatchObject({ billable: 0, notModified: 1 });
  }, 120_000);
});
