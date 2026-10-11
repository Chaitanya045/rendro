import type { MiddlewareHandler } from "hono";
import type { User } from "better-auth/types";
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
  const organizationId = c.req.param("organizationId") ?? "";
  const projectId = c.req.param("projectId")
    ?? (c.req.path.endsWith("/onboarding") ? c.req.query("projectId") : undefined);
  const query = new URLSearchParams({ organizationId });
  if (projectId !== undefined) query.set("projectId", projectId);
  const endpoint = projectId === undefined ? "management/access" : "projects/get";
  const headers = new Headers({ Accept: "application/json" });
  const cookie = c.req.header("Cookie");
  if (cookie) headers.set("Cookie", cookie);

  // Pure template rendering is also used by the offline asset build.
  const { CONVEX_SITE_URL } = await import("@/config");
  let response: Response;
  try {
    response = await fetch(`${CONVEX_SITE_URL}/api/rendro/${endpoint}?${query}`, {
      headers,
      redirect: "manual",
    });
  } catch {
    return c.text("Unable to verify workspace access. Please try again.", 502);
  }
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
  if (!response.ok) return c.text("Unable to verify workspace access. Please try again.", 502);

  const data = await response.json().catch(() => null) as {
    id?: string;
    userId?: string;
    member?: { userId?: string };
    project?: { _id?: string; organizationId?: string };
  } | null;
  const resolved = projectId === undefined
    ? data?.id === organizationId && data.userId === user.id && data.member?.userId === user.id
    : data?.project?._id === projectId && data.project.organizationId === organizationId;
  if (!resolved) return c.text("Unable to verify workspace access. Please try again.", 502);

  await next();
};
