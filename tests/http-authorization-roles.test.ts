import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  sessionUserId: "owner-user" as string | null,
  members: [] as Array<{ id: string; organizationId: string; userId: string; role: string }>,
}));

vi.mock("../convex/auth", () => ({
  createAuth: vi.fn(() => ({
    api: {
      getSession: vi.fn(() => Promise.resolve(authState.sessionUserId
        ? { user: { id: authState.sessionUserId }, session: { id: "session" } }
        : null)),
      getFullOrganization: vi.fn(({ query }: { query: { organizationId: string } }) => Promise.resolve({
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
  authState.members = [];
});

describe("HTTP organization role authorization", () => {
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
