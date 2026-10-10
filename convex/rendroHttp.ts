import type { Id } from "./_generated/dataModel";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authorizeHttpOrganization, httpOrganizationAccess } from "./authorization";
import { createAuth } from "./auth";

// The Convex auth adapter supports cursors, not Better Auth's offset API.
export const managementMembers = httpAction(async (ctx, request) => {
  const url = new URL(request.url), organizationId = url.searchParams.get("organizationId");
  const headers = { "Cache-Control": "private, no-store" };
  if (!organizationId) return Response.json({ error: "organizationId is required" }, { status: 400, headers });
  try {
    await authorizeHttpOrganization(ctx, request.headers, organizationId);
    const result = await ctx.runQuery(components.betterAuth.adapter.findMany, { model: "member", where: [{ field: "organizationId", value: organizationId }], paginationOpts: { cursor: url.searchParams.get("cursor"), numItems: 100 } }) as { page: Array<{ _id: string; userId: string; role: string; createdAt: number }>; isDone: boolean; continueCursor: string };
    const page = result.page;
    const auth = await createAuth(ctx).$context;
    const users = page.length ? await auth.adapter.findMany<{ id: string; name: string; email: string }>({ model: "user", where: [{ field: "id", value: page.map(member => member.userId), operator: "in" }], limit: 100 }) : [];
    const byId = new Map(users.map(user => [user.id, user]));
    const members = page.map(member => { const user = byId.get(member.userId); return { id: member._id, userId: member.userId, role: member.role, createdAt: member.createdAt, user: user ? { id: user.id, name: user.name, email: user.email } : null }; });
    return Response.json({ members, nextCursor: result.isDone ? null : result.continueCursor }, { headers });
  } catch (error) { const forbidden = error instanceof Error && /authentication|membership|required|role/i.test(error.message); return Response.json({ error: "Unable to load organization members" }, { status: forbidden ? 403 : 503, headers }); }
});

// Native Better Auth roster reads require the caller to belong to the team.
// Org managers must also be able to inspect/manage teams they are not in.
export const managementTeamMembers = httpAction(async (ctx, request) => {
  const url = new URL(request.url), organizationId = url.searchParams.get("organizationId"), teamId = url.searchParams.get("teamId");
  const headers = { "Cache-Control": "private, no-store" };
  if (!organizationId || !teamId) return Response.json({ error: "organizationId and teamId are required" }, { status: 400, headers });
  try {
    await authorizeHttpOrganization(ctx, request.headers, organizationId, ["owner", "admin"]);
    const auth = await createAuth(ctx).$context;
    const team = await auth.adapter.findOne<{ organizationId: string }>({ model: "team", where: [{ field: "id", value: teamId }] });
    if (!team || team.organizationId !== organizationId) return Response.json({ error: "Team not found" }, { status: 404, headers });
    const result = await ctx.runQuery(components.betterAuth.adapter.findMany, { model: "teamMember", where: [{ field: "teamId", value: teamId }], paginationOpts: { cursor: url.searchParams.get("cursor"), numItems: 50 } }) as { page: Array<{ _id: string; userId: string }>; isDone: boolean; continueCursor: string };
    const members = result.page;
    return Response.json({ members: members.map(member => ({ id: member._id, userId: member.userId })), nextCursor: result.isDone ? null : result.continueCursor }, { headers });
  } catch (error) { const response = jsonError(error); response.headers.set("Cache-Control", "private, no-store"); return response; }
});

// Navigation needs the current identity and membership, not every member/team.
// Always query fresh; this response must never enter the browser data cache.
export const managementAccess = httpAction(async (ctx, request) => {
  const organizationId = organizationIdFrom(request);
  const headers = { "Cache-Control": "private, no-store" };
  if (!organizationId) return Response.json({ error: "organizationId is required" }, { status: 400, headers });
  try {
    const { organization, member, userId } = await httpOrganizationAccess(ctx, request.headers, organizationId);
    return Response.json({ id: organization.id, name: organization.name, slug: organization.slug, userId, member: { id: member.id, userId: member.userId, role: member.role } }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const status = message.includes("Authentication required") ? 401 : message.includes("membership required") ? 403 : 503;
    return Response.json({ error: status === 503 ? "Unable to verify organization access" : status === 401 ? "Authentication required" : "Organization membership required" }, { status, headers });
  }
});

function jsonError(error: unknown, fallbackStatus = 400): Response {
  const message = error instanceof Error ? error.message : String(error);
  const unauthorized = /authentication|required|membership|role/i.test(message);
  return Response.json(
    { error: message || "Request failed" },
    { status: unauthorized ? 403 : fallbackStatus },
  );
}

function organizationIdFrom(request: Request): string | null {
  return new URL(request.url).searchParams.get("organizationId");
}

export const listProjects = httpAction(async (ctx, request) => {
  const organizationId = organizationIdFrom(request);
  if (!organizationId) return Response.json({ error: "organizationId is required" }, { status: 400 });
  try {
    await authorizeHttpOrganization(ctx, request.headers, organizationId);
    const projects = await ctx.runQuery(internal.projects.listInternal, { organizationId });
    return Response.json({ projects });
  } catch (error: unknown) {
    return jsonError(error);
  }
});

export const managementRecentDeployment = httpAction(async (ctx, request) => {
  const organizationId = organizationIdFrom(request);
  if (!organizationId) return Response.json({ error: "organizationId is required" }, { status: 400 });
  try {
    await authorizeHttpOrganization(ctx, request.headers, organizationId);
    const deployment = await ctx.runQuery(internal.deployments.latestForOrganization, { organizationId });
    return Response.json({ deployment }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
});

export const createProject = httpAction(async (ctx, request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid project body" }, { status: 400 });
  }
  const organizationId = "organizationId" in body ? body.organizationId : null;
  const name = "name" in body ? body.name : null;
  const slug = "slug" in body ? body.slug : null;
  if (typeof organizationId !== "string" || typeof name !== "string" || typeof slug !== "string") {
    return Response.json({ error: "organizationId, name, and slug are required" }, { status: 400 });
  }
  try {
    const { user } = await authorizeHttpOrganization(
      ctx,
      request.headers,
      organizationId,
      ["owner", "admin"],
    );
    const project = await ctx.runMutation(internal.projects.createInternal, {
      organizationId,
      name,
      slug,
      actorId: user._id,
    });
    return Response.json({ project }, { status: 201 });
  } catch (error: unknown) {
    // Convex wraps validation failures with stack locations. Show only the
    // allowlisted user-facing validation message, never that server wrapper.
    const message = error instanceof Error ? error.message : "";
    const validation = ["A project with this slug already exists", "Project name must be 1–80 characters", "Project slug must contain lowercase letters, numbers, and hyphens"].find(value => message.includes(value));
    if (validation) return Response.json({ error: validation }, { status: 400 });
    return jsonError(error);
  }
});

export const getProject = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const projectId = url.searchParams.get("projectId");
  if (!organizationId || !projectId) {
    return Response.json({ error: "organizationId and projectId are required" }, { status: 400 });
  }
  try {
    await authorizeHttpOrganization(ctx, request.headers, organizationId);
    const project = await ctx.runQuery(internal.projects.getInternal, {
      organizationId,
      projectId: projectId as Id<"projects">,
    });
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
    return Response.json({ project });
  } catch (error: unknown) {
    return jsonError(error, 404);
  }
});
