import { listen } from "./services";
import { HttpGitHubSource } from "../src/ingest/github/http-source";
import { staticTokenProvider } from "../src/ingest/github/token";
import { contentPipeline } from "../src/ingest/orchestrator/content-pipeline";
import { imageProxyRewriter } from "../src/image-proxy";
import { ingestBranch } from "../src/ingest/orchestrator/ingest";
import { envelopeSealer } from "../src/ingest/orchestrator/sealing";
import { r2Store, type R2BucketLike } from "../src/ingest/orchestrator/store";
import type { SearchIndex } from "../src/search/index";
import { FakeGitHub, type FakeRole } from "../tests/helpers/fake-github";
import { initNodeMarkdownEngine } from "../tests/helpers/markdown-engine";
import { visualDocs } from "./visual/visual-repo-docs";

/**
 * The repositories the E2E suite reads through /r/ (#234), in a fake GitHub the real control
 * Worker (#243) reads: snapshots built by the P3b pipeline, the installation announced by a
 * signed webhook, and three seeded users linked to GitHub accounts. `control` is a fixture
 * endpoint a spec calls to change team membership or a collaborator, or to push a commit; it
 * delivers the webhook GitHub would send (or ingests the commit, as the push webhook would).
 */
export type RepoFixture = { owner: string; name: string; commit: string };
export type RepoFixtures = {
  open: RepoFixture; closed: RepoFixture; team: RepoFixture; comments: RepoFixture; commentsPrivate: RepoFixture; control: string;
  /** The shell's own chrome and links (#286, formerly on a CLI-pushed project): long pages with sections, links and a nested folder. */
  viewer: RepoFixture;
  /** Only in the visual runs (#268): a public repository of fixed Markdown for the baselines. */
  visual?: RepoFixture;
};

/** Comments on repository docs (#254): pages with headings, one per spec, so each can push its own commits. */
export function commentDocs(): Record<string, string> {
  return {
    "README.md": "# Comments\n",
    "docs/index.md": "# Comment home\n\nPages for the comment journeys.\n",
    "docs/guide.md": "# Guide\n\n## Install\n\nRun pnpm install before anything else.\n\n## Usage\n\nCall the API when ready.\n",
    "docs/survive.md": "# Survive\n\n## Notes\n\nThis sentence survives unrelated commits.\n",
    "docs/orphan.md": "# Orphan\n\n## Notes\n\nThis sentence will be deleted.\n\nAnother paragraph stays.\n",
    "docs/other.md": "# Other\n\nVersion 1.\n",
    "docs/private.md": "# Private\n\n## Notes\n\nOnly collaborators read this.\n",
  };
}

/** Paragraphs that give a page enough height to scroll; each is its own line of plain text. */
const filler = (label: string, count: number) => Array.from({ length: count }, (_, index) =>
  `${label} paragraph ${index + 1}: the shell keeps its chrome while the document scrolls underneath it.`).join("\n\n");

/** The viewer chrome and link specs: the same shapes the publisher site had, as Markdown the read path renders. */
export function viewerDocs(): Record<string, string> {
  return {
    "README.md": "# Viewer\n",
    "docs/index.md": `# Viewer home\n\n[Section two](#section-two) · [Café](#café) · [Missing target](#missing-target) · [Bare hash](#) · [Intro](guide/intro.md) · [Intro details](guide/intro.md#details) · [Deep topic](guide/deep/topic.md) · [External](https://docs.example.test/outside)\n\n${filler("Home", 40)}\n\n## Section two\n\n${filler("Second", 40)}\n\n## Café\n\n${filler("Café", 30)}\n`,
    "docs/guide/intro.md": `# Guide intro\n\n[Home](../index.md) · [Home section two](../index.md#section-two) · [Deep topic](deep/topic.md) · [Details](#details)\n\n${filler("Intro", 50)}\n\n## Details\n\n${filler("Details", 30)}\n`,
    "docs/guide/deep/topic.md": "# Deep topic\n\n[Home](../../index.md)\n",
    "docs/other/elsewhere.md": "# Elsewhere\n",
    "docs/comment.md": `# Comment page\n\nThe quick brown fox jumps over the lazy dog.\n\n[Jump to a later section](#later-section) · [Go](guide/intro.md#details) · [External](https://docs.example.test/outside)\n\n${filler("Comment", 40)}\n\n## Later section\n\n${filler("Later", 20)}\n`,
  };
}

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

