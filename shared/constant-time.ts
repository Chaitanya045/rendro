const encoder = new TextEncoder();

/**
 * Compare two secret strings without an early exit. Both values are compared as
 * UTF-8 over the longer length with the length difference folded in, so timing
 * does not reveal where they diverge. Pure JavaScript: it runs unchanged in
 * Convex, Workers and Node. Use it for static secrets, bearer tokens and
 * stored random tokens; WebCrypto `verify` already covers HMAC signatures.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/** Check an `Authorization` header against `Bearer <secret>`; a missing secret never matches. */
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  return Boolean(secret) && constantTimeEqual(header ?? "", `Bearer ${secret}`);
}
