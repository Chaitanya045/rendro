/**
 * Installation tokens. With the GitHub App configured, a provider mints and
 * caches one per installation until shortly before its one-hour expiry
 * (`mintedInstallationTokens`, #338). Without it, development and tests run
 * with a static token or none (public repositories, unauthenticated limits).
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
  /** A minting provider can name the App's installation on a repository whose reference has none (a first view). */
  installationOf?(owner: string, name: string): Promise<number | null>;
}

export function staticTokenProvider(token: string | null): InstallationTokenProvider {
  return {
    token: () => Promise.resolve(token),
    invalidate: () => {},
  };
}
