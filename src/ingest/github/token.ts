/**
 * Installation tokens. P1 (GitHub App sign-in) supplies a provider that mints
 * and caches a token per installation until shortly before its one-hour expiry.
 * Until then the ingest Worker runs with a static development token or none
 * (public repositories, unauthenticated limits).
 */
export interface InstallationTokenProvider {
  /**
   * A bearer token for the installation, or null to send no Authorization header. A provider
   * that mints tokens throws `GitHubError("not-found")` when GitHub no longer has the
   * installation: `confirmRemoval` (src/repo-access/removal.ts) takes that as proof of an uninstall.
   */
  token(installationId: number | null): Promise<string | null>;
  /** Drop a token GitHub rejected (401), so the next call mints a fresh one. */
  invalidate(installationId: number | null): void;
}

export function staticTokenProvider(token: string | null): InstallationTokenProvider {
  return {
    token: () => Promise.resolve(token),
    invalidate: () => {},
  };
}
