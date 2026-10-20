/**
 * The access directory (#243): the logic behind the control Worker's one
 * `RepoAccessDirectory` Durable Object. It answers `RepoPermissionSource`
 * (docs/TECHNICAL.md, "Repository read path") from state it keeps current,
 * never by calling GitHub per view:
 *
 * - The registry: every repository the app can see (ID, name, visibility,
 *   default branch, installation) and every installation's state.
 * - A mirror per user: the repository IDs GitHub lists for them through the
 *   app's installations, at most `MIRROR_TTL_MS` old (conditional requests;
 *   a 304 is free).
 * - Public visibility is never trusted for longer than GitHub last stated it
 *   (#295): a public record older than `PUBLIC_CONFIRM_TTL_MS` is confirmed
 *   again before it grants (conditional, so an unchanged repository costs no
 *   quota), and one GitHub has not confirmed for `PUBLIC_CONFIRM_MAX_MS`
 *   grants nobody. A missed `privatized` delivery is then caught on the next
 *   read, and the visibility epoch moves exactly as that delivery would.
 * - The epoch outbox: users whose capabilities must be re-decided. Epochs are
 *   written to KV only after the registry and the mirror already deny. Where
 *   comments are configured (#254), each epoch, and every repository GitHub
 *   reports uninstalled or deleted, then goes to Convex too.
 * - The purge ledger (#258): a removed repository's comments are hidden at
 *   once, but purged only once its window has ended and GitHub confirms the
 *   removal (`confirmRemoval`). A replayed removal is caught there: the
 *   repository is restored and nothing is deleted. The same confirmation
 *   purges the repository's cached R2 content and search rows (#263).
 *
 * A Durable Object runs one instance, so registry and mirrors change
 * consistently. Its input gates open while it awaits GitHub, so a refresh or
 * a check that loses a race with a webhook is discarded, never committed.
 * Anything it cannot decide is `RepoAccessUnavailable` (503), never a grant.
 */
import { DeliveryDedupe } from "@/ingest/github/delivery-dedupe";
import { GitHubError } from "@/ingest/github/source";
import type { InstallationTokenProvider } from "@/ingest/github/token";
import type { DurableStorageLike } from "@/ingest/orchestrator/coordinator";
import { RepoAccessUnavailable, repoKey, USER_EPOCH_KEY_PREFIX, VISIBILITY_EPOCH_KEY_PREFIX, type RepoRecord } from "@/repo-read/access";
import type { EventPlan, RepoHint } from "./events";
import type { GitHubAccessClient, ListedInstallation, ListedRepo, Page } from "./github";
import { confirmRemoval } from "./removal";
import { openTokens, sealTokens, type TokenRefresher, type UserTokens } from "./tokens";

