// Storage validation is separate from ingress-IP, resolver, and user authority.
export const STORAGE_ATTESTATION_HEADER = "x-rendro-storage-attestation";
const encoder = new TextEncoder();
const MAX_AGE_MS = 60_000;

type Deployment = {
  organizationId: string;
  projectId: string;
  deploymentId: string;
  manifestKey: string;
  manifestSha256: string;
  fileCount: number;
};
export type StorageValidation = Deployment & (
  | { purpose: "deployment-commit" }
  | { purpose: "publication-entry"; pathPrefix: string; entryFile: string; trackingMode: "pinned" | "track_active" }
);

function payload(input: StorageValidation, timestamp: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([
    "rendro-storage-validation-v1", input.purpose,
    input.organizationId, input.projectId, input.deploymentId,
    input.manifestKey, input.manifestSha256, input.fileCount, timestamp,
    ...(input.purpose === "publication-entry" ? [input.pathPrefix, input.entryFile, input.trackingMode] : []),
  ]));
}

async function key(secret: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, encoder.encode("rendro-storage-validation-key-v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signStorageValidation(input: StorageValidation, secret: string, now = Date.now()): Promise<string> {
  if (secret.length < 32) throw new Error("Storage validation secret is not configured");
  const timestamp = String(now);
  const signature = await crypto.subtle.sign("HMAC", await key(secret), payload(input, timestamp));
  return `${timestamp}.${Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyStorageValidation(
  input: StorageValidation, attestation: string | undefined, secret: string | undefined, now = Date.now(),
): Promise<boolean> {
  if (!secret || secret.length < 32 || !attestation) return false;
  const match = /^(\d{1,16})\.([a-f0-9]{64})$/.exec(attestation);
  if (!match) return false;
  const [, timestamp, signature] = match;
  const age = now - Number(timestamp);
  if (age < 0 || age > MAX_AGE_MS) return false;
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, payload(input, timestamp));
}
