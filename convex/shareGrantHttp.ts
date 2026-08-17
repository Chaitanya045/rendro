import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authorizeHttpOrganization } from "./authorization";

function failure(error: unknown, status = 400): Response {
  return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export const createShareGrant = httpAction(async (ctx, request) => {
  let body: unknown;
  try { body = await request.json(); } catch { return failure("Invalid JSON body"); }
  if (!body || typeof body !== "object") return failure("Invalid share body");
  const organizationId = "organizationId" in body ? body.organizationId : undefined;
  const projectId = "projectId" in body ? body.projectId : undefined;
  const documentPath = "documentPath" in body ? body.documentPath : undefined;
  const expiresInSeconds = "expiresInSeconds" in body ? body.expiresInSeconds : undefined;
  if (
    typeof organizationId !== "string"
    || typeof projectId !== "string"
    || typeof documentPath !== "string"
    || typeof expiresInSeconds !== "number"
    || expiresInSeconds < 60
    || expiresInSeconds > 60 * 60 * 24 * 30
  ) return failure("Invalid share fields");
  try {
    const { user } = await authorizeHttpOrganization(ctx, request.headers, organizationId);
    const token = randomToken();
    const grant = await ctx.runMutation(internal.shareGrants.createInternal, {
      organizationId,
      projectId: projectId as Id<"projects">,
      documentPath,
      tokenHash: await sha256(token),
      expiresAt: Date.now() + expiresInSeconds * 1000,
      actorId: user._id,
    });
    return Response.json({ grant, token, url: `/s/${token}` }, { status: 201 });
  } catch (error: unknown) {
    return failure(error, 403);
  }
});

export const listShareGrants = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const organizationId = url.searchParams.get("organizationId");
  const projectId = url.searchParams.get("projectId");
  if (!organizationId || !projectId) return failure("organizationId and projectId are required");
  try {
    await authorizeHttpOrganization(ctx, request.headers, organizationId);
    const shares = await ctx.runQuery(internal.shareGrants.listInternal, {
      organizationId,
      projectId: projectId as Id<"projects">,
    });
    return Response.json({ shares });
  } catch (error: unknown) {
    return failure(error, 403);
  }
});

export const revokeShareGrant = httpAction(async (ctx, request) => {
  let body: unknown;
  try { body = await request.json(); } catch { return failure("Invalid JSON body"); }
  if (!body || typeof body !== "object") return failure("Invalid share body");
  const organizationId = "organizationId" in body ? body.organizationId : undefined;
  const grantId = "grantId" in body ? body.grantId : undefined;
  if (typeof organizationId !== "string" || typeof grantId !== "string") {
    return failure("organizationId and grantId are required");
  }
  try {
    const { user } = await authorizeHttpOrganization(ctx, request.headers, organizationId, ["owner", "admin"]);
    await ctx.runMutation(internal.shareGrants.revokeInternal, {
      organizationId,
      grantId: grantId as Id<"shareGrants">,
      actorId: user._id,
    });
    return Response.json({ revoked: true });
  } catch (error: unknown) {
    return failure(error, 403);
  }
});

export const resolveShareGrant = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return failure("token is required");
  const result = await ctx.runQuery(internal.shareGrants.resolveInternal, { tokenHash: await sha256(token) });
  if (!result) return failure("Share not found", 404);
  return Response.json(result);
});
