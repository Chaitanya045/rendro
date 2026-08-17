import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authorizeHttpOrganization } from "./authorization";

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
