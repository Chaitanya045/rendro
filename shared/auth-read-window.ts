/** Fixed windows: accepted/rejected requests never move the window start. */
export function authReadWindow(key: string, row: { count: number; lastRequest: number } | null, now: number) {
  // 600/user/minute covers >8 lookups at 68 navigations/minute. Unverified
  // probes get 120; 6,000/IP/minute remains an aggregate shared-IP backstop.
  const max = /^(session|organization)-read-ip:/.test(key) ? 6_000 : /^(session|organization)-read:/.test(key) ? 600 : 120;
  if (!row || now - row.lastRequest >= 60_000) return { count: 1, lastRequest: now, retryAfter: 0 };
  if (row.count >= max) return { ...row, retryAfter: Math.max(1, Math.ceil((60_000 - (now - row.lastRequest)) / 1000)) };
  return { count: row.count + 1, lastRequest: row.lastRequest, retryAfter: 0 };
}
