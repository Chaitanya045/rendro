/**
 * Confirming a removal with GitHub before anything is destroyed (#258).
 * Webhook payloads are signed but carry no timestamp, so a captured
 * `installation_repositories` removal or `installation` deletion can be
 * replayed under a fresh delivery ID. Hiding on a payload is safe (a replay can
 * only deny); deleting is not. Every purge of a removed repository's data
 * (comments in Convex now, cached R2 content in P9) first asks GitHub, with the
 * installation's own token, whether the app has really lost the repository:
 *
 * - `removed`: the installation is gone, or its working token no longer sees
 *   the repository. Purge.
 * - `accessible`: GitHub still shows the repository to the installation.
 *   Restore what was hidden and cancel the purge.
 * - `unknown`: anything else (no token, an outage, a rate limit, a suspended
 *   installation, another repository under the name). Postpone; never purge on
 *   doubt.
 */
import { GitHubError } from "@/ingest/github/source";
import type { InstallationTokenProvider } from "@/ingest/github/token";
import type { ConfirmedRepo, GitHubAccessClient } from "./github";

export interface RemovalTarget {
  /** GitHub's repository ID: the answer must be about this repository, whatever its name is now. */
  id: number;
  owner: string;
  name: string;
  /** The installation the repository was last seen through. */
  installation: number | null;
}

export type RemovalVerdict =
  | { kind: "removed" }
  | { kind: "accessible"; repo: ConfirmedRepo }
  | { kind: "unknown"; reason: string };

export interface RemovalCheck {
  github: GitHubAccessClient;
  /**
   * Installation tokens. A provider that mints them (P1) throws
   * `GitHubError("not-found")` when GitHub reports the installation gone: that
   * alone confirms the removal. A null token confirms nothing.
   */
  installationTokens: InstallationTokenProvider;
}

function reason(error: unknown): string {
  return error instanceof GitHubError ? error.kind : "error";
}

/** Ask GitHub whether the app has truly lost `target`. Never throws. */
export async function confirmRemoval(check: RemovalCheck, target: RemovalTarget): Promise<RemovalVerdict> {
  const { github, installationTokens: tokens } = check;
  const installation = target.installation;
  if (installation === null) return { kind: "unknown", reason: "no-installation" };
  const budget = `installation:${installation}`;
  let retried = false;
  for (;;) {
    let token: string | null;
    try {
      token = await tokens.token(installation);
    } catch (error) {
      if (error instanceof GitHubError && error.kind === "not-found") return { kind: "removed" };
      return { kind: "unknown", reason: reason(error) };
    }
    // Without the installation's own token, a 404 says nothing about the app (and a 200 nothing either).
    if (token === null) return { kind: "unknown", reason: "no-token" };
    try {
      const repo = await github.repository(budget, token, target.owner, target.name);
      if (repo) return repo.id === target.id ? { kind: "accessible", repo } : { kind: "unknown", reason: "renamed" };
      // The installation cannot see it. Only a token GitHub accepts as this installation's makes that final.
      return await github.installationActive(budget, token) ? { kind: "removed" } : { kind: "unknown", reason: "installation" };
    } catch (error) {
      // Installation tokens rotate hourly: one retry with a fresh one.
      if (error instanceof GitHubError && error.kind === "unauthorized" && !retried) {
        retried = true;
        tokens.invalidate(installation);
        continue;
      }
      return { kind: "unknown", reason: reason(error) };
    }
  }
}
