import type { Id } from "./_generated/dataModel";
import type { GenericActionCtx } from "convex/server";
import type { DataModel } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authorizeHttpOrganization } from "./authorization";

const allowedScopes = new Set([
  "docs:read",
  "docs:write",
  "publications:read",
  "publications:write",
]);

function randomHex(byteLength: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(byteLength)))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function failure(error: unknown, status = 400): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message || "Request failed" }, { status });
}

function allowedScopeArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const scopes: string[] = [];
  for (const scope of value as unknown[]) {
    if (typeof scope !== "string" || !allowedScopes.has(scope)) return null;
    scopes.push(scope);
  }
  return scopes;
}

export const createCredential = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return failure("Invalid JSON body"); }
if (!body || typeof body !== "object") return failure("Invalid credential body");
const organizationId = "organizationId" in body ? body.organizationId : null;
const projectId = "projectId" in body ? body.projectId : undefined;
const name = "name" in body ? body.name : null;
const scopes = allowedScopeArray("scopes" in body ? body.scopes : null);
const expiresAt = "expiresAt" in body ? body.expiresAt : undefined;
if (
  typeof organizationId !== "string"
  || typeof name !== "string"
  || name.trim().length === 0
  || name.trim().length > 80
  || !scopes
  || scopes.length === 0
  || (projectId !== undefined && typeof projectId !== "string")
  || (expiresAt !== undefined && (typeof expiresAt !== "number" || expiresAt <= Date.now()))
) return failure("Invalid credential fields");
try {
  const { user } = await authorizeHttpOrganization(
    ctx,
    request.headers,
    organizationId,
    ["owner", "admin"],
  );
  if (projectId) {
    const project = await ctx.runQuery(internal.projects.getInternal, {
      organizationId,
      projectId: projectId as Id<"projects">,
    });
    if (!project) return failure("Project not found", 404);
  }
  const keyId = randomHex(8);
  const secret = randomHex(32);
  const rawKey = `rnd_live_${keyId}_${secret}`;
  await ctx.runMutation(internal.apiKeyCredentials.createInternal, {
    organizationId,
    projectId: projectId as Id<"projects"> | undefined,
    keyId,
    keyPrefix: `rnd_live_${keyId}`,
    name: name.trim(),
    secretHash: await sha256(rawKey),
    scopes,
    expiresAt,
    actorId: user._id,
  });
  return Response.json({
    credential: { keyId, keyPrefix: `rnd_live_${keyId}`, name: name.trim(), scopes, projectId, expiresAt },
    rawKey,
  }, { status: 201 });
} catch (error: unknown) {
  return failure(error, 403);
} });

export const listCredentials = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const organizationId = new URL(request.url).searchParams.get("organizationId");
if (!organizationId) return failure("organizationId is required");
try {
  await authorizeHttpOrganization(ctx, request.headers, organizationId, ["owner", "admin"]);
  const credentials = await ctx.runQuery(internal.apiKeyCredentials.listInternal, { organizationId });
  return Response.json({ credentials });
} catch (error: unknown) {
  return failure(error, 403);
} });

export const revokeCredential = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return failure("Invalid JSON body"); }
if (!body || typeof body !== "object") return failure("Invalid revoke body");
const organizationId = "organizationId" in body ? body.organizationId : null;
const keyId = "keyId" in body ? body.keyId : null;
if (typeof organizationId !== "string" || typeof keyId !== "string") {
  return failure("organizationId and keyId are required");
}
try {
  const { user } = await authorizeHttpOrganization(
    ctx,
    request.headers,
    organizationId,
    ["owner", "admin"],
  );
  await ctx.runMutation(internal.apiKeyCredentials.revokeInternal, {
    organizationId,
    keyId,
    actorId: user._id,
  });
  return Response.json({ status: true });
} catch (error: unknown) {
  return failure(error, 403);
} });

export async function validateApiCredential(
  ctx: GenericActionCtx<DataModel>,
  request: Request,
  input: {
    organizationId: string;
    projectId?: Id<"projects">;
    requiredScope: string;
  },
) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return null;
  return ctx.runMutation(internal.apiKeyCredentials.validateInternal, {
    secretHash: await sha256(match[1]),
    ...input,
  });
}

export const validateCredential = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const url = new URL(request.url);
const organizationId = url.searchParams.get("organizationId");
const projectId = url.searchParams.get("projectId") ?? undefined;
const requiredScope = url.searchParams.get("scope");
if (!organizationId || !requiredScope) return failure("organizationId and scope are required");
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId: projectId as Id<"projects"> | undefined,
  requiredScope,
});
if (!principal) return failure("Invalid or insufficient API key", 401);
return Response.json({ principal }); });
