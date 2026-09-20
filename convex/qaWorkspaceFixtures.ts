// Internal, DEV-only synthetic workspace fixtures. No credentials or sessions.
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation } from "./_generated/server";
import { createAuth } from "./auth";

const args = { confirmDeployment: v.literal("deafening-beagle-38"), organizationId: v.string(), runId: v.string() };
function guard(runId: string) {
  if (process.env.SITE_URL !== "https://dev.rendro.app" || !/^[a-f0-9]{16}$/.test(runId)) throw new Error("DEV fixture identity required");
}
const applicationRef = makeFunctionReference<"mutation", { organizationId: string; runId: string; cleanup: boolean }, number>("qaWorkspaceFixtures:application");
export const application = internalMutation({
  args: { organizationId: v.string(), runId: v.string(), cleanup: v.boolean() },
  handler: async (ctx, input) => {
    guard(input.runId);
    // Validate the organization independently even for direct internal calls.
    const auth = await createAuth(ctx).$context;
    const org = await auth.adapter.findOne<{ slug: string }>({ model: "organization", where: [{ field: "id", value: input.organizationId }] });
    if (org?.slug !== `qa-regression-${input.runId}`) throw new Error("Fixture organization mismatch");
    const projects = await ctx.db.query("projects").withIndex("by_organization", q => q.eq("organizationId", input.organizationId)).collect();
    if (input.cleanup) {
      for (const table of ["apiKeyCredentials", "publications", "shareGrants"] as const) {
        if (await ctx.db.query(table).withIndex("by_organization", q => q.eq("organizationId", input.organizationId)).first()) throw new Error("Workspace has additional resources; explicit cleanup required");
      }
      // This workspace is disposable, but do not silently remove document data.
      for (const project of projects) {
        const deployments = await ctx.db.query("deployments").withIndex("by_project_created", q => q.eq("projectId", project._id)).first();
        if (deployments) throw new Error("Workspace has deployments; explicit storage cleanup required");
      }
      for (const project of projects) await ctx.db.delete(project._id);
      const audits = await ctx.db.query("auditEvents").withIndex("by_organization_created", q => q.eq("organizationId", input.organizationId)).collect();
      for (const audit of audits) await ctx.db.delete(audit._id);
      return projects.length + audits.length;
    }
    if (projects.some(p => p.slug.startsWith("qa-scale-"))) throw new Error("Fixture already seeded");
    for (let index = 0; index < 120; index++) await ctx.db.insert("projects", {
      organizationId: input.organizationId, name: `QA scale project ${String(index + 1).padStart(3, "0")}${index === 119 ? " — long documentation product title" : ""}`,
      slug: `qa-scale-${index + 1}`, createdBy: `qa-${input.runId}`, createdAt: Date.now() + index,
    });
    return 120;
  },
});

export const seed = internalAction({ args, handler: async (ctx, input) => {
  guard(input.runId);
  const auth = await createAuth(ctx).$context;
  const org = await auth.adapter.findOne<{ slug: string }>({ model: "organization", where: [{ field: "id", value: input.organizationId }] });
  if (org?.slug !== `qa-regression-${input.runId}`) throw new Error("Fixture organization mismatch");
  // Deterministic addresses make partial-seed cleanup possible without returning users.
  for (let index = 0; index < 120; index++) {
    const email = `qa-scale-${index}-${input.runId}@rendro.invalid`;
    if (await auth.adapter.findOne({ model: "user", where: [{ field: "email", value: email }] })) throw new Error("Fixture already seeded; clean up first");
    const user = await auth.internalAdapter.createUser({ email, name: `QA Member ${String(index + 1).padStart(3, "0")}`, emailVerified: true });
    await auth.adapter.create({ model: "member", data: { organizationId: input.organizationId, userId: user.id, role: index === 0 ? "admin" : "member", createdAt: new Date() } });
  }
  for (let index = 0; index < 12; index++) await auth.adapter.create({ model: "team", data: { organizationId: input.organizationId, name: `QA team ${index + 1}`, createdAt: new Date() } });
  const projects = await ctx.runMutation(applicationRef, { organizationId: input.organizationId, runId: input.runId, cleanup: false });
  return { runId: input.runId, organizationId: input.organizationId, users: 120, projects, teams: 12 };
} });

export const cleanup = internalAction({ args, handler: async (ctx, input) => {
  guard(input.runId);
  const auth = await createAuth(ctx).$context;
  const org = await auth.adapter.findOne<{ slug: string }>({ model: "organization", where: [{ field: "id", value: input.organizationId }] });
  if (org?.slug !== `qa-regression-${input.runId}`) throw new Error("Fixture organization mismatch");
  const deletedApplication = await ctx.runMutation(applicationRef, { organizationId: input.organizationId, runId: input.runId, cleanup: true });
  const teams = await auth.adapter.findMany<{ id: string }>({ model: "team", where: [{ field: "organizationId", value: input.organizationId }], limit: 1000 });
  for (const team of teams) {
    await auth.adapter.deleteMany({ model: "teamMember", where: [{ field: "teamId", value: team.id }] });
    await auth.adapter.delete({ model: "team", where: [{ field: "id", value: team.id }] });
  }
  for (const model of ["invitation", "member"]) await auth.adapter.deleteMany({ model, where: [{ field: "organizationId", value: input.organizationId }] });
  let deletedUsers = 0;
  for (let index = 0; index < 120; index++) {
    const user = await auth.adapter.findOne<{ id: string }>({ model: "user", where: [{ field: "email", value: `qa-scale-${index}-${input.runId}@rendro.invalid` }] });
    if (!user) continue;
    await auth.internalAdapter.deleteUserSessions(user.id);
    await auth.internalAdapter.deleteAccounts(user.id);
    await auth.internalAdapter.deleteUser(user.id);
    deletedUsers++;
  }
  // Clear only active pointers to the workspace being removed; never revoke
  // the signed-in user's sessions or inspect/return their tokens.
  await auth.adapter.updateMany({ model: "session", where: [{ field: "activeOrganizationId", value: input.organizationId }], update: { activeOrganizationId: null, activeTeamId: null } });
  await auth.adapter.delete({ model: "organization", where: [{ field: "id", value: input.organizationId }] });
  let remaining = 0;
  if (await auth.adapter.findOne({ model: "organization", where: [{ field: "id", value: input.organizationId }] })) remaining++;
  for (let index = 0; index < 120; index++) if (await auth.adapter.findOne({ model: "user", where: [{ field: "email", value: `qa-scale-${index}-${input.runId}@rendro.invalid` }] })) remaining++;
  for (const model of ["member", "team", "invitation"]) remaining += (await auth.adapter.findMany({ model, where: [{ field: "organizationId", value: input.organizationId }], limit: 1000 })).length;
  for (const team of teams) remaining += (await auth.adapter.findMany({ model: "teamMember", where: [{ field: "teamId", value: team.id }], limit: 1000 })).length;
  return { runId: input.runId, deletedApplication, deletedUsers, remaining };
} });
