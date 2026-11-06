/**
 * What the home's "open a repository" box accepts (#354): `owner/repo`, or a GitHub address of one
 * (`https://github.com/owner/repo`, with or without `www.`, a `.git` suffix, a trailing path or query, or an SSH
 * remote `git@github.com:owner/repo.git`). The names are checked as GitHub's own rules allow, so nothing else
 * reaches a redirect.
 */
import { isOwnerLogin, isRepoName } from "@/ingest/orchestrator/messages";

const MAX_INPUT_LENGTH = 300;
const ADDRESS = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)(.+)$/i;

export function parseRepositoryInput(value: string): { owner: string; name: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) return null;
  const path = ADDRESS.exec(trimmed)?.[1] ?? trimmed;
  const [owner, rest, ...more] = path.split(/[?#]/, 1)[0].split("/");
  // A bare `owner/repo` has exactly two parts; an address may carry more (`/tree/main/docs`) after the repository.
  if (!ADDRESS.test(trimmed) && (more.length > 0 || trimmed.endsWith("/"))) return null;
  const name = rest?.endsWith(".git") ? rest.slice(0, -".git".length) : rest;
  return isOwnerLogin(owner) && isRepoName(name) ? { owner, name } : null;
}
