import { STORAGE_ATTESTATION_HEADER } from "../shared/storage-attestation";
import { apiKeyCleanupHttpAction, apiKeyHttpAction, sessionOrApiKeyHttpAction } from "./apiKeyHttp";
import type { DataModel } from "./_generated/dataModel";
import type { GenericActionCtx } from "convex/server";
import { internal } from "./_generated/api";
import { failure, clientFailure } from "./httpErrors";
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

function objectField(body: object, name: string): unknown {
  return name in body ? body[name as keyof typeof body] : undefined;
}

export const startDeployment = apiKeyHttpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return clientFailure("Invalid JSON body"); }
if (!body || typeof body !== "object") return clientFailure("Invalid deployment body");
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
) return clientFailure("Invalid deployment fields");
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId,
  requiredScope: "docs:write",
});
if (!principal) return clientFailure("Invalid or insufficient API key", 401);
try {
  const deployment = await ctx.runMutation(internal.deployments.startInternal, {
    organizationId,
    projectId,
    manifestSha256,
    fileCount,
    byteCount,
    provenance: provenance as Provenance,
    actorId: `api-key:${principal.keyId}`,
  });
  return Response.json({ deployment }, { status: 201 });
} catch (error: unknown) {
  return failure(error, 400, "startDeployment");
} });

export const getStagingDeployment = apiKeyHttpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const url = new URL(request.url);
const organizationId = url.searchParams.get("organizationId");
const projectId = url.searchParams.get("projectId");
const deploymentId = url.searchParams.get("deploymentId");
if (!organizationId || !projectId || !deploymentId) return clientFailure("Missing deployment identity");
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId,
  requiredScope: "docs:write",
});
if (!principal) return clientFailure("Invalid or insufficient API key", 401);
try {
  const deployment = await ctx.runMutation(internal.deployments.refreshStagingInternal, {
    organizationId,
    projectId,
    deploymentId,
  });
  if (!deployment) {
    return clientFailure("Staging deployment not found", 404);
  }
  return Response.json({ deployment, principal });
} catch (error: unknown) {
  return failure(error, 404, "getStagingDeployment");
} });

export const commitDeployment = apiKeyHttpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return clientFailure("Invalid JSON body"); }
if (!body || typeof body !== "object") return clientFailure("Invalid commit body");
const organizationId = objectField(body, "organizationId");
const projectId = objectField(body, "projectId");

const deploymentId = objectField(body, "deploymentId");
if (typeof organizationId !== "string" || typeof projectId !== "string" || typeof deploymentId !== "string") {
  return clientFailure("Missing deployment identity");
}
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId,
  requiredScope: "docs:write",
});
if (!principal) return clientFailure("Invalid or insufficient API key", 401);
try {
  const result = await ctx.runMutation(internal.deployments.commitInternal, {
    attestation: request.headers.get(STORAGE_ATTESTATION_HEADER) ?? undefined,
    organizationId,
    projectId,
    deploymentId,
    actorId: `api-key:${principal.keyId}`,
  });
  return Response.json(result);
} catch (error: unknown) {
  return failure(error, 409, "commitDeployment");
} });
export const getActiveDeployment = sessionOrApiKeyHttpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const url = new URL(request.url);
const organizationId = url.searchParams.get("organizationId");
const projectId = url.searchParams.get("projectId");
if (!organizationId || !projectId) return clientFailure("Missing project identity");
const apiPrincipal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId,
  requiredScope: "docs:read",
});
let principal: { kind: "api-key"; keyId: string } | { kind: "session"; userId: string };
if (apiPrincipal) {
  principal = { kind: "api-key", keyId: apiPrincipal.keyId };
} else {
  try {
    const { user } = await authorizeHttpOrganization(ctx, request.headers, organizationId);
    principal = { kind: "session", userId: user._id };
  } catch (error) {
    return failure(error, 403, "getActiveDeployment");
  }
}
const project = await ctx.runQuery(internal.projects.getInternal, {
  organizationId,
  projectId,
});
if (!project) return clientFailure("Project not found", 404);
if (!project.activeDeploymentId) {
  return Response.json({ project, deployment: null, principal });
}
const deployment = await ctx.runQuery(internal.deployments.getInternal, {
  organizationId,
  projectId,
  deploymentId: project.activeDeploymentId,
});
return Response.json({ project, deployment, principal }); });

export const failDeployment = apiKeyCleanupHttpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return clientFailure("Invalid JSON body"); }
if (!body || typeof body !== "object") return clientFailure("Invalid failure body");
const organizationId = objectField(body, "organizationId");
const projectId = objectField(body, "projectId");
const deploymentId = objectField(body, "deploymentId");
const reason = objectField(body, "reason");
if (
  typeof organizationId !== "string"
  || typeof projectId !== "string"
  || typeof deploymentId !== "string"
  || typeof reason !== "string"
) return clientFailure("Missing deployment failure fields");
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId,
  requiredScope: "docs:write",
});
if (!principal) return clientFailure("Invalid or insufficient API key", 401);
await ctx.runMutation(internal.deployments.failInternal, {
  organizationId,
  projectId,
  deploymentId,
  reason,
});
return Response.json({ status: true }); });

export const listDeployments = sessionOrApiKeyHttpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const url = new URL(request.url);
const organizationId = url.searchParams.get("organizationId");
const projectId = url.searchParams.get("projectId");
if (!organizationId || !projectId) return clientFailure("organizationId and projectId are required");
try {
  const apiPrincipal = await validateApiCredential(ctx, request, {
    organizationId,
    projectId,
    requiredScope: "docs:read",
  });
  if (!apiPrincipal) await authorizeHttpOrganization(ctx, request.headers, organizationId);
  const project = await ctx.runQuery(internal.projects.getInternal, {
    organizationId,
    projectId,
  });
  if (!project) return clientFailure("Project not found", 404);
  const deployments = await ctx.runQuery(internal.deployments.listInternal, {
    organizationId,
    projectId,
  });
  return Response.json({ deployments });
} catch (error: unknown) {
  return failure(error, 403, "listDeployments");
} });
