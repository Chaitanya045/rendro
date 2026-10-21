/**
 * The GitHub App's own credentials (#338): an RS256 app JWT signed with the
 * App's private key, and installation tokens minted with it
 * (`POST /app/installations/{id}/access_tokens`). They replace
 * `GITHUB_DEV_TOKEN`, which stays a development and test fallback only.
 *
 * Installation tokens live an hour. One is cached per installation until five
 * minutes before it expires, minted once at a time, and dropped when GitHub
 * refuses it. Where a store is given (the control Worker's directory), the
 * cache is also kept at rest, sealed with AES-256-GCM under a key derived from
 * `GITHUB_TOKEN_KEY` and bound to the installation; elsewhere it lives in
 * memory only. Tokens never appear in a log line or a response.
 */
import { base64url, fromBase64url } from "@/repo-read/capability";
import type { AppJwtProvider } from "./deliveries";
import { GitHubError } from "./source";
import type { InstallationTokenProvider } from "./token";

export interface GitHubAppCredentials {
  appId: string;
  /** PEM: PKCS#1 (`BEGIN RSA PRIVATE KEY`, as GitHub issues it) or PKCS#8. */
  privateKey: string;
}

/** The App's credentials when both are set, else null (the dev token, or none, is used instead). */
export function gitHubAppCredentials(appId: string | undefined, privateKey: string | undefined): GitHubAppCredentials | null {
  return appId && privateKey ? { appId, privateKey } : null;
}

const encoder = new TextEncoder();
/** An app JWT may live ten minutes; it is issued a minute in the past against clock drift, and reused for most of its life. */
const JWT_LIFETIME_S = 9 * 60;
const JWT_BACKDATE_S = 60;
const JWT_REUSE_MARGIN_MS = 60_000;
/** An installation token is renewed this long before GitHub's expiry. */
export const INSTALLATION_TOKEN_MARGIN_MS = 5 * 60_000;
/** A repository's installation is looked up again after this; at most this many are remembered. */
const INSTALLATION_LOOKUP_TTL_MS = 10 * 60_000;
const MAX_INSTALLATION_LOOKUPS = 1_000;
const API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 64 * 1024;

/** A DER element. A 2048- to 4096-bit key's parts are 256 bytes to 64 KiB long, which is exactly the two-byte length form. */
function der(tag: number, content: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + content.length);
  out.set([tag, 0x82, content.length >> 8, content.length & 0xff]);
  out.set(content, 4);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `rsaEncryption` with NULL parameters: the AlgorithmIdentifier a PKCS#8 wrapper of a PKCS#1 key carries. */
