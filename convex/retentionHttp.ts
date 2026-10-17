import { internal } from "./_generated/api";
import { httpAction } from "./httpErrors";
import { bearerMatches } from "../shared/constant-time";

function authorized(request: Request): boolean {
  return bearerMatches(request.headers.get("Authorization"), process.env.RETENTION_SECRET);
}

export const listRetentionCandidates = httpAction(async (ctx, request) => {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const result = await ctx.runMutation(internal.retention.candidatesInternal, { token: crypto.randomUUID() });
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
});

export const markRetentionPurged = httpAction(async (ctx, request) => {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const deploymentId = body && typeof body === "object" && "deploymentId" in body ? body.deploymentId : undefined;
  const objectCount = body && typeof body === "object" && "objectCount" in body ? body.objectCount : undefined;
  const purgeToken = body && typeof body === "object" && "purgeToken" in body ? body.purgeToken : undefined;
  if (typeof deploymentId !== "string" || typeof purgeToken !== "string"
    || typeof objectCount !== "number" || !Number.isSafeInteger(objectCount) || objectCount < 0) {
    return Response.json({ error: "deploymentId, purgeToken and non-negative integer objectCount are required" }, { status: 400 });
  }
  const purged = await ctx.runMutation(internal.retention.markPurgedInternal, { deploymentId, objectCount, purgeToken });
  return Response.json({ purged });
}, "bearer");
