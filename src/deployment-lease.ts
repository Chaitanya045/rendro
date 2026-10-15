/** Storage writes must start within the authorized lease and finish promptly.
 * Retention additionally drains expired staging leases for 24 hours. */
export function deploymentWriteSignal(expiresAt: number): AbortSignal {
  const remaining = expiresAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Staging lease expired");
  return AbortSignal.timeout(Math.min(remaining, 5 * 60 * 1000));
}
