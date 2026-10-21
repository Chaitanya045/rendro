/**
 * GitHub sign-in hands the reader's GitHub identity and user-to-server tokens
 * to the control Worker (#338). Better Auth runs in Convex, which completes the
 * OAuth exchange but never stores the tokens (convex/githubAuth.ts), and the
 * control Worker's account endpoints answer only through the serving Worker's
 * `REPO_ACCESS` service binding. So Convex seals the hand-off into one response
 * header of the OAuth callback, and the serving Worker opens
 * it, strips it before the browser sees the response, and forwards it.
 *
 * The seal is AES-256-GCM under a key derived (HKDF-SHA256) from
 * `CONVEX_INTERNAL_SECRET`, which both sides already hold, for this purpose
 * alone. Each value expires a minute after Convex sealed it.
 */

export const GITHUB_HAND_OFF_HEADER = "x-rendro-github-hand-off";
export const HAND_OFF_TTL_MS = 60_000;

export interface HandOffTokens {
  accessToken: string;
  /** Epoch milliseconds; null when the token does not expire. */
  accessTokenExpiresAt: number | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
}

export interface GitHubHandOff {
  userId: string;
  githubId: number;
  login: string;
  tokens: HandOffTokens;
}

const PURPOSE = "rendro-github-hand-off:v1";
const MAX_SEALED_LENGTH = 8192;
const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function sealingKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode(PURPOSE) },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    })();
    keys.set(secret, key);
  }
  return key;
}

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  // A length of 4n+1 is no base64 at all.
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const isTime = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) > 0);
const isText = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 1024;

function parseHandOff(value: unknown): GitHubHandOff | null {
  const body = value as Record<string, unknown> | null;
  const tokens = body?.tokens as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== "object" || !isText(body.userId) || !Number.isSafeInteger(body.githubId) || (body.githubId as number) <= 0 || !isText(body.login)
    || !tokens || typeof tokens !== "object" || !isText(tokens.accessToken) || !isTime(tokens.accessTokenExpiresAt)
    || !(tokens.refreshToken === null || isText(tokens.refreshToken)) || !isTime(tokens.refreshTokenExpiresAt)) return null;
  return {
    userId: body.userId as string, githubId: body.githubId as number, login: body.login as string,
    tokens: {
      accessToken: tokens.accessToken as string, accessTokenExpiresAt: tokens.accessTokenExpiresAt as number | null,
      refreshToken: tokens.refreshToken as string | null, refreshTokenExpiresAt: tokens.refreshTokenExpiresAt as number | null,
    },
  };
}

/** `v1.<base64url IV>.<base64url ciphertext>` of the hand-off and its expiry. */
export async function sealHandOff(secret: string, handOff: GitHubHandOff, now = Date.now()): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify({ ...handOff, exp: now + HAND_OFF_TTL_MS }));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(PURPOSE) }, await sealingKey(secret), plain);
  return `v1.${toBase64url(iv)}.${toBase64url(new Uint8Array(sealed))}`;
}

/** The hand-off, or null when the value is malformed, sealed under another key, tampered with or expired. */
export async function openHandOff(secret: string, sealed: string, now = Date.now()): Promise<GitHubHandOff | null> {
  const parts = sealed.length <= MAX_SEALED_LENGTH ? sealed.split(".") : [];
  const iv = parts.length === 3 && parts[0] === "v1" ? fromBase64url(parts[1]) : null;
  const data = iv?.length === 12 ? fromBase64url(parts[2]) : null;
  if (!iv || !data) return null;
  let body: { exp?: unknown };
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(PURPOSE) }, await sealingKey(secret), data);
    body = JSON.parse(new TextDecoder().decode(plain)) as { exp?: unknown };
  } catch {
    return null;
  }
  if (typeof body?.exp !== "number" || body.exp <= now) return null;
  return parseHandOff(body);
}
