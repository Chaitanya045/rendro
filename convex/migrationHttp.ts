import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

function authorized(request: Request): boolean {
  const secret = process.env.MIGRATION_SECRET;
  return Boolean(secret) && request.headers.get("Authorization") === `Bearer ${secret}`;
}

export const ensureMigrationProject = httpAction(async (ctx, request) => {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid migration project" }, { status: 400 });
  const organizationId = "organizationId" in body ? body.organizationId : undefined;
  const projectId = "projectId" in body ? body.projectId : undefined;
  const name = "name" in body ? body.name : undefined;
  const slug = "slug" in body ? body.slug : undefined;
  if (typeof organizationId !== "string") return Response.json({ error: "organizationId is required" }, { status: 400 });
  if (typeof projectId === "string") {
    const project = await ctx.runQuery(internal.projects.getInternal, {
      organizationId,
      projectId: projectId as Id<"projects">,
    });
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
    if (project.activeDeploymentId) {
      return Response.json({ error: "Migration requires a new or empty project" }, { status: 409 });
    }
    return Response.json({ project, created: false });
  }
  if (typeof name !== "string" || typeof slug !== "string") {
    return Response.json({ error: "name and slug are required" }, { status: 400 });
  }
  const projects = await ctx.runQuery(internal.projects.listInternal, { organizationId });
  const existing = projects.find((project) => project.slug === slug);
  if (existing) {
    if (existing.activeDeploymentId) {
      return Response.json({ error: "Existing migration project already has an active deployment" }, { status: 409 });
    }
    return Response.json({ project: existing, created: false });
  }
  const project = await ctx.runMutation(internal.projects.createInternal, {
    organizationId,
    name,
    slug,
    actorId: "migration-job",
  });
  return Response.json({ project, created: true }, { status: 201 });
});
