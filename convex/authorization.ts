import type { GenericCtx } from "@convex-dev/better-auth";
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

export async function requireOrganizationMember(
  ctx: GenericCtx<DataModel>,
  organizationId: string,
  allowedRoles?: readonly OrganizationRole[],
): Promise<AuthorizedOrganization> {
  const user = await authComponent.getAuthUser(ctx);
  const { auth, headers } = await authComponent.getAuth(createAuth, ctx);
  const organization = await auth.api.getFullOrganization({
    query: { organizationId },
    headers,
  });
  if (!organization) throw new ConvexError("Organization not found");
  const member = organization.members.find((candidate) => candidate.userId === user._id);
  if (!member) throw new ConvexError("Organization membership required");
  if (
    allowedRoles
    && !memberRoles(member.role).some((role) => allowedRoles.includes(role as OrganizationRole))
  ) {
    throw new ConvexError("Insufficient organization role");
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

export async function authorizeHttpOrganization(
  ctx: GenericCtx<DataModel>,
  headers: Headers,
  organizationId: string,
  allowedRoles?: readonly OrganizationRole[],
): Promise<AuthorizedOrganization> {
  const auth = createAuth(ctx);
  const session = await auth.api.getSession({ headers });
  if (!session) throw new ConvexError("Authentication required");
  const organization = await auth.api.getFullOrganization({
    query: { organizationId },
    headers,
  });
  if (!organization) throw new ConvexError("Organization not found");
  const member = organization.members.find(
    (candidate) => candidate.userId === session.user.id,
  );
  if (!member) throw new ConvexError("Organization membership required");
  if (
    allowedRoles
    && !memberRoles(member.role).some((role) => allowedRoles.includes(role as OrganizationRole))
  ) {
    throw new ConvexError("Insufficient organization role");
  }
  const user = await authComponent.getAnyUserById(ctx, session.user.id);
  if (!user) throw new ConvexError("Authenticated user not found");
  return { organization, member, user };
}
