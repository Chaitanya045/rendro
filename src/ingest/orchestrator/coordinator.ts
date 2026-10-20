import { DeliveryDedupe, DELIVERY_RETENTION_MS } from "../github/delivery-dedupe";
import { GitHubError, type CachedRef, type RepoRef } from "../github/source";
import type { IngestLog } from "./consumer";
import { toIngestError, UNREADABLE_CONTENT } from "./errors";
import { CommitIngestError, ingestBranch, readPointer, type IngestDependencies, type IngestResult, type RefEtagCache } from "./ingest";
import { isBranchName, trackedKey } from "./keys";
import { parseIngestMessage, parseRepoRef, type IngestMessage } from "./messages";
import { writeJson } from "./store";
import { purgeAuditKey, wipeStep, type WipeProgress, type WipeReason } from "./wipe";

/** The subset of DurableObjectStorage used here (its key-value API; SQLite-backed objects support it). */
export interface DurableStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; end?: string; limit?: number }): Promise<Map<string, T>>;
}

/** The coordinator also uses the alarm: idle expiry and resuming an unfinished wipe (#263). */
export interface CoordinatorStorage extends DurableStorageLike {
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface DurableStateLike {
  storage: CoordinatorStorage;
}

export type IngestOutcome =
  | { status: "flipped"; commit: string; previous: string | null; snapshot: "built" | "existing"; headMoved: boolean; staleHint: boolean }
  | { status: "current"; commit: string; staleHint: boolean }
  | { status: "no-ref" }
  | { status: "duplicate" }
  | { status: "failed"; reason: string; permanent: boolean; retryAt: number | null; commit: string | null }
  /** Expired for lack of views (#263): a push or a reconciliation waits for the next view. */
  | { status: "idle" };

/** What a first view gets (#294): an ingest outcome, or a refusal while the repository's first-view budget is spent. */
export type EnsureOutcome = IngestOutcome | { status: "throttled"; retryAt: number };

/** A purge of a removed repository's content (#263): finished, or recorded and continuing from the alarm. */
export type PurgeOutcome = { status: "done" | "accepted" | "misrouted" };

/** What a view tells the coordinator: the repository was read, and whether it is private now. */
export interface RepoTouch {
  id: number;
  private: boolean;
}

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
  /** Content nobody viewed for this long is deleted; the next view ingests it again. */
  idleMs?: number;
  /** Structured logs: IDs, reasons and counts only. */
  log?: IngestLog;
}

/** Idle expiry (#263): the content of a repository nobody viewed for about a month is deleted. */
export const IDLE_EXPIRY_MS = 30 * 24 * 60 * 60_000;
/** Last access is kept to 1/30 of the idle window (a day): at most one storage write a day per repository, not one per view. */
const ACCESS_RESOLUTION = 30;
/** While a wipe is unfinished, the alarm resumes it this soon; it is also the watchdog for an instance that dies mid-step. */
export const WIPE_RESUME_MS = 1_000;
/** Durable Object storage deletes at most 128 keys per call. */
const STORAGE_DELETE_BATCH = 128;

/** A branch GitHub said does not exist is answered from here, with no GitHub call, for this long (#294). */
export const MISSING_REF_TTL_MS = 5 * 60_000;
/** At most this many distinct branches GitHub did not know, per repository and window, are asked about on first views. */
export const UNKNOWN_BRANCH_CAP = 10;
export const UNKNOWN_BRANCH_WINDOW_MS = 10 * 60_000;
/** At most this many first-view jobs for branches nothing serves yet start per repository and window. */
export const FIRST_VIEW_BUDGET = 30;
export const FIRST_VIEW_WINDOW_MS = 60 * 60_000;

/**
 * First-view admission for one repository (#294), under storage key `first-views`.
 * The default branch is exempt from both limits, never from the negative cache.
 */
