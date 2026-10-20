import type { MiddlewareHandler } from "hono";
import type { User } from "better-auth/types";
import { managementInitialData } from "./management-initial-data";
import { renderSessionUnavailablePage } from "./session-unavailable";
import { renderNotFoundPage } from "./not-found";

/**
 * Use the same fresh, authorization-first lookup as the management APIs.
 * Project resolution already checks membership: do not check it a second time.
 * Members may view every management page; mutation roles remain enforced by
 * the APIs and the existing read-only/restricted page controls.
 */
export const managementPageAccess: MiddlewareHandler<{ Variables: { user?: User } }> = async (c, next) => {
  const user = c.get("user");
  // Let each page retain its existing sign-in return URL.
  if (!user) return next();

  c.header("Cache-Control", "private, no-store");
  const invitationId = c.req.param("invitationId");
  const organizationId = c.req.param("organizationId") ?? "";
  const projectId = c.req.param("projectId");
  const query = new URLSearchParams({ organizationId });
  if (projectId !== undefined) query.set("projectId", projectId);
  const path = invitationId !== undefined
    ? `/api/auth/organization/get-invitation?${new URLSearchParams({ id: invitationId })}`
    : `/api/rendro/${projectId === undefined ? "management/access" : "projects/get"}?${query}`;
  const headers = new Headers({ Accept: "application/json" });
  const { viewerSessionCookie } = await import("@/viewer-ticket");
  const cookie = viewerSessionCookie(c.req.header("Cookie") ?? "");
  if (cookie) headers.set("Cookie", cookie);

  // Pure template rendering is also used by the offline asset build.
  const { CONVEX_SITE_URL } = await import("@/config");
  const { evictRejectedSession } = await import("@/session-cache");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let response: Response, data: AccessData | null;
  function unavailable(retryAfter = "1") {
    c.header("Retry-After", retryAfter);
    return c.html(renderSessionUnavailablePage(), 503);
  }
  try {
    // Include body consumption in the deadline, not just response headers.
    const result = await Promise.race([
      (async () => {
        const response = await fetch(`${CONVEX_SITE_URL}${path}`, {
          headers, redirect: "manual", signal: controller.signal,
        });
        const data = response.ok ? await response.json() as AccessData : null;
        return { response, data };
      })(),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("Lookup timeout")), { once: true });
      }),
    ]);
    ({ response, data } = result);
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timeout);
  }
  await evictRejectedSession(cookie, response.status);
  if (response.status === 401) {
    return c.redirect(`/sign-in?returnTo=${encodeURIComponent(c.req.path)}`);
  }
  // Backend membership failures are 403, but must not disclose whether an org
  // exists. Never forward backend error bodies or distinguish invalid ID kinds.
  if ([400, 403, 404].includes(response.status)) {
    return c.html(renderNotFoundPage({
      path: c.req.path,
      homeHref: "/organizations?choose=1",
      homeLabel: "Manage organizations",
    }), 404);
  }
  if (!response.ok) {
    const value = response.headers.get("Retry-After");
    const seconds = value && /^\d+$/.test(value) ? Number(value)
      : value ? Math.ceil((Date.parse(value) - Date.now()) / 1000) : 1;
    return unavailable(String(Number.isSafeInteger(seconds) ? Math.max(1, seconds) : 1));
  }

  if (invitationId !== undefined) {
    // The backend resolves for the signed-in recipient, without membership.
    if (!data || data.id !== invitationId || (typeof data.email !== "string" || data.email.toLowerCase() !== user.email.toLowerCase())
      || data.status !== "pending" || !data.expiresAt || !(new Date(data.expiresAt).getTime() > Date.now())) {
      await evictRejectedSession(cookie, 403);
      return c.html(renderNotFoundPage({ path: c.req.path, homeHref: "/organizations?choose=1", homeLabel: "Manage organizations" }), 404);
    }
  } else {
    const resolved = projectId === undefined
      ? data?.id === organizationId && data.userId === user.id && data.member?.userId === user.id
      : data?.project?._id === projectId && data.project.organizationId === organizationId;
    if (!resolved) return unavailable();
  }

  await managementInitialData.run({ path, data }, next);
};

interface AccessData {
  id?: string;
  userId?: string;
  member?: { userId?: string };
  project?: { _id?: string; organizationId?: string };
  email?: string;
  status?: string;
  expiresAt?: string | number;
}
