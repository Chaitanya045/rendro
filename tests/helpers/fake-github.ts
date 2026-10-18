import { createHash, randomBytes } from "node:crypto";
import { githubArchive, gzip } from "./tar-writer";

/**
 * A fake GitHub for ingest tests: a real git object model (blob, tree and
 * commit IDs are computed exactly as git does), served over the documented
 * REST shapes. Conditional requests, rate-limit headers, truncated recursive
 * trees, expiring archive links, app webhook deliveries and scripted faults
 * are all modelled, so HttpGitHubSource is tested against it unchanged.
 */

export type FileSpec = string | Uint8Array | { symlink: string } | { submodule: string } | { executable: string };

interface TreeItem {
  name: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export type Endpoint = "ref" | "tree" | "blob" | "tarball" | "archive" | "deliveries" | "redeliver" | "other";

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

  constructor(readonly github: FakeGitHub, readonly owner: string, readonly name: string, readonly id: number, readonly isPrivate: boolean) {}

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
      response = this.route(request, url, endpoint);
    }
    this.requests.push({ method: request.method, path: url.pathname + url.search, endpoint, status: response.status, authorization });
    return response;
  };

  private route(request: Request, url: URL, endpoint: Endpoint): Response {
    if (url.origin === this.archiveOrigin) return this.archive(url);
    if (url.origin !== this.origin) return new Response("unknown origin", { status: 502 });
    if (url.pathname.startsWith("/app/")) return this.app(request, url);
    const match = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    const moved = match ? this.renamed.get(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`) : undefined;
    if (match && moved) {
      return this.json({ message: "Moved Permanently", url: "x" }, 301, { location: `/repos/${moved.owner}/${moved.name}/${match[3]}${url.search}` });
    }
    const repo = match ? this.repos.get(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`) : undefined;
    const authorization = request.headers.get("authorization");
    if (authorization && authorization !== `Bearer ${this.token}`) return this.json({ message: "Bad credentials" }, 401);
    if (!match || !repo || (repo.isPrivate && !authorization)) return this.json({ message: "Not Found" }, 404);
    if (this.rate.remaining <= 0) {
      return this.withRate(this.json({ message: "API rate limit exceeded for installation." }, 403));
    }
    const rest = match[3];
    const etag = request.headers.get("if-none-match");
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
  if (/\/attempts$/.test(url.pathname)) return "redeliver";
  if (url.pathname.startsWith("/app/hook/deliveries")) return "deliveries";
  if (/\/git\/ref\//.test(url.pathname)) return "ref";
  if (/\/git\/trees\//.test(url.pathname)) return "tree";
  if (/\/git\/blobs\//.test(url.pathname)) return "blob";
  if (/\/tarball\//.test(url.pathname)) return "tarball";
  return "other";
}
