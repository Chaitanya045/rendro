// Only this verified header is trusted by Better Auth. Never trust raw forwarding
// headers at the public Convex origin: callers can supply them themselves.
export const AUTH_CLIENT_IP_HEADER = "x-rendro-verified-client-ip";
const IP_HEADER = "x-rendro-client-ip";
const TIME_HEADER = "x-rendro-client-ip-time";
const SIGNATURE_HEADER = "x-rendro-client-ip-signature";
const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
// Only hex digits, colons and dots can make an address; the URL parser would otherwise re-read `@` or `\` as an authority.
const IPV6_ALPHABET = /^[0-9a-fA-F:.]+$/;
const encoder = new TextEncoder();

/**
 * A dotted-quad IPv4 or a textual IPv6 address, nothing else (no port, zone, brackets, whitespace or list). Written by hand
 * rather than with zod (#357), which this module (shared with Convex, and bundled into the serving Worker) otherwise needs;
 * the accepted set is the one zod's `ipv4()` and `ipv6()` define. It needs no `node:net`, which Convex does not provide.
 */
export function isIpAddress(value: string): boolean {
  if (IPV4.test(value)) return true;
  if (!IPV6_ALPHABET.test(value)) return false;
  try {
    new URL(`http://[${value}]`);
    return true;
  } catch {
    return false;
  }
}

function payload(request: Request, ip: string, timestamp: string): Uint8Array<ArrayBuffer> {
  const url = new URL(request.url);
  return encoder.encode(JSON.stringify([
    "rendro-auth-client-ip-v1", request.method, url.pathname + url.search, ip, timestamp,
  ]));
}

function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

/** Called only with an address obtained by the server from its trusted ingress. */
export async function signAuthClientIp(
  request: Request,
  ip: string | undefined,
  secret: string,
  now = Date.now(),
): Promise<Headers> {
  const headers = new Headers();
  if (!ip || !isIpAddress(ip) || secret.length < 32) return headers;
  const timestamp = String(now);
  const signature = await crypto.subtle.sign("HMAC", await key(secret), payload(request, ip, timestamp));
  headers.set(IP_HEADER, ip);
  headers.set(TIME_HEADER, timestamp);
  headers.set(SIGNATURE_HEADER, Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(""));
  return headers;
}

export async function verifiedAuthRequest(
  request: Request,
  secret: string | undefined,
  now = Date.now(),
): Promise<Request> {
  const headers = new Headers(request.headers);
  const ip = headers.get(IP_HEADER);
  const timestamp = headers.get(TIME_HEADER);
  const signature = headers.get(SIGNATURE_HEADER);
  for (const name of [AUTH_CLIENT_IP_HEADER, IP_HEADER, TIME_HEADER, SIGNATURE_HEADER]) headers.delete(name);
  if (
    secret && secret.length >= 32 && ip && isIpAddress(ip)
    && timestamp && /^\d+$/.test(timestamp) && Math.abs(now - Number(timestamp)) <= 60_000
    && signature && /^[a-f0-9]{64}$/.test(signature)
  ) {
    // The pattern above guarantees exactly 32 hex byte pairs.
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16));
    if (await crypto.subtle.verify("HMAC", await key(secret), bytes, payload(request, ip, timestamp))) {
      headers.set(AUTH_CLIENT_IP_HEADER, ip);
    }
  }
  // Unverified/direct callers retain a shared per-path limit, never a client-
  // chosen bucket. Better Auth is configured to ignore all other IP headers.
  return new Request(request, { headers });
}
