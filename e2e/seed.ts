import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signAuthClientIp } from "../shared/auth-client-ip";
import { assertLoopback, localEnvironment, root, run, ready } from "./backend";
import { publicationSlug, type Mail } from "./services";

export const roles = ["owner", "admin", "member", "outsider"] as const;
export type Role = typeof roles[number];
export type Seed = { organizationId: string; otherOrganizationId: string; projectId: string; cookies: Record<Role, string> };
export const password = "Local fixture password 109!";
export async function pushDocuments(source: string, endpoint: string, organizationId: string, projectId: string, token: string) {
  assertLoopback(endpoint);
  await run(process.execPath, [join(root, "bin/rendro.mjs"), "push", "--source", source, "--organization", organizationId,
    "--project", projectId, "--endpoint", endpoint, "--concurrency", "1"], { cwd: source, env: { ...localEnvironment(), RENDRO_API_KEY: token }, timeout: 60_000 });
}
export async function seedWorkspace(input: { site: string; worker: string; secret: string; mail: Mail[]; directory: string; fetch: typeof fetch }): Promise<Seed> {
  const cookies = {} as Record<Role, string>;
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
    await call(role, "/api/auth/sign-in/email", { email, password });
  }
  const organization = await call<{ id: string }>("owner", "/api/auth/organization/create", { name: "E2E primary", slug: "e2e-primary" });
  const other = await call<{ id: string }>("outsider", "/api/auth/organization/create", { name: "E2E other", slug: "e2e-other" });
  for (const role of ["admin", "member"] as const) {
    const invitation = await call<{ id: string }>("owner", "/api/auth/organization/invite-member", { organizationId: organization.id, email: `${role}@example.test`, role });
    await call(role, "/api/auth/organization/accept-invitation", { invitationId: invitation.id });
  }
  const { project } = await call<{ project: { _id: string } }>("owner", "/api/rendro/projects", { organizationId: organization.id, name: "Worker publication", slug: "smoke" });
  const { rawKey } = await call<{ rawKey: string }>("owner", "/api/rendro/credentials", { organizationId: organization.id, projectId: project._id,
    name: "Smoke publisher", scopes: ["docs:read", "docs:write", "publications:read", "publications:write"] });
  const source = join(input.directory, "smoke-docs");
  await mkdir(source);
  await writeFile(join(source, "index.html"), '<!doctype html><html><head><title>Worker publication</title></head><body><h1>Publication from local storage</h1><img src="diagram.svg" alt="Local diagram"><script>document.body.dataset.publisherReady="yes"</script></body></html>');
  await writeFile(join(source, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><title>Local diagram</title><rect width="80" height="40" fill="green"/></svg>');
  await writeFile(join(source, "deleted.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await pushDocuments(source, input.worker, organization.id, project._id, rawKey);
  const response = await input.fetch(`${input.worker}/api/rendro/publications`, { method: "POST",
    headers: { Authorization: `Bearer ${rawKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: organization.id, projectId: project._id, slug: publicationSlug, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", title: "Worker publication" }) });
  if (!response.ok) throw new Error(`Seed publication failed (${response.status}): ${await response.text()}`);
  return { organizationId: organization.id, otherOrganizationId: other.id, projectId: project._id, cookies };
}
