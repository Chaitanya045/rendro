import { signAuthClientIp } from "../shared/auth-client-ip";
import { ready } from "./backend";
import type { Mail } from "./services";

export const roles = ["owner", "admin", "member", "outsider"] as const;
export type Role = typeof roles[number];
// Verified, signed-in users. The role names only label them: repository access is granted per test.
export type Seed = { cookies: Record<Role, string>; userIds: Record<Role, string> };
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
  return { cookies, userIds };
}