const RSA_ALGORITHM = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/** The PEM's key as PKCS#8 DER: WebCrypto imports only that, and GitHub issues PKCS#1. */
export function pkcs8FromPem(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END \1?PRIVATE KEY-----/.exec(pem.replace(/\\n/g, "\n"));
  const body = match ? fromBase64url(match[2].replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")) : null;
  if (!match || !body?.length) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const key = match[1] ? der(0x30, concat(new Uint8Array([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, body))) : body;
  return new Uint8Array(key);
}

/** Signs app JWTs (RS256, `iss` the App ID), reusing one until a minute before it expires. */
export function appJwtSigner(credentials: GitHubAppCredentials, now: () => number = Date.now): AppJwtProvider & { invalidate(): void } {
  let key: Promise<CryptoKey> | null = null;
  let cached: { jwt: string; expiresAt: number } | null = null;
  return {
    async jwt() {
      const time = now();
      if (cached && cached.expiresAt - time > JWT_REUSE_MARGIN_MS) return cached.jwt;
      key ??= crypto.subtle.importKey("pkcs8", pkcs8FromPem(credentials.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      const seconds = Math.floor(time / 1000);
      const part = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
      const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: seconds - JWT_BACKDATE_S, exp: seconds + JWT_LIFETIME_S, iss: credentials.appId })}`;
      let signature: ArrayBuffer;
      try {
        signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await key, encoder.encode(unsigned));
      } catch (error) {
        key = null;
        throw error;
      }
      cached = { jwt: `${unsigned}.${base64url(new Uint8Array(signature))}`, expiresAt: (seconds + JWT_LIFETIME_S) * 1000 };
      return cached.jwt;
    },
    invalidate() {
      cached = null;
    },
  };
}

/** Where minted tokens are kept at rest: the control Worker's directory storage. */
export interface TokenStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
}

interface Minted {
  token: string;
  expiresAt: number;
}

const keys = new Map<string, Promise<CryptoKey>>();

function sealingKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("rendro-github-installation-tokens:v1") },
        material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    })();
    keys.set(secret, key);
  }
  return key;
}

const associatedData = (installation: number) => encoder.encode(`rendro-github-installation-tokens:v1:${installation}`);

async function seal(secret: string, installation: number, minted: Minted): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: associatedData(installation) }, await sealingKey(secret), encoder.encode(JSON.stringify(minted)));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
}

/** The stored token, or null when it does not open (another key, another installation, tampering) or is malformed. */
async function open(secret: string, installation: number, sealed: unknown): Promise<Minted | null> {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  const iv = parts.length === 3 && parts[0] === "v1" ? fromBase64url(parts[1]) : null;
  const data = iv?.length === 12 ? fromBase64url(parts[2]) : null;
  if (!iv || !data) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv), additionalData: associatedData(installation) }, await sealingKey(secret), new Uint8Array(data));
    // Authenticated under our own key and this installation: it is what this module sealed.
    return JSON.parse(new TextDecoder().decode(plain)) as Minted;
  } catch {
    return null;
  }
}

export interface MintedTokenOptions {
  app: AppJwtProvider & { invalidate?(): void };
  apiOrigin?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Keep tokens at rest too, sealed under `secret` (the control Worker's `GITHUB_TOKEN_KEY`). */
  store?: { storage: TokenStore; secret: string };
  timeoutMs?: number;
}

export interface MintingTokenProvider extends InstallationTokenProvider {
  /** The App's installation on `owner/name`, or null when the App is not installed there (`GET /repos/{o}/{r}/installation`). */
  installationOf(owner: string, name: string): Promise<number | null>;
}

const storeKey = (installation: number) => `installation-token:${installation}`;
const validToken = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,512}$/.test(value);

/** Installation tokens minted from the App's JWT; see the module comment. */
export function mintedInstallationTokens(options: MintedTokenOptions): MintingTokenProvider {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const apiOrigin = new URL(options.apiOrigin ?? "https://api.github.com").origin;
  const now = options.now ?? Date.now;
  const memory = new Map<number, Minted>();
  const minting = new Map<number, Promise<string>>();
  const installations = new Map<string, { at: number; found: Promise<number | null> }>();
  const fresh = (minted: Minted | null | undefined): minted is Minted => !!minted && minted.expiresAt - now() > INSTALLATION_TOKEN_MARGIN_MS;

  async function call(method: "GET" | "POST", path: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
    // A key that does not sign is a configuration error, not GitHub failing: it propagates as it is.
    const authorization = `Bearer ${await options.app.jwt()}`;
    let response: Response;
    let text: string;
    try {
      response = await fetcher(`${apiOrigin}${path}`, {
        method, redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        headers: { accept: "application/vnd.github+json", authorization, "user-agent": "rendro", "x-github-api-version": API_VERSION },
      });
      text = await response.text();
    } catch {
      throw new GitHubError("network", "GitHub request failed");
    }
    let body: Record<string, unknown> | null;
    try { body = text.length <= MAX_RESPONSE_BYTES ? JSON.parse(text) as Record<string, unknown> : null; } catch { body = null; }
    if (response.status === 401) options.app.invalidate?.();
    return { status: response.status, body };
  }

  function failure(status: number, what: string): GitHubError {
    if (status === 404) return new GitHubError("not-found", `${what}: not found`, status);
    if (status === 401) return new GitHubError("unauthorized", `${what}: the app JWT was refused`, status);
    if (status === 403) return new GitHubError("forbidden", `${what}: forbidden`, status);
    return new GitHubError(status >= 500 ? "server" : "invalid-response", `${what}: unexpected response`, status);
  }

  async function mint(installation: number): Promise<string> {
    const stored = options.store ? await open(options.store.secret, installation, await options.store.storage.get(storeKey(installation))) : null;
    if (fresh(stored)) {
      memory.set(installation, stored);
      return stored.token;
    }
    const { status, body } = await call("POST", `/app/installations/${installation}/access_tokens`);
    // A deleted installation is a 404: removal confirmation (src/repo-access/removal.ts) takes that as proof.
    if (status !== 201) throw failure(status, "Installation token");
    const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    if (!validToken(body?.token) || !Number.isSafeInteger(expiresAt)) throw new GitHubError("invalid-response", "Installation token: unexpected response", status);
    const minted = { token: body.token, expiresAt };
    memory.set(installation, minted);
    if (options.store) await options.store.storage.put(storeKey(installation), await seal(options.store.secret, installation, minted));
    return minted.token;
  }

  return {
    async token(installation) {
      // No installation (an anonymous first view's reference): no token; installationOf can resolve it.
      if (installation === null) return null;
      const cached = memory.get(installation);
      if (fresh(cached)) return cached.token;
      let pending = minting.get(installation);
      if (!pending) {
        pending = mint(installation).finally(() => minting.delete(installation));
        minting.set(installation, pending);
      }
      return pending;
    },
    invalidate(installation) {
      if (installation === null) return;
      memory.delete(installation);
      if (options.store) void options.store.storage.delete([storeKey(installation)]).catch(() => 0);
    },
    installationOf(owner, name) {
      const key = `${owner}/${name}`.toLowerCase();
      const cached = installations.get(key);
      if (cached && now() - cached.at < INSTALLATION_LOOKUP_TTL_MS) return cached.found;
      const found = call("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`).then(({ status, body }) => {
        if (status === 404) return null;
        if (status !== 200 || !Number.isSafeInteger(body?.id) || (body?.id as number) <= 0) throw failure(status, "Repository installation");
        return body?.id as number;
      });
      // Answers are kept for a while; a failure is asked again on the next call.
      found.catch(() => installations.delete(key));
      installations.delete(key);
      installations.set(key, { at: now(), found });
      if (installations.size > MAX_INSTALLATION_LOOKUPS) installations.delete(installations.keys().next().value as string);
      return found;
    },
  };
}
