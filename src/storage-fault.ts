/** A storage failure after which replaying the same idempotent request is expected to succeed. */
export type StorageFault = { kind: "service" | "timeout" | "network"; status: number | null };

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
const NETWORK_MESSAGE = /fetch failed|network connection lost|connection (?:reset|closed|terminated)|socket hang up|terminated/i;

/**
 * Classifies a thrown storage error without ever exposing it: only the returned enumerations may be logged.
 * Throttling, 5xx answers, timeouts and dropped connections are transient; rejections such as 403 or 404,
 * and anything unrecognised (a code defect, a malformed object), are not and stay an internal error.
 */
export function transientStorageFault(error: unknown): StorageFault | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500 ? { kind: "service", status } : null;
  if ((error as { name?: unknown }).name === "TimeoutError") return { kind: "timeout", status: null };
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && NETWORK_CODES.has(code)) return { kind: "network", status: null };
  if (error instanceof TypeError && typeof message === "string" && NETWORK_MESSAGE.test(message)) return { kind: "network", status: null };
  return null;
}
