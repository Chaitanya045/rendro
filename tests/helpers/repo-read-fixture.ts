import { vi } from "vitest";
import { repoAccessHandler, repoKey, RepoAccessUnavailable, type RepoPermissionSource, type RepoRecord, type RevocationEpochs } from "../../src/repo-read/access";
import { clearAuthorizationMemory } from "../../src/repo-read/authorize";
import { clearSnapshotMemory, type EdgeCache } from "../../src/repo-read/snapshot";
import { clearTouches } from "../../src/repo-read/first-view";
import { ingestBranch, type RefEtagCache } from "../../src/ingest/orchestrator/ingest";
import type { CachedRef } from "../../src/ingest/github/source";
import { ingestFixture } from "./ingest-fixture";
import { sessionCache } from "../../src/session-cache";

/**
 * The in-memory test double for the permission source and the revocation
 * epochs (#234). It is what P5's GitHub-backed implementation replaces:
 * repositories by name, readers per repository, an epoch per user.
 */
export class InMemoryRepoAccess implements RepoPermissionSource, RevocationEpochs {
  readonly repos = new Map<string, RepoRecord>();
  readonly readers = new Map<number, Set<string>>();
  readonly epochs = new Map<string, number>();
  readonly calls = { authorize: [] as Array<{ viewer: string | null; repo: string }>, epochs: 0 };
  unavailable = false;
  epochsUnavailable = false;

  addRepo(repo: RepoRecord, readers: string[] = []): this {
    this.repos.set(repoKey(repo.owner, repo.name), repo);
    this.readers.set(repo.id, new Set(readers));
    return this;
  }

  grant(userId: string, repoId: number): void {
    this.readers.get(repoId)?.add(userId);
  }

  /** Removes access, then bumps the epoch: the order P5 must keep. */
  revoke(userId: string, repoId: number, at = Date.now()): void {
    this.readers.get(repoId)?.delete(userId);
    this.epochs.set(userId, Math.max(at, (this.epochs.get(userId) ?? 0) + 1));
  }

  authorize(viewer: string | null, owner: string, name: string): Promise<RepoRecord | null> {
    this.calls.authorize.push({ viewer, repo: repoKey(owner, name) });
    if (this.unavailable) return Promise.reject(new RepoAccessUnavailable());
    const repo = this.repos.get(repoKey(owner, name));
    if (!repo) return Promise.resolve(null);
    return Promise.resolve(!repo.private || (viewer !== null && this.readers.get(repo.id)?.has(viewer)) ? repo : null);
  }

  currentEpoch(userId: string): Promise<number> {
    this.calls.epochs += 1;
    if (this.epochsUnavailable) return Promise.reject(new RepoAccessUnavailable());
    return Promise.resolve(this.epochs.get(userId) ?? 0);
  }
}

/**
 * A Workers KV namespace holding `epoch:user:<userId>` and `epoch:repo:<id>` like P5 writes them, from
 * `access.epochs` (repositories as `repo:<id>`). No legacy `epoch:<userId>` key exists, and reads of one are not counted.
 */
export function epochKv(access: InMemoryRepoAccess) {
  return {
    get: vi.fn((key: string) => {
      if (access.epochsUnavailable) return Promise.reject(new Error("KV GET failed: 503"));
      const name = key.startsWith("epoch:user:") ? key.slice("epoch:user:".length) : key.startsWith("epoch:repo:") ? key.slice("epoch:".length) : null;
      if (name === null) return Promise.resolve(null);
      access.calls.epochs += 1;
      const epoch = access.epochs.get(name);
      return Promise.resolve(epoch === undefined ? null : String(epoch));
    }),
  };
}

/** `caches.default` as an in-memory map, counting lookups. */
export class MemoryEdgeCache implements EdgeCache {
  readonly entries = new Map<string, Uint8Array>();
  readonly ops = { match: [] as string[], put: [] as string[] };
  match(key: string) {
    this.ops.match.push(key);
    const bytes = this.entries.get(key);
    return Promise.resolve(bytes ? new Response(bytes as Uint8Array<ArrayBuffer>) : undefined);
  }
  async put(key: string, response: Response) {
    this.ops.put.push(key);
    this.entries.set(key, new Uint8Array(await response.arrayBuffer()));
  }
}

export const users = { reader: "user-reader", outsider: "user-outsider" } as const;
export const sessionCookies = { reader: "better-auth.session_token=reader-token.sig", outsider: "better-auth.session_token=outsider-token.sig" } as const;

/** Answers Better Auth's get-session for the fixture session cookies. */
export function stubSessions(byToken: Record<string, string> = { "reader-token.sig": users.reader, "outsider-token.sig": users.outsider }) {
  /** A token mapped to "down" makes the session backend fail. */
  const lookups: string[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith("/api/auth/get-session")) return Promise.resolve(new Response("Not found", { status: 404 }));
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    const token = /session_token=([^;]+)/.exec(cookie)?.[1] ?? "";
    lookups.push(token);
    const user = byToken[token];
    if (user === "down") return Promise.resolve(new Response("down", { status: 503 }));
    if (!user) return Promise.resolve(Response.json(null));
    const now = new Date().toISOString();
    return Promise.resolve(Response.json({
      user: { id: user, email: `${user}@example.test`, name: user, emailVerified: true, image: null, createdAt: now, updatedAt: now },
      session: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    }));
  }) as typeof fetch;
  return lookups;
}

const etags = (): RefEtagCache => {
  const values = new Map<string, CachedRef>();
  return { get: (branch) => Promise.resolve(values.get(branch) ?? null), set: (branch, value) => Promise.resolve(void values.set(branch, value)) };
};

