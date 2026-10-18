import { GitHubError, type CachedRef, type RepoRef } from "../github/source";
import { toIngestError } from "./errors";
import { CommitIngestError, ingestBranch, readPointer, type IngestDependencies, type IngestResult, type RefEtagCache } from "./ingest";
import { isBranchName, trackedKey } from "./keys";
import { parseIngestMessage, parseRepoRef, type IngestMessage } from "./messages";
import { writeJson } from "./store";

/** The subset of DurableObjectStorage used here (its key-value API; SQLite-backed objects support it). */
export interface DurableStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; end?: string; limit?: number }): Promise<Map<string, T>>;
}

export interface DurableStateLike {
  storage: DurableStorageLike;
}

export type IngestOutcome =
  | { status: "flipped"; commit: string; previous: string | null; snapshot: "built" | "existing"; headMoved: boolean; staleHint: boolean }
  | { status: "current"; commit: string; staleHint: boolean }
  | { status: "no-ref" }
  | { status: "duplicate" }
  | { status: "failed"; reason: string; permanent: boolean; retryAt: number | null; commit: string | null };

export interface ReconcileOutcome {
  stale: Array<{ branch: string; sha: string }>;
  /** Set when GitHub rate-limited the check; the remaining branches wait for the next run. */
  retryAt: number | null;
}

/** Registry entry the reconciliation cron reads (gh/v1/tracked/<repo id>.json). */
export interface TrackedRepo {
  schema: 1;
  repo: RepoRef;
  branches: string[];
}

export interface CoordinatorOptions {
  /** Extra ingests in the same call when the head moved during a build. */
  maxFollowUps?: number;
  /** How long a processed delivery ID is remembered. GitHub redelivers for up to three days. */
  deliveryRetentionMs?: number;
}

interface FailureRecord {
  commit: string | null;
  reason: string;
  rendererVersion: number;
  at: number;
}

type JobResult = IngestResult | Extract<IngestOutcome, { status: "failed" }>;

interface Job {
  hint: string | null;
  /** The head this job is building, once known. */
  observed: string | null;
  promise: Promise<JobResult>;
}

const HISTORY = 50;
const PRUNE_BATCH = 100;

/**
 * The per-repository coordinator behind the RepoIngestCoordinator Durable
 * Object. Durable Objects are single-instance per name, but input gates open
 * while a request awaits network I/O, so ingests are serialized here
 * explicitly: one at a time per repository, and concurrent requests for the
 * same branch share one job (single flight).
 */