interface FirstViewRecord {
  /** Branches GitHub did not know, and until when each is answered without asking again. */
  missing: Record<string, number>;
  /** The current unknown-branch window: its start, and the distinct misses counted in it. */
  unknownSince: number;
  unknown: number;
  /** The current budget window: its start, and the first-view jobs started in it. */
  jobsSince: number;
  jobs: number;
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

/**
 * What the stored content is sealed with (storage key `content`): the sealer's
 * key ID, `plaintext` (a public repository, or a sealer that stores bytes as
 * they are), `none` (nothing stored since a wipe) or `unreadable` (an object
 * did not open during an ingest). Absent means unknown.
 */
type ContentState = string;

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * The per-repository coordinator behind the RepoIngestCoordinator Durable
 * Object. Durable Objects are single-instance per name, but input gates open
 * while a request awaits network I/O, so ingests are serialized here
 * explicitly: one at a time per repository, and concurrent requests for the
 * same branch share one job (single flight).
 *
 * It also owns the repository's cached content over time (#263): sealing
 * private content (a repository once private stays sealed), idle expiry from
 * a coarse last-access time, and wiping the content for a confirmed removal.
 * Every wipe runs in the same serialized chain as ingests, so an ingest never
 * writes into a half-deleted prefix.
 */
export class IngestCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  /** Changes to the first-view record (#294), one at a time. */
  private firstViewChain: Promise<unknown> = Promise.resolve();
  /** First-view jobs admitted and not yet answered: each may still turn out to be a miss. */
  private firstViewJobs = 0;
  private readonly running = new Map<string, Job>();
  private readonly pending = new Map<string, Job>();
  private readonly maxFollowUps: number;
  private readonly deliveries: DeliveryDedupe;
  private readonly idleMs: number;
  private readonly log: IngestLog;

