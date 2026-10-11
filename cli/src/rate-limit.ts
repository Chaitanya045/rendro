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

/** Callers must opt POST operations into retry only when replay is safe. */
export async function fetchWithRateLimit(
  url: string,
  init?: RequestInit,
  idempotent = ["GET", "HEAD"].includes(init?.method?.toUpperCase() ?? "GET"),
): Promise<Response> {
  const maxRetries = 3;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 || !idempotent || attempt === maxRetries) return response;
    const delay = Math.max(retryAfterMs(response) ?? 0, 1000 * 2 ** attempt)
      + Math.floor(Math.random() * 250);
    // Do not silently wait indefinitely or overflow setTimeout for a bad header.
    if (delay > 60_000) return response;
    console.error(`Rate limited (429). Retrying in ${(delay / 1000).toFixed(1)}s (${attempt + 1}/${maxRetries})…`);
    await response.body?.cancel();
    await new Promise<void>(resolve => setTimeout(resolve, delay));
  }
}