export interface DirectoryStorage extends DurableStorageLike {
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface DirectoryState {
  storage: DirectoryStorage;
}

/** The write half of the `REPO_EPOCHS` KV binding. */
export interface EpochStore {
  put(key: string, value: string, options: { expirationTtl?: number }): Promise<void>;
}

/** Convex's answer to a purge: the repositories whose own retention window has not ended yet, and when it does. */
export interface PurgeAnswer {
  notDue: Array<{ repoId: number; dueAt: number }>;
}

/**
 * Comments on repository docs (#254) keep their own grants in Convex, which
 * cannot read KV. It hears every epoch after KV does (the same value), and
 * every repository that left the app, so comment access ends with page access.
 * Convex never purges on its own: only after GitHub confirmed the removal (#258).
 */
export interface CommentAccessSink {
  revoke(userId: string, epoch: number): Promise<void>;
  removeRepos(repoIds: number[]): Promise<void>;
  /** GitHub just confirmed these removed: purge the comments of every one whose window has ended. */
  purgeRepos(repoIds: number[]): Promise<PurgeAnswer>;
  /** GitHub still grants these: show their comments again and cancel any purge. */
  restoreRepos(repoIds: number[]): Promise<void>;
}

/**
 * A removed repository's cached content in R2 and its search rows (#263),
 * deleted only after GitHub confirmed the removal, like its comments. Throws
 * unless every purge was accepted, so the ledger confirms with GitHub again.
 */
export interface ContentPurgeSink {
  purge(repoIds: number[]): Promise<void>;
}

export type DirectoryLog = (event: string, fields: Record<string, string | number | boolean>) => void;

export interface DirectoryDependencies {
  github: GitHubAccessClient;
  installationTokens: InstallationTokenProvider;
  refresher: TokenRefresher;
  /** The dedicated `GITHUB_TOKEN_KEY` secret. */
  tokenKey: string;
  epochs: EpochStore;
  /** Optional: without it, comment grants end with their own lifetime (at most the five-minute capability). */
  comments?: CommentAccessSink;
  /** Optional: without it, a removed repository's content stays until idle expiry deletes it (nobody can view it). */
  content?: ContentPurgeSink;
  now(): number;
  log: DirectoryLog;
}

export interface LinkRequest {
  userId: string;
  githubId: number;
  login: string;
  tokens: UserTokens;
}

/** A mirror older than this is refreshed from GitHub before it answers; if that fails, the answer is 503. */
export const MIRROR_TTL_MS = 5 * 60_000;
/** A public record GitHub has not confirmed for this long is confirmed again before it grants anyone. */
export const PUBLIC_CONFIRM_TTL_MS = MIRROR_TTL_MS;
/**
 * While GitHub cannot answer (an outage, a rate limit), a public record keeps granting until it is this old;
 * past it, nobody is granted on it (503) until GitHub confirms it again.
 */
export const PUBLIC_CONFIRM_MAX_MS = 60 * 60_000;
/** An epoch outlives every capability minted before it (cookies 5 minutes, tickets 15), so the KV key may expire. */
export const EPOCH_TTL_SECONDS = 3_600;
/** After a failed GitHub call, the same work answers 503 at once for this long instead of calling again. */
export const FAILURE_COOLDOWN_MS = 5_000;
/** Repository pages per refresh (100 each). An installation not listed in full falls back to single-repository checks. */
export const MAX_REPOSITORY_PAGES = 20;
const MAX_INSTALLATION_PAGES = 3;
const TOKEN_EARLY_REFRESH_MS = 60_000;
const EPOCH_BATCH = 64;
const EPOCH_CONCURRENCY = 8;
const EPOCH_RETRY_MS = 10_000;
/** Repositories per removal call to Convex. */
const REMOVAL_BATCH = 100;
/** Decisions per authorize: each GitHub step (installation, repository, mirror, single check) takes one. */
const MAX_ROUNDS = 6;
/** A removed repository's data is purged this long after the removal, once GitHub confirms it. Convex keeps the same window for comments. */
export const REMOVAL_PURGE_DELAY_MS = 30 * 24 * 60 * 60_000;
/** A removal GitHub could not confirm is asked again after this, doubling up to `PURGE_RETRY_MAX_MS`. */
export const PURGE_RETRY_MS = 15 * 60_000;
export const PURGE_RETRY_MAX_MS = 24 * 60 * 60_000;
/** Confirmations per alarm. */
export const PURGE_BATCH = 20;

interface RepoEntry {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string | null;
  installation: number | null;
  removed: boolean;
  /** Set by permissive events: confirm with GitHub before the next grant. */
  check: boolean;
  /** The event sequence number that last changed this record. */
  seq: number;
  /** When GitHub last stated this record's visibility (a repository read or a listing); absent: never. */
  confirmedAt?: number;
  /** The ETag of the repository read that set these fields, for a conditional re-read; null once anything else changed them. */
  etag?: string | null;
}

interface InstallationEntry {
  id: number;
  account: string | null;
  state: "active" | "suspended" | "deleted";
  check: boolean;
  seq: number;
}

interface UserEntry {
  githubId: number;
  login: string;
  /** Sealed `UserTokens`, or null once GitHub revoked or refused them. */
  tokens: string | null;
  /** Changes whenever the tokens are replaced or dropped. */
  tokenVersion: number;
  /** Changes whenever the user's access may have changed: mirrors and checks from an older generation are not used. */
  gen: number;
}

interface PageCache {
  etag: string | null;
  ids: number[];
  next: boolean;
}

interface Mirror {
  gen: number;
  fetchedAt: number;
  installationPages: PageCache[];
  repoPages: Record<string, PageCache[]>;
  /** Installations listed only in part. */
  partial: number[];
}

interface Listing {
  installationPages: PageCache[];
  repoPages: Record<string, PageCache[]>;
  partial: number[];
  installations: ListedInstallation[];
  repos: Array<ListedRepo & { installation: number }>;
}

/** `purge:<due time, 16 digits>:<repo>`, so a listing returns the earliest first; `purging:<repo>` names it. */
interface PurgeEntry {
  repoId: number;
  dueAt: number;
  /** Confirmations GitHub could not give so far. */
  attempts: number;
}

function purgeKey(dueAt: number, repoId: number): string {
  return `purge:${String(dueAt).padStart(16, "0")}:${repoId}`;
}

interface ReaderCheck {
  allowed: boolean;
  at: number;
  gen: number;
}

type Need =
  | { kind: "installation"; entry: InstallationEntry }
  | { kind: "repo"; entry: RepoEntry }
  | { kind: "visibility"; entry: RepoEntry }
  | { kind: "mirror"; user: UserEntry }
  | { kind: "reader"; user: UserEntry; entry: RepoEntry };

type Decision = { answer: RepoRecord | null } | { need: Need };

function repoRecord(entry: RepoEntry): RepoRecord {
  return { id: entry.id, owner: entry.owner, name: entry.name, private: entry.private, defaultBranch: entry.defaultBranch as string };
}

/** True when an access token expires soon enough that it must be renewed before use. */
function expiring(tokens: UserTokens, now: number): boolean {
  return tokens.accessTokenExpiresAt !== null && tokens.accessTokenExpiresAt - now < TOKEN_EARLY_REFRESH_MS;
}

/** GitHub refused the user's tokens for good: they must sign in again. */
class TokensRejected extends Error {}

function pageIds(pages: PageCache[]): Set<number> {
  return new Set(pages.flatMap((page) => page.ids));
}

function mirrorIds(mirror: Mirror | null): Set<number> {
  return pageIds(mirror ? Object.values(mirror.repoPages).flat() : []);
}

function mirrorInstallations(mirror: Mirror | null): Set<number> {
  return pageIds(mirror?.installationPages ?? []);
}

async function eachLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export class AccessDirectory {
  private readonly deliveries: DeliveryDedupe;
  private readonly refreshing = new Map<string, { gen: number; promise: Promise<Mirror | null> }>();
  private readonly renewing = new Map<string, Promise<string>>();
  private readonly failures = new Map<string, number>();
  private epochChain: Promise<void> = Promise.resolve();
  /** The alarm this instance set since the last one fired (null: none), so the purge ledger never postpones a sooner one. */
  private armed: number | null = null;

  constructor(private readonly state: DirectoryState, private readonly deps: DirectoryDependencies) {
    this.deliveries = new DeliveryDedupe(state.storage);
  }

  private get storage(): DirectoryStorage {
    return this.state.storage;
  }

  /** Internal protocol, spoken only by the control Worker (src/repo-access/worker.ts). */
  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    switch (new URL(request.url).pathname) {
      case "/authorize": {
        try {
          const repo = await this.authorize(body.viewer as string | null, body.owner as string, body.name as string);
          return repo ? Response.json({ repo }) : Response.json({}, { status: 404 });
        } catch {
          return Response.json({ error: "Unavailable" }, { status: 503 });
        }
      }
      case "/link":
        await this.link(body as unknown as LinkRequest);
        return new Response(null, { status: 204 });
      case "/unlink":
        await this.forget(body.userId as string);
        return new Response(null, { status: 204 });
      case "/webhook":
        return Response.json({ status: await this.applyWebhook(body.deliveryId as string, body.plan as EventPlan) });
      default:
        return new Response(null, { status: 404 });
    }
  }

  // ---- Authorization -------------------------------------------------------

