import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { githubArchive, gzip } from "./tar-writer";

/**
 * A fake GitHub for ingest tests: a real git object model (blob, tree and
 * commit IDs are computed exactly as git does), served over the documented
 * REST shapes. Conditional requests, rate-limit headers, truncated recursive
 * trees, expiring archive links, app webhook deliveries and scripted faults
 * are all modelled, so HttpGitHubSource is tested against it unchanged.
 *
 * For the permission mirror (#243) it also models users, app installations,
 * collaborators, teams and organization base permissions, user-to-server
 * tokens that expire and rotate on refresh, the listing endpoints a GitHub App
 * user token reads, and signed webhook deliveries.
 */

export type FileSpec = string | Uint8Array | { symlink: string } | { submodule: string } | { executable: string };

interface TreeItem {
  name: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export type Endpoint = "ref" | "tree" | "blob" | "tarball" | "archive" | "deliveries" | "redeliver"
  | "user-installations" | "installation-repositories" | "installation" | "repository" | "permission" | "oauth" | "other";

export interface FakeUser {
  id: number;
  login: string;
}

export interface FakeInstallation {
  id: number;
  account: string;
  suspended: boolean;
  /** Repository IDs the installation was granted, or all of the account's repositories. */
  repositories: "all" | Set<number>;
}

export interface FakeTeam {
  org: string;
  members: Set<number>;
  repos: Set<number>;
}

export interface FakeUserTokens {
  accessToken: string;
  accessTokenExpiresAt: number | null;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

export interface LoggedRequest {
  method: string;
  path: string;
  endpoint: Endpoint;
  status: number;
  authorization: string | null;
}

interface Fault {
  match: (request: { method: string; url: URL; endpoint: Endpoint }) => boolean;
  times: number;
  response: () => Response | Promise<Response>;
}

export interface FakeDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  status_code: number | null;
  event: string;
}

const encoder = new TextEncoder();

function sha1(data: Uint8Array | string): string {
  return createHash("sha1").update(data).digest("hex");
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

export class FakeRepo {
  readonly branches = new Map<string, string>();
  /** Recursive tree listings stop after this many entries and report truncated, as GitHub does past 100k / 7 MB. */
  truncateAt = Number.POSITIVE_INFINITY;
  /** Rewrite file contents in the archive only (export-subst, LFS smudging). */
  archiveTransform: ((path: string, content: Uint8Array) => Uint8Array) | null = null;
  /** Serve only this fraction of the archive bytes (a dropped connection). */
  archiveCut: number | null = null;
  /** Pax global comment override (an archive of the wrong commit). */
  archiveComment: string | null = null;
  readonly files = new Map<string, Map<string, FileSpec>>();

  /** Users (by ID) with a direct collaborator grant. */
  readonly collaborators = new Set<number>();
  defaultBranch = "main";

  constructor(readonly github: FakeGitHub, readonly owner: string, readonly name: string, readonly id: number, public isPrivate: boolean) {}

  get ref() {
    return { id: this.id, owner: this.owner, name: this.name, private: this.isPrivate, installationId: 42 };
  }

  /** Commit a complete file set (path → content) onto `branch`. Returns the commit ID. */
  commit(files: Record<string, FileSpec>, branch = "main"): string {
    const parent = this.branches.get(branch) ?? null;
    const tree = this.github.writeTree(files);
    const body = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author Fake <fake@example.test> ${this.github.commits.size} +0000\ncommitter Fake <fake@example.test> ${this.github.commits.size} +0000\n\nfixture\n`;
    const sha = sha1(`commit ${Buffer.byteLength(body)}\0${body}`);
    this.github.commits.set(sha, { tree, files: new Map(Object.entries(files)) });
    this.branches.set(branch, sha);
    return sha;
  }

  /** Commit the previous commit's files with changes applied (null deletes). */
  change(changes: Record<string, FileSpec | null>, branch = "main"): string {
    const head = this.branches.get(branch);
    const files = head ? Object.fromEntries(this.github.commits.get(head)?.files ?? []) : {};
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) delete files[path];
      else files[path] = content;
    }
    return this.commit(files, branch);
  }

  head(branch = "main"): string {
    return this.branches.get(branch) as string;
  }
}

export class FakeGitHub {
  readonly origin = "https://api.github.test";
  readonly archiveOrigin = "https://codeload.github.test";
  readonly token = "fake-installation-token";
  readonly appJwt = "fake-app-jwt";
  readonly blobs = new Map<string, Uint8Array>();
  readonly trees = new Map<string, TreeItem[]>();
  readonly commits = new Map<string, { tree: string; files: Map<string, FileSpec> }>();
  readonly repos = new Map<string, FakeRepo>();
  readonly requests: LoggedRequest[] = [];
  readonly deliveries: FakeDelivery[] = [];
  readonly redelivered: number[] = [];
  /** Status our endpoint answers redelivered attempts with. */
  redeliveryStatus = 202;
  rate = { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 };
  now: () => number = () => Date.now();
  /** Hold every response until released (to interleave concurrent work). */
  gate: Promise<void> | null = null;
  /** Which requests the gate holds (all when unset). */
  gateFilter: ((endpoint: Endpoint) => boolean) | null = null;
  /** Requests currently waiting at the gate. */
  held = 0;
  private faults: Fault[] = [];
  private archiveLinks = new Map<string, { repo: FakeRepo; sha: string; expiresAt: number }>();

  /** Old "owner/name" → repository, after a rename or transfer. */
  readonly renamed = new Map<string, FakeRepo>();

  readonly webOrigin = "https://github.test";
  readonly clientId = "fake-client-id";
  readonly clientSecret = "fake-client-secret";
  readonly users = new Map<number, FakeUser>();
  readonly installations = new Map<number, FakeInstallation>();
  readonly teams = new Map<string, FakeTeam>();
  /** Organization login → members who may read every repository of it (base permission "read"). */
  readonly orgReaders = new Map<string, Set<number>>();
  /** Lifetime of user access tokens in milliseconds; null issues tokens that never expire. */
  userTokenLifetime: number | null = 8 * 60 * 60 * 1000;
  refreshTokenLifetime = 184 * 24 * 60 * 60 * 1000;
  private readonly accessTokens = new Map<string, { user: number; expiresAt: number | null }>();
  private readonly refreshTokens = new Map<string, { user: number; expiresAt: number }>();
  private readonly installationTokens = new Map<string, number>();

  user(login: string, id = 5000 + this.users.size + 1): FakeUser {
    const user = { id, login };
    this.users.set(id, user);
    return user;
  }

  install(account: string, options: { id?: number; repositories?: "all" | number[]; suspended?: boolean } = {}): FakeInstallation {
    const repositories = options.repositories ?? "all";
    const installation: FakeInstallation = { id: options.id ?? 70 + this.installations.size + 1, account, suspended: options.suspended ?? false, repositories: repositories === "all" ? "all" : new Set(repositories) };
    this.installations.set(installation.id, installation);
    return installation;
  }

  team(org: string, slug: string, members: FakeUser[] = [], repos: FakeRepo[] = []): FakeTeam {
    const team = { org, members: new Set(members.map((member) => member.id)), repos: new Set(repos.map((repo) => repo.id)) };
    this.teams.set(`${org}/${slug}`, team);
    return team;
  }

  /** The installation that covers a repository, if any. */
  installationOf(repo: FakeRepo): FakeInstallation | undefined {
    return [...this.installations.values()].find((installation) => installation.account.toLowerCase() === repo.owner.toLowerCase()
      && (installation.repositories === "all" || installation.repositories.has(repo.id)));
  }

  /** Explicit read access, as /user/installations/{id}/repositories counts it: owner, collaborator, team or organization base permission. */
  canRead(user: FakeUser, repo: FakeRepo): boolean {
    return repo.owner.toLowerCase() === user.login.toLowerCase() || repo.collaborators.has(user.id)
      || [...this.teams.values()].some((team) => team.members.has(user.id) && team.repos.has(repo.id))
      || (this.orgReaders.get(repo.owner)?.has(user.id) ?? false);
  }

  /** What the OAuth callback hands over at sign-in: a user-to-server token pair. */
  signIn(user: FakeUser): FakeUserTokens {
    const accessToken = `ghu_${randomBytes(12).toString("hex")}`;
    const refreshToken = `ghr_${randomBytes(12).toString("hex")}`;
    const accessTokenExpiresAt = this.userTokenLifetime === null ? null : this.now() + this.userTokenLifetime;
    const refreshTokenExpiresAt = this.now() + this.refreshTokenLifetime;
    this.accessTokens.set(accessToken, { user: user.id, expiresAt: accessTokenExpiresAt });
    this.refreshTokens.set(refreshToken, { user: user.id, expiresAt: refreshTokenExpiresAt });
    return { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt };
  }

  /** The user revoked the app's authorization: every token of theirs stops working. */
  revokeAuthorization(user: FakeUser): void {
    for (const tokens of [this.accessTokens, this.refreshTokens]) {
      for (const [token, grant] of tokens) if (grant.user === user.id) tokens.delete(token);
    }
  }

  /** An installation-scoped token, as P1 will mint (the shared `token` reads everything). */
  installationToken(installation: FakeInstallation): string {
    const token = `ghs_${installation.id}_${randomBytes(6).toString("hex")}`;
    this.installationTokens.set(token, installation.id);
    return token;
  }

  /** A signed delivery as GitHub sends it. */
  webhook(secret: string, event: string, payload: unknown, delivery: string = randomUUID()): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify(payload);
    return { body, headers: {
      "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    } };
  }

  /** A repository as webhook payloads and the REST API describe it. */
  repoJson(repo: FakeRepo): Record<string, unknown> {
    return { id: repo.id, node_id: `R_${repo.id}`, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.isPrivate,
      visibility: repo.isPrivate ? "private" : "public", owner: { login: repo.owner, id: 9000 + repo.id }, default_branch: repo.defaultBranch };
  }

  /** Rename a repository in place; its old path answers 301, as GitHub's does. */
  rename(repo: FakeRepo, owner: string, name: string): FakeRepo {
    const moved = new FakeRepo(this, owner, name, repo.id, repo.isPrivate);
    for (const [branch, sha] of repo.branches) moved.branches.set(branch, sha);
    this.repos.delete(`${repo.owner}/${repo.name}`);
    this.renamed.set(`${repo.owner}/${repo.name}`, moved);
    this.repos.set(`${owner}/${name}`, moved);
    return moved;
  }

  repo(owner: string, name: string, options: { id?: number; private?: boolean } = {}): FakeRepo {
    const repo = new FakeRepo(this, owner, name, options.id ?? this.repos.size + 1, options.private ?? false);
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  /** Answer the next `times` matching requests with `response` instead of the real thing. */
  fault(match: RegExp | Fault["match"], response: () => Response | Promise<Response>, times = 1): void {
    const test = match instanceof RegExp ? ({ url }: { url: URL }) => match.test(url.pathname + url.search) : match;
    this.faults.push({ match: test, times, response });
  }

  count(endpoint?: Endpoint, options: { status?: number } = {}): number {
    return this.requests.filter((request) => (!endpoint || request.endpoint === endpoint) && (options.status === undefined || request.status === options.status)).length;
  }

  /** Requests that cost primary quota (everything except 304s and archive downloads). */
  billable(): number {
    return this.requests.filter((request) => request.status !== 304 && request.endpoint !== "archive").length;
  }

  resetLog(): void {
    this.requests.length = 0;
  }

  writeBlob(content: Uint8Array): string {
    const sha = sha1(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
    this.blobs.set(sha, content);
    return sha;
  }

  writeTree(files: Record<string, FileSpec>): string {
    interface Node { files: Map<string, FileSpec>; dirs: Map<string, Node> }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        let child = node.dirs.get(part);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1], content);
    }
    const write = (node: Node): string => {
      const items: TreeItem[] = [];
      for (const [name, child] of node.dirs) items.push({ name, mode: "040000", type: "tree", sha: write(child) });
      for (const [name, spec] of node.files) {
        if (typeof spec === "object" && "submodule" in spec) {
          items.push({ name, mode: "160000", type: "commit", sha: spec.submodule });
        } else {
          const content = typeof spec === "object" && "symlink" in spec ? encoder.encode(spec.symlink)
            : typeof spec === "object" && "executable" in spec ? encoder.encode(spec.executable) : toBytes(spec);
          const mode = typeof spec === "object" && "symlink" in spec ? "120000" : typeof spec === "object" && "executable" in spec ? "100755" : "100644";
          items.push({ name, mode, type: "blob", sha: this.writeBlob(content), size: content.length });
        }
      }
      // git orders entries by name, comparing a tree's name as if it ended in "/".
      const key = (item: TreeItem) => Buffer.from(item.type === "tree" ? `${item.name}/` : item.name);
      items.sort((a, b) => Buffer.compare(key(a), key(b)));
      const body = Buffer.concat(items.map((item) => Buffer.concat([
        Buffer.from(`${item.mode === "040000" ? "40000" : item.mode} ${item.name}\0`), Buffer.from(item.sha, "hex"),
      ])));
      const sha = sha1(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]));
      this.trees.set(sha, items);
      return sha;
    };
    return write(root);
  }

  /** Every path → content of a commit, symlinks as link targets (for the archive). */
  private archiveFiles(repo: FakeRepo, sha: string): Map<string, Uint8Array | { symlink: string }> {
    const out = new Map<string, Uint8Array | { symlink: string }>();
    for (const [path, spec] of (this.commits.get(sha) as { files: Map<string, FileSpec> }).files) {
      if (typeof spec === "object" && "submodule" in spec) continue;
      if (typeof spec === "object" && "symlink" in spec) out.set(path, spec);
      else {
        const content = typeof spec === "object" && "executable" in spec ? encoder.encode(spec.executable) : toBytes(spec);
        out.set(path, repo.archiveTransform ? repo.archiveTransform(path, content) : content);
      }
    }
    return out;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const endpoint = classify(url);
    const authorization = request.headers.get("authorization");
    if (this.gate && (!this.gateFilter || this.gateFilter(endpoint))) {
      this.held += 1;
      await this.gate;
      this.held -= 1;
    }
    const fault = this.faults.find((candidate) => candidate.times > 0 && candidate.match({ method: request.method, url, endpoint }));
    let response: Response;
    if (fault) {
      fault.times -= 1;
      response = await fault.response();
    } else {
      response = url.origin === this.webOrigin ? await this.oauth(request, url) : this.route(request, url, endpoint);
    }
    this.requests.push({ method: request.method, path: url.pathname + url.search, endpoint, status: response.status, authorization });
    return response;
  };

  private route(request: Request, url: URL, endpoint: Endpoint): Response {
    if (url.origin === this.archiveOrigin) return this.archive(url);
    if (url.origin !== this.origin) return new Response("unknown origin", { status: 502 });
    if (url.pathname.startsWith("/app/")) return this.app(request, url);
    if (url.pathname.startsWith("/user/")) return this.userApi(request, url);
    const authorization = request.headers.get("authorization");
    const scope = this.installationScope(authorization);
    if (scope === "invalid") return this.json({ message: "Bad credentials" }, 401);
    if (scope !== "all" && scope?.suspended) return this.json({ message: "This installation has been suspended" }, 403);
    if (url.pathname === "/installation/repositories") {
      if (!scope) return this.json({ message: "Requires authentication" }, 401);
      const repos = [...this.repos.values()].filter((repo) => scope === "all" || this.installationOf(repo) === scope);
      return this.billed(this.json({ total_count: repos.length, repositories: repos.slice(0, Number(url.searchParams.get("per_page") ?? 30)).map((repo) => this.repoJson(repo)) }));
    }
    const exact = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const match = exact ? [exact[0], exact[1], exact[2], ""] : /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    const moved = match ? this.renamed.get(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`) : undefined;
    if (match && moved) {
      return this.json({ message: "Moved Permanently", url: "x" }, 301, { location: `/repos/${moved.owner}/${moved.name}${match[3] ? `/${match[3]}` : ""}${url.search}` });
    }
    const repo = match ? this.repos.get(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`) : undefined;
    if (!match || !repo || (repo.isPrivate && !authorization) || (scope && scope !== "all" && this.installationOf(repo) !== scope)) return this.json({ message: "Not Found" }, 404);
    if (this.rate.remaining <= 0) {
      return this.withRate(this.json({ message: "API rate limit exceeded for installation." }, 403));
    }
    const rest = match[3];
    const etag = request.headers.get("if-none-match");
    if (endpoint === "repository") {
      const body = JSON.stringify(this.repoJson(repo));
      const tag = `W/"${sha1(body)}"`;
      if (etag === tag) return this.withRate(new Response(null, { status: 304, headers: { etag: tag } }));
      return this.billed(new Response(body, { headers: { "content-type": "application/json", etag: tag } }));
    }
    if (endpoint === "permission") {
      const login = decodeURIComponent(rest.slice("collaborators/".length, -"/permission".length));
      const user = [...this.users.values()].find((candidate) => candidate.login.toLowerCase() === login.toLowerCase());
      if (!user) return this.billed(this.json({ message: "Not Found" }, 404));
      const permission = this.canRead(user, repo) ? "read" : "none";
      return this.billed(this.json({ permission, role_name: permission, user: { login: user.login, id: user.id } }));
    }
    if (endpoint === "ref") {
      if (repo.branches.size === 0) return this.billed(this.json({ message: "Git Repository is empty." }, 409));
      const branch = rest.slice("git/ref/heads/".length).split("/").map(decodeURIComponent).join("/");
      const sha = repo.branches.get(branch);
      if (!sha) return this.billed(this.json({ message: "Not Found" }, 404));
      const body = JSON.stringify({ ref: `refs/heads/${branch}`, node_id: "REF_x", url: url.href, object: { sha, type: "commit", url: `${this.origin}/x` } });
      const tag = `W/"${sha1(body)}"`;
      if (etag === tag) return this.withRate(new Response(null, { status: 304, headers: { etag: tag } }));
      return this.billed(new Response(body, { headers: { "content-type": "application/json", etag: tag } }));
    }
    if (endpoint === "tree") {
      const sha = rest.slice("git/trees/".length);
      const treeSha = this.commits.get(sha)?.tree ?? sha;
      const items = this.trees.get(treeSha);
      if (!items) return this.billed(this.json({ message: "Not Found" }, 404));
      if (!url.searchParams.has("recursive")) {
        return this.billed(this.json({ sha: treeSha, url: url.href, tree: items.map((item) => this.apiEntry(item, item.name)), truncated: false }));
      }
      const entries: object[] = [];
      const walk = (tree: TreeItem[], prefix: string) => {
        for (const item of tree) {
          const path = prefix ? `${prefix}/${item.name}` : item.name;
          entries.push(this.apiEntry(item, path));
          if (item.type === "tree") walk(this.trees.get(item.sha) as TreeItem[], path);
        }
      };
      walk(items, "");
      const truncated = entries.length > repo.truncateAt;
      return this.billed(this.json({ sha: treeSha, url: url.href, tree: truncated ? entries.slice(0, repo.truncateAt) : entries, truncated }));
    }
    if (endpoint === "blob") {
      const sha = rest.slice("git/blobs/".length);
      const content = this.blobs.get(sha);
      if (!content) return this.billed(this.json({ message: "Not Found" }, 404));
      if (request.headers.get("accept") === "application/vnd.github.raw+json") {
        return this.billed(new Response(content as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/vnd.github.raw", "content-length": String(content.length) } }));
      }
      return this.billed(this.json({ sha, size: content.length, encoding: "base64", content: Buffer.from(content).toString("base64") }));
    }
    if (endpoint === "tarball") {
      const sha = rest.slice("tarball/".length);
      if (!this.commits.has(sha)) return this.billed(this.json({ message: "Not Found" }, 404));
      const token = randomBytes(8).toString("hex");
      this.archiveLinks.set(token, { repo, sha, expiresAt: this.now() + 5 * 60 * 1000 });
      return this.billed(new Response(null, { status: 302, headers: { location: `${this.archiveOrigin}/${repo.owner}/${repo.name}/legacy.tar.gz/${sha}?token=${token}` } }));
    }
    return this.billed(this.json({ message: "Not Found" }, 404));
  }

  /** "all" for the shared token, the installation for a scoped one, undefined without a token, "invalid" for anything else. */
  private installationScope(authorization: string | null): "all" | FakeInstallation | "invalid" | undefined {
    if (!authorization) return undefined;
    if (authorization === `Bearer ${this.token}`) return "all";
    const installation = this.installations.get(this.installationTokens.get(authorization.slice("Bearer ".length)) ?? -1);
    return installation ?? "invalid";
  }

  private userApi(request: Request, url: URL): Response {
    const grant = this.accessTokens.get((request.headers.get("authorization") ?? "").slice("Bearer ".length));
    const user = grant && (grant.expiresAt === null || grant.expiresAt > this.now()) ? this.users.get(grant.user) : undefined;
    if (!user) return this.json({ message: "Bad credentials" }, 401);
    if (this.rate.remaining <= 0) return this.withRate(this.json({ message: "API rate limit exceeded for user." }, 403));
    const perPage = Number(url.searchParams.get("per_page") ?? 30);
    const page = Number(url.searchParams.get("page") ?? 1);
    const reachable = (installation: FakeInstallation) => installation.account.toLowerCase() === user.login.toLowerCase()
      || [...this.repos.values()].some((repo) => this.installationOf(repo) === installation && this.canRead(user, repo));
    const listed = (key: string, items: unknown[], extra: Record<string, unknown> = {}) => {
      const slice = items.slice((page - 1) * perPage, page * perPage);
      const body = JSON.stringify({ total_count: items.length, ...extra, [key]: slice });
      const tag = `W/"${sha1(body)}"`;
      if (request.headers.get("if-none-match") === tag) return this.withRate(new Response(null, { status: 304, headers: { etag: tag } }));
      const headers: Record<string, string> = { "content-type": "application/json", etag: tag };
      if (page * perPage < items.length) headers.link = `<${this.origin}${url.pathname}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      return this.billed(new Response(body, { headers }));
    };
    if (url.pathname === "/user/installations") {
      const installations = [...this.installations.values()].filter(reachable).sort((a, b) => a.id - b.id);
      return listed("installations", installations.map((installation) => ({
        id: installation.id, account: { login: installation.account }, suspended_at: installation.suspended ? new Date(this.now()).toISOString() : null,
      })));
    }
    const match = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    const installation = match ? this.installations.get(Number(match[1])) : undefined;
    if (!installation || !reachable(installation)) return this.billed(this.json({ message: "Not Found" }, 404));
    if (installation.suspended) return this.billed(this.json({ message: "This installation has been suspended" }, 403));
    const repos = [...this.repos.values()].filter((repo) => this.installationOf(repo) === installation && this.canRead(user, repo)).sort((a, b) => a.id - b.id);
    return listed("repositories", repos.map((repo) => ({ ...this.repoJson(repo), permissions: { admin: false, maintain: false, push: false, triage: false, pull: true } })), { repository_selection: installation.repositories === "all" ? "all" : "selected" });
  }

  /** POST /login/oauth/access_token with grant_type=refresh_token. GitHub answers errors with 200 and an `error` code. */
  private async oauth(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST" || url.pathname !== "/login/oauth/access_token") return new Response("Not found", { status: 404 });
    const form = new URLSearchParams(await request.text());
    if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret) return this.json({ error: "incorrect_client_credentials" });
    const grant = this.refreshTokens.get(form.get("refresh_token") ?? "");
    if (form.get("grant_type") !== "refresh_token" || !grant || grant.expiresAt <= this.now()) return this.json({ error: "bad_refresh_token" });
    // Refresh tokens rotate: the one just used stops working.
    this.refreshTokens.delete(form.get("refresh_token") as string);
    const tokens = this.signIn(this.users.get(grant.user) as FakeUser);
    return this.json({
      access_token: tokens.accessToken, expires_in: tokens.accessTokenExpiresAt === null ? undefined : Math.round((tokens.accessTokenExpiresAt - this.now()) / 1000),
      refresh_token: tokens.refreshToken, refresh_token_expires_in: Math.round(this.refreshTokenLifetime / 1000), token_type: "bearer", scope: "",
    });
  }

