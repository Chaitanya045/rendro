import { betterAuth } from "better-auth/minimal";
import { testUtils } from "better-auth/plugins";
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation } from "./_generated/server";
import { createAuthOptions } from "./auth";

const DEV_SITE_URL = "https://dev.rendro.app";
const DEV_DEPLOYMENT = "deafening-beagle-38";

type Check = { name: string; expected: number; actual: number; passed: boolean };

export const cleanupApplicationFixtures = internalMutation({
  args: { runId: v.string(), projectIds: v.array(v.id("projects")), keyIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (process.env.SITE_URL !== DEV_SITE_URL || !/^[a-f0-9]{16}$/.test(args.runId)) {
      throw new Error("QA fixture cleanup requires the dev site and a valid run ID");
    }
    let deleted = 0;
    for (const keyId of args.keyIds) {
      const credential = await ctx.db.query("apiKeyCredentials")
        .withIndex("by_key_id", (query) => query.eq("keyId", keyId)).unique();
      if (!credential || !credential.name.endsWith(args.runId)) throw new Error("Credential fixture identity mismatch");
      await ctx.db.delete(credential._id); deleted += 1;
      const audits = await ctx.db.query("auditEvents")
        .withIndex("by_resource", (query) => query.eq("resourceType", "api_key").eq("resourceId", keyId)).collect();
      for (const audit of audits) { await ctx.db.delete(audit._id); deleted += 1; }
    }
    for (const projectId of args.projectIds) {
      const project = await ctx.db.get(projectId);
      if (!project || !project.slug.endsWith(args.runId)) throw new Error("Project fixture identity mismatch");
      await ctx.db.delete(project._id); deleted += 1;
      const audits = await ctx.db.query("auditEvents")
        .withIndex("by_resource", (query) => query.eq("resourceType", "project").eq("resourceId", projectId)).collect();
      for (const audit of audits) { await ctx.db.delete(audit._id); deleted += 1; }
    }
    return deleted;
  },
});

export const countApplicationFixtures = internalMutation({
  args: { projectIds: v.array(v.id("projects")), keyIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    let count = 0;
    for (const projectId of args.projectIds) if (await ctx.db.get(projectId)) count += 1;
    for (const keyId of args.keyIds) if (await ctx.db.query("apiKeyCredentials")
      .withIndex("by_key_id", (query) => query.eq("keyId", keyId)).unique()) count += 1;
    return count;
  },
});

const cleanupRef = makeFunctionReference<"mutation", { runId: string; projectIds: string[]; keyIds: string[] }, number>(
  "qaPermissionFixtures:cleanupApplicationFixtures",
);
const countRef = makeFunctionReference<"mutation", { projectIds: string[]; keyIds: string[] }, number>(
  "qaPermissionFixtures:countApplicationFixtures",
);