  /**
   * `RepoPermissionSource.authorize`: the repository when `viewer` may read it now, null otherwise,
   * `RepoAccessUnavailable` when unknown. Every answer is decided from storage alone (`decide` awaits
   * nothing else, so no webhook can interleave). When the answer needs GitHub first, that work runs and
   * the decision is taken again from what storage holds afterwards, a bounded number of times.
   */
  async authorize(viewer: string | null, owner: string, name: string): Promise<RepoRecord | null> {
    try {
      // Set once GitHub could not confirm a public record: it grants until PUBLIC_CONFIRM_MAX_MS, still decided from storage.
      let unconfirmed = false;
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const decision = await this.decide(viewer, owner, name, unconfirmed);
        if ("answer" in decision) return decision.answer;
        try {
          await this.perform(viewer as string, decision.need);
        } catch (error) {
          const { need } = decision;
          if (need.kind !== "visibility" || this.deps.now() - (need.entry.confirmedAt ?? 0) >= PUBLIC_CONFIRM_MAX_MS) throw error;
          this.deps.log("access.visibility-unconfirmed", { reason: error instanceof GitHubError ? error.kind : "unavailable" });
          unconfirmed = true;
        }
      }
      // Webhooks kept changing the answer while GitHub was asked: unknown for now.
      throw new RepoAccessUnavailable();
    } catch (error) {
      if (!(error instanceof RepoAccessUnavailable)) this.deps.log("access.unavailable", { reason: error instanceof GitHubError ? error.kind : "error" });
      throw new RepoAccessUnavailable();
    }
  }

  /** A name's registry records, if it names a live repository of a known installation. Storage reads only. */
  private async lookup(owner: string, name: string): Promise<{ entry: RepoEntry; installation: InstallationEntry } | null> {
    const key = repoKey(owner, name);
    const id = await this.storage.get<number>(`name:${key}`);
    const entry = id === undefined ? undefined : await this.storage.get<RepoEntry>(`repo:${id}`);
    if (!entry || entry.removed || entry.installation === null || repoKey(entry.owner, entry.name) !== key) return null;
    const installation = await this.storage.get<InstallationEntry>(`inst:${entry.installation}`);
    return installation ? { entry, installation } : null;
  }

  private async decide(viewer: string | null, owner: string, name: string, unconfirmed = false): Promise<Decision> {
    const found = await this.lookup(owner, name);
    if (found) {
      const { entry, installation } = found;
      if (installation.check) return { need: { kind: "installation", entry: installation } };
      if (installation.state !== "active") return { answer: null };
      // An anonymous reader is denied a repository recorded as private without asking GitHub: a check could only deny them too.
      if (viewer === null && entry.private) return { answer: null };
      if (entry.check || entry.defaultBranch === null) return { need: { kind: "repo", entry } };
      if (!entry.private) {
        // A `privatized` delivery can be missed: public is only as current as GitHub's last word on it.
        const age = this.deps.now() - (entry.confirmedAt ?? 0);
        if (age >= PUBLIC_CONFIRM_TTL_MS && !(unconfirmed && age < PUBLIC_CONFIRM_MAX_MS)) return { need: { kind: "visibility", entry } };
        return { answer: repoRecord(entry) };
      }
    }
    if (viewer === null) return { answer: null };
    const user = await this.user(viewer);
    if (!user?.tokens) return { answer: null };
    const mirror = await this.storage.get<Mirror>(`mirror:${viewer}`);
    // A stale mirror is refreshed first, even for an unknown name: the listing may teach the registry a repository no webhook announced.
    if (!mirror || mirror.gen !== user.gen || this.deps.now() - mirror.fetchedAt >= MIRROR_TTL_MS) return { need: { kind: "mirror", user } };
    if (!found) return { answer: null };
    const { entry } = found;
    if (mirrorIds(mirror).has(entry.id)) return { answer: repoRecord(entry) };
    if (!mirror.partial.includes(entry.installation as number)) return { answer: null };
    // The installation was listed only in part: GitHub answers for this one repository, kept as long as a mirror.
    const cached = await this.storage.get<ReaderCheck>(`check:${viewer}:${entry.id}`);
    if (cached && cached.gen === user.gen && this.deps.now() - cached.at < MIRROR_TTL_MS) return { answer: cached.allowed ? repoRecord(entry) : null };
    return { need: { kind: "reader", user, entry } };
  }

  /** The GitHub work a decision needs. Results an event overtook meanwhile are dropped, and the next decision sees why. */
  private async perform(viewer: string, need: Need): Promise<void> {
    switch (need.kind) {
      case "installation":
        return this.checkInstallation(need.entry);
      case "repo":
      case "visibility":
        return this.checkRepo(need.entry);
      case "mirror":
        await this.refreshMirror(viewer, need.user);
        return;
      default:
        return this.checkReader(viewer, need.user, need.entry);
    }
  }

  private async checkReader(userId: string, user: UserEntry, entry: RepoEntry): Promise<void> {
    const installation = entry.installation as number;
    const key = `check:${userId}:${entry.id}`;
    const allowed = await this.guarded(key, () => this.asInstallation(installation, (token) => this.deps.github.canRead(`installation:${installation}`, token, entry.owner, entry.name, user.login)));
    if ((await this.user(userId))?.gen === user.gen) await this.storage.put(key, { allowed, at: this.deps.now(), gen: user.gen } satisfies ReaderCheck);
  }

  private async checkInstallation(entry: InstallationEntry): Promise<void> {
    const active = await this.guarded(`inst:${entry.id}`, () => this.asInstallation(entry.id, (token) => this.deps.github.installationActive(`installation:${entry.id}`, token)));
    const current = await this.storage.get<InstallationEntry>(`inst:${entry.id}`) as InstallationEntry;
    // An event landed while GitHub answered: its state wins.
    if (current.seq !== entry.seq) return;
    await this.storage.put(`inst:${entry.id}`, { ...current, state: active ? "active" : "suspended", check: false } satisfies InstallationEntry);
    // Confirmed suspended: its repositories stop being publicly served, even without a webhook (#242).
    if (!active && current.state === "active") await this.enqueueInstallationVisibilityEpochs(entry.id);
  }

  private async checkRepo(entry: RepoEntry): Promise<void> {
    const installation = entry.installation as number;
    // The fields GitHub answered with last time, so an unchanged repository is a free 304.
    const cached = entry.etag && entry.defaultBranch !== null ? { ...repoRecord(entry), etag: entry.etag } : null;
    const repo = await this.guarded(`repo:${entry.id}`, () => this.asInstallation(installation, (token) => this.deps.github.repository(`installation:${installation}`, token, entry.owner, entry.name, cached)));
    const current = await this.storage.get<RepoEntry>(`repo:${entry.id}`) as RepoEntry;
    if (current.seq !== entry.seq) return;
    // Not visible to the installation (or now another repository under that name): nobody reads it through the app.
    if (!repo || repo.id !== entry.id) {
      await this.putRepo({ ...current, removed: true, check: false, etag: null }, current);
    } else {
      await this.putRepo({
        ...current, owner: repo.owner, name: repo.name, private: repo.private, defaultBranch: repo.defaultBranch, removed: false, check: false,
        confirmedAt: this.deps.now(), etag: repo.etag,
      }, current);
      // GitHub answered for this very repository: a purge pending from an earlier removal (a reinstall since, or a replay) is cancelled.
      await this.restoreRemoved(entry.id);
    }
    // Found invisible without an event (a missed `privatized` delivery): its visibility epoch is written now, as that delivery's would be.
    if (await this.storage.get(`pending-repo:${entry.id}`) !== undefined) await this.flushEpochs();
  }

  private async asInstallation<T>(installation: number, call: (token: string | null) => Promise<T>): Promise<T> {
    const tokens = this.deps.installationTokens;
    try {
      return await call(await tokens.token(installation));
    } catch (error) {
      // Installation tokens rotate hourly: one retry with a fresh one.
      if (!(error instanceof GitHubError && error.kind === "unauthorized")) throw error;
      tokens.invalidate(installation);
      return call(await tokens.token(installation));
    }
  }

  /** Fail fast for a few seconds after a failure, so an outage is not hammered by retrying readers. */
  private async guarded<T>(key: string, work: () => Promise<T>): Promise<T> {
    if ((this.failures.get(key) ?? 0) > this.deps.now()) throw new RepoAccessUnavailable();
    try {
      return await work();
    } catch (error) {
      // A race lost to a webhook is not GitHub failing: the next request may try again at once.
      if (!(error instanceof RepoAccessUnavailable)) {
        const now = this.deps.now();
        // Entries are kept in expiry order: drop the expired ones from the front, so the map holds only live cooldowns.
        for (const [old, until] of this.failures) {
          if (until > now) break;
          this.failures.delete(old);
        }
        this.failures.delete(key);
        this.failures.set(key, now + FAILURE_COOLDOWN_MS);
      }
      throw error;
    }
  }

  // ---- The mirror ----------------------------------------------------------

  private user(userId: string): Promise<UserEntry | undefined> {
    return this.storage.get<UserEntry>(`user:${userId}`);
  }

  private refreshMirror(userId: string, user: UserEntry): Promise<Mirror | null> {
    // One refresh per user and generation; one from before an invalidation is never joined.
    const running = this.refreshing.get(userId);
    if (running?.gen === user.gen) return running.promise;
    const promise = this.guarded(`user:${userId}`, () => this.refresh(userId, user)).finally(() => {
      if (this.refreshing.get(userId)?.promise === promise) this.refreshing.delete(userId);
    });
    this.refreshing.set(userId, { gen: user.gen, promise });
    return promise;
  }

  /** List what GitHub shows the user now, then commit it unless their access changed meanwhile. Null when the user has no usable tokens. */
  private async refresh(userId: string, before: UserEntry): Promise<Mirror | null> {
    const start = await this.storage.get<number>("seq") ?? 0;
    let listing: Listing;
    try {
      listing = await this.list(userId, before);
    } catch (error) {
      if (!(error instanceof TokensRejected)) throw error;
      this.deps.log("access.tokens-rejected", { revoked: true });
      await this.forget(userId);
      return null;
    }
    const user = await this.user(userId);
    // Invalidated (or unlinked) while GitHub answered: this listing may predate the change, so it is not committed.
    if (user?.gen !== before.gen) return null;
    return this.commit(userId, user, start, listing);
  }

  private async list(userId: string, user: UserEntry): Promise<Listing> {
    const previous = await this.storage.get<Mirror>(`mirror:${userId}`) ?? null;
    const budget = `user:${userId}`;
    let token = await this.accessToken(userId, user);
    let renewed = false;
    const unauthorized = (error: unknown) => error instanceof GitHubError && error.kind === "unauthorized";
    const call = async <T>(request: () => Promise<T>): Promise<T> => {
      try {
        return await request();
      } catch (error) {
        if (!unauthorized(error)) throw error;
        // Refused once: renew and retry. Refused again with a fresh token: the authorization is gone.
        if (renewed) throw new TokensRejected();
        renewed = true;
        // GitHub refused the token outright: a current one must come from a real renewal.
        token = await this.renewAccessToken(userId, true);
        try {
          return await request();
        } catch (retryError) {
          throw unauthorized(retryError) ? new TokensRejected() : retryError;
        }
      }
    };
    const listing: Listing = { installationPages: [], repoPages: {}, partial: [], installations: [], repos: [] };
    const pages = async <T>(cached: PageCache[] | undefined, limit: number, fetchPage: (page: number, etag: string | null) => Promise<Page<T>>, idOf: (item: T) => number, collect: (items: T[]) => void) => {
      const out: PageCache[] = [];
      for (let page = 1; page <= limit; page += 1) {
        const before = cached?.[page - 1];
        const result = await call(() => fetchPage(page, before?.etag ?? null));
        const current = result ? { etag: result.etag, ids: result.items.map(idOf), next: result.next } : before as PageCache;
        if (result) collect(result.items);
        out.push(current);
        if (!current.next) break;
      }
      return out;
    };
    listing.installationPages = await pages(previous?.installationPages, MAX_INSTALLATION_PAGES,
      (page, etag) => this.deps.github.userInstallations(budget, token, page, etag), (item) => item.id, (items) => listing.installations.push(...items));
    let budgetPages = MAX_REPOSITORY_PAGES;
    const suspended = new Set(listing.installations.filter((installation) => installation.suspended).map((installation) => installation.id));
    for (const installation of pageIds(listing.installationPages)) {
      // A suspended installation grants nothing; listing it could only fail.
      if (suspended.has(installation)) continue;
      const repoPages = budgetPages > 0 ? await pages(previous?.repoPages[installation], budgetPages,
        (page, etag) => this.deps.github.installationRepositories(budget, token, installation, page, etag), (item) => item.id,
        (items) => listing.repos.push(...items.map((item) => ({ ...item, installation })))) : [];
      budgetPages -= repoPages.length;
      listing.repoPages[installation] = repoPages;
      if (repoPages.length === 0 || repoPages[repoPages.length - 1].next) listing.partial.push(installation);
    }
    return listing;
  }

  /** The user's access token, renewed first when it is about to expire. */
  private async accessToken(userId: string, user: UserEntry): Promise<string> {
    const tokens = await openTokens(this.deps.tokenKey, userId, user.tokens as string);
    if (expiring(tokens, this.deps.now())) return this.renewAccessToken(userId);
    return tokens.accessToken;
  }

  /** One renewal per user at a time: GitHub rotates the refresh token, so a second concurrent use would look revoked. */
  private renewAccessToken(userId: string, force = false): Promise<string> {
    let renewal = this.renewing.get(userId);
    if (!renewal) {
      renewal = this.renew(userId, force).finally(() => this.renewing.delete(userId));
      this.renewing.set(userId, renewal);
    }
    return renewal;
  }

  private async renew(userId: string, force: boolean): Promise<string> {
    const user = await this.user(userId);
    if (!user?.tokens) throw new TokensRejected();
    const tokens = await openTokens(this.deps.tokenKey, userId, user.tokens);
    // A renewal that just completed already rotated the tokens: the snapshot that sent us here was
    // stale. The current access token is served without spending a second OAuth renewal on it.
    if (!force && !expiring(tokens, this.deps.now())) return tokens.accessToken;
    if (!tokens.refreshToken || (tokens.refreshTokenExpiresAt !== null && tokens.refreshTokenExpiresAt <= this.deps.now())) throw new TokensRejected();
    const result = await this.deps.refresher.refresh(tokens.refreshToken);
    const current = await this.user(userId);
    // Replaced or dropped meanwhile (a new sign-in, a revocation): this renewal is moot.
    if (current?.tokenVersion !== user.tokenVersion) throw new RepoAccessUnavailable();
    if (result.kind === "rejected") throw new TokensRejected();
    await this.storage.put(`user:${userId}`, { ...current, tokens: await sealTokens(this.deps.tokenKey, userId, result.tokens) });
    return result.tokens.accessToken;
  }

  /** Write the listing: registry first, then who holds what, then the mirror. Records an event changed after `start` keep the event's version. */
  private async commit(userId: string, user: UserEntry, start: number, listing: Listing): Promise<Mirror> {
    for (const installation of listing.installations) {
      const existing = await this.storage.get<InstallationEntry>(`inst:${installation.id}`);
      if (existing && existing.seq > start) continue;
      await this.storage.put(`inst:${installation.id}`, { id: installation.id, account: installation.account, state: installation.suspended ? "suspended" : "active", check: false, seq: existing?.seq ?? 0 } satisfies InstallationEntry);
    }
    const now = this.deps.now();
    for (const repo of listing.repos) {
      const existing = await this.storage.get<RepoEntry>(`repo:${repo.id}`);
      if (existing && existing.seq > start) continue;
      const fields = { id: repo.id, owner: repo.owner, name: repo.name, private: repo.private, defaultBranch: repo.defaultBranch, installation: repo.installation, removed: false, check: false };
      const same = existing !== undefined && (Object.keys(fields) as Array<keyof typeof fields>).every((key) => existing[key] === fields[key]);
      // The listing is GitHub's word on visibility too; an unchanged record is rewritten only to renew a public one's confirmation.
      if (same && (fields.private || now - (existing.confirmedAt ?? 0) < PUBLIC_CONFIRM_TTL_MS)) continue;
      await this.putRepo({ ...fields, seq: existing?.seq ?? 0, confirmedAt: now, etag: same ? existing.etag ?? null : null }, existing);
    }
    const previous = await this.storage.get<Mirror>(`mirror:${userId}`) ?? null;
    const mirror: Mirror = { gen: user.gen, fetchedAt: this.deps.now(), installationPages: listing.installationPages, repoPages: listing.repoPages, partial: listing.partial };
    // Holdings before the mirror: whoever a mirror lets read a repository can be found when it must be revoked.
    await this.replaceHoldings(userId, previous, mirror);
    await this.storage.put(`mirror:${userId}`, mirror);
    this.deps.log("access.refresh", { installations: mirrorInstallations(mirror).size, repositories: mirrorIds(mirror).size, partial: mirror.partial.length });
    return mirror;
  }

  private async replaceHoldings(userId: string, previous: Mirror | null, next: Mirror | null): Promise<void> {
    const [before, after] = [mirrorIds(previous), mirrorIds(next)];
    const [installationsBefore, installationsAfter] = [mirrorInstallations(previous), mirrorInstallations(next)];
    for (const id of after) if (!before.has(id)) await this.storage.put(`holder:${id}:${userId}`, 1);
    for (const id of installationsAfter) if (!installationsBefore.has(id)) await this.storage.put(`member:${id}:${userId}`, 1);
    const gone = [...before].filter((id) => !after.has(id)).map((id) => `holder:${id}:${userId}`)
      .concat([...installationsBefore].filter((id) => !installationsAfter.has(id)).map((id) => `member:${id}:${userId}`));
    if (gone.length) await this.storage.delete(gone);
  }

  private async putRepo(entry: RepoEntry, previous: RepoEntry | undefined): Promise<void> {
    await this.storage.put(`repo:${entry.id}`, entry);
    // A repository that just became invisible stops being publicly served (#242): the serving
    // Worker re-checks the visibility epoch in every signed shared-cache URL against this one.
    if ((entry.private || entry.removed) && !(previous && (previous.private || previous.removed))) {
      await this.enqueueVisibilityEpoch(entry.id);
    }
    // A tombstone never takes a name: a stale removal must not shadow the repository that owns the name now.
    if (entry.removed) return;
    const [before, after] = [previous ? repoKey(previous.owner, previous.name) : null, repoKey(entry.owner, entry.name)];
    if (before !== null && before !== after && await this.storage.get<number>(`name:${before}`) === entry.id) await this.storage.delete([`name:${before}`]);
    // The newest repository to take a name owns it (a deleted repository's name can be reused).
    if (before !== after || await this.storage.get<number>(`name:${after}`) !== entry.id) await this.storage.put(`name:${after}`, entry.id);
  }

  // ---- Accounts (P1 hands these over at sign-in) ---------------------------

  async link(request: LinkRequest): Promise<void> {
    const { userId, githubId, login, tokens } = request;
    const owner = await this.storage.get<string>(`gh:${githubId}`);
    // One GitHub account belongs to one Rendro user.
    if (owner !== undefined && owner !== userId) await this.forget(owner);
    const existing = await this.user(userId);
    if (existing && existing.githubId !== githubId) await this.forget(userId);
    const current = await this.user(userId);
    await this.storage.put(`user:${userId}`, {
      githubId, login, tokens: await sealTokens(this.deps.tokenKey, userId, tokens),
      tokenVersion: (current?.tokenVersion ?? 0) + 1, gen: (current?.gen ?? 0) + 1,
    } satisfies UserEntry);
    await this.storage.put(`gh:${githubId}`, userId);
    // Capabilities minted before this sign-in are decided again.
    await this.enqueueRevocations([userId]);
  }

  /** Drop a user's tokens and mirror (sign-out of GitHub, revoked authorization, refused tokens), then revoke what they hold. */
  async forget(userId: string): Promise<void> {
    const user = await this.user(userId);
    if (!user) return;
    await this.storage.put(`user:${userId}`, { ...user, tokens: null, tokenVersion: user.tokenVersion + 1, gen: user.gen + 1 } satisfies UserEntry);
    if (await this.storage.get<string>(`gh:${user.githubId}`) === userId) await this.storage.delete([`gh:${user.githubId}`]);
    await this.replaceHoldings(userId, await this.storage.get<Mirror>(`mirror:${userId}`) ?? null, null);
    await this.storage.delete([`mirror:${userId}`]);
    await this.enqueueRevocations([userId]);
  }

  // ---- Webhooks ------------------------------------------------------------

  /** Apply one verified delivery: registry, then mirrors, then the epoch outbox. Redeliveries of a settled delivery do nothing. */
  async applyWebhook(deliveryId: string, plan: EventPlan): Promise<"applied" | "duplicate"> {
    if (await this.deliveries.seen(deliveryId)) return "duplicate";
    const seq = (await this.storage.get<number>("seq") ?? 0) + 1;
    await this.storage.put("seq", seq);
    if (plan.installation) {
      const { id, account, state } = plan.installation;
      const existing = await this.storage.get<InstallationEntry>(`inst:${id}`);
      await this.storage.put(`inst:${id}`, { id, account: account ?? existing?.account ?? null, state, check: state === "active", seq } satisfies InstallationEntry);
      // Suspended or deleted: its repositories stop being publicly served (#242).
      if (state !== "active") await this.enqueueInstallationVisibilityEpochs(id);
    }
    if (plan.repos) for (const hint of plan.repos.hints) await this.applyRepoChange(plan.repos.change, hint, plan.repos.installation, seq);
    if (plan.renameOwner) await this.renameOwner(plan.renameOwner.from, plan.renameOwner.to, seq);
    if (this.deps.comments || this.deps.content) await this.enqueueRemovals(plan);

    const affected = new Set<string>();
    for (const githubId of [...plan.users ?? [], ...plan.unauthorize === undefined ? [] : [plan.unauthorize]]) {
      const userId = await this.storage.get<string>(`gh:${githubId}`);
      if (userId !== undefined) affected.add(userId);
    }
    for (const repoId of plan.holders ?? []) for (const key of (await this.storage.list({ prefix: `holder:${repoId}:` })).keys()) affected.add(key.slice(`holder:${repoId}:`.length));
    if (plan.installationUsers !== undefined) {
      const prefix = `member:${plan.installationUsers}:`;
      for (const key of (await this.storage.list({ prefix })).keys()) affected.add(key.slice(prefix.length));
    }
    for (const userId of affected) {
      if (plan.unauthorize !== undefined) await this.forget(userId);
      else await this.invalidate(userId);
    }
    if (plan.revoke && affected.size) await this.enqueueRevocations(affected);
    await this.deliveries.remember(deliveryId, this.deps.now());
    await this.flushEpochs();
    this.deps.log("access.webhook", { users: affected.size, revoke: plan.revoke });
    return "applied";
  }

  private async applyRepoChange(change: "confirm" | "privatize" | "remove", hint: RepoHint, installation: number | null, seq: number): Promise<void> {
    const existing = await this.storage.get<RepoEntry>(`repo:${hint.id}`);
    if (change === "privatize" && !existing) return;
    const base: RepoEntry = existing ?? { id: hint.id, owner: hint.owner, name: hint.name, private: true, defaultBranch: null, installation, removed: true, check: true, seq };
    // A payload is not a repository read: its fields no longer match the stored ETag.
    const entry: RepoEntry = change === "confirm"
      ? { ...base, owner: hint.owner, name: hint.name, private: hint.private ?? base.private, installation: installation ?? base.installation, removed: false, check: true, seq, etag: null }
      : change === "privatize" ? { ...base, private: true, seq, etag: null } : { ...base, removed: true, seq, etag: null };
    await this.putRepo(entry, existing);
  }

  private async renameOwner(from: string, to: string, seq: number): Promise<void> {
    for (const entry of (await this.storage.list<RepoEntry>({ prefix: "repo:" })).values()) {
      if (entry.owner.toLowerCase() === from.toLowerCase()) await this.putRepo({ ...entry, owner: to, check: true, seq, etag: null }, entry);
    }
  }

  private async invalidate(userId: string): Promise<void> {
    const user = await this.user(userId) as UserEntry;
    await this.storage.put(`user:${userId}`, { ...user, gen: user.gen + 1 });
    this.failures.delete(`user:${userId}`);
  }

  // ---- Epochs --------------------------------------------------------------

  /** Repositories that just became invisible: one outbox entry per repository, flushed like the user epochs. */
  private async enqueueVisibilityEpoch(repoId: number): Promise<void> {
    await this.storage.put(`pending-repo:${repoId}`, 1);
    await this.arm(this.deps.now());
  }

  /** Every repository of an installation that stopped being active stops being publicly served (#242). */
  private async enqueueInstallationVisibilityEpochs(installationId: number): Promise<void> {
    for (const entry of (await this.storage.list<RepoEntry>({ prefix: "repo:" })).values()) {
      if (entry.installation === installationId) await this.enqueueVisibilityEpoch(entry.id);
    }
  }

  /** Repositories that left the app with this delivery: removed ones, and every one of a deleted installation. */
  private async enqueueRemovals(plan: EventPlan): Promise<void> {
    const removed = new Set(plan.repos?.change === "remove" ? plan.repos.hints.map(hint => hint.id) : []);
    if (plan.installation?.state === "deleted") {
      for (const entry of (await this.storage.list<RepoEntry>({ prefix: "repo:" })).values()) {
        if (entry.installation === plan.installation.id) removed.add(entry.id);
      }
    }
    const dueAt = this.deps.now() + REMOVAL_PURGE_DELAY_MS;
    for (const repoId of removed) {
      // Convex hides the comments at once (its outbox); content waits for the purge like comments do.
      if (this.deps.comments) {
        await this.storage.put(`removed:${repoId}`, 1);
        await this.storage.delete([`restore:${repoId}`]);
      }
      // A purge already pending keeps its time: a repeated removal never extends the window.
      if (await this.storage.get(`purging:${repoId}`) === undefined) await this.schedulePurge(repoId, dueAt, 0);
    }
    if (removed.size) await this.arm(this.deps.now());
  }

  private async enqueueRevocations(userIds: Iterable<string>): Promise<void> {
    const marker = crypto.randomUUID();
    for (const userId of userIds) await this.storage.put(`pending:${userId}`, marker);
    // The alarm writes them even if this request never gets to.
    await this.arm(this.deps.now());
  }

  private arm(at: number): Promise<void> {
    this.armed = at;
    return this.storage.setAlarm(at);
  }

  /** Write pending epochs, one pass at a time, so a user's epochs only ever grow. */
  flushEpochs(): Promise<void> {
    const pass = this.epochChain.then(() => this.flushOnce());
    this.epochChain = pass.catch(() => {});
    return pass;
  }

  async alarm(): Promise<void> {
    // The alarm that woke us is spent: anything armed from here on is newer.
    this.armed = null;
    await this.flushEpochs();
    const next = await this.purgeDue();
    if (next !== null && (this.armed === null || next < this.armed)) await this.arm(next);
  }

  private async flushOnce(): Promise<void> {
    const pending = [...(await this.storage.list<string>({ prefix: "pending:", limit: EPOCH_BATCH })).entries()];
    let failed = 0;
    await eachLimit(pending, EPOCH_CONCURRENCY, async ([key, marker]) => {
      const userId = key.slice("pending:".length);
      try {
        // A time, never an increment: it is the order of writes, not their count, that revokes.
        const epoch = Math.max(this.deps.now(), (await this.storage.get<number>(`epoch:${userId}`) ?? 0) + 1);
        await this.deps.epochs.put(`${USER_EPOCH_KEY_PREFIX}${userId}`, String(epoch), { expirationTtl: EPOCH_TTL_SECONDS });
        await this.storage.put(`epoch:${userId}`, epoch);
        // Pages are revoked; comments follow from their own outbox entry, so a Convex outage never rewrites KV.
        if (this.deps.comments) await this.storage.put(`notify:${userId}`, epoch);
        // Re-queued meanwhile: leave it for the next pass.
        if (await this.storage.get(key) === marker) await this.storage.delete([key]);
      } catch {
        failed += 1;
      }
    });
    const [repoFailed, repoFull] = await this.flushRepoEpochs();
    const [notified, notifyFull] = await this.flushComments();
    if (failed || notified || repoFailed) {
      if (failed || repoFailed) this.deps.log("access.epochs-failed", { failed: failed + repoFailed });
      await this.arm(this.deps.now() + EPOCH_RETRY_MS);
    } else if (pending.length === EPOCH_BATCH || repoFull || notifyFull) {
      await this.arm(this.deps.now());
    }
  }

  /**
   * Write pending visibility epochs. Unlike a user's epoch, the entry never expires: it must
   * outlive every signed shared-cache URL (a year), and reverting to 0 would revive old URLs.
   */
  private async flushRepoEpochs(): Promise<[number, boolean]> {
    const pending = [...(await this.storage.list<number>({ prefix: "pending-repo:", limit: EPOCH_BATCH })).entries()];
    let failed = 0;
    await eachLimit(pending, EPOCH_CONCURRENCY, async ([key, marker]) => {
      const repoId = Number(key.slice("pending-repo:".length));
      try {
        await this.deps.epochs.put(`${VISIBILITY_EPOCH_KEY_PREFIX}${repoId}`, String(this.deps.now()), {});
        // Re-queued meanwhile: leave it for the next pass.
        if (await this.storage.get(key) === marker) await this.storage.delete([key]);
      } catch {
        failed += 1;
      }
    });
    return [failed, pending.length === EPOCH_BATCH];
  }

  /** Tell Convex about written epochs, removed and restored repositories. Returns the failures and whether a batch was full. */
  private async flushComments(): Promise<[number, boolean]> {
    const sink = this.deps.comments;
    if (!sink) return [0, false];
    let failed = 0;
    const notify = [...(await this.storage.list<number>({ prefix: "notify:", limit: EPOCH_BATCH })).entries()];
    await eachLimit(notify, EPOCH_CONCURRENCY, async ([key, epoch]) => {
      try {
        await sink.revoke(key.slice("notify:".length), epoch);
        // A newer epoch written meanwhile stays for the next pass.
        if (await this.storage.get(key) === epoch) await this.storage.delete([key]);
      } catch {
        failed += 1;
      }
    });
    let full = notify.length === EPOCH_BATCH;
    const outboxes: Array<[string, (repoIds: number[]) => Promise<void>]> = [["removed:", (ids) => sink.removeRepos(ids)], ["restore:", (ids) => sink.restoreRepos(ids)]];
    for (const [prefix, send] of outboxes) {
      const keys = [...(await this.storage.list<number>({ prefix, limit: REMOVAL_BATCH })).keys()];
      if (!keys.length) continue;
      full ||= keys.length === REMOVAL_BATCH;
      try {
        await send(keys.map(key => Number(key.slice(prefix.length))));
        await this.storage.delete(keys);
      } catch {
        failed += 1;
      }
    }
    if (failed) this.deps.log("access.comments-failed", { failed });
    return [failed, full];
  }

  // ---- The purge ledger (#258) ---------------------------------------------

  private async schedulePurge(repoId: number, dueAt: number, attempts: number): Promise<void> {
    await this.cancelPurge(repoId);
    const key = purgeKey(dueAt, repoId);
    await this.storage.put(key, { repoId, dueAt, attempts } satisfies PurgeEntry);
    await this.storage.put(`purging:${repoId}`, key);
  }

  private async cancelPurge(repoId: number): Promise<void> {
    const key = await this.storage.get<string>(`purging:${repoId}`);
    if (key !== undefined) await this.storage.delete([key, `purging:${repoId}`]);
  }

  /** GitHub still grants the app this repository: cancel its pending purge and show its comments again. */
  private async restoreRemoved(repoId: number): Promise<void> {
    if (await this.storage.get(`purging:${repoId}`) === undefined) return;
    await this.cancelPurge(repoId);
    if (this.deps.comments) {
      await this.storage.delete([`removed:${repoId}`]);
      await this.storage.put(`restore:${repoId}`, 1);
    }
    this.deps.log("access.removal-reverted", { restored: 1 });
    await this.arm(this.deps.now());
  }

  /**
   * Removed repositories whose window has ended: ask GitHub, then purge, restore or postpone. Never
   * purges on doubt, and a decision an event overtook is taken again later. Returns when the next is due.
   */
  private async purgeDue(): Promise<number | null> {
    const { comments: sink, content } = this.deps;
    if (!sink && !content) return null;
    const now = this.deps.now();
    const confirmed: PurgeEntry[] = [];
    let [restored, postponed] = [0, 0];
    const postpone = async (item: PurgeEntry) => {
      postponed += 1;
      await this.schedulePurge(item.repoId, now + Math.min(PURGE_RETRY_MS * 2 ** item.attempts, PURGE_RETRY_MAX_MS), item.attempts + 1);
    };
    for (const [key, item] of await this.storage.list<PurgeEntry>({ prefix: "purge:", limit: PURGE_BATCH })) {
      if (item.dueAt > now) break;
      const entry = await this.storage.get<RepoEntry>(`repo:${item.repoId}`) as RepoEntry;
      const verdict = await confirmRemoval(this.deps, entry);
      // Cancelled or moved while GitHub answered (the repository came back meanwhile): that decision stands.
      if (await this.storage.get(`purging:${item.repoId}`) !== key) continue;
      const current = await this.storage.get<RepoEntry>(`repo:${item.repoId}`) as RepoEntry;
      // Unknown, overtaken by an event, or Convex has not heard of the removal yet: ask again later.
      if (verdict.kind === "unknown" || current.seq !== entry.seq || (sink && await this.storage.get(`removed:${item.repoId}`) !== undefined)) {
        await postpone(item);
      } else if (verdict.kind === "accessible") {
        const { repo } = verdict;
        await this.putRepo({
          ...current, owner: repo.owner, name: repo.name, private: repo.private, defaultBranch: repo.defaultBranch, removed: false, check: false,
          confirmedAt: now, etag: repo.etag,
        }, current);
        // A replayed uninstall also marked the installation deleted: GitHub decides it again on the next read.
        const installation = await this.storage.get<InstallationEntry>(`inst:${current.installation}`);
        if (installation && installation.state !== "active") await this.storage.put(`inst:${installation.id}`, { ...installation, check: true } satisfies InstallationEntry);
        await this.restoreRemoved(item.repoId);
        restored += 1;
      } else {
        confirmed.push(item);
      }
    }
    let contentPurged = 0;
    if (confirmed.length) {
      const repoIds = confirmed.map(item => item.repoId);
      // Both purges are idempotent, so a failure of either confirms with GitHub again and repeats both.
      let contentDone = !content;
      let answer: PurgeAnswer | null = null;
      try {
        if (content) await content.purge(repoIds);
        contentDone = true;
        contentPurged = content ? repoIds.length : 0;
      } catch {
        // Confirmed again on the next attempt: GitHub's answer is never reused across a delay.
      }
      try {
        if (sink) answer = await sink.purgeRepos(repoIds);
      } catch {
        // As above.
      }
      for (const item of confirmed) {
        if (await this.storage.get(`purging:${item.repoId}`) !== purgeKey(item.dueAt, item.repoId)) continue;
        const notDue = answer?.notDue.find(late => late.repoId === item.repoId);
        if (!contentDone || (sink && !answer)) await postpone(item);
        // Convex heard of the removal later than this ledger: its own window ends later.
        else if (notDue) await this.schedulePurge(item.repoId, notDue.dueAt, 0);
        else await this.cancelPurge(item.repoId);
      }
    }
    if (confirmed.length || restored || postponed) this.deps.log("access.purge", { confirmed: confirmed.length, content: contentPurged, restored, postponed });
    const [first] = (await this.storage.list<PurgeEntry>({ prefix: "purge:", limit: 1 })).values();
    return first ? first.dueAt : null;
  }
}
