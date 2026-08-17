import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

function authorized(request: Request): boolean {
  const secret = process.env.RETENTION_SECRET;
  return Boolean(secret) && request.headers.get("Authorization") === `Bearer ${secret}`;
}

export const listRetentionCandidates = httpAction(async (ctx, request) => {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const now = Date.now();
  const deployments = await ctx.runQuery(internal.retention.candidatesInternal, {
    failedBefore: now - 24 * 60 * 60 * 1000,
    supersededBefore: now - 30 * 24 * 60 * 60 * 1000,
    limit: 50,
  });
  return Response.json({ deployments });
});

export const markRetentionPurged = httpAction(async (ctx, request) => {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const deploymentId = body && typeof body === "object" && "deploymentId" in body ? body.deploymentId : undefined;
  const objectCount = body && typeof body === "object" && "objectCount" in body ? body.objectCount : undefined;
  if (typeof deploymentId !== "string" || typeof objectCount !== "number") {
    return Response.json({ error: "deploymentId and objectCount are required" }, { status: 400 });
  }
  const purged = await ctx.runMutation(internal.retention.markPurgedInternal, {
    deploymentId: deploymentId as Id<"deployments">,
    objectCount,
  });
  return Response.json({ purged });
});
