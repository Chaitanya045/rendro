import type { GenericActionCtx } from "convex/server";
import type { DataModel } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction, failure, clientFailure } from "./httpErrors";
import { authorizeHttpOrganization } from "./authorization";
import { apiKeyHttpAction } from "./apiKeyHttp";
import { sha256 } from "./credentialHash";
import { usageDue } from "./apiKeyCredentials";
export { sha256 } from "./credentialHash";

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

// The UI offers 30 days, 90 days, 1 year or never. A year is 365 days there, so a leap day absorbs clock skew
// between the caller and this server; anything later is not a product choice.
export const API_KEY_MAX_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;

// Keys are created with an absolute millisecond timestamp, which must be an exact integer in the future and no later
// than the longest lifetime. Non-integers, 1e300 and the like are rejected rather than stored as an unrepresentable date.
export function validExpiresAt(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > now && value <= now + API_KEY_MAX_LIFETIME_MS;
}

// A repeated permission is requested once: the first occurrence keeps its position and the rest are dropped.
function allowedScopeArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const scopes = new Set<string>();
  for (const scope of value as unknown[]) {
    if (typeof scope !== "string" || !allowedScopes.has(scope)) return null;
    scopes.add(scope);
  }
  return [...scopes];
}

export const createCredential = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return clientFailure("Invalid JSON body"); }
if (!body || typeof body !== "object") return clientFailure("Invalid credential body");
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
  || (expiresAt !== undefined && !validExpiresAt(expiresAt, Date.now()))
) return clientFailure("Invalid credential fields");
try {
  const { user } = await authorizeHttpOrganization(
    ctx,
    request.headers,
    organizationId,
    ["owner", "admin"],
  );
  if (projectId !== undefined) {
    const project = await ctx.runQuery(internal.projects.getInternal, {
      organizationId,
      projectId,
    });
    if (!project) return clientFailure("Project not found", 404);
  }
  const keyId = randomHex(8);
  const secret = randomHex(32);
  const rawKey = `rnd_live_${keyId}_${secret}`;
  await ctx.runMutation(internal.apiKeyCredentials.createInternal, {
    organizationId,
    projectId,
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
  return failure(error, 403, "createCredential");
} }, "cookie-json");

export const listCredentials = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const organizationId = new URL(request.url).searchParams.get("organizationId");
if (!organizationId) return clientFailure("organizationId is required");
try {
  await authorizeHttpOrganization(ctx, request.headers, organizationId, ["owner", "admin"]);
  const credentials = await ctx.runQuery(internal.apiKeyCredentials.listInternal, { organizationId });
  return Response.json({ credentials });
} catch (error: unknown) {
  return failure(error, 403, "listCredentials");
} });

export const revokeCredential = httpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { let body: unknown;
try { body = await request.json(); } catch { return clientFailure("Invalid JSON body"); }
if (!body || typeof body !== "object") return clientFailure("Invalid revoke body");
const organizationId = "organizationId" in body ? body.organizationId : null;
const keyId = "keyId" in body ? body.keyId : null;
if (typeof organizationId !== "string" || typeof keyId !== "string") {
  return clientFailure("organizationId and keyId are required");
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
  return failure(error, 403, "revokeCredential");
} }, "cookie-json");

export async function validateApiCredential(
  ctx: GenericActionCtx<DataModel>,
  request: Request,
  input: {
    organizationId: string;
    projectId?: string;
    requiredScope: string;
  },
) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return null;
  const result = await ctx.runQuery(internal.apiKeyCredentials.validateInternal, {
    secretHash: await sha256(match[1]),
    ...input,
  });
  if (!result) return null;
  // The query is cached until its read set changes, so time is evaluated here.
  const now = Date.now();
  if (result.expiresAt !== undefined && result.expiresAt <= now) return null;
  if (usageDue(result.lastUsedAt, now)) {
    // Usage telemetry is best-effort and must never deny an authorized request.
    try {
      await ctx.runMutation(internal.apiKeyCredentials.recordUsageInternal, {
        credentialId: result.credentialId,
      });
    } catch {
      console.warn("API key usage telemetry failed", { operation: "recordUsage" });
    }
  }
  return result.principal;
}

export const validateCredential = apiKeyHttpAction(async (ctx: GenericActionCtx<DataModel>, request: Request) => { const url = new URL(request.url);
const organizationId = url.searchParams.get("organizationId");
const projectId = url.searchParams.get("projectId") ?? undefined;
const requiredScope = url.searchParams.get("scope");
if (!organizationId || !requiredScope) return clientFailure("organizationId and scope are required");
const principal = await validateApiCredential(ctx, request, {
  organizationId,
  projectId,
  requiredScope,
});
if (!principal) return clientFailure("Invalid or insufficient API key", 401);
return Response.json({ principal }); });
