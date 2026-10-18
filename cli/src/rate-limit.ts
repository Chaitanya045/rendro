/** Retry-After is seconds or an HTTP date. Ignore malformed/negative values. */
export function retryAfterMs(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (!/[a-z]/i.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Rate limits and transient infrastructure failures (an unexpected 500, a gateway or storage outage, a dropped
 * connection) clear on their own. Only requests the caller marks replay-safe are ever repeated. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function describeFailure(response: Response | undefined): string {
  if (!response) return "Network error";
  return response.status === 429 ? "Rate limited (429)" : `Server error (${response.status})`;
}

/** Callers must opt POST operations into retry only when replay is safe. */
export async function fetchWithRateLimit(
  url: string,
  init?: RequestInit,
  idempotent = ["GET", "HEAD"].includes(init?.method?.toUpperCase() ?? "GET"),
): Promise<Response> {
  const maxRetries = 3;
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(url, init);
      if (!RETRYABLE_STATUSES.has(response.status) || !idempotent || attempt === maxRetries) return response;
    } catch (error) {
      if (!idempotent || attempt === maxRetries) throw error;
    }
    const delay = Math.max(response ? retryAfterMs(response) ?? 0 : 0, 1000 * 2 ** attempt)
      + Math.floor(Math.random() * 250);
    // Do not silently wait indefinitely or overflow setTimeout for a bad header.
    if (response && delay > 60_000) return response;
    console.error(`${describeFailure(response)}. Retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${maxRetries})…`);
    await response?.body?.cancel();
    await new Promise<void>(resolve => setTimeout(resolve, delay));
  }
}
