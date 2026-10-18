import { listen } from "./services";
import { HttpGitHubSource } from "../src/ingest/github/http-source";
import { staticTokenProvider } from "../src/ingest/github/token";
import { contentPipeline } from "../src/ingest/orchestrator/content-pipeline";
import { ingestBranch } from "../src/ingest/orchestrator/ingest";
import { plaintextSealer, r2Store, type R2BucketLike } from "../src/ingest/orchestrator/store";
import { FakeGitHub } from "../tests/helpers/fake-github";
import { initNodeMarkdownEngine } from "../tests/helpers/markdown-engine";

/**
 * The repositories the E2E suite reads through /r/ (#234), in a fake GitHub the real control
 * Worker (#243) reads: snapshots built by the P3b pipeline, the installation announced by a
 * signed webhook, and three seeded users linked to GitHub accounts. `control` is a fixture
 * endpoint a spec calls to change team membership; it delivers the webhook GitHub would send.
 */
export type RepoFixture = { owner: string; name: string; commit: string };
export type RepoFixtures = { open: RepoFixture; closed: RepoFixture; team: RepoFixture; control: string };

/** Dispatches to the control Worker (the harness's `getWorker(name).fetch`). */
export type ControlFetch = (url: string, init: { method: "POST"; body: string; headers?: Record<string, string> }) => Promise<Response>;

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

/** e2e-org with the app installed; the owner is a collaborator on closed-docs, the member reads team-docs through a team. */
export function repositoryWorld() {
  const github = new FakeGitHub();
  const installation = github.install("e2e-org", { id: 9100 });
  const repos = {
    open: github.repo("e2e-org", "open-docs", { id: 9001 }),
    closed: github.repo("e2e-org", "closed-docs", { id: 9002, private: true }),
    team: github.repo("e2e-org", "team-docs", { id: 9003, private: true }),
  };
  const people = { owner: github.user("e2e-reader", 9501), outsider: github.user("e2e-outsider", 9502), member: github.user("e2e-member", 9503) };
  repos.closed.collaborators.add(people.owner.id);
  const team = github.team("e2e-org", "docs-readers", [people.member], [repos.team]);
  return { github, installation, repos, people, team };
}

export type RepositoryWorld = ReturnType<typeof repositoryWorld>;

export async function seedRepositories(input: {
  bucket: R2BucketLike; world: RepositoryWorld; control: ControlFetch; webhookSecret: string; userIds: Record<"owner" | "outsider" | "member", string>;
}): Promise<{ fixtures: RepoFixtures; close(): Promise<void> }> {
  initNodeMarkdownEngine();
  const { github, installation, repos, people, team } = input.world;
  const commits = { open: repos.open.commit(docs("Open home")), closed: repos.closed.commit(docs("Closed home")), team: repos.team.commit(docs("Team home")) };
  const deps = {
    source: new HttpGitHubSource({ tokens: staticTokenProvider(github.token), fetch: github.fetch, apiOrigin: github.origin, archiveOrigins: [github.archiveOrigin] }),
    store: r2Store(input.bucket), sealer: plaintextSealer, pipeline: contentPipeline(), now: () => Date.now(),
  };
  const etags = { get: () => Promise.resolve(null), set: () => Promise.resolve() };
  for (const repo of Object.values(repos)) {
    const result = await ingestBranch(deps, etags, repo.ref, "main");
    if (result.status !== "flipped") throw new Error(`Repository fixture ${repo.name} was not ingested (${result.status})`);
  }
  async function deliver(event: string, payload: Record<string, unknown>): Promise<number> {
    const { body, headers } = github.webhook(input.webhookSecret, event, { installation: { id: installation.id, account: { login: installation.account } }, ...payload });
    const response = await input.control("https://control.e2e.test/v1/github/webhook", { method: "POST", body, headers });
    await response.arrayBuffer();
    return response.status;
  }
  const installed = await deliver("installation", { action: "created", repositories: Object.values(repos).map(repo => github.repoJson(repo)) });
  if (installed !== 202) throw new Error(`Installation webhook answered ${installed}`);
  for (const role of ["owner", "outsider", "member"] as const) {
    const person = people[role];
    const linked = await input.control("https://repo-access.internal/v1/accounts/link", {
      method: "POST", body: JSON.stringify({ userId: input.userIds[role], githubId: person.id, login: person.login, tokens: github.signIn(person) }),
    });
    if (linked.status !== 204) throw new Error(`Linking ${role} answered ${linked.status}`);
  }
  // POST /membership/added|removed: the member joins or leaves the team, and GitHub's webhook follows.
  const control = await listen((request, response) => {
    void (async () => {
      const action = /^\/membership\/(added|removed)$/.exec(request.url ?? "")?.[1];
      if (request.method !== "POST" || !action) {
        response.writeHead(404).end();
        return;
      }
      if (action === "added") team.members.add(people.member.id);
      else team.members.delete(people.member.id);
      const status = await deliver("membership", { action, member: { id: people.member.id, login: people.member.login }, team: { slug: "docs-readers" } });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status }));
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  const fixture = (repo: { owner: string; name: string }, commit: string): RepoFixture => ({ owner: repo.owner, name: repo.name, commit });
  return {
    fixtures: { open: fixture(repos.open, commits.open), closed: fixture(repos.closed, commits.closed), team: fixture(repos.team, commits.team), control: control.origin },
    close: () => control.close(),
  };
}
