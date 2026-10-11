import type { User } from "better-auth/types";

interface FixtureOrganization {
  id: string;
  name: string;
  slug: string;
  members: Array<{ id: string; userId: string; role: string; user: User }>;
}

/** Share the authorized response between SSR fetch and browser-facing API fixtures. */
export function managementAccessFixture(organization: FixtureOrganization, user: User) {
  const member = organization.members.find(member => member.userId === user.id);
  if (!member) throw new Error("Management fixture user must belong to the organization");
  return (input: string | URL | Request): Response | undefined => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname !== "/api/rendro/management/access") return undefined;
    if (url.searchParams.get("organizationId") !== organization.id) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json({ ...organization, userId: user.id, member });
  };
}
