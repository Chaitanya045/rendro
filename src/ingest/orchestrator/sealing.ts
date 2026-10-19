/**
 * Per-repository envelope encryption for private-repository content in R2
 * (#263, P9). R2 is a disposable cache of GitHub, but it holds copies of
 * private docs; sealing them means a leaked bucket, a leaked edge cache entry
 * or a misrouted object reveals nothing.
 *
 * - One master secret (`REPO_CONTENT_KEY`) per key generation. Each
 *   repository's data key is HKDF-SHA256 of it with the repository ID as the
 *   info, imported once per isolate; nothing per repository is stored.
 * - AES-256-GCM with a fresh 96-bit IV per object. The additional data is the
 *   envelope header, the repository ID and the object's storage key, so a blob
 *   copied to another repository or another key does not open.
 * - The header names the key that sealed the object (a key ID derived from the
 *   secret, never the secret), so a rotated key keeps opening older objects
 *   while new ones use the new key.
 *
 * Envelope (bytes): `00 52 43 53` ("\0RCS"), version `01`, key ID (8), IV (12),
 * ciphertext with its 16-byte tag. Anything else is not sealed content.
 */
import type { ContentSealer, SealScope } from "./store";
import { repoPrefix } from "./keys";

/** A key secret must carry at least 256 bits when it is hex. */
export const MIN_CONTENT_KEY_LENGTH = 32;
const MAGIC = [0x00, 0x52, 0x43, 0x53];
const VERSION = 0x01;
const KEY_ID_BYTES = 8;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES;
const MIN_ENVELOPE_BYTES = HEADER_BYTES + IV_BYTES + TAG_BYTES;
/** Data keys kept per isolate; a repository past this is derived again (one HKDF). */
const MAX_DATA_KEYS = 1_024;
const LABEL = "rendro-repo-content:v1";
const encoder = new TextEncoder();

export type SealFailure =
  /** The bytes are not an envelope: stored as is, never sealed (or replaced by someone who could write the bucket). */
  | "unsealed"
  /** Sealed under a key this Worker does not hold (a retired or misconfigured key). */
  | "unknown-key"
  /** The envelope does not authenticate: tampered, truncated, or another repository's or object's. */
  | "tampered"
  /** No valid `REPO_CONTENT_KEY`: private content can be neither written nor read. */
  | "unconfigured";

/** Private content that cannot be opened. Never served: the read path answers a retryable 503. */
export class SealedContentError extends Error {
  constructor(readonly reason: SealFailure) {
    super(`Repository content cannot be opened (${reason})`);
    this.name = "SealedContentError";
  }
}

interface MasterKey {
  id: string;
  idBytes: Uint8Array;
  material: CryptoKey;
}

const masters = new Map<string, Promise<MasterKey>>();
const dataKeys = new Map<string, Promise<CryptoKey>>();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function masterKey(secret: string): Promise<MasterKey> {
  let master = masters.get(secret);
  if (!master) {
    master = (async () => {
      const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey", "deriveBits"]);
      const id = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(LABEL), info: encoder.encode("key-id") }, material, KEY_ID_BYTES * 8));
      return { id: hex(id), idBytes: id, material };
    })();
    masters.set(secret, master);
  }
  return master;
}

function dataKey(master: MasterKey, repoId: number): Promise<CryptoKey> {
  const name = `${master.id}:${repoId}`;
  let key = dataKeys.get(name);
  if (key) {
    // Least recently used goes first.
    dataKeys.delete(name);
  } else {
    key = crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: encoder.encode(LABEL), info: encoder.encode(`repo:${repoId}`) },
      master.material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
  }
  dataKeys.set(name, key);
  if (dataKeys.size > MAX_DATA_KEYS) dataKeys.delete(dataKeys.keys().next().value as string);
  return key;
}