/** One GitHub account per engine that signs in with GitHub (#338): `e2e-gh-<engine>`, a collaborator on the private repositories. */
export const githubSignInLogin = (engine: string) => `e2e-gh-${engine}`;

/** e2e-org with the app installed; the owner is a collaborator on closed-docs, the member reads team-docs through a team. */
export function repositoryWorld(options: { visual?: boolean } = {}) {
  const github = new FakeGitHub();
  const installation = github.install("e2e-org", { id: 9100 });
  const repos = {
    open: github.repo("e2e-org", "open-docs", { id: 9001 }),
    closed: github.repo("e2e-org", "closed-docs", { id: 9002, private: true }),
    team: github.repo("e2e-org", "team-docs", { id: 9003, private: true }),
    comments: github.repo("e2e-org", "comment-docs", { id: 9004 }),
    commentsPrivate: github.repo("e2e-org", "comment-private", { id: 9005, private: true }),
    viewer: github.repo("e2e-org", "viewer-docs", { id: 9007 }),
    ...(options.visual ? { visual: github.repo("e2e-org", "visual-docs", { id: 9006 }) } : {}),
  };
  const people = { owner: github.user("e2e-reader", 9501), outsider: github.user("e2e-outsider", 9502), member: github.user("e2e-member", 9503) };
  repos.closed.collaborators.add(people.owner.id);
  repos.commentsPrivate.collaborators.add(people.owner.id);
  // The home shows a repository's last push where GitHub's listing reports one (#338); a fixed time keeps the visual baselines stable.
  repos.closed.pushedAt = Date.parse("2026-10-01T09:30:00Z");
  // Readers who sign in with GitHub (#338), one per engine so the engines never share an account.
  ["chromium", "firefox", "webkit"].forEach((engine, index) => {
    const login = githubSignInLogin(engine);
    const reader = github.user(login, 9511 + index, [{ email: `${login}@example.test`, primary: true, verified: true }]);
    repos.closed.collaborators.add(reader.id);
    repos.commentsPrivate.collaborators.add(reader.id);
  });
  const team = github.team("e2e-org", "docs-readers", [people.member], [repos.team]);
  return { github, installation, repos, people, team };
}

export type RepositoryWorld = ReturnType<typeof repositoryWorld>;

