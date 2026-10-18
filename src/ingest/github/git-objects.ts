const encoder = new TextEncoder();

/** A git object ID: SHA-1 (40 hex) or SHA-256 (64 hex) repositories. */
export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && GIT_OBJECT_ID.test(value);
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The git object ID of a blob: hash("blob <size>\0" + content). Tar entries carry
 * no blob ID, so archive content is checked against the tree listing with this.
 * The hash follows the expected ID's length (SHA-1 or SHA-256 repositories).
 */
export async function gitBlobId(content: Uint8Array, algorithm: "SHA-1" | "SHA-256" = "SHA-1"): Promise<string> {
  const header = encoder.encode(`blob ${content.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + content.byteLength);
  object.set(header, 0);
  object.set(content, header.byteLength);
  return toHex(new Uint8Array(await crypto.subtle.digest(algorithm, object)));
}

/** True when `content` hashes to the blob ID `expected`. */
export async function matchesBlobId(content: Uint8Array, expected: string): Promise<boolean> {
  return await gitBlobId(content, expected.length === 64 ? "SHA-256" : "SHA-1") === expected;
}