/** Whether `bytes` carry the envelope's magic and version (not whether they open). */
export function isSealed(bytes: Uint8Array): boolean {
  return bytes.length >= MIN_ENVELOPE_BYTES && MAGIC.every((byte, index) => bytes[index] === byte) && bytes[MAGIC.length] === VERSION;
}

/** The key ID an envelope names, or null for bytes that are not sealed. */
export function envelopeKeyId(bytes: Uint8Array): string | null {
  return isSealed(bytes) ? hex(bytes.subarray(MAGIC.length + 1, HEADER_BYTES)) : null;
}

function associatedData(header: Uint8Array, scope: SealScope): Uint8Array<ArrayBuffer> {
  const binding = encoder.encode(`\n${LABEL}\n${scope.repoId}\n${scope.key}`);
  const data = new Uint8Array(header.length + binding.length);
  data.set(header);
  data.set(binding, header.length);
  return data;
}

function requireScope(scope: SealScope): void {
  // repoPrefix validates the ID; an object outside its repository's prefix is never sealed for it.
  if (!scope.key.startsWith(repoPrefix(scope.repoId))) throw new TypeError("Sealed content must sit under its repository's prefix");
}

function validSecret(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length >= MIN_CONTENT_KEY_LENGTH;
}

/**
 * The sealer for one key generation: `current` seals, and `current` or any of
 * `previous` opens. Throws on a key shorter than 256 bits or a repeated one.
 */
export function envelopeSealer(current: string, previous: readonly string[] = []): ContentSealer {
  const secrets = [current, ...previous];
  if (!secrets.every(validSecret) || new Set(secrets).size !== secrets.length) throw new TypeError("Invalid repository content keys");
  const keyring = Promise.all(secrets.map(masterKey));
  return {
    async currentKeyId() {
      return (await keyring)[0].id;
    },
    async seal(scope, plaintext) {
      requireScope(scope);
      const master = (await keyring)[0];
      const envelope = new Uint8Array(MIN_ENVELOPE_BYTES + plaintext.length);
      envelope.set(MAGIC);
      envelope[MAGIC.length] = VERSION;
      envelope.set(master.idBytes, MAGIC.length + 1);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      envelope.set(iv, HEADER_BYTES);
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: associatedData(envelope.subarray(0, HEADER_BYTES), scope) },
        await dataKey(master, scope.repoId), plaintext as Uint8Array<ArrayBuffer>,
      );
      envelope.set(new Uint8Array(sealed), HEADER_BYTES + IV_BYTES);
      return envelope;
    },
    async open(scope, stored) {
      requireScope(scope);
      const id = envelopeKeyId(stored);
      if (id === null) throw new SealedContentError("unsealed");
      const master = (await keyring).find(candidate => candidate.id === id);
      if (!master) throw new SealedContentError("unknown-key");
      try {
        const opened = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: stored.slice(HEADER_BYTES, HEADER_BYTES + IV_BYTES), additionalData: associatedData(stored.subarray(0, HEADER_BYTES), scope) },
          await dataKey(master, scope.repoId), stored.slice(HEADER_BYTES + IV_BYTES),
        );
        return new Uint8Array(opened);
      } catch {
        throw new SealedContentError("tampered");
      }
    },
  };
}

/** Where no valid key is configured: private content is never written or read, and public content is unaffected. */
export const unconfiguredSealer: ContentSealer = {
  currentKeyId: () => Promise.reject(new SealedContentError("unconfigured")),
  seal: () => Promise.reject(new SealedContentError("unconfigured")),
  open: () => Promise.reject(new SealedContentError("unconfigured")),
};

/**
 * The sealer a Worker builds from its secrets: `REPO_CONTENT_KEY` seals, and
 * `REPO_CONTENT_KEY_PREVIOUS` (optional, during a rotation) still opens.
 * Anything invalid leaves private content unavailable rather than plaintext.
 */
export function contentSealer(current: string | undefined, previous?: string): ContentSealer {
  try {
    return envelopeSealer(current as string, previous ? [previous] : []);
  } catch {
    return unconfiguredSealer;
  }
}
