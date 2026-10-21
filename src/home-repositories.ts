/**
 * The repositories a reader's home lists (#338), from the control Worker's
 * mirror over the `REPO_ACCESS` binding (`/v1/accounts/repositories`). A view
 * never calls GitHub: the mirror answers, and lists again only once it is
 * stale. Every field is checked before it reaches the page.
 */
import { isOwnerLogin, isRepoName } from "@/ingest/orchestrator/messages";
import type { Fetcher } from "@/repo-read/access";

export interface HomeRepository {
  owner: string;
  name: string;
  private: boolean;
  /** The last push, epoch ms, when GitHub reported one. */
  pushedAt: number | null;
}

export type HomeRepositories =
  | { kind: "list"; repositories: HomeRepository[]; truncated: boolean }
  /** No GitHub tokens for this reader in the mirror: they connect GitHub first. */
  | { kind: "unlinked" }
  /** The mirror could not answer (GitHub, the binding, a malformed answer): the page offers to try again. */
  | { kind: "unavailable" };

const URL = "https://repo-access.internal/v1/accounts/repositories";
const TIMEOUT_MS = 5_000;

function parseRepository(value: unknown): HomeRepository | null {
  const repo = value as Partial<Record<keyof HomeRepository, unknown>> | null;
  if (!repo || typeof repo !== "object" || !isOwnerLogin(repo.owner) || !isRepoName(repo.name) || typeof repo.private !== "boolean"
    || !(repo.pushedAt === null || (Number.isSafeInteger(repo.pushedAt) && (repo.pushedAt as number) > 0))) return null;
  return { owner: repo.owner, name: repo.name, private: repo.private, pushedAt: repo.pushedAt as number | null };
}

export async function homeRepositories(binding: Fetcher, userId: string): Promise<HomeRepositories> {
  let body: { linked?: unknown; repositories?: unknown; truncated?: unknown } | null;
  try {
    const response = await binding.fetch(new Request(URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }), signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
    body = response.ok ? await response.json() as typeof body : null;
  } catch {
    return { kind: "unavailable" };
  }
  if (body?.linked === false) return { kind: "unlinked" };
  const repositories = body?.linked === true && Array.isArray(body.repositories) ? body.repositories.map(parseRepository) : null;
  if (!repositories || repositories.some((repo) => repo === null) || typeof body?.truncated !== "boolean") return { kind: "unavailable" };
  return { kind: "list", repositories: repositories as HomeRepository[], truncated: body.truncated };
}
