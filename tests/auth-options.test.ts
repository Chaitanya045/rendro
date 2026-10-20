import { afterEach, expect, it, vi } from "vitest";
import { createAuth, createAuthOptions } from "../convex/auth";
import type * as readLimit from "../convex/sessionReadLimit";
import * as emails from "../convex/authEmails";

const consumers = vi.hoisted(() => [] as Array<(key: string) => Promise<number>>);
vi.mock("../convex/authEmails", () => ({ sendAuthLinkEmail: vi.fn(), sendExistingAccountNotice: vi.fn() }));
vi.mock("../convex/sessionReadLimit", async importOriginal => {
  const original = await importOriginal<typeof readLimit>();
  return { ...original,
    sessionReadLimit: (consume: (key: string) => Promise<number>) => { consumers.push(consume); return original.sessionReadLimit(consume); },
  };
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); consumers.length = 0; });

it("requires runtime auth secrets while permitting offline schema generation", () => {
  for (const name of ["SITE_URL", "AUTH_SECRET"]) vi.stubEnv(name, undefined);
  expect(() => createAuth({} as never)).toThrow("SITE_URL is required");
  const generated = createAuth({} as never, true);
  expect(generated.options.baseURL).toBe("http://localhost:3000");
  expect(generated.options.secret).toBe("schema-generation-auth_secret");
  // Email is the only sign-in method until GitHub sign-in (#286): no social provider and no provider credential is needed.
  expect(generated.options).not.toHaveProperty("socialProviders");
  vi.stubEnv("SITE_URL", "https://rendro.test");
  expect(() => createAuth({} as never)).toThrow("AUTH_SECRET is required");
  vi.stubEnv("AUTH_SECRET", "synthetic-auth-secret-at-least-32-characters");
  expect(() => createAuth({} as never)).not.toThrow();
});

it("keeps email callbacks and exact credential rate rules wired to their services", async () => {
  const options = createAuthOptions({} as never);
  const user = { email: "reader@example.test", name: "Reader" }, url = "http://localhost:3000/verify";
  await options.emailAndPassword.sendResetPassword({ user, url } as never);
  await options.emailAndPassword.onExistingUserSignUp({ user } as never);
  await options.emailVerification.sendVerificationEmail({ user, url } as never);
  expect(emails.sendAuthLinkEmail).toHaveBeenCalledWith("password-reset", user, url);
  expect(emails.sendAuthLinkEmail).toHaveBeenCalledWith("verification", user, url);
  expect(emails.sendExistingAccountNotice).toHaveBeenCalledWith(user);
  // No organization plugin, so no invitation email and no organization read rule (#286).
  expect(options.plugins.some(plugin => plugin.id === "organization")).toBe(false);
  const rules = options.rateLimit.customRules as Record<string, unknown>;
  expect(Object.keys(rules).filter(path => path.startsWith("/organization"))).toEqual([]);
  expect(rules["/sign-in/email"]).toEqual({ window: 60, max: 5 });
});

it("refuses HTTP limiter consumption in a read-only auth context", () => {
  createAuthOptions({} as never);
  expect(consumers).toHaveLength(1);
  for (const consume of consumers) expect(() => consume("test")).toThrow("mutation-capable context");
});

it("does not emit Better Auth callback URLs or exception diagnostics", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const context = await createAuth({} as never).$context;
    for (const path of ["reset-password", "verify-email", "callback/oauth"]) {
      const url = `https://test/${path}/synthetic-private-token?token=synthetic-private-token`;
      context.logger.error(url, Object.assign(new Error(url), { cause: { token: url }, authorization: url }));
      context.logger.warn(url, { password: url, token: url });
    }
    expect(log).toHaveBeenCalled();
    for (const call of log.mock.calls) expect(call).toEqual(["Auth diagnostic", { category: "AuthDiagnostic" }]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-private-token");
  } finally { log.mockRestore(); }
});
