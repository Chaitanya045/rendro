/**
 * Authorization for the repository read path (#234), before any private cache
 * lookup or storage read. In order:
 *
 * 1. A public repository seen in this isolate within a minute needs nothing.
 * 2. A capability cookie for this `owner/name`, signed, unexpired, bound to the
 *    request's session cookie and minted at the reader's current revocation
 *    epoch, grants without contacting anything but the epoch store. Past half
 *    its lifetime it is re-checked in the background (`waitUntil`) and the
 *    next request in this isolate carries the renewed cookie, or is denied.
 * 3. Otherwise (a miss, an expired or revoked cookie): the session, then the
 *    epoch, then the permission source. A private grant mints a new cookie.
 *
 * Denials are indistinguishable from missing repositories. "Could not check"
 * is `unavailable`, never a denial.
 */
import { cookieSite, sessionTokenCookie } from "@/viewer-ticket";
import { constantTimeEqual } from "../../shared/constant-time";
import { repoKey, type RepoPermissionSource, type RepoRecord, type RevocationEpochs } from "./access";
import { mintCapability, peekCapability, sessionBinding, verifyCapability, type CapabilityClaims } from "./capability";
import { issueGrant, type RepoGrant } from "./grant";

export type Viewer = { kind: "anonymous" } | { kind: "user"; id: string } | { kind: "unavailable"; retryAfter: string };

export interface AuthorizeDependencies {
  secret: string;
  permissions: RepoPermissionSource;
  epochs: RevocationEpochs;
  /** The signed-in user behind the request's session cookie (a Convex round trip, cached briefly). */
  identity(request: Request): Promise<Viewer>;
  now(): number;
  waitUntil(promise: Promise<unknown>): void;
}

export type Authorization =
  | { kind: "granted"; grant: RepoGrant; cookies: string[] }
  | { kind: "denied"; cookies: string[] }
  | { kind: "unavailable"; retryAfter: string };

export const CAPABILITY_TTL_SECONDS = 5 * 60;
/** An asset ticket lives no longer than the cookie it was minted under; the frame renews it halfway (#293). */
export const TICKET_TTL_SECONDS = CAPABILITY_TTL_SECONDS;
const PUBLIC_TTL_MS = 60_000;
const ANONYMOUS_DENIAL_TTL_MS = 30_000;
const REFRESH_TTL_MS = 60_000;
const MAX_ENTRIES = 1_024;
const CAPABILITY_COOKIE = /^(__Host-)?rendro-repo\.([1-9]\d{0,15})$/;

type Refreshed = { repo: RepoRecord | null; epoch: number; at: number };

const publicRepos = new Map<string, { repo: RepoRecord; until: number }>();
const anonymousDenials = new Map<string, number>();
const refreshes = new Map<string, Refreshed>();
const refreshing = new Set<string>();

export function clearAuthorizationMemory(): void {
  publicRepos.clear();
  anonymousDenials.clear();
  refreshes.clear();
  refreshing.clear();
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
}

function secureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

export function capabilityCookieName(secure: boolean, repoId: number): string {
  return `${secure ? "__Host-" : ""}rendro-repo.${repoId}`;
}

