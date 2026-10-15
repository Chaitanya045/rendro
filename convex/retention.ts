import { requireId } from "./ids";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { FAILED_RETENTION_MS, PURGE_CLAIM_MS, STAGING_DRAIN_MS, SUPERSEDED_RETENTION_MS, stagingExpiry } from "./retentionPolicy";

const phases = ["failed", "superseded", "staging"] as const;

// Selection, reference checks, claims, and continuation are one transaction.
// Empty pages still advance. A bounded run can stop anywhere and resume tomorrow.
export const candidatesInternal = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const now = Date.now();
    const progress = await ctx.db.query("retentionProgress").withIndex("by_name", q => q.eq("name", "deployments")).unique();
    const phase = progress?.phase ?? 0;
    const cutoff = progress?.cutoff ?? now;
    const status = phases[phase];
    const query = status === "staging"
      ? ctx.db.query("deployments").withIndex("by_staging_expiry", q => q.eq("status", "staging").eq("purgedAt", undefined).lte("stagingExpiresAt", cutoff - STAGING_DRAIN_MS))
      : ctx.db.query("deployments").withIndex("by_retention", q => q.eq("status", status).eq("purgedAt", undefined)
        .lte("createdAt", cutoff - (status === "failed" ? FAILED_RETENTION_MS : SUPERSEDED_RETENTION_MS)));
    // Pagination may cross the byte budget by one document (at most 1 MiB).
    // Three candidates also bound the three reference reads per candidate to
    // 9 MiB, leaving headroom below the 16 MiB transaction read limit. A large
    // legacy row still advances; claims never rewrite deployment documents.
    const page = await query.paginate({ cursor: progress?.cursor ?? null, numItems: 3, maximumBytesRead: 256 * 1024 });
    const deployments = [];
    for (const deployment of page.page) {
      const claim = await ctx.db.query("deploymentPurges").withIndex("by_deployment", q => q.eq("deploymentId", deployment._id)).unique();
      if (claim?.purgedAt !== undefined || (claim?.claimUntil ?? deployment.purgeClaimUntil ?? 0) > now) continue;
      // Also drain in-flight writes after an explicit failure, including old rows.
      if (status !== "superseded" && stagingExpiry(deployment) + STAGING_DRAIN_MS > now) continue;
      const project = await ctx.db.get(deployment.projectId);
      if (project?.activeDeploymentId === deployment._id) continue;
      if (await ctx.db.query("publications").withIndex("by_pinned_deployment", q => q.eq("pinnedDeploymentId", deployment._id)).first()) continue;
      if (await ctx.db.query("shareGrants").withIndex("by_deployment_live", q => q.eq("deploymentId", deployment._id)
        .eq("revokedAt", undefined).gt("expiresAt", now)).first()) continue;
      const fields = { deploymentId: deployment._id, purgeToken: token, claimUntil: now + PURGE_CLAIM_MS };
      if (claim) await ctx.db.patch(claim._id, fields);
      else await ctx.db.insert("deploymentPurges", fields);
      deployments.push({ _id: deployment._id, organizationId: deployment.organizationId, projectId: deployment.projectId, purgeToken: token });
    }
    const cycleComplete = page.isDone && phase === phases.length - 1;
    const next = {
      name: "deployments",
      phase: page.isDone ? (phase + 1) % phases.length : phase,
      cursor: page.isDone ? null : page.continueCursor,
      cutoff: cycleComplete ? now : cutoff,
    };
    if (progress) await ctx.db.patch(progress._id, next);
    else await ctx.db.insert("retentionProgress", next);
    return { deployments, cycleComplete, scanned: page.page.length };
  },
});

export const markPurgedInternal = internalMutation({
  args: { deploymentId: v.string(), purgeToken: v.string(), objectCount: v.number() },
  handler: async (ctx, args) => {
    const deployment = await ctx.db.get(requireId(ctx, "deployments", args.deploymentId));
    if (!deployment) return false;
    const claim = await ctx.db.query("deploymentPurges").withIndex("by_deployment", q => q.eq("deploymentId", deployment._id)).unique();
    if (!claim || claim.purgeToken !== args.purgeToken) return false;
    if (claim.purgedAt !== undefined) return true;
    const now = Date.now();
    await ctx.db.patch(claim._id, { purgedAt: now });
    await ctx.db.insert("auditEvents", {
      organizationId: deployment.organizationId,
      actorId: "retention-job",
      action: "deployment.purged",
      resourceType: "deployment",
      resourceId: deployment._id,
      metadata: { projectId: deployment.projectId, objectCount: args.objectCount },
      createdAt: now,
    });
    return true;
  },
});
