/**
 * Where the control Worker tells Convex about lost access (#254): the comment
 * grants there must end when page access does, and Convex cannot read KV.
 * Internal-secret mutations: `repoCommentAccess:revokeUser` (with the epoch the
 * outbox just wrote to KV), `removeRepos` (hide), and, once GitHub confirmed
 * the removal or refuted it (#258), `purgeRepos` or `restoreRepos`. Anything
 * but a confirmed success throws, so the outbox keeps the entry and retries it.
 */
import type { CommentAccessSink, PurgeAnswer } from "./directory";

const TIMEOUT_MS = 5_000;

function parsePurgeAnswer(value: unknown): PurgeAnswer | null {
  const notDue = (value as { notDue?: unknown } | null)?.notDue;
  if (!Array.isArray(notDue)) return null;
  const valid = notDue.every((item: { repoId?: unknown; dueAt?: unknown } | null) => Number.isSafeInteger(item?.repoId) && Number.isSafeInteger(item?.dueAt));
  return valid ? { notDue: notDue as PurgeAnswer["notDue"] } : null;
}

export function convexCommentSink(convexUrl: string, internalSecret: string, fetcher: typeof fetch = fetch): CommentAccessSink {
  async function call(path: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await fetcher(`${convexUrl}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args: [{ ...args, internalSecret }], format: "json" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = response.ok ? await response.json().catch(() => null) as { status?: unknown; value?: unknown } | null : null;
    if (!response.ok) await response.body?.cancel();
    if (body?.status !== "success") throw new Error(`Convex ${path} failed`);
    return body.value;
  }
  return {
    revoke: async (userId, epoch) => void await call("repoCommentAccess:revokeUser", { userId, epoch }),
    removeRepos: async (repoIds) => void await call("repoCommentAccess:removeRepos", { repoIds }),
    restoreRepos: async (repoIds) => void await call("repoCommentAccess:restoreRepos", { repoIds }),
    async purgeRepos(repoIds) {
      const answer = parsePurgeAnswer(await call("repoCommentAccess:purgeRepos", { repoIds }));
      if (!answer) throw new Error("Convex repoCommentAccess:purgeRepos answered unexpectedly");
      return answer;
    },
  };
}