  private archive(url: URL): Response {
    const link = this.archiveLinks.get(url.searchParams.get("token") ?? "");
    if (!link || link.expiresAt < this.now()) return new Response("expired", { status: 404 });
    const { repo, sha } = link;
    let data = gzip(githubArchive(repo.owner, repo.name, repo.archiveComment ?? sha, this.archiveFiles(repo, sha)));
    if (repo.archiveCut !== null) data = data.slice(0, Math.floor(data.length * repo.archiveCut));
    return new Response(data as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/x-gzip" } });
  }

  private app(request: Request, url: URL): Response {
    if (request.headers.get("authorization") !== `Bearer ${this.appJwt}`) return this.json({ message: "A JSON web token could not be decoded" }, 401);
    const attempts = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(url.pathname);
    if (attempts && request.method === "POST") {
      const original = this.deliveries.find((delivery) => delivery.id === Number(attempts[1]));
      if (!original) return this.json({ message: "Not Found" }, 404);
      this.redelivered.push(original.id);
      // GitHub records the new attempt as a delivery with the same GUID.
      this.deliveries.unshift({ ...original, id: Math.max(...this.deliveries.map((delivery) => delivery.id)) + 1, delivered_at: new Date(this.now()).toISOString(), status_code: this.redeliveryStatus });
      return this.json({}, 202);
    }
    if (url.pathname === "/app/hook/deliveries" && request.method === "GET") {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = this.deliveries.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < this.deliveries.length) {
        headers.link = `<${this.origin}/app/hook/deliveries?per_page=${perPage}&cursor=${start + perPage}>; rel="next"`;
      }
      return this.json(page, 200, headers);
    }
    return this.json({ message: "Not Found" }, 404);
  }

