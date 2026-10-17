import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { DISPLAY_NAME_MAX_LENGTH } from "../shared/text-input";

// The same rule as the create and settings forms' slug inputs.
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ORGANIZATION_SLUG_MAX_LENGTH = 48;

export function isOrganizationSlug(slug: unknown): boolean {
  return typeof slug === "string" && slug.length <= ORGANIZATION_SLUG_MAX_LENGTH && slugPattern.test(slug);
}

function invalidSlug(): never {
  // The management forms display this message verbatim.
  throw new APIError("BAD_REQUEST", {
    code: "INVALID_ORGANIZATION_SLUG",
    message: "Organization slug must contain lowercase letters, numbers, and hyphens",
  });
}

function invalidName(): never {
  // The management forms display this message verbatim.
  throw new APIError("BAD_REQUEST", {
    code: "INVALID_ORGANIZATION_NAME",
    message: `Organization name must be 1–${DISPLAY_NAME_MAX_LENGTH} characters`,
  });
}

function organizationName(name: unknown): string | null {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed && trimmed.length <= DISPLAY_NAME_MAX_LENGTH ? trimmed : null;
}

type StoredOrganization = { name?: unknown; slug?: unknown } | null | undefined;

/**
 * Better Auth organization hooks: every create and update request, over HTTP or
 * the server API, validates the name (trimmed, 1–80 characters, as in the forms) and
 * slug it writes. Organizations whose values predate this validation keep them;
 * resubmitting the stored value unchanged is allowed.
 */
export function organizationFieldHooks(current: (organizationId: string) => Promise<StoredOrganization>) {
  return {
    beforeCreateOrganization: ({ organization }: { organization: { name?: unknown; slug?: unknown } }) => {
      const name = organizationName(organization.name);
      if (name === null) invalidName();
      if (!isOrganizationSlug(organization.slug)) invalidSlug();
      return Promise.resolve({ data: { name } });
    },
    beforeUpdateOrganization: async ({ organization, member }: { organization: { name?: unknown; slug?: unknown }; member: { organizationId: string } }) => {
      const { name, slug } = organization;
      if (slug !== undefined && !isOrganizationSlug(slug) && slug !== (await current(member.organizationId))?.slug) invalidSlug();
      if (name === undefined) return;
      const trimmed = organizationName(name);
      if (trimmed !== null) return { data: { name: trimmed } };
      if (name !== (await current(member.organizationId))?.name) invalidName();
    },
  };
}

const managerRoles = new Set(["owner", "admin"]);

/**
 * Invitations disclose invited addresses, so only owners and admins may read an
 * organization's list. Better Auth only requires membership for these reads.
 * The check runs after the endpoint, against the organization whose data it
 * actually returned, for the session the endpoint authenticated, with a fresh
 * member lookup. Members receive 403 from the list and an empty full-organization list.
 */
export function invitationListPrivacy(): BetterAuthPlugin {
  return {
    id: "rendro-invitation-list-privacy",
    hooks: { after: [{
      matcher: ctx => ctx.path === "/organization/list-invitations" || ctx.path === "/organization/get-full-organization",
      handler: createAuthMiddleware(async (ctx) => {
        const returned: unknown = ctx.context.returned;
        // The endpoint has already authenticated this request's session cookie but
        // does not share its session with hooks. Re-resolve the same token; the
        // session plugins' request-local lookup makes this a cached read.
        const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
        const session = token ? await ctx.context.internalAdapter.findSession(token) : null;
        async function manages(organizationId: unknown): Promise<boolean> {
          if (typeof organizationId !== "string" || !organizationId || !session) return false;
          const member = await ctx.context.adapter.findOne<{ role: string }>({
            model: "member",
            where: [{ field: "organizationId", value: organizationId }, { field: "userId", value: session.user.id }],
          });
          return !!member && member.role.split(",").some(role => managerRoles.has(role.trim()));
        }
        if (ctx.path === "/organization/list-invitations") {
          // Errors and other non-list results pass through unchanged.
          if (!Array.isArray(returned)) return;
          const requested: unknown = (ctx.query as { organizationId?: unknown } | undefined)?.organizationId || session?.session.activeOrganizationId;
          const organizations = new Set([requested, ...returned.map((invitation: { organizationId?: unknown }) => invitation.organizationId)]);
          for (const organizationId of organizations) {
            if (!await manages(organizationId)) {
              throw new APIError("FORBIDDEN", {
                code: "YOU_ARE_NOT_ALLOWED_TO_LIST_INVITATIONS",
                message: "You are not allowed to list this organization's invitations",
              });
            }
          }
          return;
        }
        if (!returned || typeof returned !== "object" || !("invitations" in returned)) return;
        if (await manages((returned as { id?: unknown }).id)) return;
        return ctx.json({ ...returned, invitations: [] });
      }),
    }] },
  };
}
