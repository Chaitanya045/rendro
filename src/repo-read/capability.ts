/**
 * Stateless repository capabilities (#234). A capability is a short-lived
 * HMAC-SHA256 token saying "user U may read repository R (named owner/name) as
 * of revocation epoch E, until X". Two purposes share the format, each under
 * its own derived key, so a token minted for one is never valid as the other:
 *
 * - `cookie`: the repo capability cookie. Bound to the reader's session cookie,
 *   so signing out or switching accounts invalidates it at once.
 * - `ticket`: the asset ticket in a private document frame's base URL. Requests
 *   made by the opaque sandbox carry no cookies, so images use this instead. It
 *   is bound to one commit.
 *
 * Format: `v1.<base64url JSON claims>.<base64url HMAC>`. The key is derived and
 * imported once per isolate; verifying costs one HMAC (microseconds) and a
 * constant-time comparison. Claims are only parsed after the signature matches.
 */
import { constantTimeEqual } from "../../shared/constant-time";

export type CapabilityPurpose = "cookie" | "ticket";

export interface CapabilityClaims {
  /** Rendro user ID. */
  u: string;
  /** GitHub repository ID. */
  r: number;
  /** Lower-cased `owner/name` the grant was made for; a rename is a cookie miss. */
  n: string;
  /** Repository visibility when granted. */
  p: boolean;
  /** Default branch when granted. */
  b: string;
  /** The user's revocation epoch read before the grant was made. */
  e: number;
  /** Issued at, seconds. */
  i: number;
  /** Expires at, seconds. */
  x: number;
  /** Cookie only: binding to the session cookie (see `sessionBinding`). */
  s?: string;
  /** Ticket only: the commit the ticket may read. */
  c?: string;
}

/** Cookies and tickets are far shorter; longer values are never parsed. */
const MAX_TOKEN_LENGTH = 2048;
/** Tolerated clock skew between isolates for `i`. */
const SKEW_SECONDS = 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importHmac(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** One derived key per secret and purpose, imported once per isolate. */
function purposeKey(secret: string, purpose: CapabilityPurpose): Promise<CryptoKey> {
  const id = `${purpose}\u0000${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = (async () => {
      const root = await importHmac(encoder.encode(secret));
      const derived = await crypto.subtle.sign("HMAC", root, encoder.encode(`rendro-repo-capability:v1:${purpose}`));
      return importHmac(new Uint8Array(derived));
    })();
    keys.set(id, key);
  }
  return key;
}

async function mac(secret: string, purpose: CapabilityPurpose, message: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await purposeKey(secret, purpose), encoder.encode(message));
  return base64url(new Uint8Array(signature));
}

export async function mintCapability(secret: string, purpose: CapabilityPurpose, claims: CapabilityClaims): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  return `v1.${payload}.${await mac(secret, purpose, `v1.${payload}`)}`;
}

/** The claims of an untrusted token, without checking its signature: only for choosing which cookie to verify. */
export function peekCapability(token: string): Pick<CapabilityClaims, "n"> | null {
  const parts = token.length <= MAX_TOKEN_LENGTH ? token.split(".") : [];
  const bytes = parts.length === 3 ? fromBase64url(parts[1]) : null;
  if (!bytes) return null;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as { n?: unknown } | null;
    return value && typeof value.n === "string" ? { n: value.n } : null;
  } catch {
    return null;
  }
}

function validClaims(value: unknown, purpose: CapabilityPurpose): value is CapabilityClaims {
  const claims = value as Partial<Record<keyof CapabilityClaims, unknown>> | null;
  return !!claims && typeof claims === "object"
    && typeof claims.u === "string" && claims.u.length > 0 && claims.u.length <= 256
    && Number.isSafeInteger(claims.r) && (claims.r as number) > 0
    && typeof claims.n === "string" && claims.n.length > 0 && claims.n.length <= 256
    && typeof claims.p === "boolean"
    && typeof claims.b === "string" && claims.b.length > 0 && claims.b.length <= 255
    && Number.isSafeInteger(claims.e) && (claims.e as number) >= 0
    && Number.isSafeInteger(claims.i) && Number.isSafeInteger(claims.x)
    && (purpose === "cookie" ? typeof claims.s === "string" && claims.s.length > 0 && claims.c === undefined
      : typeof claims.c === "string" && claims.c.length > 0 && claims.s === undefined);
}

/**
 * The claims of a token with a valid signature for `purpose` that has not
 * expired at `nowSeconds`; otherwise null. Callers still check the claims'
 * subject (repository, session binding, commit) and the epoch.
 */
export async function verifyCapability(secret: string, purpose: CapabilityPurpose, token: string, nowSeconds: number): Promise<CapabilityClaims | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const expected = await mac(secret, purpose, `v1.${parts[1]}`);
  if (!constantTimeEqual(parts[2], expected)) return null;
  const bytes = fromBase64url(parts[1]);
  if (!bytes) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!validClaims(claims, purpose)) return null;
  return claims.x > nowSeconds && claims.i <= nowSeconds + SKEW_SECONDS ? claims : null;
}

/** Binds a cookie capability to the session cookie it was minted for, without storing any session material. */
export async function sessionBinding(secret: string, sessionCookie: string): Promise<string> {
  return (await mac(secret, "cookie", `session.${sessionCookie}`)).slice(0, 22);
}
