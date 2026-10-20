import { signAuthClientIp } from "../shared/auth-client-ip";
import { ready } from "./backend";
import type { Mail } from "./services";

export const roles = ["owner", "admin", "member", "outsider"] as const;
export type Role = typeof roles[number];
export type Seed = { organizationId: string; otherOrganizationId: string; projectId: string; cookies: Record<Role, string>; userIds: Record<Role, string> };
export const password = "Local fixture password 109!";
export async function seedWorkspace(input: { site: string; worker: string; secret: string; mail: Mail[]; fetch: typeof fetch }): Promise<Seed> {
  const cookies = {} as Record<Role, string>;
  const userIds = {} as Record<Role, string>;
  async function call<T>(role: Role, path: string, data?: unknown): Promise<T> {
    const request = new Request(`${input.site}${path}`, { method: data === undefined ? "GET" : "POST",
      headers: { Origin: input.worker, "Content-Type": "application/json", Cookie: cookies[role] ?? "" },
      body: data === undefined ? undefined : JSON.stringify(data) });
    const signed = await signAuthClientIp(request, `192.0.2.${roles.indexOf(role) + 1}`, input.secret);
    signed.forEach((value, name) => request.headers.set(name, value));
    const response = await input.fetch(request, { redirect: "manual" });
    if (response.status >= 400) throw new Error(`Seed ${path} failed (${response.status}): ${await response.text()}`);
    const pairs = response.headers.getSetCookie().map(value => value.split(";", 1)[0]);
    if (pairs.length) cookies[role] = pairs.join("; ");
    return await response.json() as T;
  }
  for (const role of roles) {
    const email = `${role}@example.test`;
    await call(role, "/api/auth/sign-up/email", { name: `E2E ${role}`, email, password });
    await ready(() => input.mail.some(message => message.to === email), `Mail for ${role}`, 10_000);
    const message = input.mail.find(message => message.to === email && message.subject.includes("Verify"));
    const link = message?.text.match(/http:\/\/[^\s]+/)?.[0];
    if (!link) throw new Error(`Verification mail missing for ${role}`);
    const url = new URL(link);
    const verified = await input.fetch(`${input.site}${url.pathname}${url.search}`, { redirect: "manual" });
    // A failed verification would otherwise surface as a misleading sign-in error.
    const outcome = `${verified.status} ${(await verified.text()).slice(0, 200)}`;
    if (verified.status >= 400) throw new Error(`Seed verification for ${role} failed (${outcome})`);
    userIds[role] = (await call<{ user: { id: string } }>(role, "/api/auth/sign-in/email", { email, password })).user.id;
  }
  const organization = await call<{ id: string }>("owner", "/api/auth/organization/create", { name: "E2E primary", slug: "e2e-primary" });
  const other = await call<{ id: string }>("outsider", "/api/auth/organization/create", { name: "E2E other", slug: "e2e-other" });
  for (const role of ["admin", "member"] as const) {
    const invitation = await call<{ id: string }>("owner", "/api/auth/organization/invite-member", { organizationId: organization.id, email: `${role}@example.test`, role });
    await call(role, "/api/auth/organization/accept-invitation", { invitationId: invitation.id });
  }
  const { project } = await call<{ project: { _id: string } }>("owner", "/api/rendro/projects", { organizationId: organization.id, name: "Worker publication", slug: "smoke" });
  return { organizationId: organization.id, otherOrganizationId: other.id, projectId: project._id, cookies, userIds };
}
