// Dedicated proof: ordinary auth/proxy ingress signatures cannot request storage metadata.
const TIME = "x-rendro-resolver-time";
const SIGNATURE = "x-rendro-resolver-signature";
const encoder = new TextEncoder();
function payload(request: Request, timestamp: string): Uint8Array<ArrayBuffer> {
  const url = new URL(request.url);
  return encoder.encode(JSON.stringify(["rendro-storage-resolver-v1", request.method, url.pathname + url.search, timestamp]));
}
function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signResolverRequest(request: Request, secret: string, now = Date.now()): Promise<Headers> {
  if (secret.length < 32) throw new Error("Resolver secret is not configured");
  const timestamp = String(now);
  const signature = await crypto.subtle.sign("HMAC", await key(secret), payload(request, timestamp));
  return new Headers({
    [TIME]: timestamp,
    [SIGNATURE]: Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join(""),
  });
}
export async function isWorkerResolverRequest(request: Request, secret: string | undefined, now = Date.now()): Promise<boolean> {
  const timestamp = request.headers.get(TIME);
  const signature = request.headers.get(SIGNATURE);
  if (!secret || secret.length < 32 || !timestamp || !/^\d+$/.test(timestamp)
    || Math.abs(now - Number(timestamp)) > 60_000 || !signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, payload(request, timestamp));
}
