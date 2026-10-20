/** Largest delay a browser timer honors; longer server delays are capped, never dropped. */
export const MAX_RETRY_AFTER_MS = 2_147_483_647;

/** Retry-After as a positive millisecond delay: digits-only seconds or an HTTP date. 0 means absent or invalid. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number {
  const text = value?.trim();
  if (!text) return 0;
  const delay = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return delay > 0 ? Math.min(delay, MAX_RETRY_AFTER_MS) : 0;
}