function cookieAttributes(secure: boolean, maxAge: number): string {
  return `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearCookie(secure: boolean, repoId: number): string {
  return `${capabilityCookieName(secure, repoId)}=; ${cookieAttributes(secure, 0)}`;
}

/** Capability cookies the request carries for `key`: verified ones first, plus the names of any that no longer verify. */
async function capabilityCookies(deps: AuthorizeDependencies, request: Request, key: string, session: string): Promise<{ claims: CapabilityClaims | null; stale: number[] }> {
  const secure = secureRequest(request);
  const binding = session ? await sessionBinding(deps.secret, session) : null;
  const stale: number[] = [];
  let found: CapabilityClaims | null = null;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    const match = CAPABILITY_COOKIE.exec(part.slice(0, separator).trim());
    // Over HTTPS only host-only cookies count: no sibling subdomain can plant one.
    if (separator === -1 || !match || Boolean(match[1]) !== secure) continue;
    const value = part.slice(separator + 1).trim();
    // Cookies for other repositories are left alone; unreadable ones are cleared like forged ones.
    const peeked = peekCapability(value);
    if (peeked && peeked.n !== key) continue;
    const claims = await verifyCapability(deps.secret, "cookie", value, Math.floor(deps.now() / 1000));
    if (!found && claims && claims.p && claims.r === Number(match[2]) && binding !== null && constantTimeEqual(claims.s as string, binding)) found = claims;
    else stale.push(Number(match[2]));
  }
  return { claims: found, stale };
}

async function mintCookie(deps: AuthorizeDependencies, request: Request, repo: RepoRecord, userId: string, epoch: number, session: string): Promise<string> {
  const secure = secureRequest(request);
  const issuedAt = Math.floor(deps.now() / 1000);
  const value = await mintCapability(deps.secret, "cookie", {
    u: userId, r: repo.id, n: repoKey(repo.owner, repo.name), p: true, b: repo.defaultBranch, e: epoch,
    s: await sessionBinding(deps.secret, session), i: issuedAt, x: issuedAt + CAPABILITY_TTL_SECONDS,
  });
  return `${capabilityCookieName(secure, repo.id)}=${value}; ${cookieAttributes(secure, CAPABILITY_TTL_SECONDS)}`;
}

/** Refresh results belong to one session's cookie for one repository: another session of the same user is unaffected. */
function refreshId(claims: CapabilityClaims): string {
  return `${claims.s as string}\u0000${claims.r}`;
}

/** Re-check a cookie's grant off the request path; the result serves this isolate's next request. */
function scheduleRefresh(deps: AuthorizeDependencies, request: Request, claims: CapabilityClaims, owner: string, name: string): void {
  const id = refreshId(claims);
  if (refreshing.has(id)) return;
  refreshing.add(id);
  deps.waitUntil((async () => {
    try {
      const viewer = await deps.identity(request);
      if (viewer.kind === "unavailable") return;
      const epoch = viewer.kind === "user" && viewer.id === claims.u ? await deps.epochs.currentEpoch(claims.u) : 0;
      const repo = viewer.kind === "user" && viewer.id === claims.u ? await deps.permissions.authorize(claims.u, owner, name) : null;
      remember(refreshes, id, { repo, epoch, at: deps.now() });
    } catch {
      // Unknown: the cookie stays valid until it expires, then the blocking path decides.
    } finally {
      refreshing.delete(id);
    }
  })());
}

function grantFromClaims(claims: CapabilityClaims, owner: string, name: string): RepoGrant {
  return issueGrant({ id: claims.r, owner, name, private: true, defaultBranch: claims.b }, claims.u, claims.e, claims.x * 1000);
}

/**
 * Decide whether this request may read `owner/name`. Nothing private is touched before this returns `granted`.
 * `minRemainingMs` asks for a grant that holds at least that long (comment access, #254): a memory or cookie
 * closer to its end is decided again, exactly as if it had lapsed.
 */
export async function authorizeRepo(deps: AuthorizeDependencies, request: Request, owner: string, name: string, minRemainingMs = 0): Promise<Authorization> {
  const key = repoKey(owner, name);
  const secure = secureRequest(request);
  const known = publicRepos.get(key);
  if (known && known.until > deps.now() + minRemainingMs) return { kind: "granted", grant: issueGrant(known.repo, null, 0, known.until), cookies: [] };

  const session = sessionTokenCookie(cookieSite(request.url), request.headers.get("cookie") ?? "");
  const { claims, stale } = await capabilityCookies(deps, request, key, session);
  const cookies = stale.map(repoId => clearCookie(secure, repoId));
  try {
    if (claims && claims.x * 1000 - deps.now() >= minRemainingMs && claims.e >= await deps.epochs.currentEpoch(claims.u)) {
      const nowSeconds = Math.floor(deps.now() / 1000);
      if (nowSeconds - claims.i < CAPABILITY_TTL_SECONDS / 2) return { kind: "granted", grant: grantFromClaims(claims, owner, name), cookies };
      const refreshed = refreshes.get(refreshId(claims));
      if (!refreshed || refreshed.at < claims.i * 1000 || deps.now() - refreshed.at >= REFRESH_TTL_MS) {
        scheduleRefresh(deps, request, claims, owner, name);
        return { kind: "granted", grant: grantFromClaims(claims, owner, name), cookies };
      }
      if (!refreshed.repo) return { kind: "denied", cookies: [...cookies, clearCookie(secure, claims.r)] };
      if (refreshed.repo.id === claims.r && refreshed.repo.private) {
        const renewed = await mintCookie(deps, request, refreshed.repo, claims.u, refreshed.epoch, session);
        const until = deps.now() + CAPABILITY_TTL_SECONDS * 1000;
        return { kind: "granted", grant: issueGrant(refreshed.repo, claims.u, refreshed.epoch, until), cookies: [...cookies, renewed] };
      }
      // Renamed onto another repository, or made public: decide afresh below.
    }
    if (claims) cookies.push(clearCookie(secure, claims.r));

    const deniedAt = anonymousDenials.get(key);
    if (!session && deniedAt !== undefined && deniedAt > deps.now()) return { kind: "denied", cookies };
    const viewer: Viewer = session ? await deps.identity(request) : { kind: "anonymous" };
    if (viewer.kind === "unavailable") return { kind: "unavailable", retryAfter: viewer.retryAfter };
    const userId = viewer.kind === "user" ? viewer.id : null;
    // The epoch is read before the grant: a revocation landing in between leaves the cookie already stale.
    const epoch = userId ? await deps.epochs.currentEpoch(userId) : 0;
    const repo = await deps.permissions.authorize(userId, owner, name);
    if (!repo) {
      if (!userId) remember(anonymousDenials, key, deps.now() + ANONYMOUS_DENIAL_TTL_MS);
      return { kind: "denied", cookies };
    }
    if (!repo.private) {
      const until = deps.now() + PUBLIC_TTL_MS;
      remember(publicRepos, key, { repo, until });
      return { kind: "granted", grant: issueGrant(repo, null, 0, until), cookies };
    }
    // A source that grants a private repository to nobody in particular is wrong; never serve it.
    if (!userId) return { kind: "denied", cookies };
    const cookie = await mintCookie(deps, request, repo, userId, epoch, session);
    return { kind: "granted", grant: issueGrant(repo, userId, epoch, deps.now() + CAPABILITY_TTL_SECONDS * 1000), cookies: [...cookies, cookie] };
  } catch {
    // RepoAccessUnavailable, or a failing epoch store: unknown, so retryable.
    return { kind: "unavailable", retryAfter: "1" };
  }
}

/** An asset ticket for `commit`, carried only in a private document frame's image URLs (#293). */
export async function mintTicket(deps: Pick<AuthorizeDependencies, "secret" | "now">, grant: RepoGrant, commit: string): Promise<string> {
  const issuedAt = Math.floor(deps.now() / 1000);
  return mintCapability(deps.secret, "ticket", {
    u: grant.viewer as string, r: grant.repo.id, n: repoKey(grant.repo.owner, grant.repo.name), p: true, b: grant.repo.defaultBranch,
    e: grant.epoch, c: commit, i: issuedAt, x: issuedAt + TICKET_TTL_SECONDS,
  });
}

/**
 * Requests from the opaque frame carry no cookies: the ticket alone authorizes, bounded by its lifetime and the epoch.
 * It authorizes assets only; the read path never parses a page under a ticket (#293).
 */
export async function authorizeTicket(deps: AuthorizeDependencies, ticket: string, owner: string, name: string, commit: string): Promise<Authorization> {
  const claims = await verifyCapability(deps.secret, "ticket", ticket, Math.floor(deps.now() / 1000));
  if (!claims || claims.n !== repoKey(owner, name) || claims.c !== commit || !claims.p) return { kind: "denied", cookies: [] };
  try {
    if (claims.e < await deps.epochs.currentEpoch(claims.u)) return { kind: "denied", cookies: [] };
  } catch {
    return { kind: "unavailable", retryAfter: "1" };
  }
  return { kind: "granted", grant: grantFromClaims(claims, owner, name), cookies: [] };
}