  constructor(private readonly state: DurableStateLike, private readonly deps: IngestDependencies, options: CoordinatorOptions = {}) {
    this.maxFollowUps = options.maxFollowUps ?? 2;
    this.deliveries = new DeliveryDedupe(state.storage, options.deliveryRetentionMs ?? DELIVERY_RETENTION_MS);
    this.idleMs = options.idleMs ?? IDLE_EXPIRY_MS;
    this.log = options.log ?? (() => {});
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    switch (new URL(request.url).pathname) {
      case "/ingest": {
        const message = parseIngestMessage(body);
        return message ? Response.json(await this.ingest(message)) : new Response("Bad message", { status: 400 });
      }
      case "/ensure": {
        const repo = parseRepoRef(body?.repo);
        return repo && isBranchName(body?.branch)
          ? Response.json(await this.ensure(repo, body.branch, body.defaultBranch === true))
          : new Response("Bad request", { status: 400 });
      }
      case "/reconcile": {
        const repo = parseRepoRef(body?.repo);
        return repo ? Response.json(await this.reconcile(repo)) : new Response("Bad request", { status: 400 });
      }
      case "/touch":
        return positiveInteger(body?.id) && typeof body.private === "boolean"
          ? Response.json(await this.touch({ id: body.id, private: body.private }))
          : new Response("Bad request", { status: 400 });
      case "/purge":
        return positiveInteger(body?.repoId) ? Response.json(await this.purge(body.repoId)) : new Response("Bad request", { status: 400 });
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  async ingest(message: IngestMessage): Promise<IngestOutcome> {
    const misrouted = await this.claim(message.repo.id);
    if (misrouted) return misrouted;
    if (message.deliveryId && await this.deliveries.seen(message.deliveryId)) {
      return { status: "duplicate" };
    }
    // Expired for lack of views: pushes and reconciliation wait for the next view; an installation event ingests.
    const idle = (message.reason === "push" || message.reason === "reconcile") && await this.state.storage.get("expired") === true;
    const outcome: IngestOutcome = idle ? { status: "idle" } : await this.schedule(message.repo, message.branch, message.sha);
    // A delivery is remembered once its work is done; transient failures and unconfirmed hints stay retryable.
    const settled = outcome.status === "failed" ? outcome.permanent
      : outcome.status === "no-ref" || outcome.status === "idle" || !outcome.staleHint;
    if (message.deliveryId && settled) await this.deliveries.remember(message.deliveryId, this.deps.now());
    return outcome;
  }

  /**
   * First view of a branch: return the served commit, or ingest it once however many readers ask.
   * A branch nothing serves yet is admitted first (#294): one GitHub said does not exist is answered
   * from the negative cache, and other than the default branch, a new job needs the repository's
   * unknown-branch cap and first-view budget. Readers joining a job already queued spend nothing.
   */
  async ensure(repo: RepoRef, branch: string, defaultBranch = false): Promise<EnsureOutcome> {
    const misrouted = await this.claim(repo.id);
    if (misrouted) return misrouted;
    // A view: the repository is wanted again, whatever idle expiry did.
    await this.state.storage.delete(["expired"]);
    await this.recordAccess();
    // Content that must be wiped first (or a wipe still running) is never answered from: the job wipes, then builds.
    const pointer = await this.contentReady(repo.private) === true ? await readPointer(this.deps.store, repo.id, branch) : null;
    if (pointer) return { status: "current", commit: pointer.value.commit, staleHint: false };
    const admission = await this.admitFirstView(branch, defaultBranch);
    if ("refused" in admission) return admission.refused;
    let outcome: EnsureOutcome;
    try {
      outcome = await this.schedule(repo, branch, null);
      if (outcome.status === "no-ref") await this.rememberMissing(branch, defaultBranch);
    } finally {
      if (admission.charged) this.firstViewJobs -= 1;
    }
    // The reader waited for this build: the idle window starts when it is served.
    await this.recordAccess();
    return outcome;
  }

  /** Compare each tracked branch's head (conditional request, a 304 is free) with what is served. */
  async reconcile(repo: RepoRef): Promise<ReconcileOutcome> {
    const outcome: ReconcileOutcome = { stale: [], retryAt: null };
    if (await this.claim(repo.id)) return outcome;
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

  /**
   * A view of the repository (#263), sent by the read path at most once per
   * isolate and hour. It records the coarse last-access time idle expiry
   * reads, and carries the visibility the reader was granted: content stored
   * before the repository was made private (or under a rotated key) is wiped,
   * so the next view ingests it sealed.
   */
  async touch(touch: RepoTouch): Promise<{ status: "ok" | "misrouted" }> {
    if (await this.claim(touch.id)) return { status: "misrouted" };
    await this.recordAccess();
    // A wipe already running continues from the alarm. Without a content key nothing can be decided here; the next ingest reports why.
    if (await this.contentReady(touch.private) === false && await this.state.storage.get("wipe") === undefined) {
      await this.serialize(() => this.settle(touch.private));
    }
    return { status: "ok" };
  }

  /**
   * GitHub confirmed the app lost this repository (#258 via the control
   * Worker's purge ledger): delete its content in bounded steps, then forget
   * everything about it. Recorded durably first, so an evicted instance
   * resumes from its alarm. Idempotent: a repeated purge finds less to delete.
   */
  async purge(repoId: number): Promise<PurgeOutcome> {
    if (await this.claim(repoId)) return { status: "misrouted" };
    return this.serialize(async () => {
      await this.startWipe("removed");
      return { status: await this.wipeOnce() ? "done" : "accepted" };
    });
  }

  /** Resume an unfinished wipe, or expire the content once nobody viewed it for the idle window. */
  async alarm(): Promise<void> {
    await this.serialize(async () => {
      const { storage } = this.state;
      if (await storage.get<WipeProgress>("wipe") === undefined) {
        const last = await storage.get<number>("lastAccess");
        if (last === undefined || this.deps.now() - last < this.idleMs) return this.rearm();
        await this.startWipe("idle");
      }
      // An unfinished step has already re-armed the alarm for the next one.
      if (await this.wipeOnce()) await this.rearm();
    });
  }

  /** The first-view record with expired negative entries dropped and finished windows restarted. */
  private async firstViews(now: number): Promise<FirstViewRecord> {
    const stored = await this.state.storage.get<FirstViewRecord>("first-views");
    const record: FirstViewRecord = stored ?? { missing: {}, unknownSince: now, unknown: 0, jobsSince: now, jobs: 0 };
    record.missing = Object.fromEntries(Object.entries(record.missing).filter(([, until]) => until > now));
    if (now - record.unknownSince >= UNKNOWN_BRANCH_WINDOW_MS) Object.assign(record, { unknownSince: now, unknown: 0 });
    if (now - record.jobsSince >= FIRST_VIEW_WINDOW_MS) Object.assign(record, { jobsSince: now, jobs: 0 });
    return record;
  }

  /**
   * Read, change and store the first-view record one change at a time: readers that arrive together
   * must not overwrite each other's counts. `change` returns the result and whether to store the record.
   */
  private updateFirstViews<T>(change: (record: FirstViewRecord, now: number) => [T, boolean]): Promise<T> {
    const run = this.firstViewChain.then(async () => {
      const now = this.deps.now();
      const record = await this.firstViews(now);
      const [result, changed] = change(record, now);
      if (changed) await this.state.storage.put("first-views", record);
      return result;
    });
    this.firstViewChain = run.catch(() => {});
    return run;
  }

  /**
   * Whether a first view of `branch` may run, and if so whether it was charged as a new job; else what
   * to answer instead. Jobs still in flight count against the unknown-branch cap as possible misses, so
   * readers arriving together cannot make the coordinator ask GitHub about more than the cap allows.
   */
  private admitFirstView(branch: string, defaultBranch: boolean): Promise<{ refused: EnsureOutcome } | { charged: boolean }> {
    return this.updateFirstViews<{ refused: EnsureOutcome } | { charged: boolean }>((record) => {
      if (Object.hasOwn(record.missing, branch)) return [{ refused: { status: "no-ref" } }, false];
      if (defaultBranch || this.running.has(branch) || this.pending.has(branch)) return [{ charged: false }, false];
      if (record.unknown + this.firstViewJobs >= UNKNOWN_BRANCH_CAP) {
        return [{ refused: { status: "throttled", retryAt: record.unknownSince + UNKNOWN_BRANCH_WINDOW_MS } }, false];
      }
      if (record.jobs >= FIRST_VIEW_BUDGET) return [{ refused: { status: "throttled", retryAt: record.jobsSince + FIRST_VIEW_WINDOW_MS } }, false];
      record.jobs += 1;
      this.firstViewJobs += 1;
      return [{ charged: true }, true];
    });
  }

  /** GitHub does not know `branch`: answer it from here for a while; a branch other than the default counts against the cap once. */
  private rememberMissing(branch: string, defaultBranch: boolean): Promise<void> {
    return this.updateFirstViews((record, now) => {
      // Readers who shared the job report the same miss.
      if (Object.hasOwn(record.missing, branch)) return [undefined, false];
      record.missing[branch] = now + MISSING_REF_TTL_MS;
      if (!defaultBranch) record.unknown += 1;
      return [undefined, true];
    });
  }

  /** The branch exists after all (a push created it): drop its negative entry. */
  private forgetMissing(branch: string): Promise<void> {
    return this.updateFirstViews((record) => {
      if (!Object.hasOwn(record.missing, branch)) return [undefined, false];
      delete record.missing[branch];
      return [undefined, true];
    });
  }

  /** One Durable Object per repository: refuse work for any other repository ID. */
  private async claim(repoId: number): Promise<Extract<IngestOutcome, { status: "failed" }> | null> {
    const owner = await this.state.storage.get<number>("repoId");
    if (owner === undefined) await this.state.storage.put("repoId", repoId);
    else if (owner !== repoId) return { status: "failed", reason: "misrouted", permanent: true, retryAt: null, commit: null };
    return null;
  }

  /** Run `work` after every job and wipe step before it. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => {});
    return run;
  }

  /** Last access to the idle window's resolution: one storage write a day per repository at most. */
  private async recordAccess(): Promise<void> {
    const { storage } = this.state;
    const now = this.deps.now();
    const last = await storage.get<number>("lastAccess");
    if (last !== undefined && now - last < this.idleMs / ACCESS_RESOLUTION) return;
    await storage.put("lastAccess", now);
    await this.rearm();
  }

  /** The next alarm: the next wipe step while one is unfinished, else the end of the idle window. */
  private async rearm(): Promise<void> {
    const { storage } = this.state;
    if (await storage.get<WipeProgress>("wipe") !== undefined) return storage.setAlarm(this.deps.now() + WIPE_RESUME_MS);
    const last = await storage.get<number>("lastAccess");
    if (last !== undefined) await storage.setAlarm(last + this.idleMs);
  }

  /** What the content must be sealed with now, and whether the stored content already is. */
  private async contentTarget(privateHint: boolean): Promise<{ isPrivate: boolean; want: ContentState; have: ContentState }> {
    const { storage } = this.state;
    // A repository once private stays sealed: a stale message (a reconciliation entry, an old redelivery) cannot unseal it.
    const isPrivate = privateHint || await storage.get<boolean>("private") === true;
    const want = isPrivate ? await this.deps.sealer.currentKeyId() ?? "plaintext" : "plaintext";
    // Unknown state with no branch ever flipped here: nothing was stored by this coordinator.
    const have = await storage.get<ContentState>("content") ?? (await storage.get("branches") === undefined ? "none" : "unknown");
    return { isPrivate, want, have };
  }

  /**
   * Whether jobs may run on the stored content as it is: no wipe pending, and
   * sealed as the repository needs. Null when that cannot be told (no content key).
   */
  private async contentReady(privateHint: boolean): Promise<boolean | null> {
    if (await this.state.storage.get<WipeProgress>("wipe") !== undefined) return false;
    try {
      const { isPrivate, want, have } = await this.contentTarget(privateHint);
      return !isPrivate || have === "none" || have === want;
    } catch {
      return null;
    }
  }

  /**
   * Inside the chain, before any job: finish a pending wipe, then wipe content
   * that is not sealed the way the repository needs (made private since, a
   * rotated key, an object that did not open). Returns the visibility to
   * ingest with: private once private.
   */
  private async settle(privateHint: boolean): Promise<boolean> {
    const { storage } = this.state;
    while (await storage.get<WipeProgress>("wipe") !== undefined) await this.wipeOnce();
    const { isPrivate, want, have } = await this.contentTarget(privateHint);
    if (isPrivate && await storage.get("private") !== true) await storage.put("private", true);
    if (isPrivate && have !== "none" && have !== want) {
      await this.startWipe("reseal");
      while (!await this.wipeOnce()) { /* bounded steps until nothing is left */ }
    }
    if (await storage.get<ContentState>("content") !== want) await storage.put("content", want);
    return isPrivate;
  }

  private async startWipe(reason: WipeReason): Promise<void> {
    const { storage } = this.state;
    const pending = await storage.get<WipeProgress>("wipe");
    // A removal outranks any other reason: once it finishes, nothing of the repository is kept.
    if (pending && (pending.reason === "removed" || reason !== "removed")) return;
    await storage.put("wipe", { reason, startedAt: pending?.startedAt ?? this.deps.now(), objects: pending?.objects ?? 0, searchRows: pending?.searchRows ?? 0 } satisfies WipeProgress);
  }

  /** One bounded step of the pending wipe. Returns true when it finished. */
  private async wipeOnce(): Promise<boolean> {
    const { storage } = this.state;
    const progress = await storage.get<WipeProgress>("wipe") as WipeProgress;
    const repoId = await storage.get<number>("repoId") as number;
    // The watchdog: an instance that dies mid-step resumes from here.
    await storage.setAlarm(this.deps.now() + WIPE_RESUME_MS);
    if (!await wipeStep(this.deps.store, this.deps.search, repoId, progress)) {
      await storage.put("wipe", progress);
      return false;
    }
    this.log("ingest.wipe", { repoId, reason: progress.reason, objects: progress.objects, searchRows: progress.searchRows });
    if (progress.reason === "removed") {
      // The audit record outlives the prefix: IDs, times and counts only.
      await writeJson(this.deps.store, purgeAuditKey(repoId, progress.startedAt), {
        schema: 1, event: "repository.content-purged", repoId, startedAt: new Date(progress.startedAt).toISOString(),
        finishedAt: new Date(this.deps.now()).toISOString(), objects: progress.objects, searchRows: progress.searchRows,
      });
      // Everything this coordinator knew goes too: a reinstall starts afresh.
      await this.deleteStorage([...(await storage.list({ prefix: "" })).keys()]);
      return true;
    }
    const stale = [...(await storage.list({ prefix: "failure:" })).keys(), "branches", "tracked", "wipe"];
    if (progress.reason === "idle") {
      stale.push("lastAccess");
      await storage.put("expired", true);
    }
    await storage.put("content", "none");
    await this.deleteStorage(stale);
    return true;
  }

  private async deleteStorage(keys: string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += STORAGE_DELETE_BATCH) await this.state.storage.delete(keys.slice(start, start + STORAGE_DELETE_BATCH));
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
      const effective = { ...repo, private: await this.settle(repo.private) };
      let result: IngestResult;
      for (let followUps = 0; ; followUps += 1) {
        result = await ingestBranch(this.deps, this.etags(), effective, branch, (sha) => { job.observed = sha; });
        if (result.status === "flipped") await this.flipped(effective, branch, result.commit);
        if (result.status !== "flipped" || !result.headMoved || followUps >= this.maxFollowUps) break;
      }
      await this.state.storage.delete([`failure:${branch}`]);
      if (result.status !== "no-ref") await this.forgetMissing(branch);
      return result;
    } catch (error) {
      const failure = toIngestError(error);
      const commit = failure instanceof CommitIngestError ? failure.commit : null;
      // Stored content that does not open is replaced on the retry instead of failing on it forever.
      if (UNREADABLE_CONTENT.has(failure.reason)) await this.state.storage.put("content", "unreadable");
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
    // Served again: pushes are ingested again, and content nobody ever views expires a window after its first flip.
    await storage.delete(["expired"]);
    if (await storage.get("lastAccess") === undefined) await this.recordAccess();
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

  private etags(): RefEtagCache {
    const { storage } = this.state;
    return {
      get: async (branch) => await storage.get<CachedRef>(`etag:${branch}`) ?? null,
      set: (branch, value) => storage.put(`etag:${branch}`, value),
    };
  }
}
