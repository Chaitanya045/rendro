/**
 * GitHub user-to-server tokens (#243). P1's sign-in hands them to the control
 * Worker, which stores them sealed with AES-GCM under a key derived from the
 * dedicated `GITHUB_TOKEN_KEY` secret and bound to the Rendro user they belong
 * to. They are never logged and never leave the control Worker except as an
 * `Authorization` header to GitHub.
 */
import { base64url, fromBase64url } from "@/repo-read/capability";

export interface UserTokens {
  accessToken: string;
  /** Epoch milliseconds; null when the app's user tokens do not expire. */
  accessTokenExpiresAt: number | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
}

/** The key secret must carry at least 256 bits when it is hex. */
export const MIN_TOKEN_KEY_LENGTH = 32;
const MAX_TOKEN_LENGTH = 1024;
const MAX_SEALED_LENGTH = 8192;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** The sealing key: HKDF-SHA256 of the secret, imported once per isolate. */
function tokenKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("rendro-github-user-tokens:v1") },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
      );
    })();
    keys.set(secret, key);
  }
  return key;
}

function associatedData(userId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`rendro-github-user-tokens:v1:${userId}`);
}

/** The vault cannot open a sealed value: a different key, another user's value or tampering. Never a reason to allow. */
export class TokenVaultError extends Error {
  constructor() {
    super("Stored GitHub tokens cannot be opened");
    this.name = "TokenVaultError";
  }
}

function validToken(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/[\s\u0000-\u001f]/.test(value);
}

function validTime(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) > 0);
}

export function parseUserTokens(value: unknown): UserTokens | null {
  const tokens = value as Partial<Record<keyof UserTokens, unknown>> | null;
  if (!tokens || typeof tokens !== "object" || !validToken(tokens.accessToken) || !validTime(tokens.accessTokenExpiresAt)
    || !(tokens.refreshToken === null || validToken(tokens.refreshToken)) || !validTime(tokens.refreshTokenExpiresAt)) return null;
  return { accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt, refreshToken: tokens.refreshToken, refreshTokenExpiresAt: tokens.refreshTokenExpiresAt };
}

/** `v1.<base64url IV>.<base64url ciphertext>`, authenticated with the user ID, so a value moved to another user does not open. */
export async function sealTokens(secret: string, userId: string, tokens: UserTokens): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: associatedData(userId) }, await tokenKey(secret), encoder.encode(JSON.stringify(tokens)));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

export async function openTokens(secret: string, userId: string, sealed: string): Promise<UserTokens> {
  const parts = sealed.length <= MAX_SEALED_LENGTH ? sealed.split(".") : [];
  const iv = parts.length === 3 && parts[0] === "v1" ? fromBase64url(parts[1]) : null;
  const data = iv?.length === 12 ? fromBase64url(parts[2]) : null;
  if (!iv || !data) throw new TokenVaultError();
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv), additionalData: associatedData(userId) }, await tokenKey(secret), new Uint8Array(data));
  } catch {
    throw new TokenVaultError();
  }
  const tokens = parseUserTokens(JSON.parse(decoder.decode(plain)));
  if (!tokens) throw new TokenVaultError();
  return tokens;
}

export type RefreshResult = { kind: "refreshed"; tokens: UserTokens } | { kind: "rejected" };

export interface TokenRefresher {
  /**
   * Exchange a refresh token (GitHub rotates it on every use). `rejected` means
   * GitHub refused it for good (expired, revoked or already used): the user has
   * to sign in again. Throws when the answer is unknown.
   */
  refresh(refreshToken: string): Promise<RefreshResult>;
}

/** Until P1 supplies the app's client credentials: an expired token cannot be renewed, so access is unknown (503). */
export const unconfiguredRefresher: TokenRefresher = {
  refresh: () => Promise.reject(new Error("GitHub token refresh is not configured")),
};

export interface HttpTokenRefresherOptions {
  clientId: string;
  clientSecret: string;
  /** github.com; tests point it at a fake GitHub. */
  webOrigin?: string;
  fetch?: typeof fetch;
  now(): number;
  timeoutMs?: number;
}

const MAX_REFRESH_RESPONSE_BYTES = 16 * 1024;

/** GitHub's documented refresh: POST /login/oauth/access_token with grant_type=refresh_token. */
export function httpTokenRefresher(options: HttpTokenRefresherOptions): TokenRefresher {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const url = `${new URL(options.webOrigin ?? "https://github.com").origin}/login/oauth/access_token`;
  return {
    async refresh(refreshToken) {
      const response = await fetcher(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "rendro-control" },
        body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      const text = response.ok ? await response.text() : "";
      if (!response.ok || text.length > MAX_REFRESH_RESPONSE_BYTES) throw new Error(`GitHub token refresh failed (${response.status})`);
      const body = JSON.parse(text) as Record<string, unknown>;
      // GitHub answers 200 with an error code. Only a bad refresh token is final; anything else (client credentials, outages) is unknown.
      if (body.error === "bad_refresh_token") return { kind: "rejected" };
      const now = options.now();
      const seconds = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? now + (value as number) * 1000 : null;
      const tokens = parseUserTokens({
        accessToken: body.access_token, accessTokenExpiresAt: seconds(body.expires_in),
        refreshToken: body.refresh_token ?? null, refreshTokenExpiresAt: seconds(body.refresh_token_expires_in),
      });
      if (!tokens) throw new Error("GitHub token refresh answered without usable tokens");
      return { kind: "refreshed", tokens };
    },
  };
}
