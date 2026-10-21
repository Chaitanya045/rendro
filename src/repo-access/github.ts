/**
 * The GitHub endpoints the permission mirror reads (#243). User-to-server
 * tokens list what a user can read through the app's installations; an
 * installation token confirms one repository or one collaborator. Every
 * request goes through a `RateGovernor` (#229) chosen by budget: one per user
 * (user tokens share the user's own 5,000/h) and one per installation.
 */
import { isBranchName } from "@/ingest/orchestrator/keys";
import { isOwnerLogin, isRepoName } from "@/ingest/orchestrator/messages";
import { readBytes } from "@/ingest/github/http-source";
import { RateGovernor, systemClock, type Clock } from "@/ingest/github/rate-governor";
import { GitHubError } from "@/ingest/github/source";
import type { ModerationRole } from "@/repo-read/access";

export interface ListedInstallation {
  id: number;
  /** The account the app is installed on. */
  account: string;
  suspended: boolean;
}

export interface ListedRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  /** When it was last pushed to (epoch ms), where a listing says (#338): the home shows it. */
  pushedAt?: number;
  /** The listing user's moderation role on it (#259), from the `permissions` of a user-token listing; absent: none. */
  role?: ModerationRole;
}

/** A repository as `GET /repos/{owner}/{name}` answered it, with that response's validator. */
export interface ConfirmedRepo extends ListedRepo {
  etag: string | null;
}

/** A conditional read: `null` means 304, the cached page is still current (and cost no primary quota). */
export type Page<T> = { items: T[]; etag: string | null; next: boolean } | null;

export interface GitHubAccessClientOptions {
  apiOrigin?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  /** Budgets are created lazily; keep at most this many. */
  maxBudgets?: number;
  governor?: (budget: string) => RateGovernor;
  maxAttempts?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
}

const API_VERSION = "2022-11-28";
const PER_PAGE = 100;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const READ_ROLES = new Set(["admin", "maintain", "write", "triage", "read"]);

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseListedRepo(value: unknown): ListedRepo | null {
  const repo = value as { id?: unknown; name?: unknown; owner?: { login?: unknown }; private?: unknown; default_branch?: unknown } | null;
  if (!repo || !positiveId(repo.id) || !isRepoName(repo.name) || !isOwnerLogin(repo.owner?.login) || typeof repo.private !== "boolean"
    || !isBranchName(repo.default_branch)) return null;
  return { id: repo.id, owner: repo.owner.login, name: repo.name, private: repo.private, defaultBranch: repo.default_branch };
}

/**
 * The moderation role a repository's `permissions` object states for the token's user (#259). Only a literal `true`
 * counts: a missing or malformed object, or any other value, is no role.
 */
export function moderationRoleOf(permissions: unknown): ModerationRole | undefined {
  const flags = permissions as { admin?: unknown; maintain?: unknown } | null;
  if (flags === null || typeof flags !== "object") return undefined;
  if (flags.admin === true) return "admin";
  return flags.maintain === true ? "maintain" : undefined;
}

/** A listed repository, with its last push and the listing user's role when the listing has them. */
function parseListing(value: unknown): ListedRepo | null {
  const repo = parseListedRepo(value);
  if (!repo) return null;
  const { pushed_at: pushed, permissions } = value as { pushed_at?: unknown; permissions?: unknown };
  const pushedAt = typeof pushed === "string" ? Date.parse(pushed) : NaN;
  const role = moderationRoleOf(permissions);
  return { ...repo, ...Number.isSafeInteger(pushedAt) && pushedAt > 0 ? { pushedAt } : {}, ...role ? { role } : {} };
}

function parseInstallation(value: unknown): ListedInstallation | null {
  const installation = value as { id?: unknown; account?: { login?: unknown }; suspended_at?: unknown } | null;
  if (!installation || !positiveId(installation.id) || !isOwnerLogin(installation.account?.login)) return null;
  return { id: installation.id, account: installation.account.login, suspended: installation.suspended_at !== null && installation.suspended_at !== undefined };
}

