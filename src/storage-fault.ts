/** A storage failure after which replaying the same idempotent request is expected to succeed. */
export type StorageFault = { kind: "service" | "timeout" | "network"; status: number | null };

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const NETWORK_MESSAGE = /fetch failed|network connection lost|connection (?:reset|closed|terminated)|socket hang up|terminated/i;

/**
 * R2 binding failures are plain `Error`s whose message is `<operation>: <text> (<code>)`. Only these
 * codes mean "try again": 10001 internal error, 10043 temporarily unavailable, 10058 rate limited
 * (statuses as documented by Cloudflare), and 10054 client disconnected mid-transfer. Rejections such
 * as 10007/10020/10031/10039 and 10003 (permission) describe the request and are final.
 */
const R2_MESSAGE = /^\w+: [^]*\((\d{5,6})\)$/;
const R2_SERVICE_STATUS: Readonly<Record<string, number>> = { 10001: 500, 10043: 503, 10058: 429 };

/**
 * Classifies a thrown storage error without ever exposing it: only the returned enumerations may be logged.
 * Throttling, service errors, timeouts and dropped connections are transient; rejections such as a bad
 * key, an unsatisfiable range or a missing permission, and anything unrecognised (a code defect, a
 * malformed object), are not and stay an internal error.
 */
export function transientStorageFault(error: unknown): StorageFault | null {
  if (!error || typeof error !== "object") return null;
  if ((error as { name?: unknown }).name === "TimeoutError") return { kind: "timeout", status: null };
  const { code, message } = error as { code?: unknown; message?: unknown };
  const r2Code = error instanceof Error && typeof message === "string" ? R2_MESSAGE.exec(message)?.[1] : undefined;
  if (r2Code !== undefined) {
    if (r2Code in R2_SERVICE_STATUS) return { kind: "service", status: R2_SERVICE_STATUS[r2Code] };
    return r2Code === "10054" ? { kind: "network", status: null } : null;
  }
  if (typeof code === "string" && NETWORK_CODES.has(code)) return { kind: "network", status: null };
  if (error instanceof TypeError && typeof message === "string" && NETWORK_MESSAGE.test(message)) return { kind: "network", status: null };
  return null;
}