export class IngestCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<string, Job>();
  private readonly pending = new Map<string, Job>();
  private readonly maxFollowUps: number;
  private readonly deliveryRetentionMs: number;

  constructor(private readonly state: DurableStateLike, private readonly deps: IngestDependencies, options: CoordinatorOptions = {}) {
    this.maxFollowUps = options.maxFollowUps ?? 2;
    this.deliveryRetentionMs = options.deliveryRetentionMs ?? 4 * 24 * 60 * 60 * 1000;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.json().catch(() => null) as { repo?: unknown; branch?: unknown } | null;
    switch (new URL(request.url).pathname) {
      case "/ingest": {
        const message = parseIngestMessage(body);
        return message ? Response.json(await this.ingest(message)) : new Response("Bad message", { status: 400 });
      }
      case "/ensure": {
        const repo = parseRepoRef(body?.repo);
        return repo && isBranchName(body?.branch) ? Response.json(await this.ensure(repo, body.branch)) : new Response("Bad request", { status: 400 });
      }
      case "/reconcile": {
        const repo = parseRepoRef(body?.repo);
        return repo ? Response.json(await this.reconcile(repo)) : new Response("Bad request", { status: 400 });
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  async ingest(message: IngestMessage): Promise<IngestOutcome> {
    const misrouted = await this.claim(message.repo);
    if (misrouted) return misrouted;
    if (message.deliveryId && await this.state.storage.get(`delivery:${message.deliveryId}`) !== undefined) {
      return { status: "duplicate" };
    }
    const outcome = await this.schedule(message.repo, message.branch, message.sha);
    // A delivery is remembered once its work is done; transient failures and unconfirmed hints stay retryable.
    const settled = outcome.status === "failed" ? outcome.permanent : outcome.status === "no-ref" || !outcome.staleHint;
    if (message.deliveryId && settled) await this.rememberDelivery(message.deliveryId);
    return outcome;
  }

  /** First view of a branch: return the served commit, or ingest it once however many readers ask. */
  async ensure(repo: RepoRef, branch: string): Promise<IngestOutcome> {
    const misrouted = await this.claim(repo);
    if (misrouted) return misrouted;
    const pointer = await readPointer(this.deps.store, repo.id, branch);
    if (pointer) return { status: "current", commit: pointer.value.commit, staleHint: false };
    return this.schedule(repo, branch, null);
  }

  /** Compare each tracked branch's head (conditional request, a 304 is free) with what is served. */
  async reconcile(repo: RepoRef): Promise<ReconcileOutcome> {
    const outcome: ReconcileOutcome = { stale: [], retryAt: null };
    if (await this.claim(repo)) return outcome;
    const { source, pipeline, store } = this.deps;
    for (const branch of await this.state.storage.get<string[]>("branches") ?? []) {
      const etags = this.etags();
      let head;
      try {
        head = await source.getRef(repo, branch, await etags.get(branch));
      } catch (error) {
        if (error instanceof GitHubError && error.kind === "rate-limited") {
          outcome.retryAt = error.retryAt;
          break;
        }
        continue;
      }
      if (!head) continue;
      if (head.etag && !head.notModified) await etags.set(branch, { etag: head.etag, sha: head.sha });
      const pointer = (await readPointer(store, repo.id, branch))?.value;
      if (pointer?.commit === head.sha && pointer.rendererVersion === pipeline.rendererVersion) continue;
      const failure = await this.state.storage.get<FailureRecord>(`failure:${branch}`);
      if (failure?.commit === head.sha && failure.rendererVersion === pipeline.rendererVersion) continue;
      outcome.stale.push({ branch, sha: head.sha });
    }
    return outcome;
  }

  /** One Durable Object per repository: refuse work for any other repository ID. */
  private async claim(repo: RepoRef): Promise<Extract<IngestOutcome, { status: "failed" }> | null> {
    const owner = await this.state.storage.get<number>("repoId");
    if (owner === undefined) await this.state.storage.put("repoId", repo.id);
    else if (owner !== repo.id) return { status: "failed", reason: "misrouted", permanent: true, retryAt: null, commit: null };
    return null;
  }

  private async schedule(repo: RepoRef, branch: string, hint: string | null): Promise<Exclude<IngestOutcome, { status: "duplicate" }>> {
    const running = this.running.get(branch);
    const joined = running && (hint === null || hint === running.hint || hint === running.observed) ? running : this.pending.get(branch);
    // A pending job reads the head when it starts, so it covers any hint; a running one only the head it is building.
    if (joined) return this.view(await joined.promise, hint, branch);
    const job = { hint, observed: null } as Job;
    job.promise = this.tail.then(() => this.execute(job, repo, branch));
    this.tail = job.promise.catch(() => {});
    this.pending.set(branch, job);
    return this.view(await job.promise, hint, branch);
  }

  private async execute(job: Job, repo: RepoRef, branch: string): Promise<JobResult> {
    this.pending.delete(branch);
    this.running.set(branch, job);
    try {
      let result: IngestResult;
      for (let followUps = 0; ; followUps += 1) {
        result = await ingestBranch(this.deps, this.etags(), repo, branch, (sha) => { job.observed = sha; });
        if (result.status === "flipped") await this.flipped(repo, branch, result.commit);
        if (result.status !== "flipped" || !result.headMoved || followUps >= this.maxFollowUps) break;
      }
      await this.state.storage.delete([`failure:${branch}`]);
      return result;
    } catch (error) {
      const failure = toIngestError(error);
      const commit = failure instanceof CommitIngestError ? failure.commit : null;
      if (failure.permanent) {
        await this.state.storage.put(`failure:${branch}`, {
          commit, reason: failure.reason, rendererVersion: this.deps.pipeline.rendererVersion, at: this.deps.now(),
        } satisfies FailureRecord);
      }
      return { status: "failed", reason: failure.reason, permanent: failure.permanent, retryAt: failure.retryAt, commit };
    } finally {
      this.running.delete(branch);
    }
  }

  /** Per-caller view of a shared job: whether the caller's hint is explained by what was served. */
  private async view(result: JobResult, hint: string | null, branch: string): Promise<Exclude<IngestOutcome, { status: "duplicate" }>> {
    if (result.status !== "flipped" && result.status !== "current") return result;
    const history = await this.state.storage.get<string[]>(`history:${branch}`) ?? [];
    const staleHint = hint !== null && hint !== result.commit && !history.includes(hint);
    if (result.status === "current") return { status: "current", commit: result.commit, staleHint };
    return { status: "flipped", commit: result.commit, previous: result.previous, snapshot: result.snapshot, headMoved: result.headMoved, staleHint };
  }

  private async flipped(repo: RepoRef, branch: string, commit: string): Promise<void> {
    const { storage } = this.state;
    const history = await storage.get<string[]>(`history:${branch}`) ?? [];
    await storage.put(`history:${branch}`, [commit, ...history.filter((sha) => sha !== commit)].slice(0, HISTORY));
    const branches = await storage.get<string[]>("branches") ?? [];
    const tracked: TrackedRepo = { schema: 1, repo, branches: branches.includes(branch) ? branches : [...branches, branch].sort() };
    const serialized = JSON.stringify(tracked);
    // Written only when it changes (a new branch, a rename): R2 allows one write per second per key.
    if (await storage.get<string>("tracked") !== serialized) {
      await writeJson(this.deps.store, trackedKey(repo.id), tracked);
      await storage.put("branches", tracked.branches);
      await storage.put("tracked", serialized);
    }
  }

  private async rememberDelivery(id: string): Promise<void> {
    const { storage } = this.state;
    const now = this.deps.now();
    await storage.put(`delivery:${id}`, now);
    await storage.put(`delivery-at:${timeKey(now)}:${id}`, id);
    const expired = await storage.list<string>({ prefix: "delivery-at:", end: `delivery-at:${timeKey(now - this.deliveryRetentionMs)}`, limit: PRUNE_BATCH });
    if (expired.size > 0) await storage.delete([...expired.keys(), ...[...expired.values()].map((old) => `delivery:${old}`)]);
  }

  private etags(): RefEtagCache {
    const { storage } = this.state;
    return {
      get: async (branch) => await storage.get<CachedRef>(`etag:${branch}`) ?? null,
      set: (branch, value) => storage.put(`etag:${branch}`, value),
    };
  }
}

function timeKey(ms: number): string {
  return String(Math.max(0, ms)).padStart(16, "0");
}