function parseAll<T>(values: unknown, parse: (value: unknown) => T | null): T[] {
  if (!Array.isArray(values)) throw new GitHubError("invalid-response", "Unexpected list response");
  return values.map((value) => {
    const item = parse(value);
    if (!item) throw new GitHubError("invalid-response", "Unexpected list entry");
    return item;
  });
}

export class GitHubAccessClient {
  private readonly fetcher: typeof fetch;
  private readonly apiOrigin: string;
  private readonly clock: Clock;
  private readonly maxBudgets: number;
  private readonly createGovernor: (budget: string) => RateGovernor;
  private readonly governors = new Map<string, RateGovernor>();
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly timeoutMs: number;
  /** Requests sent, including 304s and failed attempts. */
  requests = 0;

  constructor(options: GitHubAccessClientOptions = {}) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.apiOrigin = new URL(options.apiOrigin ?? "https://api.github.com").origin;
    this.clock = options.clock ?? systemClock;
    this.maxBudgets = options.maxBudgets ?? 1_000;
    this.createGovernor = options.governor ?? (() => new RateGovernor({ clock: this.clock }));
    this.maxAttempts = options.maxAttempts ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 200;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** The budget's governor (`user:<id>` or `installation:<id>`), least recently used dropped past the cap. */
  governor(budget: string): RateGovernor {
    let governor = this.governors.get(budget);
    if (governor) this.governors.delete(budget);
    else governor = this.createGovernor(budget);
    this.governors.set(budget, governor);
    if (this.governors.size > this.maxBudgets) this.governors.delete(this.governors.keys().next().value as string);
    return governor;
  }

  /** `GET /user/installations`: this app's installations the user can reach. */
  async userInstallations(budget: string, token: string, page: number, etag: string | null): Promise<Page<ListedInstallation>> {
    const response = await this.send(budget, "user-installations", `/user/installations?per_page=${PER_PAGE}&page=${page}`, token, etag);
    if (!response) return null;
    const body = await readJson(response) as { installations?: unknown };
    return { items: parseAll(body?.installations, parseInstallation), etag: response.headers.get("etag"), next: hasNext(response) };
  }

  /** `GET /user/installations/{id}/repositories`: what the user can read through one installation. A 404 is an empty list. */
  async installationRepositories(budget: string, token: string, installationId: number, page: number, etag: string | null): Promise<Page<ListedRepo>> {
    let response: Response | null;
    try {
      response = await this.send(budget, "installation-repositories", `/user/installations/${installationId}/repositories?per_page=${PER_PAGE}&page=${page}`, token, etag);
    } catch (error) {
      // No access to the installation (left it, or it is suspended) is an empty list, never an error that blocks the user's other installations.
      if (error instanceof GitHubError && (error.kind === "not-found" || error.kind === "forbidden")) return { items: [], etag: null, next: false };
      throw error;
    }
    if (!response) return null;
    const body = await readJson(response) as { repositories?: unknown };
    return { items: parseAll(body?.repositories, parseListing), etag: response.headers.get("etag"), next: hasNext(response) };
  }

  /**
   * `GET /repos/{owner}/{name}` with an installation token, or null when the installation cannot see it.
   * With `cached` (an earlier answer and its ETag) the request is conditional: a 304, which costs no
   * primary quota, answers `cached` again.
   */
  async repository(budget: string, token: string | null, owner: string, name: string, cached: ConfirmedRepo | null = null): Promise<ConfirmedRepo | null> {
    try {
      const response = await this.send(budget, "repository", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token, cached?.etag ?? null);
      if (!response) return cached;
      const repo = parseListedRepo(await readJson(response));
      if (!repo) throw new GitHubError("invalid-response", "Unexpected repository response", response.status);
      return { ...repo, etag: response.headers.get("etag") };
    } catch (error) {
      if (error instanceof GitHubError && error.kind === "not-found") return null;
      throw error;
    }
  }

  /** `GET /installation/repositories?per_page=1`: the installation token still works (the installation exists and is not suspended). */
  async installationActive(budget: string, token: string | null): Promise<boolean> {
    try {
      const response = await this.send(budget, "installation", "/installation/repositories?per_page=1", token, null) as Response;
      await response.body?.cancel();
      return true;
    } catch (error) {
      if (error instanceof GitHubError && (error.kind === "not-found" || error.kind === "forbidden")) return false;
      throw error;
    }
  }

