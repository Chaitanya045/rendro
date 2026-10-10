import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { components, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import authSchema from "../convex/betterAuth/schema";

// Exercise the real session/membership path in addition to the larger HTTP
// matrix's mocked session authorization. All records live in convex-test.
async function fixture() {
  const backend = convexTest(schema, import.meta.glob("../convex/**/*.ts"));
  backend.registerComponent("betterAuth", authSchema, import.meta.glob("../convex/betterAuth/**/*.ts"));
  const now = Date.now();
  const token = "test-session-token";
  const seeded = await backend.run(async ctx => {
    const organization = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "organization", data: { name: "Test", slug: "test", createdAt: now },
    } });
    const user = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "user", data: { name: "Owner", email: "owner@example.test", emailVerified: true, createdAt: now, updatedAt: now },
    } });
    const member = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "member", data: { organizationId: organization._id, userId: user._id, role: "owner", createdAt: now },
    } });
    await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "session", data: { userId: user._id, token, createdAt: now, updatedAt: now, expiresAt: now + 60_000 },
    } });
    const team = await ctx.runMutation(components.betterAuth.adapter.create, { input: {
      model: "team", data: { organizationId: organization._id, name: "Test team", createdAt: now },
    } });
    return {
      organizationId: organization._id as string,
      userId: user._id as string,
      memberId: member._id as string,
      teamId: team._id as string,
    };
  });
  const project = await backend.mutation(internal.projects.createInternal, { organizationId: seeded.organizationId, name: "Docs", slug: "docs", actorId: seeded.userId });
  if (!project) throw new Error("Missing project");
  const signature = createHmac("sha256", process.env.AUTH_SECRET!).update(token).digest("base64");
  const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
  return { backend, projectId: project._id, cookie, ...seeded };
}

describe("real-session ID boundaries", () => {
  it("keeps valid sessions working and rejects malformed project IDs in the fallback and credential creation", async () => {
    const f = await fixture();
    const headers = { cookie: f.cookie };
    const query = new URLSearchParams({ organizationId: f.organizationId, projectId: f.projectId });
    const valid = await f.backend.fetch(`/api/rendro/deployments/active?${query}`, { headers });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ principal: { kind: "session", userId: f.userId } });
    for (const projectId of ["not-an-id", f.memberId]) {
      query.set("projectId", projectId);
      const response = await f.backend.fetch(`/api/rendro/deployments/active?${query}`, { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Project not found" });
      const credential = await f.backend.fetch("/api/rendro/credentials", { method: "POST", headers, body: JSON.stringify({ organizationId: f.organizationId, projectId, name: "test", scopes: ["docs:read"] }) });
      expect(credential.status).toBe(404);
      expect(await credential.json()).toEqual({ error: "Project not found" });
    }
  });

  it("normalizes team IDs in the component and keeps the valid-team path working", async () => {
    const f = await fixture();
    for (const teamId of [f.teamId, "not-an-id", f.memberId]) {
      for (const cookie of [f.cookie, "better-auth.session_token=invalid"]) {
        const query = new URLSearchParams({ organizationId: f.organizationId, teamId });
        const response = await f.backend.fetch(`/api/rendro/management/team-members?${query}`, { headers: { cookie } });
        expect(response.status).toBe(cookie !== f.cookie ? 403 : teamId === f.teamId ? 200 : 404);
        expect(await response.text()).not.toMatch(/ConvexError|ArgumentValidationError|\.ts:\d/);
      }
    }
  });

  it("rejects unknown organization identities through membership checks before ID lookups", async () => {
    const f = await fixture();
    for (const organizationId of ["not-an-id", f.memberId]) {
      for (const cookie of [f.cookie, "better-auth.session_token=invalid"]) {
        const query = new URLSearchParams({ organizationId, projectId: f.projectId, teamId: f.teamId });
        for (const path of ["projects", "projects/get", "credentials", "deployments", "deployments/active", "shares", "publications", "management/access", "management/members", "management/team-members", "management/recent-deployment"]) {
          const response = await f.backend.fetch(`/api/rendro/${path}?${query}`, { headers: { cookie } });
          expect([401, 403]).toContain(response.status);
          expect(await response.text()).not.toMatch(/ConvexError|ArgumentValidationError|\.ts:\d/);
        }
      }
    }
  });
});
