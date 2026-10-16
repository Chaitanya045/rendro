/** Largest delay a browser timer honors; longer server delays are capped, never dropped. */
export const MAX_RETRY_AFTER_MS = 2_147_483_647;

/** Browser-safe twin of {@link retryAfterMs} for the inline page scripts. Tests keep them identical. */
export const RETRY_AFTER_SOURCE = String.raw`function parseRetryAfterMs(value,now){
  if(value===null||value===undefined)return 0;
  var text=String(value).trim();
  if(!text)return 0;
  var delay=/^\d+$/.test(text)?Number(text)*1000:Date.parse(text)-now;
  return delay>0?Math.min(delay,2147483647):0;
}`;

/** Retry-After as a positive millisecond delay: digits-only seconds or an HTTP date. 0 means absent or invalid. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number {
  const text = value?.trim();
  if (!text) return 0;
  const delay = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return delay > 0 ? Math.min(delay, MAX_RETRY_AFTER_MS) : 0;
}
