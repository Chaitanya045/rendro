import type { BetterAuthPlugin, DBAdapter, DBTransactionAdapter } from "better-auth";
import { GITHUB_HAND_OFF_HEADER, sealHandOff, type GitHubHandOff, type HandOffTokens } from "../shared/github-hand-off";

/**
 * GitHub sign-in (#338): the GitHub App's user-to-server OAuth through Better
 * Auth's GitHub provider, on only when the App's client credentials are set.
 *
 * Convex completes the OAuth exchange but never stores the user's tokens: the
 * adapter wrapper below drops them from every account write and keeps them for
 * this request only, and the hand-off plugin seals them into the callback's
 * response for the serving Worker, which forwards them to the control Worker
 * (shared/github-hand-off.ts). Better Auth builds one instance per HTTP request
 * (convex/http.ts), so the capture belongs to exactly one request.
 */

export interface GitHubSignInConfig {
  clientId: string;
  clientSecret: string;
}

/** The GitHub App's OAuth client, or null while the App is not configured (email sign-in only). */
export function githubSignInConfig(): GitHubSignInConfig | null {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * `AUTH_EMAIL_SIGN_IN=off` makes sign-in GitHub-only. It takes effect only once GitHub sign-in is
 * configured, so switching it off early never leaves an install without a way to sign in.
 */
export function emailSignInEnabled(github: GitHubSignInConfig | null): boolean {
  return github === null || process.env.AUTH_EMAIL_SIGN_IN !== "off";
}

/** The Better Auth endpoints `AUTH_EMAIL_SIGN_IN=off` turns off (404). */
export const EMAIL_SIGN_IN_PATHS = ["/sign-in/email", "/sign-up/email"];

/** What one request learned about the reader's GitHub account, until its response hands it over. */
export interface HandOffCapture {
  identity: { githubId: number; login: string } | null;
  tokens: HandOffTokens | null;
}

export function handOffCapture(): HandOffCapture {
  return { identity: null, tokens: null };
}

const GITHUB_API = "https://api.github.com";
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

async function githubJson(path: string, token: string): Promise<unknown> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "rendro", "x-github-api-version": "2022-11-28" },
    redirect: "manual",
  });
  return response.ok ? response.json().catch(() => null) : null;
}

interface GitHubEmail { email?: unknown; primary?: unknown; verified?: unknown }

/**
 * The provider's user info, from `GET /user` and `GET /user/emails` (the App's "Email addresses" read
 * permission). Only an address GitHub verified counts, the primary one first: Better Auth trusts GitHub
 * for linking (`trustedProviders`), so an unverified address must never reach it. Without one the email
 * is absent, and Better Auth refuses the sign-in (`email_not_found`) or the link (`email_doesn't_match`).
 */
export function githubUserInfo(capture: HandOffCapture) {
  return async (token: { accessToken?: string }) => {
    if (!token.accessToken) return null;
    const [profile, emails] = await Promise.all([githubJson("/user", token.accessToken), githubJson("/user/emails", token.accessToken)]);
    const user = profile as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown } | null;
    if (!user || !Number.isSafeInteger(user.id) || (user.id as number) <= 0 || typeof user.login !== "string" || !LOGIN.test(user.login)) return null;
    const verified = (Array.isArray(emails) ? emails as GitHubEmail[] : [])
      .filter((entry): entry is { email: string; primary?: unknown; verified: true } => entry?.verified === true && typeof entry.email === "string" && entry.email.length > 0);
    const email = (verified.find((entry) => entry.primary === true) ?? verified[0])?.email;
    capture.identity = { githubId: user.id as number, login: user.login };
    return {
      user: {
        id: String(user.id),
        name: typeof user.name === "string" && user.name.trim() ? user.name : user.login,
        email,
        image: typeof user.avatar_url === "string" ? user.avatar_url : undefined,
        emailVerified: email !== undefined,
      },
      data: profile,
    };
  };
}

const TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"];

function expiry(value: unknown): number | null {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : NaN;
  return Number.isSafeInteger(time) && time > 0 ? time : null;
}

/** An account write without its OAuth tokens; the access and refresh token are kept for the hand-off. */
function withoutTokens<T extends Record<string, unknown>>(data: T, capture: HandOffCapture): T {
  if (!TOKEN_FIELDS.some((field) => field in data)) return data;
  if (typeof data.accessToken === "string" && data.accessToken) {
    capture.tokens = {
      accessToken: data.accessToken,
      accessTokenExpiresAt: expiry(data.accessTokenExpiresAt),
      refreshToken: typeof data.refreshToken === "string" && data.refreshToken ? data.refreshToken : null,
      refreshTokenExpiresAt: expiry(data.refreshTokenExpiresAt),
    };
  }
  return Object.fromEntries(Object.entries(data).filter(([field]) => !TOKEN_FIELDS.includes(field))) as T;
}

/**
 * Authoritative: no account write through Better Auth's adapter, transactions included, stores an OAuth
 * token. Convex never holds a GitHub token, so nothing in Convex can call GitHub as a reader.
 */
export function withoutOAuthTokens<A extends DBAdapter | DBTransactionAdapter>(adapter: A, capture: HandOffCapture): A {
  const stripped: DBTransactionAdapter = {
    ...adapter,
    create: (data) => adapter.create(data.model === "account" ? { ...data, data: withoutTokens(data.data, capture) } : data),
    update: (data) => adapter.update(data.model === "account" ? { ...data, update: withoutTokens(data.update as Record<string, unknown>, capture) } : data),
    updateMany: (data) => adapter.updateMany(data.model === "account" ? { ...data, update: withoutTokens(data.update, capture) } : data),
  };
  if (!("transaction" in adapter)) return stripped as A;
  // As boundSessionLifetime does: adapters without transactions run the callback on themselves.
  const result: DBAdapter = { ...stripped, transaction: (callback) => adapter.transaction((trx) => callback(trx === adapter ? result : withoutOAuthTokens(trx, capture))) };
  return result as A;
}

/** The hand-off this request owes the control Worker: it signed in with, or linked, a GitHub account. */
async function pendingHandOff(capture: HandOffCapture, findAccount: (githubId: number) => Promise<{ userId: string } | null>): Promise<GitHubHandOff | null> {
  if (!capture.identity || !capture.tokens) return null;
  // The tokens were written to (and dropped from) this GitHub account's row: it names the Rendro user.
  const account = await findAccount(capture.identity.githubId);
  return account ? { userId: account.userId, ...capture.identity, tokens: capture.tokens } : null;
}

/**
 * Seals the request's hand-off into its response (`x-rendro-github-hand-off`), for the serving Worker
 * alone: it opens, strips and forwards it. Without `CONVEX_INTERNAL_SECRET` nothing is handed over.
 * (Unlinking is the serving Worker's: it drops the tokens before it forwards the unlink, src/github-hand-off.ts.)
 */
export function githubHandOff(capture: HandOffCapture, secret: string | undefined): BetterAuthPlugin {
  return {
    id: "rendro-github-hand-off",
    async onResponse(response, ctx) {
      const handOff = await pendingHandOff(capture, (githubId) => ctx.internalAdapter.findAccountByProviderId(String(githubId), "github"));
      Object.assign(capture, handOffCapture());
      if (!handOff || !secret) return;
      const headers = new Headers(response.headers);
      headers.set(GITHUB_HAND_OFF_HEADER, await sealHandOff(secret, handOff));
      return { response: new Response(response.body, { status: response.status, statusText: response.statusText, headers }) };
    },
  };
}