export async function seedRepositories(input: {
  /** The serving Worker's REPO_CONTENT_KEY: private fixtures are sealed as the ingest Worker would seal them (#263). */
  bucket: R2BucketLike; contentKey: string; world: RepositoryWorld; control: ControlFetch; webhookSecret: string; userIds: Record<"owner" | "outsider" | "member" | "admin", string>;
  /** The serving Worker's REPO_ACCESS binding: the control Worker's internal endpoints answer only through it (#295). */
  service: ControlFetch;
  /** The serving Worker's IMAGE_PROXY_SECRET: external images are rewritten to the signed proxy (#224), as the ingest Worker does. */
  imageProxySecret: string;
  /** The repository search index (#251), when the harness binds one; sections are written at ingest. */
  search?: SearchIndex;
}): Promise<{ fixtures: RepoFixtures; close(): Promise<void> }> {
  initNodeMarkdownEngine();
  const { github, installation, repos, people, team } = input.world;
  const commits = {
    open: repos.open.commit(docs("Open home")), closed: repos.closed.commit(docs("Closed home")), team: repos.team.commit(docs("Team home")),
    comments: repos.comments.commit(commentDocs()), commentsPrivate: repos.commentsPrivate.commit(commentDocs()), viewer: repos.viewer.commit(viewerDocs()),
    visual: repos.visual?.commit(visualDocs()),
  };
  const deps = {
    source: new HttpGitHubSource({ tokens: staticTokenProvider(github.token), fetch: github.fetch, apiOrigin: github.origin, archiveOrigins: [github.archiveOrigin] }),
    store: r2Store(input.bucket), sealer: envelopeSealer(input.contentKey), pipeline: contentPipeline({ rewriteImageUrl: imageProxyRewriter(input.imageProxySecret) }), now: () => Date.now(),
    ...(input.search ? { search: input.search } : {}),
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
    const linked = await input.service("https://repo-access.internal/v1/accounts/link", {
      method: "POST", body: JSON.stringify({ userId: input.userIds[role], githubId: person.id, login: person.login, tokens: github.signIn(person) }),
    });
    if (linked.status !== 204) throw new Error(`Linking ${role} answered ${linked.status}`);
  }
  // The visual runs only (#338): the admin's GitHub account answers every request with a 502, so their home renders its
  // failure state. Functional specs never see it: the admin stays unlinked there.
  if (repos.visual) {
    const broken = github.user("e2e-broken", 9520);
    github.failingUsers.add(broken.id);
    const linked = await input.service("https://repo-access.internal/v1/accounts/link", {
      method: "POST", body: JSON.stringify({ userId: input.userIds.admin, githubId: broken.id, login: broken.login, tokens: github.signIn(broken) }),
    });
    if (linked.status !== 204) throw new Error(`Linking admin answered ${linked.status}`);
  }
  // POST /membership/added|removed: the member joins or leaves the team, and GitHub's webhook follows.
  // POST /collaborator/added|removed: the owner gains or loses comment-private, and GitHub's webhook follows.
  // POST /role/<admin|maintain|write|triage|read|none>: the member's role on comment-docs (#259) changes, and GitHub's
  // `member` webhook follows. The member holds no role on it otherwise, so a spec that sets one must set `none` after.
  // POST /commit/comments (or /commit/comments-private) with { changes }: a commit to comment-docs (comment-private), null
  // deleting a file, ingested as a push would be.
  // GET /github/authorize?as=<login>&decision=approve|deny&<GitHub's query>: GitHub's answer to its authorize page (#338).
  const control = await listen((request, response) => {
    void (async () => {
      const reply = (value: unknown) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(value));
      };
      const url = request.url ?? "";
      const membership = /^\/membership\/(added|removed)$/.exec(url)?.[1];
      const collaborator = /^\/collaborator\/(added|removed)$/.exec(url)?.[1];
      const role = /^\/role\/(admin|maintain|write|triage|read|none)$/.exec(url)?.[1] as FakeRole | "none" | undefined;
      if (request.method === "GET" && url.startsWith("/github/authorize?")) {
        const params = new URL(url, "http://fixture.invalid").searchParams;
        const user = [...github.users.values()].find(candidate => candidate.login === params.get("as"));
        const decision = params.get("decision") === "deny" ? "deny" : "approve";
        params.delete("as");
        params.delete("decision");
        if (!user) response.writeHead(404).end();
        else reply({ location: github.authorize(params, user, decision) });
      } else if (request.method === "POST" && membership) {
        if (membership === "added") team.members.add(people.member.id);
        else team.members.delete(people.member.id);
        reply({ status: await deliver("membership", { action: membership, member: { id: people.member.id, login: people.member.login }, team: { slug: "docs-readers" } }) });
      } else if (request.method === "POST" && collaborator) {
        if (collaborator === "added") repos.commentsPrivate.collaborators.add(people.owner.id);
        else repos.commentsPrivate.collaborators.delete(people.owner.id);
        reply({ status: await deliver("member", { action: collaborator, member: { id: people.owner.id, login: people.owner.login }, repository: github.repoJson(repos.commentsPrivate) }) });
      } else if (request.method === "POST" && role) {
        const member = { id: people.member.id, login: people.member.login };
        if (role === "none") {
          repos.comments.collaborators.delete(member.id);
          repos.comments.roles.delete(member.id);
        } else {
          repos.comments.roles.set(member.id, role);
        }
        reply({ status: await deliver("member", { action: role === "none" ? "removed" : "edited", member, repository: github.repoJson(repos.comments) }) });
      } else if (request.method === "POST" && (url === "/commit/comments" || url === "/commit/comments-private")) {
        const repo = url === "/commit/comments" ? repos.comments : repos.commentsPrivate;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const { changes } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { changes: Record<string, string | null> };
        const commit = repo.change(changes);
        const result = await ingestBranch(deps, etags, repo.ref, "main");
        if (result.status !== "flipped" && result.status !== "current") throw new Error(`Commit was not ingested (${result.status})`);
        reply({ commit });
      } else {
        response.writeHead(404).end();
      }
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  const fixture = (repo: { owner: string; name: string }, commit: string): RepoFixture => ({ owner: repo.owner, name: repo.name, commit });
  return {
    fixtures: {
      open: fixture(repos.open, commits.open), closed: fixture(repos.closed, commits.closed), team: fixture(repos.team, commits.team),
      comments: fixture(repos.comments, commits.comments), commentsPrivate: fixture(repos.commentsPrivate, commits.commentsPrivate), control: control.origin,
      viewer: fixture(repos.viewer, commits.viewer),
      ...(repos.visual && commits.visual ? { visual: fixture(repos.visual, commits.visual) } : {}),
    },
    close: () => control.close(),
  };
}
