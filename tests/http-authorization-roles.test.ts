import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  sessionUserId: "owner-user" as string | null,
  organizationErrorStatus: null as number | null,
  members: [] as Array<{ id: string; organizationId: string; userId: string; role: string }>,
}));

vi.mock("../convex/auth", () => ({
  createAuth: vi.fn(() => ({
    $context: Promise.resolve({ adapter: { findOne: vi.fn(({ model, where }: { model: string; where: Array<{ field: string; value: string }> }) => {
      if (authState.organizationErrorStatus) return Promise.reject(Object.assign(new Error("Provider lookup failed"), { statusCode: authState.organizationErrorStatus }));
      const organizationId = where.find((entry) => entry.field === "organizationId" || entry.field === "id")?.value;
      return Promise.resolve(model === "member"
        ? authState.members.find((member) => member.organizationId === organizationId && member.userId === authState.sessionUserId) ?? null
        : { id: organizationId, name: "Acme", slug: "acme" });
    }) } }),
    api: {
      getSession: vi.fn(() => Promise.resolve(authState.sessionUserId
        ? { user: { id: authState.sessionUserId }, session: { id: "session" } }
        : null)),
      getFullOrganization: vi.fn(({ query }: { query: { organizationId: string } }) => authState.organizationErrorStatus
        ? Promise.reject(Object.assign(new Error("You are not a member of this organization"), { statusCode: authState.organizationErrorStatus }))
        : Promise.resolve({
        id: query.organizationId,
        name: "Acme",
        slug: "acme",
        members: authState.members,
      })),
    },
  })),
  authComponent: {
    getAuth: vi.fn(),
    getAuthUser: vi.fn(),
    getAnyUserById: vi.fn((_ctx: unknown, userId: string) => Promise.resolve({
      _id: userId,
      email: `${userId}@example.test`,
    })),
  },
}));

import { authorizeHttpOrganization } from "../convex/authorization";

const fakeContext = {} as Parameters<typeof authorizeHttpOrganization>[0];

function asRole(role: "owner" | "admin" | "member") {
  authState.sessionUserId = `${role}-user`;
  authState.members = [{
    id: `${role}-membership`,
    organizationId: "org-a",
    userId: `${role}-user`,
    role,
  }];
}

beforeEach(() => {
  authState.sessionUserId = "owner-user";
  authState.organizationErrorStatus = null;
  authState.members = [];
});

describe("HTTP organization role authorization", () => {
  it("normalizes native provider permission errors without hiding unrelated failures", async () => {
    authState.organizationErrorStatus = 403;
    await expect(authorizeHttpOrganization(fakeContext, new Headers(), "org-a"))
      .rejects.toThrow("Organization membership required");
    authState.organizationErrorStatus = 401;
    await expect(authorizeHttpOrganization(fakeContext, new Headers(), "org-a"))
      .rejects.toThrow("Authentication required");
    authState.organizationErrorStatus = 500;
    await expect(authorizeHttpOrganization(fakeContext, new Headers(), "org-a"))
      .rejects.toMatchObject({ statusCode: 500 });
  });
  it.each(["owner", "admin"] as const)("allows %s to perform administrative writes", async (role) => {
    asRole(role);
    await expect(authorizeHttpOrganization(
      fakeContext,
      new Headers({ cookie: "session=test" }),
      "org-a",
      ["owner", "admin"],
    )).resolves.toMatchObject({ member: { role }, user: { _id: `${role}-user` } });
  });

  it("allows a member to read but denies administrative writes", async () => {
    asRole("member");
    await expect(authorizeHttpOrganization(
      fakeContext,
      new Headers({ cookie: "session=test" }),
      "org-a",
    )).resolves.toMatchObject({ member: { role: "member" } });
    await expect(authorizeHttpOrganization(
      fakeContext,
      new Headers({ cookie: "session=test" }),
      "org-a",
      ["owner", "admin"],
    )).rejects.toThrow("Insufficient organization role");
  });

  it("denies a signed-in outsider who has no organization membership", async () => {
    authState.sessionUserId = "outsider-user";
    authState.members = [{
      id: "other-membership",
      organizationId: "org-a",
      userId: "someone-else",
      role: "owner",
    }];
    await expect(authorizeHttpOrganization(
      fakeContext,
      new Headers({ cookie: "session=test" }),
      "org-a",
    )).rejects.toThrow("Organization membership required");
  });

  it("denies an anonymous request", async () => {
    authState.sessionUserId = null;
    await expect(authorizeHttpOrganization(
      fakeContext,
      new Headers(),
      "org-a",
    )).rejects.toThrow("Authentication required");
  });
});