  private apiEntry(item: TreeItem, path: string): object {
    const entry: Record<string, unknown> = { path, mode: item.mode, type: item.type, sha: item.sha, url: `${this.origin}/x` };
    if (item.size !== undefined) entry.size = item.size;
    return entry;
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private withRate(response: Response): Response {
    response.headers.set("x-ratelimit-limit", String(this.rate.limit));
    response.headers.set("x-ratelimit-remaining", String(this.rate.remaining));
    response.headers.set("x-ratelimit-reset", String(this.rate.reset));
    return response;
  }

  /** A response that costs one request of primary quota. */
  private billed(response: Response): Response {
    this.rate.remaining = Math.max(0, this.rate.remaining - 1);
    return this.withRate(response);
  }
}

function classify(url: URL): Endpoint {
  if (url.hostname.startsWith("codeload")) return "archive";
  if (url.hostname === "github.test") return "oauth";
  if (/^\/user\/installations\/\d+\/repositories$/.test(url.pathname)) return "installation-repositories";
  if (url.pathname === "/user/installations") return "user-installations";
  if (url.pathname === "/installation/repositories") return "installation";
  if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return "repository";
  if (/^\/repos\/[^/]+\/[^/]+\/collaborators\/[^/]+\/permission$/.test(url.pathname)) return "permission";
  if (/\/attempts$/.test(url.pathname)) return "redeliver";
  if (url.pathname.startsWith("/app/hook/deliveries")) return "deliveries";
  if (/\/git\/ref\//.test(url.pathname)) return "ref";
  if (/\/git\/trees\//.test(url.pathname)) return "tree";
  if (/\/git\/blobs\//.test(url.pathname)) return "blob";
  if (/\/tarball\//.test(url.pathname)) return "tarball";
  return "other";
}
