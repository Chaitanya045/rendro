import { HttpGitHubSource } from "../src/ingest/github/http-source";
import { staticTokenProvider } from "../src/ingest/github/token";
import { contentPipeline } from "../src/ingest/orchestrator/content-pipeline";
import { ingestBranch } from "../src/ingest/orchestrator/ingest";
import { plaintextSealer, r2Store, type R2BucketLike } from "../src/ingest/orchestrator/store";
import { FakeGitHub } from "../tests/helpers/fake-github";
import { initNodeMarkdownEngine } from "../tests/helpers/markdown-engine";

/** The repositories the E2E suite reads through /r/ (#234): built by the P3b pipeline from a fake GitHub. */
export type RepoFixture = { owner: string; name: string; commit: string };
export type RepoFixtures = { open: RepoFixture; closed: RepoFixture };

const logo = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><title>Logo</title><rect width="64" height="32" fill="#c2410c"/></svg>';

function docs(home: string): Record<string, string> {
  return {
    "README.md": "# Project\n",
    "docs/index.md": `# ${home}\n\nRead the [guide](guide/start.md).\n\n![Logo](img/logo.svg)\n\n> [!TIP]\n> Rendered once, at ingest.\n`,
    "docs/guide/start.md": "---\ntitle: Getting started\n---\n# Start here\n\nGo back [home](../index.md).\n",
    "docs/guide/advanced.md": "# Advanced\n\n```ts\nexport const answer = 42;\n```\n",
    "docs/img/logo.svg": logo,
  };
}

interface KvWriter { put(key: string, value: string): Promise<void> }

/** Ingests both repositories into the Worker's bucket and grants the closed one to `reader` alone. */
export async function seedRepositories(bucket: R2BucketLike, grants: KvWriter, reader: string): Promise<RepoFixtures> {
  initNodeMarkdownEngine();
  const github = new FakeGitHub();
  const open = github.repo("e2e-org", "open-docs", { id: 9001 });
  const closed = github.repo("e2e-org", "closed-docs", { id: 9002, private: true });
  const commits = { open: open.commit(docs("Open home")), closed: closed.commit(docs("Closed home")) };
  const deps = {
    source: new HttpGitHubSource({ tokens: staticTokenProvider(github.token), fetch: github.fetch, apiOrigin: github.origin, archiveOrigins: [github.archiveOrigin] }),
    store: r2Store(bucket), sealer: plaintextSealer, pipeline: contentPipeline(), now: () => Date.now(),
  };
  const etags = { get: () => Promise.resolve(null), set: () => Promise.resolve() };
  for (const repo of [open, closed]) {
    const result = await ingestBranch(deps, etags, repo.ref, "main");
    if (result.status !== "flipped") throw new Error(`Repository fixture ${repo.ref.name} was not ingested (${result.status})`);
  }
  await grants.put("grants", JSON.stringify({ repos: [
    { id: 9001, owner: "e2e-org", name: "open-docs", private: false, defaultBranch: "main", readers: [] },
    { id: 9002, owner: "e2e-org", name: "closed-docs", private: true, defaultBranch: "main", readers: [reader] },
  ] }));
  return { open: { owner: "e2e-org", name: "open-docs", commit: commits.open }, closed: { owner: "e2e-org", name: "closed-docs", commit: commits.closed } };
}
