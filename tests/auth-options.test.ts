import { afterEach, expect, it, vi } from "vitest";
import { createAuth, createAuthOptions } from "../convex/auth";
import type * as readLimit from "../convex/sessionReadLimit";
import * as emails from "../convex/authEmails";

const consumers = vi.hoisted(() => [] as Array<(key: string) => Promise<number>>);
vi.mock("../convex/authEmails", () => ({ sendAuthLinkEmail: vi.fn(), sendExistingAccountNotice: vi.fn(), sendOrganizationInvitationEmail: vi.fn() }));
vi.mock("../convex/sessionReadLimit", async importOriginal => {
  const original = await importOriginal<typeof readLimit>();
  return { ...original,
    sessionReadLimit: (consume: (key: string) => Promise<number>) => { consumers.push(consume); return original.sessionReadLimit(consume); },
    organizationReadLimit: (consume: (key: string) => Promise<number>) => { consumers.push(consume); return original.organizationReadLimit(consume); },
  };
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); consumers.length = 0; });

it("requires runtime auth secrets while permitting offline schema generation", () => {
  for (const name of ["SITE_URL", "AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) vi.stubEnv(name, undefined);
  expect(() => createAuth({} as never)).toThrow("SITE_URL is required");
  const generated = createAuth({} as never, true);
  expect(generated.options.baseURL).toBe("http://localhost:3000");
  expect(generated.options.secret).toBe("schema-generation-auth_secret");
  expect(generated.options.socialProviders?.google).toMatchObject({ clientId: "schema-generation-google_client_id", clientSecret: "schema-generation-google_client_secret" });
});

it("keeps email callbacks and exact organization read/write rate rules wired to their services", async () => {
  const options = createAuthOptions({} as never);
  const user = { email: "reader@example.test", name: "Reader" }, url = "http://localhost:3000/verify";
  await options.emailAndPassword.sendResetPassword({ user, url } as never);
  await options.emailAndPassword.onExistingUserSignUp({ user } as never);
  await options.emailVerification.sendVerificationEmail({ user, url } as never);
  expect(emails.sendAuthLinkEmail).toHaveBeenCalledWith("password-reset", user, url);
  expect(emails.sendAuthLinkEmail).toHaveBeenCalledWith("verification", user, url);
  expect(emails.sendExistingAccountNotice).toHaveBeenCalledWith(user);
  const org = options.plugins.find(plugin => plugin.id === "organization") as Extract<typeof options.plugins[number], { id: "organization" }>;
  await org.options.sendInvitationEmail!({ email: user.email, inviter: { user }, organization: { name: "Readers" }, id: "invite /" } as never);
  expect(emails.sendOrganizationInvitationEmail).toHaveBeenCalledWith({ email: user.email, inviterName: user.name, organizationName: "Readers", invitationUrl: "http://localhost:3000/accept-invitation/invite%20%2F" });
  const rules = options.rateLimit.customRules as unknown as Record<string, (request: Request) => unknown>;
  const path = "/organization/list";
  expect(rules[path](new Request(`http://localhost:3000${path}`))).toBe(false);
  expect(rules[path](new Request(`http://localhost:3000${path}`, { method: "POST" }))).toEqual({ window: 60, max: 100 });
});

it("refuses HTTP limiter consumption in a read-only auth context", () => {
  createAuthOptions({} as never);
  expect(consumers).toHaveLength(2);
  for (const consume of consumers) expect(() => consume("test")).toThrow("mutation-capable context");
});
