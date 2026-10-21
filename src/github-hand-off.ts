/**
 * The serving Worker's half of GitHub sign-in (#338): it alone holds the
 * control Worker's `REPO_ACCESS` service binding, so it passes the reader's
 * GitHub account to the permission mirror.
 *
 * - After the OAuth callback, Convex's response carries the sealed hand-off
 *   (shared/github-hand-off.ts). The auth proxy strips it from every response
 *   and, on the callback alone, opens it here and forwards it to
 *   `/v1/accounts/link`, where the tokens are sealed at rest.
 * - Before Convex unlinks the reader's GitHub account, the mirror forgets the
 *   tokens (`/v1/accounts/unlink`). If it cannot, the unlink is not sent, so
 *   no GitHub account is ever unlinked while its tokens still grant access.
 *
 * Tokens never reach a log line, a response or Convex.
 */
import { CONVEX_INTERNAL_SECRET } from "@/config";
import { logger } from "@/logger";
import type { Fetcher } from "@/repo-read/access";
import { openHandOff } from "../shared/github-hand-off";

const ACCOUNTS_URL = "https://repo-access.internal/v1/accounts";
const TIMEOUT_MS = 5_000;

/** The `REPO_ACCESS` binding, when this Worker has one. */
export function repoAccessBinding(env: unknown): Fetcher | null {
  const binding = (env as { REPO_ACCESS?: unknown } | undefined)?.REPO_ACCESS;
  return binding && typeof (binding as Fetcher).fetch === "function" ? binding as Fetcher : null;
}

async function post(binding: Fetcher, path: "link" | "unlink", body: unknown): Promise<boolean> {
  try {
    const response = await binding.fetch(new Request(`${ACCOUNTS_URL}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
    await response.body?.cancel();
    return response.status === 204;
  } catch {
    return false;
  }
}

/**
 * Open a sealed hand-off and link the account in the mirror. A failure leaves the reader signed in
 * without GitHub access (private repositories are denied) until their next GitHub sign-in links again.
 */
export async function linkGitHubAccount(binding: Fetcher, sealed: string): Promise<boolean> {
  const handOff = await openHandOff(CONVEX_INTERNAL_SECRET, sealed);
  const linked = handOff !== null && await post(binding, "link", handOff);
  if (!linked) logger.error({ category: "GitHubHandOff", outcome: handOff ? "unavailable" : "invalid" }, "GitHub account was not linked");
  return linked;
}

/** Drop the reader's GitHub tokens from the mirror; false when the mirror could not confirm it. */
export async function unlinkGitHubAccount(binding: Fetcher, userId: string): Promise<boolean> {
  const unlinked = await post(binding, "unlink", { userId });
  if (!unlinked) logger.error({ category: "GitHubHandOff", outcome: "unlink-unavailable" }, "GitHub account was not unlinked");
  return unlinked;
}
