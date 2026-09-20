/* Async mocks model the production promise-returning adapters. */
/* eslint-disable @typescript-eslint/require-await */
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), find: vi.fn(), user: vi.fn(), full: vi.fn() }));
vi.mock("../convex/auth", () => ({
  createAuth: () => ({ api: { getSession: mocks.session, getFullOrganization: mocks.full }, $context: Promise.resolve({ adapter: { findOne: mocks.find } }) }),
  authComponent: { getAnyUserById: mocks.user },
}));
import { authorizeHttpOrganization, httpOrganizationAccess } from "../convex/authorization";

const ctx = {} as Parameters<typeof httpOrganizationAccess>[0];
const headers = new Headers();
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ user: { id: "user-a" } });
  mocks.user.mockResolvedValue({ _id: "user-a" });
  mocks.find.mockImplementation(async ({ model }: { model: string }) => model === "member"
    ? { id: "member-a", organizationId: "org-a", userId: "user-a", role: "member" }
    : { id: "org-a", name: "Acme", slug: "acme" });
});
describe("fresh minimal management authorization", () => {
  it("queries only the current membership and organization, without loading a roster", async () => {
    expect(await httpOrganizationAccess(ctx, headers, "org-a")).toMatchObject({ userId: "user-a", member: { role: "member" } });
    expect(mocks.find).toHaveBeenCalledWith({ model: "member", where: [{ field: "organizationId", value: "org-a" }, { field: "userId", value: "user-a" }] });
    expect(mocks.find).toHaveBeenCalledWith({ model: "organization", where: [{ field: "id", value: "org-a" }] });
    expect(mocks.full).not.toHaveBeenCalled();
  });
  it("rejects revoked/expired sessions before querying any organization data", async () => {
    mocks.session.mockResolvedValue(null);
    await expect(httpOrganizationAccess(ctx, headers, "org-a")).rejects.toThrow("Authentication required");
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("checks access again after membership removal and reveals no organization lookup", async () => {
    await httpOrganizationAccess(ctx, headers, "org-a");
    mocks.find.mockClear(); mocks.find.mockResolvedValue(null);
    await expect(httpOrganizationAccess(ctx, headers, "org-a")).rejects.toThrow("membership required");
    expect(mocks.session).toHaveBeenCalledTimes(2);
    expect(mocks.find).toHaveBeenCalledTimes(1);
  });
  it("keeps management API role restrictions and user existence checks", async () => {
    await expect(authorizeHttpOrganization(ctx, headers, "org-a", ["owner", "admin"])).rejects.toThrow("Insufficient organization role");
    expect(mocks.user).not.toHaveBeenCalled();
    mocks.find.mockImplementation(async ({ model }: { model: string }) => model === "member"
      ? { id: "member-a", organizationId: "org-a", userId: "user-a", role: "member, admin" }
      : { id: "org-a", name: "Acme", slug: "acme" });
    await expect(authorizeHttpOrganization(ctx, headers, "org-a", ["admin"])).resolves.toMatchObject({ user: { _id: "user-a" } });
    mocks.user.mockResolvedValue(null);
    await expect(authorizeHttpOrganization(ctx, headers, "org-a", ["admin"])).rejects.toThrow("Authenticated user not found");
  });
  it("fails closed if the authorization backend fails", async () => {
    mocks.find.mockRejectedValue(new Error("Backend unavailable"));
    await expect(httpOrganizationAccess(ctx, headers, "org-a")).rejects.toThrow("Backend unavailable");
  });
});
