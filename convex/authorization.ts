import { isOrganizationDeleted, requireActiveOrganization } from "./organizationLifecycle";
import type { GenericCtx } from "@convex-dev/better-auth";
import { publicError } from "./publicErrors";
import { ConvexError } from "convex/values";
import type { DataModel } from "./_generated/dataModel";
import { authComponent, createAuth } from "./auth";

export type OrganizationRole = "owner" | "admin" | "member";

type AuthorizedOrganization = {
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  member: {
    id: string;
    organizationId: string;
    userId: string;
    role: string;
  };
  user: Awaited<ReturnType<typeof authComponent.getAuthUser>>;
};

function memberRoles(role: string): string[] {
  return role.split(",").map((value) => value.trim()).filter(Boolean);
}

/** Call only after organization membership has been verified. */
export function canDeleteComment(authorized: AuthorizedOrganization, authorId: string): boolean {
  return authorized.user._id === authorId
    || memberRoles(authorized.member.role).some((role) => role === "owner" || role === "admin");
}

export function requireCommentAuthorOrAdmin(authorized: AuthorizedOrganization, authorId: string): void {
  if (!canDeleteComment(authorized, authorId)) {
    publicError("forbidden");
  }
}

export async function requireOrganizationMember(
  ctx: GenericCtx<DataModel>,
  organizationId: string,
  allowedRoles?: readonly OrganizationRole[],
): Promise<AuthorizedOrganization> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || typeof identity.sessionId !== "string") publicError("unauthenticated");
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) publicError("unauthenticated");
  if (await isOrganizationDeleted(ctx, organizationId)) publicError("not_found");
  const auth = await createAuth(ctx).$context;
  const member = await auth.adapter.findOne<AuthorizedOrganization["member"]>({
    model: "member",
    where: [
      { field: "organizationId", value: organizationId },
      { field: "userId", value: user._id },
    ],
  });
  if (!member) publicError("not_found");
  const organization = await auth.adapter.findOne<AuthorizedOrganization["organization"]>({
    model: "organization",
    where: [{ field: "id", value: organizationId }],
  });
  if (!organization) publicError("not_found");
  if (
    allowedRoles
    && !memberRoles(member.role).some((role) => allowedRoles.includes(role as OrganizationRole))
  ) {
    publicError("forbidden");
  }
  return { organization, member, user };
}

export async function requireOrganizationRole(
  ctx: GenericCtx<DataModel>,
  organizationId: string,
  roles: readonly OrganizationRole[],
): Promise<AuthorizedOrganization> {
  return requireOrganizationMember(ctx, organizationId, roles);
}

/** Fresh, indexed access lookup shared by navigation and management APIs. */
export async function httpOrganizationAccess(
  ctx: GenericCtx<DataModel>,
  headers: Headers,
  organizationId: string,
) {
  try {
    const auth = createAuth(ctx);
    const session = await auth.api.getSession({ headers });
    if (!session) throw new ConvexError("Authentication required");
    await requireActiveOrganization(ctx, organizationId);
    const context = await auth.$context;
    const member = await context.adapter.findOne<AuthorizedOrganization["member"]>({
      model: "member", where: [{ field: "organizationId", value: organizationId }, { field: "userId", value: session.user.id }],
    });
    if (!member) throw new ConvexError("Organization membership required");
    const organization = await context.adapter.findOne<AuthorizedOrganization["organization"]>({
      model: "organization", where: [{ field: "id", value: organizationId }],
    });
    if (!organization) throw new ConvexError("Organization membership required");
    return { organization, member, userId: session.user.id };
  } catch (error) {
    const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
    if (status === 403) throw new ConvexError("Organization membership required");
    if (status === 401) throw new ConvexError("Authentication required");
    throw error;
  }
}

export async function authorizeHttpOrganization(
  ctx: GenericCtx<DataModel>,
  headers: Headers,
  organizationId: string,
  allowedRoles?: readonly OrganizationRole[],
): Promise<AuthorizedOrganization> {
  const { organization, member, userId } = await httpOrganizationAccess(ctx, headers, organizationId);
  if (allowedRoles && !memberRoles(member.role).some((role) => allowedRoles.includes(role as OrganizationRole))) {
    throw new ConvexError("Insufficient organization role");
  }
  const user = await authComponent.getAnyUserById(ctx, userId);
  if (!user) throw new ConvexError("Authenticated user not found");
  return { organization, member, user };
}
