import { describe, expect, it } from "vitest";
import { blobKey, manifestKey, renderObjectKey } from "../src/ingest/orchestrator/keys";
import { contentSealer, envelopeKeyId, envelopeSealer, isSealed, MIN_CONTENT_KEY_LENGTH, SealedContentError, unconfiguredSealer } from "../src/ingest/orchestrator/sealing";
import { toIngestError, UNREADABLE_CONTENT } from "../src/ingest/orchestrator/errors";

/** Per-repository envelope encryption of private-repository content (#263). */

const KEY = "test-content-key-a-0123456789abcdef";
const NEXT = "test-content-key-b-0123456789abcdef";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha = "a".repeat(40);
const commit = "c".repeat(40);
const scope = { repoId: 42, key: blobKey(42, sha) };
const secret = encoder.encode("# Private roadmap\n\nShip the thing.\n");

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SealedContentError);
  return (error as SealedContentError).reason;
}

describe("the content envelope", () => {
  it("round-trips, hides the plaintext and carries a fresh IV each time", async () => {
    const sealer = envelopeSealer(KEY);
    const sealed = await sealer.seal(scope, secret);
    expect(isSealed(sealed)).toBe(true);
    // Magic "\0RCS", version 1, an 8-byte key ID, a 12-byte IV, then the ciphertext and its 16-byte tag.
    expect([...sealed.subarray(0, 5)]).toEqual([0x00, 0x52, 0x43, 0x53, 0x01]);
    expect(sealed.length).toBe(secret.length + 41);
    expect(decoder.decode(sealed)).not.toContain("roadmap");
    expect(envelopeKeyId(sealed)).toBe(await sealer.currentKeyId());
    expect(await sealer.currentKeyId()).toMatch(/^[0-9a-f]{16}$/);
    const again = await sealer.seal(scope, secret);
    expect(again.subarray(13, 25)).not.toEqual(sealed.subarray(13, 25));
    expect(await sealer.open(scope, sealed)).toEqual(secret);
    expect(await sealer.open(scope, await sealer.seal(scope, new Uint8Array()))).toEqual(new Uint8Array());
  });

  it("derives one key per repository: another repository's key, or the same blob under another repository, does not open", async () => {
    const sealer = envelopeSealer(KEY);
    const sealed = await sealer.seal(scope, secret);
    // A blob copied into another repository's prefix, under the same blob SHA.
    expect(await failure(sealer.open({ repoId: 43, key: blobKey(43, sha) }, sealed))).toBe("tampered");
    // The same repository, another object: a page swapped for another page.
    expect(await failure(sealer.open({ repoId: 42, key: blobKey(42, "b".repeat(40)) }, sealed))).toBe("tampered");
    expect(await failure(sealer.open({ repoId: 42, key: manifestKey(42, commit, 2) }, sealed))).toBe("tampered");
    expect(await failure(sealer.open({ repoId: 42, key: renderObjectKey(42, `render/v2/md/${sha}/d`) }, sealed))).toBe("tampered");
    // Another master key with the same envelope header (key ID rewritten) still fails authentication.
    const other = envelopeSealer(NEXT);
    const forged = sealed.slice();
    forged.set(Buffer.from(await other.currentKeyId() as string, "hex"), 5);
    expect(await failure(other.open(scope, forged))).toBe("tampered");
  });

  it("rejects every tampered byte: header, IV, ciphertext and tag", async () => {
    const sealer = envelopeSealer(KEY);
    const sealed = await sealer.seal(scope, secret);
    for (const index of [5, 12, 13, 24, 25, 25 + Math.floor(secret.length / 2), sealed.length - 1]) {
      const tampered = sealed.slice();
      tampered[index] ^= 0x01;
      // Flipping a key-ID byte names a key this sealer does not hold.
      expect(await failure(sealer.open(scope, tampered))).toBe(index < 13 ? "unknown-key" : "tampered");
    }
    expect(await failure(sealer.open(scope, sealed.subarray(0, sealed.length - 1)))).toBe("tampered");
  });

  it("refuses bytes that are not an envelope, so plaintext in a private repository is never served", async () => {
    const sealer = envelopeSealer(KEY);
    expect(await failure(sealer.open(scope, secret))).toBe("unsealed");
    expect(await failure(sealer.open(scope, new Uint8Array(40)))).toBe("unsealed");
    const sealed = await sealer.seal(scope, secret);
    const otherVersion = sealed.slice();
    otherVersion[4] = 0x02;
    expect(isSealed(otherVersion)).toBe(false);
    expect(envelopeKeyId(otherVersion)).toBeNull();
    expect(isSealed(sealed.subarray(0, 40))).toBe(false);
    expect(await failure(sealer.open(scope, otherVersion))).toBe("unsealed");
  });

  it("seals only under the repository's own prefix", async () => {
    const sealer = envelopeSealer(KEY);
    await expect(sealer.seal({ repoId: 42, key: blobKey(43, sha) }, secret)).rejects.toThrow(TypeError);
    await expect(sealer.open({ repoId: 42, key: "gh/v1/tracked/42.json" }, secret)).rejects.toThrow(TypeError);
    await expect(sealer.seal({ repoId: 0, key: "gh/v1/repo/0/blob/x" }, secret)).rejects.toThrow(TypeError);
  });

  it("rotates through the key ID: the new key seals, the previous one still opens", async () => {
    const before = envelopeSealer(KEY);
    const old = await before.seal(scope, secret);
    const during = envelopeSealer(NEXT, [KEY]);
    expect(await during.currentKeyId()).not.toBe(await before.currentKeyId());
    expect(await during.open(scope, old)).toEqual(secret);
    const fresh = await during.seal(scope, secret);
    expect(envelopeKeyId(fresh)).toBe(await during.currentKeyId());
    // The old sealer cannot open what the new key sealed; once the previous key is dropped, old content does not open.
    expect(await failure(before.open(scope, fresh))).toBe("unknown-key");
    expect(await failure(envelopeSealer(NEXT).open(scope, old))).toBe("unknown-key");
  });

  it("keeps a bounded number of data keys per isolate", async () => {
    const sealer = envelopeSealer(KEY);
    const first = await sealer.seal(scope, secret);
    // More repositories than the per-isolate cache holds: the first repository's key is derived again.
    for (let repoId = 1_000; repoId < 2_100; repoId += 1) await sealer.seal({ repoId, key: blobKey(repoId, sha) }, secret);
    expect(await sealer.open(scope, first)).toEqual(secret);
  });

  it("refuses weak or repeated keys, and leaves private content unavailable without one", async () => {
    expect(() => envelopeSealer("short")).toThrow(TypeError);
    expect(() => envelopeSealer(KEY, [KEY])).toThrow(TypeError);
    expect(() => envelopeSealer(KEY, ["x".repeat(MIN_CONTENT_KEY_LENGTH - 1)])).toThrow(TypeError);
    for (const sealer of [contentSealer(undefined), contentSealer("short"), contentSealer(KEY, KEY), unconfiguredSealer]) {
      expect(await failure(sealer.seal(scope, secret))).toBe("unconfigured");
      expect(await failure(sealer.open(scope, secret))).toBe("unconfigured");
      expect(await failure(sealer.currentKeyId())).toBe("unconfigured");
    }
    const rotating = contentSealer(NEXT, KEY);
    expect(await rotating.open(scope, await envelopeSealer(KEY).seal(scope, secret))).toEqual(secret);
    expect(await contentSealer(KEY).open(scope, await envelopeSealer(KEY).seal(scope, secret))).toEqual(secret);
  });

  it("classifies content that does not open for ingest: replaced on retry, a missing key only retried", () => {
    for (const reason of ["unsealed", "unknown-key", "tampered"] as const) {
      const error = toIngestError(new SealedContentError(reason));
      expect(error).toMatchObject({ reason: `content-${reason}`, permanent: false });
      expect(UNREADABLE_CONTENT.has(error.reason)).toBe(true);
    }
    expect(UNREADABLE_CONTENT.has(toIngestError(new SealedContentError("unconfigured")).reason)).toBe(false);
  });
});