export const run = internalAction({
  args: { confirmDeployment: v.literal(DEV_DEPLOYMENT) },
  handler: async (ctx) => {
    if (process.env.SITE_URL !== DEV_SITE_URL) throw new Error("QA permission fixtures require the dev site");
    const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const options = createAuthOptions(ctx);
    // Prepare a correctly signed legacy cache cookie to verify that deployed
    // endpoints reject it after revocation, even if new cookies stop being cached.
    // This configuration belongs ONLY to the internal fixture instance.
    const auth = betterAuth({ ...options, session: { ...options.session, cookieCache: { enabled: true, maxAge: 300 } }, plugins: [...options.plugins, testUtils()] });
    const authContext = await auth.$context;
    const test = authContext.test;
    if (!test?.login || !test.deleteOrganization) {
      throw new Error("Better Auth test fixture helpers unavailable");
    }

    const roles = ["owner", "admin", "member", "outsider"] as const;
    const userDrafts = roles.map((role) => ({
      email: `qa-${role}-${runId}@rendro.invalid`,
      name: `QA ${role}`,
      emailVerified: true,
    }));
    const checks: Check[] = [];
    const sessionTokens: string[] = [];
    const headers = new Map<(typeof roles)[number], Headers>();
    const cachedHeaders = new Map<(typeof roles)[number], Headers>();
    const users: Awaited<ReturnType<typeof authContext.internalAdapter.createUser>>[] = [];
    const organizationIds: string[] = [];
    const teamIds: string[] = [];
    const projectIds: string[] = [];
    const keyIds: string[] = [];
    let cleanupDeleted: number;
    let remaining: number;
    let cleanupFailed = false;
    let phase = "seed-users";
    let executionError: string | null = null;

    const record = (name: string, expected: number, actual: number) => {
      checks.push({ name, expected, actual, passed: expected === actual });
    };
    const call = async (role: (typeof roles)[number] | "anonymous", path: string, init?: RequestInit) => {
      const requestHeaders = new Headers(init?.headers);
      if (role !== "anonymous") {
        const cookie = headers.get(role)?.get("cookie");
        if (cookie) requestHeaders.set("cookie", cookie);
      }
      requestHeaders.set("accept", "application/json");
      requestHeaders.set("origin", DEV_SITE_URL);
      if (init?.body) requestHeaders.set("content-type", "application/json");
      return fetch(`${DEV_SITE_URL}${path}`, { ...init, headers: requestHeaders, redirect: "manual" });
    };
    const captureCookies = (base: Headers, response: Response): Headers => {
      const result = new Headers(base);
      const setCookies = response.headers.getSetCookie?.() ?? [];
      if (setCookies.length === 0) {
        const combined = response.headers.get("set-cookie");
        if (combined) setCookies.push(combined);
      }
      const cookiePairs = setCookies
        .map((value) => value.split(";", 1)[0])
        .filter(Boolean);
      if (cookiePairs.length > 0) {
        const existing = result.get("cookie");
        result.set("cookie", [existing, ...cookiePairs].filter(Boolean).join("; "));
      }
      return result;
    };

    try {
      // Convex assigns IDs; generic fixture factories supply incompatible IDs.
      for (const user of userDrafts) users.push(await authContext.internalAdapter.createUser(user));
      phase = "seed-organizations";
      const primaryOrg = await authContext.adapter.create<{ id: string }>({ model: "organization", data: {
        name: `QA permissions ${runId}`,
        slug: `qa-permissions-${runId}`,
        createdAt: new Date(),
      } });
      const primaryOrgId = String(primaryOrg.id);
      organizationIds.push(primaryOrgId);
      const outsiderOrg = await authContext.adapter.create<{ id: string }>({ model: "organization", data: {
        name: `QA outsider ${runId}`,
        slug: `qa-outsider-${runId}`,
        createdAt: new Date(),
      } });
      const outsiderOrgId = String(outsiderOrg.id);
      organizationIds.push(outsiderOrgId);
      const projectPath = `/api/rendro/projects?organizationId=${encodeURIComponent(primaryOrgId)}`;
      phase = "seed-memberships";
      const addMember = (userId: string, organizationId: string, role: string) => authContext.adapter.create<{ id: string }>({
        model: "member", data: { userId, organizationId, role, createdAt: new Date() },
      });
      const ownerMember = await addMember(users[0].id, primaryOrgId, "owner");
      const adminMember = await addMember(users[1].id, primaryOrgId, "admin");
      const memberMember = await addMember(users[2].id, primaryOrgId, "member");
      await addMember(users[3].id, outsiderOrgId, "owner");

      for (let index = 0; index < roles.length; index += 1) {
        phase = `authenticate-${roles[index]}`;
        const login = await test.login({ userId: users[index].id });
        sessionTokens.push(login.session.token);
        await authContext.internalAdapter.updateSession(login.session.token, {
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
        });
        headers.set(roles[index], login.headers);
        const session = await call(roles[index], "/api/auth/get-session");
        record(`get-session:${roles[index]}`, 200, session.status);
        const sessionBody = await session.clone().json() as { user?: { id?: string } } | null;
        record(`get-session:${roles[index]}:identity`, 1, sessionBody?.user?.id === users[index].id ? 1 : 0);
        if (sessionBody?.user?.id !== users[index].id) throw new Error("Fixture session identity mismatch");
        const legacySession = await auth.api.getSession({ headers: login.headers, asResponse: true });
        cachedHeaders.set(roles[index], captureCookies(login.headers, legacySession));
        record(`get-session:${roles[index]}:legacy-cache-prepared`, 1, /session_data/.test(cachedHeaders.get(roles[index])?.get("cookie") ?? "") ? 1 : 0);
      }
      phase = "http-permission-matrix";

      const memberOrganization = await call("member", `/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(primaryOrgId)}`);
      record("organization:get-full:member", 200, memberOrganization.status);
      const outsiderOrganization = await call("outsider", `/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(primaryOrgId)}`);
      record("organization:get-full:outsider", 403, outsiderOrganization.status);

      record("projects:list:owner", 200, (await call("owner", projectPath)).status);
      record("projects:list:admin", 200, (await call("admin", projectPath)).status);
      record("projects:list:member", 200, (await call("member", projectPath)).status);
      record("projects:list:outsider", 403, (await call("outsider", projectPath)).status);
      record("projects:list:anonymous", 403, (await call("anonymous", projectPath)).status);

      const createProject = async (
        role: "owner" | "admin" | "member" | "outsider",
        organizationId: string,
        slug: string,
      ) => {
        const response = await call(role, "/api/rendro/projects", {
          method: "POST",
          body: JSON.stringify({ organizationId, name: slug, slug }),
        });
        const value = await response.clone().json().catch(() => null) as { project?: { _id?: string } } | null;
        if (value?.project?._id) projectIds.push(value.project._id);
        return response;
      };
      const ownerProject = await createProject("owner", primaryOrgId, `owner-${runId}`);
      record("projects:create:owner", 201, ownerProject.status);
      const adminProject = await createProject("admin", primaryOrgId, `admin-${runId}`);
      record("projects:create:admin", 201, adminProject.status);
      record("projects:create:member", 403, (await createProject("member", primaryOrgId, `member-${runId}`)).status);

      const credentialPath = `/api/rendro/credentials?organizationId=${encodeURIComponent(primaryOrgId)}`;
      record("credentials:list:owner", 200, (await call("owner", credentialPath)).status);
      record("credentials:list:admin", 200, (await call("admin", credentialPath)).status);
      record("credentials:list:member", 403, (await call("member", credentialPath)).status);
      const createCredential = async (role: "owner" | "admin" | "member", name: string) => {
        const response = await call(role, "/api/rendro/credentials", {
          method: "POST",
          body: JSON.stringify({ organizationId: primaryOrgId, name, scopes: ["docs:read"] }),
        });
        const value = await response.clone().json().catch(() => null) as { credential?: { keyId?: string } } | null;
        if (value?.credential?.keyId) keyIds.push(value.credential.keyId);
        return response;
      };
      const ownerCredential = await createCredential("owner", `owner-${runId}`);
      record("credentials:create:owner", 201, ownerCredential.status);
      const adminCredential = await createCredential("admin", `admin-${runId}`);
      record("credentials:create:admin", 201, adminCredential.status);
      record("credentials:create:member", 403, (await createCredential("member", `member-${runId}`)).status);

      const authPost = (role: (typeof roles)[number], action: string, body: Record<string, unknown>) =>
        call(role, `/api/auth/organization/${action}`, { method: "POST", body: JSON.stringify(body) });
      for (const role of ["owner", "admin", "member"] as const) {
        const response = await authPost(role, "create-team", { organizationId: primaryOrgId, name: `QA ${role} ${runId}` });
        const team = await response.clone().json().catch(() => null) as { id?: string } | null;
        if (team?.id) teamIds.push(team.id);
        record(`teams:create:${role}`, role === "member" ? 403 : 200, response.status);
      }
      if (!teamIds[0]) throw new Error("Fixture team unavailable");
      const teamBody = { organizationId: primaryOrgId, teamId: teamIds[0], userId: users[2].id };
      record("teams:add:member-denied", 403, (await authPost("member", "add-team-member", teamBody)).status);
      record("teams:add:admin", 200, (await authPost("admin", "add-team-member", teamBody)).status);
      record("teams:add:duplicate-idempotent", 200, (await authPost("admin", "add-team-member", teamBody)).status);
      record("teams:add:single-membership", 1, (await authContext.adapter.findMany({ model: "teamMember", where: [{ field: "teamId", value: teamIds[0] }, { field: "userId", value: users[2].id }] })).length);
      record("teams:remove-member:member-denied", 403, (await authPost("member", "remove-team-member", teamBody)).status);
      record("teams:remove-member:admin", 200, (await authPost("admin", "remove-team-member", teamBody)).status);
      record("teams:remove-member:organization-access-retained", 200, (await call("member", projectPath)).status);
      record("teams:remove:member-denied", 403, (await authPost("member", "remove-team", teamBody)).status);
      record("teams:remove:owner", 200, (await authPost("owner", "remove-team", teamBody)).status);

      // Seed only invitation records; this does not invoke or certify email delivery.
      // Invite the outsider only after all outsider-isolation assertions are finished below.

      const selfEscalation = await call("member", "/api/auth/organization/update-member-role", {
        method: "POST", body: JSON.stringify({ organizationId: primaryOrgId, memberId: String(memberMember.id), role: "admin" }),
      });
      record("role:self-escalation", 403, selfEscalation.status);
      const downgrade = await call("owner", "/api/auth/organization/update-member-role", {
        method: "POST", body: JSON.stringify({ organizationId: primaryOrgId, memberId: String(adminMember.id), role: "member" }),
      });
      record("role:owner-downgrades-admin", 200, downgrade.status);
      record("role:downgraded-admin-loses-write", 403, (await createProject("admin", primaryOrgId, `downgraded-${runId}`)).status);
      const promote = await call("owner", "/api/auth/organization/update-member-role", {
        method: "POST", body: JSON.stringify({ organizationId: primaryOrgId, memberId: String(memberMember.id), role: "admin" }),
      });
      record("role:owner-promotes-member", 200, promote.status);
      const promotedProject = await createProject("member", primaryOrgId, `promoted-${runId}`);
      record("role:promoted-member-gains-write", 201, promotedProject.status);
      const remove = await call("owner", "/api/auth/organization/remove-member", {
        method: "POST", body: JSON.stringify({ organizationId: primaryOrgId, memberIdOrEmail: users[2].email }),
      });
      record("role:owner-removes-member", 200, remove.status);
      record("role:removed-member-loses-read", 403, (await call("member", projectPath)).status);

      const foreignProjectResponse = await createProject("outsider", outsiderOrgId, `foreign-${runId}`);
      record("foreign-project:create", 201, foreignProjectResponse.status);
      const foreignBody = await foreignProjectResponse.json() as { project?: { _id?: string } };
      const foreignId = foreignBody.project?._id ?? "missing";
      record("foreign-project:lookup-denied", 404, (await call(
        "owner",
        `/api/rendro/projects/get?organizationId=${encodeURIComponent(primaryOrgId)}&projectId=${encodeURIComponent(foreignId)}`,
      )).status);

      const seedInvitation = (status = "pending", expired = false) => authContext.adapter.create<{ id: string }>({
        model: "invitation", data: {
          organizationId: primaryOrgId, email: users[3].email, inviterId: users[0].id, role: "member", status,
          createdAt: new Date(), expiresAt: new Date(Date.now() + (expired ? -60_000 : 15 * 60_000)),
        },
      });
      const expiredInvite = await seedInvitation("pending", true);
      record("invitations:expired-accept-denied", 400, (await authPost("outsider", "accept-invitation", { invitationId: expiredInvite.id })).status);
      const declinedInvite = await seedInvitation();
      record("invitations:wrong-recipient-denied", 403, (await authPost("owner", "accept-invitation", { invitationId: declinedInvite.id })).status);
      record("invitations:decline", 200, (await authPost("outsider", "reject-invitation", { invitationId: declinedInvite.id })).status);
      record("invitations:declined-accept-denied", 400, (await authPost("outsider", "accept-invitation", { invitationId: declinedInvite.id })).status);
      const cancelledInvite = await seedInvitation();
      record("invitations:cancel", 200, (await authPost("owner", "cancel-invitation", { invitationId: cancelledInvite.id })).status);
      record("invitations:cancelled-accept-denied", 400, (await authPost("outsider", "accept-invitation", { invitationId: cancelledInvite.id })).status);
      const acceptedInvite = await seedInvitation();
      record("invitations:accept", 200, (await authPost("outsider", "accept-invitation", { invitationId: acceptedInvite.id })).status);
      record("invitations:accepted-member-can-read", 200, (await call("outsider", projectPath)).status);
      record("invitations:accepted-member-cannot-write", 403, (await createProject("outsider", primaryOrgId, `invited-${runId}`)).status);
      record("invitations:duplicate-accept-denied", 400, (await authPost("outsider", "accept-invitation", { invitationId: acceptedInvite.id })).status);
      record("invitations:single-membership", 1, (await authContext.adapter.findMany({ model: "member", where: [{ field: "organizationId", value: primaryOrgId }, { field: "userId", value: users[3].id }] })).length);

      await authContext.internalAdapter.updateSession(sessionTokens[1], { expiresAt: new Date(Date.now() - 1_000) });
      record("session:expired-uncached-denied", 403, (await call("admin", projectPath)).status);
      headers.set("admin", cachedHeaders.get("admin") ?? new Headers());
      record("session:expired-cached-denied", 403, (await call("admin", projectPath)).status);
      await authContext.internalAdapter.deleteSession(sessionTokens[0]);
      record("session:revoked-uncached-denied", 403, (await call("owner", projectPath)).status);
      headers.set("owner", cachedHeaders.get("owner") ?? new Headers());
      record("session:revoked-cached-denied", 403, (await call("owner", projectPath)).status);
      record("session:revoked-cached-native-organization-denied", 401, (await call("owner", `/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(primaryOrgId)}`)).status);
      void ownerMember;
    } catch (error) {
      // Never return exception messages/arguments, which may include session material.
      executionError = error instanceof Error ? error.name : "UnknownError";
    } finally {
      for (const user of users) {
        await authContext.internalAdapter.deleteUserSessions(user.id).catch(() => { cleanupFailed = true; });
      }
      cleanupDeleted = await ctx.runMutation(cleanupRef, { runId, projectIds, keyIds }).catch(() => {
        cleanupFailed = true;
        return 0;
      });
      for (const organizationId of organizationIds) {
        // Delete only teams belonging to this run's exact organization IDs,
        // including any unexpected successful writes whose response was lost.
        const teams = await authContext.adapter.findMany<{ id: string }>({ model: "team", where: [{ field: "organizationId", value: organizationId }] }).catch(() => { cleanupFailed = true; return []; });
        for (const team of teams) {
          if (!teamIds.includes(team.id)) teamIds.push(team.id);
          await authContext.adapter.deleteMany({ model: "teamMember", where: [{ field: "teamId", value: team.id }] }).catch(() => { cleanupFailed = true; });
          await authContext.adapter.delete({ model: "team", where: [{ field: "id", value: team.id }] }).catch(() => { cleanupFailed = true; });
        }
        await test.deleteOrganization(organizationId).catch(() => { cleanupFailed = true; });
      }
      for (const user of users) {
        await authContext.internalAdapter.deleteAccounts(user.id).catch(() => { cleanupFailed = true; });
        await authContext.internalAdapter.deleteUser(user.id).catch(() => { cleanupFailed = true; });
      }
      const remainingApplication = await ctx.runMutation(countRef, { projectIds, keyIds }).catch(() => {
        cleanupFailed = true;
        return -1;
      });
      let remainingAuth = 0;
      for (const user of users) {
        if (await authContext.internalAdapter.findUserById(user.id)) remainingAuth += 1;
        remainingAuth += (await authContext.internalAdapter.listSessions(user.id)).length;
        remainingAuth += (await authContext.internalAdapter.findAccounts(user.id)).length;
      }
      for (const organizationId of organizationIds) {
        if (await authContext.adapter.findOne({
          model: "organization",
          where: [{ field: "id", value: organizationId }],
        })) remainingAuth += 1;
        remainingAuth += (await authContext.adapter.findMany({
          model: "member",
          where: [{ field: "organizationId", value: organizationId }],
        })).length;
        for (const model of ["team", "invitation"]) remainingAuth += (await authContext.adapter.findMany({ model, where: [{ field: "organizationId", value: organizationId }] })).length;
      }
      for (const teamId of teamIds) remainingAuth += (await authContext.adapter.findMany({ model: "teamMember", where: [{ field: "teamId", value: teamId }] })).length;
      remaining = remainingApplication + remainingAuth;
    }

    const passed = checks.filter((check) => check.passed).length;
    return { runId, checks, passed, total: checks.length, cleanupDeleted, remaining, cleanupFailed, executionError, phase };
  },
});