  /**
   * `GET /repos/{owner}/{name}/collaborators/{login}/permission`: whether `login` may read, counting teams, org and
   * enterprise grants, and the moderation role they hold (#259). The role is the response's `role_name` (the legacy
   * `permission` cannot tell maintain from write); where that is missing, only the legacy `admin` counts. A custom
   * role is none: GitHub does not say what it was derived from.
   */
  async collaboratorAccess(budget: string, token: string | null, owner: string, name: string, login: string): Promise<{ read: boolean; role: ModerationRole | null }> {
    let response: Response;
    try {
      response = await this.send(budget, "permission", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(login)}/permission`, token, null) as Response;
    } catch (error) {
      if (error instanceof GitHubError && error.kind === "not-found") return { read: false, role: null };
      throw error;
    }
    const body = await readJson(response) as { permission?: unknown; role_name?: unknown } | null;
    if (typeof body?.permission !== "string") throw new GitHubError("invalid-response", "Unexpected permission response", response.status);
    const read = READ_ROLES.has(body.permission);
    const named = typeof body.role_name === "string" ? body.role_name : body.permission;
    return { read, role: read && (named === "admin" || named === "maintain") ? named : null };
  }

  /** One request with bounded retries: a 2xx response, null for 304, or a GitHubError. Redirects are not followed. */
  private async send(budget: string, endpoint: string, path: string, token: string | null, etag: string | null): Promise<Response | null> {
    const governor = this.governor(budget);
    let url = `${this.apiOrigin}${path}`;
    let redirects = 0;
    for (let attempt = 1; ; attempt += 1) {
      const release = await governor.acquire(endpoint);
      let response: Response;
      try {
        const headers = new Headers({ accept: "application/vnd.github+json", "user-agent": "rendro-control", "x-github-api-version": API_VERSION });
        if (token) headers.set("authorization", `Bearer ${token}`);
        if (etag) headers.set("if-none-match", etag);
        response = await this.fetcher(url, { headers, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        this.requests += 1;
        if (attempt < this.maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
        throw new GitHubError("network", "GitHub request failed");
      } finally {
        release();
      }
      this.requests += 1;
      governor.observe(response.headers);
      const { status } = response;
      if (status === 304 && etag) return null;
      if (status >= 200 && status < 300) {
        governor.succeeded();
        return response;
      }
      const location = response.headers.get("location");
      if ((status === 301 || status === 307) && location && redirects < MAX_REDIRECTS) {
        // A renamed or transferred repository answers with a redirect to its new address; follow it within the API origin only.
        await response.body?.cancel();
        const target = new URL(location, url);
        if (target.origin !== this.apiOrigin) throw new GitHubError("invalid-response", "Unexpected GitHub redirect", status);
        url = target.href;
        redirects += 1;
        attempt -= 1;
        continue;
      }
      const message = await response.text().catch(() => "");
      if (status === 403 || status === 429) {
        const retryAt = governor.limited(status, response.headers, message);
        if (retryAt === null) throw new GitHubError("forbidden", "GitHub denied the request", status);
        throw new GitHubError("rate-limited", "GitHub rate limit", status, retryAt);
      }
      if (status === 401) throw new GitHubError("unauthorized", "GitHub rejected the token", status);
      if (status === 404 || status === 410) throw new GitHubError("not-found", "Not found on GitHub", status);
      if (status >= 500 && attempt < this.maxAttempts) {
        await this.backoff(attempt);
        continue;
      }
      throw new GitHubError(status >= 500 ? "server" : "invalid-response", "Unexpected GitHub response", status);
    }
  }

  private backoff(attempt: number): Promise<void> {
    const delay = this.retryBaseMs * 2 ** (attempt - 1);
    return this.clock.sleep(delay + Math.floor(Math.random() * delay));
  }
}

function hasNext(response: Response): boolean {
  return /<[^>]*>;\s*rel="next"/.test(response.headers.get("link") ?? "");
}

async function readJson(response: Response): Promise<unknown> {
  const bytes = await readBytes(response, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new GitHubError("invalid-response", "GitHub returned invalid JSON", response.status);
  }
}