export const publicRepo: RepoRecord = { id: 501, owner: "Octo", name: "public-docs", private: false, defaultBranch: "main" };
export const privateRepo: RepoRecord = { id: 502, owner: "octo", name: "secret-docs", private: true, defaultBranch: "main" };

/** Docs with nested pages, cross links, an image, an alert and a page too large to render. */
export function repoFiles(title = "Home"): Record<string, string | Uint8Array> {
  return {
    "README.md": "# Project\n",
    "docs/index.md": `# ${title}\n\nRead the [guide](guide/start.md) and see ![Logo](img/logo.png).\n\n> [!NOTE]\n> Rendered at ingest.\n`,
    "docs/guide/start.md": "---\ntitle: Getting started\n---\n# Start here\n\nBack to [home](../index.md#user-content-home). [Top](#user-content-start-here)\n",
    "docs/guide/README.md": "# Guide\n\nThe guide.\n",
    "docs/reference/api.md": "# API\n\n```ts\nconst x = 1;\n```\n",
    "docs/img/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]),
    "docs/huge.md": `# Huge\n\n${"x".repeat(1024 * 1024 + 10)}`,
  };
}

/** Builds real snapshots with the P3b pipeline against the fake GitHub, then serves them through the Worker. */
export async function repoReadFixture() {
  clearAuthorizationMemory();
  clearSnapshotMemory();
  clearTouches();
  sessionCache.clear();
  const ingest = ingestFixture();
  const access = new InMemoryRepoAccess().addRepo(publicRepo).addRepo(privateRepo, [users.reader]);
  const repos = {
    public: ingest.github.repo(publicRepo.owner, publicRepo.name, { id: publicRepo.id }),
    private: ingest.github.repo(privateRepo.owner, privateRepo.name, { id: privateRepo.id, private: true }),
  };
  const commits = { public: repos.public.commit(repoFiles()), private: repos.private.commit(repoFiles("Secret home")) };
  const cache = etags();
  for (const repo of Object.values(repos)) await ingestBranch(ingest.deps, cache, repo.ref, "main");
  const pending: Array<Promise<unknown>> = [];
  const kv = epochKv(access);
  const env = { REPO_CONTENT: ingest.bucket, REPO_EPOCHS: kv, REPO_ACCESS: { fetch: repoAccessHandler(access) }, REPO_INGEST: null as FakeIngestCoordinator["namespace"] | null,
    FIRST_VIEW_LIMIT: null as FakeRateLimiter | null, SEARCH_LIMIT: null as FakeRateLimiter | null };
  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException() {}, props: {} };
  const settle = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  return { ingest, access, repos, commits, env, ctx, pending, settle, kv, cache, bucket: ingest.bucket };
}

/**
 * The ingest coordinator as a Durable Object namespace double (#242): every
 * ensure call lands in a pending queue that tests resolve in order, or
 * transport-fails. The serving Worker talks to it exactly as to the real one.
 */
/** A Workers Rate Limiting binding (#294): grants `allow` tokens, then refuses; records every key it was asked for. */
export class FakeRateLimiter {
  readonly keys: string[] = [];
  /** When set, every call fails like an unavailable limiter. */
  fail = false;
  constructor(public allow = Number.POSITIVE_INFINITY) {}

  limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(key);
    if (this.fail) return Promise.reject(new Error("limiter unavailable"));
    return Promise.resolve({ success: this.keys.length <= this.allow });
  }
}

export class FakeIngestCoordinator {
  readonly calls: Array<{ repo: { id: number; owner: string; name: string; private: boolean; installationId: number | null }; branch: string; defaultBranch: boolean }> = [];
  /** When set, every ensure call fails like an unreachable coordinator. */
  transportError: string | null = null;
  /** When set, every ensure call answers immediately with this outcome. */
  autoAnswer: unknown = null;
  /** Views reported for idle expiry (#263). */
  readonly touches: Array<{ id: number; private: boolean }> = [];
  /** When set, touches fail like an unreachable coordinator. */
  failTouches = false;
  private pending: Array<{ resolve: (outcome: unknown) => void; reject: (error: Error) => void }> = [];

  readonly namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (url: string, init?: RequestInit) => {
        if (new URL(url).pathname === "/touch") {
          this.touches.push(JSON.parse(String(init?.body as string)) as { id: number; private: boolean });
          return this.failTouches ? new Response("down", { status: 502 }) : Response.json({ status: "ok" });
        }
        if (new URL(url).pathname !== "/ensure") return new Response("Bad request", { status: 400 });
        const { repo, branch, defaultBranch } = JSON.parse(String(init?.body as string)) as { repo: unknown; branch: string; defaultBranch: boolean };
        this.calls.push({ repo: repo as typeof this.calls[number]["repo"], branch, defaultBranch });
        if (this.transportError) return new Response(this.transportError, { status: 502 });
        if (this.autoAnswer !== null) return Response.json(this.autoAnswer);
        return await new Promise<Response>((resolve, reject) => this.pending.push({
          resolve: outcome => resolve(Response.json(outcome)),
          reject,
        }));
      },
    }),
  };

  /** Resolves the oldest pending ensure call with an outcome. */
  release(outcome: unknown): void {
    this.pending.shift()?.resolve(outcome);
  }

  /** Rejects the oldest pending ensure call like a coordinator transport fault. */
  failCall(): void {
    this.pending.shift()?.reject(new Error("Coordinator unreachable"));
  }
}

/** A repository the fixture knows but has built no snapshot for yet. */
export const freshRepo: RepoRecord = { id: 503, owner: "octo", name: "fresh-docs", private: false, defaultBranch: "main" };
