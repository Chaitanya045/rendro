import type { Context } from "hono";
import { CONVEX_SITE_URL } from "./config";
import { convexQueryRequired } from "./convex-internal";
import { viewerBackendJson, ViewerBackendError } from "./viewer-backend";
import { viewerSessionCookie } from "./viewer-ticket";
import { legacyStoragePrefix } from "./storage-boundary";

export async function legacyOrganization(org: string): Promise<string | null> {
  if (!legacyStoragePrefix(org)) return null;
  const id = await convexQueryRequired("legacyAccess:resolve", { orgSlug: org });
  if (id === null) return null;
  if (typeof id !== "string" || !id.trim()) throw new ViewerBackendError();
  return id;
}

export async function legacyMember(org: string, cookie: string, destructive = false): Promise<boolean> {
  if (!cookie) return false;
  const id = await legacyOrganization(org);
  if (!id) return false;
  const data = await viewerBackendJson<{ id: string; userId: string; member: { userId: string; role: string } }>(
    `${CONVEX_SITE_URL}/api/rendro/management/access?${new URLSearchParams({ organizationId: id })}`,
    { headers: { cookie, accept: "application/json" } },
  );
  if (data === null) return false;
  if (data.id !== id || typeof data.userId !== "string" || !data.userId
    || data.member?.userId !== data.userId || typeof data.member.role !== "string") throw new ViewerBackendError();
  return !destructive || data.member.role.split(",").some(role => ["owner", "admin"].includes(role.trim()));
}

export function legacyRequestMember(c: Context, org: string, destructive = false): Promise<boolean> {
  return legacyMember(org, viewerSessionCookie(c.req.header("Cookie") ?? ""), destructive);
}

export function legacyUnavailable(_error: Error, c: Context): Response {
  return c.json({ error: "Legacy backend unavailable", retryable: true }, 503, { "Retry-After": "1", "Cache-Control": "private, no-store" });
}

export function retiredLegacy(): Response {
  return Response.json({ error: "Legacy API retired. Use rendro@2 organization/project deployments. See README: Migrating from 1.x.", migration: "https://github.com/Chaitanya045/rendro#migrating-from-1x" }, { status: 410 });
}
