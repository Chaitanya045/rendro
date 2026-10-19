/**
 * Where the control Worker tells Convex about lost access (#254): the comment
 * grants there must end when page access does, and Convex cannot read KV. Two
 * internal-secret mutations, `repoCommentAccess:revokeUser` (with the epoch the
 * outbox just wrote to KV) and `repoCommentAccess:removeRepos`. Anything but a
 * confirmed success throws, so the outbox keeps the entry and retries it.
 */
import type { CommentAccessSink } from "./directory";

const TIMEOUT_MS = 5_000;

export function convexCommentSink(convexUrl: string, internalSecret: string, fetcher: typeof fetch = fetch): CommentAccessSink {
  async function call(path: string, args: Record<string, unknown>): Promise<void> {
    const response = await fetcher(`${convexUrl}/api/mutation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args: [{ ...args, internalSecret }], format: "json" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = response.ok ? await response.json().catch(() => null) as { status?: unknown } | null : null;
    if (!response.ok) await response.body?.cancel();
    if (body?.status !== "success") throw new Error(`Convex ${path} failed`);
  }
  return {
    revoke: (userId, epoch) => call("repoCommentAccess:revokeUser", { userId, epoch }),
    removeRepos: (repoIds) => call("repoCommentAccess:removeRepos", { repoIds }),
  };
}
