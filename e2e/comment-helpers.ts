import type { Page } from "@playwright/test";
import { assertLoopback } from "./backend";

/**
 * Helpers for the repository comment specs (#254): server state is re-read through the same Convex functions the widget
 * subscribes to, authenticated by the person's own session token.
 */
export type CallResult<T = unknown> = { ok: boolean; value?: T; code?: string; retryAfter?: number; message?: string };

/** Convex function call authenticated by `token` (the widget's JWT), never an ambient cookie. */
export async function convexCallWith<T = unknown>(token: string | undefined, kind: "query" | "mutation", path: string, args: unknown): Promise<CallResult<T>> {
  const origin = process.env.RENDRO_E2E_CONVEX;
  if (!origin) throw new Error("Missing local Convex origin");
  assertLoopback(origin);
  const response = await fetch(`${origin}/api/${kind}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ path, args, format: "json" }) });
  const body = await response.json() as { status: string; value?: T; errorMessage?: string; errorData?: { code?: string; kind?: string; retryAfter?: number } };
  if (body.status === "success") return { ok: true, value: body.value };
  return { ok: false, code: body.errorData?.code ?? body.errorData?.kind, retryAfter: body.errorData?.retryAfter, message: body.errorMessage };
}

/** Drafts the parent shell keeps for the signed-in person (sessionStorage, per tab). */
export const storedDrafts = (page: Page) => page.evaluate(() => Object.entries(sessionStorage)
  .filter(([key]) => key.startsWith("commentor-operations:"))
  .flatMap(([, value]) => Object.values((JSON.parse(value as string) as { drafts: Record<string, { body: string }> }).drafts).map(draft => draft.body)));
