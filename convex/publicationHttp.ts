import type { GenericActionCtx } from "convex/server";
import type { DataModel, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authorizeHttpOrganization } from "./authorization";
import { validateApiCredential } from "./credentialHttp";

function failure(error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message || "Request failed" }, { status });
}

async function publicationPrincipal(
  ctx: GenericActionCtx<DataModel>,
  request: Request,
  input: {
    organizationId: string;
    projectId?: Id<"projects">;
    scope: "publications:read" | "publications:write";
    write: boolean;
  },
): Promise<{ actorId: string } | null> {
  const apiPrincipal = await validateApiCredential(ctx, request, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    requiredScope: input.scope,
  });
  if (apiPrincipal) return { actorId: `api-key:${apiPrincipal.keyId}` };
  try {
    const { user } = await authorizeHttpOrganization(
      ctx,
      request.headers,
      input.organizationId,
      input.write ? ["owner", "admin"] : undefined,
    );
    return { actorId: user._id };
  } catch {
    return null;
  }
}

export const createPublication = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => {
  let body: unknown;
  try { body = await request.json(); } catch { return failure("Invalid JSON body"); }
  if (!body || typeof body !== "object") return failure("Invalid publication body");
  const value = (name: string): unknown => name in body ? body[name as keyof typeof body] : undefined;
  const organizationId = value("organizationId");
  const projectId = value("projectId");
  const slug = value("slug");
  const pathPrefix = value("pathPrefix");
  const entryFile = value("entryFile");
  const trackingMode = value("trackingMode");
  const pinnedDeploymentId = value("pinnedDeploymentId");
  const title = value("title");
  const description = value("description");
  if (
    typeof organizationId !== "string"
    || typeof projectId !== "string"
    || typeof slug !== "string"
    || typeof pathPrefix !== "string"
    || typeof entryFile !== "string"
    || (trackingMode !== "track_active" && trackingMode !== "pinned")
    || (pinnedDeploymentId !== undefined && typeof pinnedDeploymentId !== "string")
    || (title !== undefined && typeof title !== "string")
    || (description !== undefined && typeof description !== "string")
  ) return failure("Invalid publication fields");
  const principal = await publicationPrincipal(ctx, request, {
    organizationId,
    projectId: projectId as Id<"projects">,
    scope: "publications:write",
    write: true,
  });
  if (!principal) return failure("Invalid or insufficient principal", 403);
  try {
    const publication = await ctx.runMutation(internal.publicationsV2.createInternal, {
      organizationId,
      projectId: projectId as Id<"projects">,
      slug,
      pathPrefix,
      entryFile,
      trackingMode,
      pinnedDeploymentId: pinnedDeploymentId as Id<"deployments"> | undefined,
      title,
      description,
      actorId: principal.actorId,
    });
    return Response.json({ publication, url: publication ? `/p/${publication.slug}` : null }, { status: 201 });
  } catch (error: unknown) {
    return failure(error);
  }
});

export const listPublications = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const projectId = url.searchParams.get("projectId") ?? undefined;
  if (!organizationId) return failure("organizationId is required");
  const principal = await publicationPrincipal(ctx, request, {
    organizationId,
    projectId: projectId as Id<"projects"> | undefined,
    scope: "publications:read",
    write: false,
  });
  if (!principal) return failure("Invalid or insufficient principal", 403);
  const publications = await ctx.runQuery(internal.publicationsV2.listInternal, {
    organizationId,
    projectId: projectId as Id<"projects"> | undefined,
  });
  return Response.json({ publications });
});

export const removePublication = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => {
  let body: unknown;
  try { body = await request.json(); } catch { return failure("Invalid JSON body"); }
  if (!body || typeof body !== "object") return failure("Invalid publication body");
  const organizationId = "organizationId" in body ? body.organizationId : undefined;
  const projectId = "projectId" in body ? body.projectId : undefined;
  const publicationId = "publicationId" in body ? body.publicationId : undefined;
  if (typeof organizationId !== "string" || typeof projectId !== "string" || typeof publicationId !== "string") {
    return failure("organizationId, projectId, and publicationId are required");
  }
  const principal = await publicationPrincipal(ctx, request, {
    organizationId,
    projectId: projectId as Id<"projects">,
    scope: "publications:write",
    write: true,
  });
  if (!principal) return failure("Invalid or insufficient principal", 403);
  await ctx.runMutation(internal.publicationsV2.removeInternal, {
    organizationId,
    publicationId: publicationId as Id<"publications">,
    actorId: principal.actorId,
  });
  return Response.json({ removed: true });
});

export const resolvePublicPublication = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => {
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug) return failure("slug is required");
  const result = await ctx.runQuery(internal.publicationsV2.resolvePublicInternal, { slug });
  if (!result) return failure("Publication not found", 404);
  return Response.json(result);
});
