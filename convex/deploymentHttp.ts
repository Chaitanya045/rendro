import type { DataModel, Id } from "./_generated/dataModel";
import type { GenericActionCtx } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authorizeHttpOrganization } from "./authorization";
import { validateApiCredential } from "./credentialHttp";

type Provenance = {
  source: {
    kind: "local" | "git";
    repository?: string;
    commit?: string;
    ref?: string;
    dirty?: boolean;
    localPathLabel?: string;
  };
  execution: {
    kind: "local" | "ci";
    provider?: string;
    runId?: string;
    workflow?: string;
    job?: string;
    actor?: string;
  };
  cliVersion: string;
  manifestSha256: string;
};

function failure(error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message || "Request failed" }, { status });
}

function objectField(body: object, name: string): unknown {
  return name in body ? body[name as keyof typeof body] : undefined;
}

export const startDeployment = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return failure("Invalid JSON body"); }
if (!body || typeof body !== "object") return failure("Invalid deployment body");
const organizationId = objectField(body, "organizationId");
const projectId = objectField(body, "projectId");
const manifestSha256 = objectField(body, "manifestSha256");
const fileCount = objectField(body, "fileCount");
const byteCount = objectField(body, "byteCount");
const provenance = objectField(body, "provenance");
if (
  typeof organizationId !== "string"
  || typeof projectId !== "string"
  || typeof manifestSha256 !== "string"
  || typeof fileCount !== "number"
  || typeof byteCount !== "number"
  || !provenance
  || typeof provenance !== "object"
) return failure("Invalid deployment fields");
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId: projectId as Id<"projects">,
  requiredScope: "docs:write",
});
if (!principal) return failure("Invalid or insufficient API key", 401);
try {
  const deployment = await ctx.runMutation(internal.deployments.startInternal, {
    organizationId,
    projectId: projectId as Id<"projects">,
    manifestSha256,
    fileCount,
    byteCount,
    provenance: provenance as Provenance,
    actorId: `api-key:${principal.keyId}`,
  });
  return Response.json({ deployment }, { status: 201 });
} catch (error: unknown) {
  return failure(error);
} });

export const getStagingDeployment = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const url = new URL(request.url);
const organizationId = url.searchParams.get("organizationId");
const projectId = url.searchParams.get("projectId");
const deploymentId = url.searchParams.get("deploymentId");
if (!organizationId || !projectId || !deploymentId) return failure("Missing deployment identity");
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId: projectId as Id<"projects">,
  requiredScope: "docs:write",
});
if (!principal) return failure("Invalid or insufficient API key", 401);
try {
  const deployment = await ctx.runQuery(internal.deployments.getInternal, {
    organizationId,
    projectId: projectId as Id<"projects">,
    deploymentId: deploymentId as Id<"deployments">,
  });
  if (!deployment || deployment.status !== "staging") {
    return failure("Staging deployment not found", 404);
  }
  return Response.json({ deployment, principal });
} catch (error: unknown) {
  return failure(error, 404);
} });

export const commitDeployment = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return failure("Invalid JSON body"); }
if (!body || typeof body !== "object") return failure("Invalid commit body");
const organizationId = objectField(body, "organizationId");
const projectId = objectField(body, "projectId");

const deploymentId = objectField(body, "deploymentId");
if (typeof organizationId !== "string" || typeof projectId !== "string" || typeof deploymentId !== "string") {
  return failure("Missing deployment identity");
}
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId: projectId as Id<"projects">,
  requiredScope: "docs:write",
});
if (!principal) return failure("Invalid or insufficient API key", 401);
try {
  const result = await ctx.runMutation(internal.deployments.commitInternal, {
    organizationId,
    projectId: projectId as Id<"projects">,
    deploymentId: deploymentId as Id<"deployments">,
    actorId: `api-key:${principal.keyId}`,
  });
  return Response.json(result);
} catch (error: unknown) {
  return failure(error, 409);
} });
export const getActiveDeployment = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const url = new URL(request.url);
const organizationId = url.searchParams.get("organizationId");
const projectId = url.searchParams.get("projectId");
if (!organizationId || !projectId) return failure("Missing project identity");
const apiPrincipal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId: projectId as Id<"projects">,
  requiredScope: "docs:read",
});
let principal: { kind: "api-key"; keyId: string } | { kind: "session"; userId: string };
if (apiPrincipal) {
  principal = { kind: "api-key", keyId: apiPrincipal.keyId };
} else {
  try {
    const { user } = await authorizeHttpOrganization(ctx, request.headers, organizationId);
    principal = { kind: "session", userId: user._id };
  } catch {
    return failure("Invalid or insufficient principal", 403);
  }
}
const project = await ctx.runQuery(internal.projects.getInternal, {
  organizationId,
  projectId: projectId as Id<"projects">,
});
if (!project?.activeDeploymentId) {
  return Response.json({ project, deployment: null, principal });
}
const deployment = await ctx.runQuery(internal.deployments.getInternal, {
  organizationId,
  projectId: projectId as Id<"projects">,
  deploymentId: project.activeDeploymentId,
});
return Response.json({ project, deployment, principal }); });

export const failDeployment = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return failure("Invalid JSON body"); }
if (!body || typeof body !== "object") return failure("Invalid failure body");
const organizationId = objectField(body, "organizationId");
const projectId = objectField(body, "projectId");
const deploymentId = objectField(body, "deploymentId");
const reason = objectField(body, "reason");
if (
  typeof organizationId !== "string"
  || typeof projectId !== "string"
  || typeof deploymentId !== "string"
  || typeof reason !== "string"
) return failure("Missing deployment failure fields");
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId: projectId as Id<"projects">,
  requiredScope: "docs:write",
});
if (!principal) return failure("Invalid or insufficient API key", 401);
await ctx.runMutation(internal.deployments.failInternal, {
  deploymentId: deploymentId as Id<"deployments">,
  reason,
});
return Response.json({ status: true }); });

export const listDeployments = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const url = new URL(request.url);
const organizationId = url.searchParams.get("organizationId");
const projectId = url.searchParams.get("projectId");
if (!organizationId || !projectId) return failure("organizationId and projectId are required");
try {
  const apiPrincipal = await validateApiCredential(ctx, request, {
    organizationId,
    projectId: projectId as Id<"projects">,
    requiredScope: "docs:read",
  });
  if (!apiPrincipal) await authorizeHttpOrganization(ctx, request.headers, organizationId);
  const project = await ctx.runQuery(internal.projects.getInternal, {
    organizationId,
    projectId: projectId as Id<"projects">,
  });
  if (!project) return failure("Project not found", 404);
  const deployments = await ctx.runQuery(internal.deployments.listInternal, {
    projectId: projectId as Id<"projects">,
  });
  return Response.json({ deployments });
} catch (error: unknown) {
  return failure(error, 403);
} });
