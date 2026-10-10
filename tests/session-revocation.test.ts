import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import { testUtils } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import { createAuthOptions } from "../convex/auth";

const baseUrl = "http://localhost:3000";

function appendResponseCookies(headers: Headers, response: Response): Headers {
  const result = new Headers(headers);
  const setCookies = response.headers.getSetCookie?.()
    ?? [response.headers.get("set-cookie") ?? ""];
  const cookiePairs = setCookies
    .map((cookie) => cookie.split(";", 1)[0])
    .filter(Boolean);
  if (cookiePairs.length > 0) {
    result.set(
      "cookie",
      [result.get("cookie"), ...cookiePairs].filter(Boolean).join("; "),
    );
  }
  return result;
}

describe("Better Auth session revocation", () => {
  it("checks persistence even when a request presents a previously signed cache cookie", async () => {
    const configured = createAuthOptions({} as never);
    expect(configured.session.cookieCache).toEqual({ enabled: false });

    const organizationPlugin = configured.plugins.find(
      (plugin) => plugin.id === "organization",
    );
    expect(organizationPlugin).toBeDefined();

    const database: Record<string, unknown[]> = {
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
      invitation: [],
      team: [],
      teamMember: [],
    };
    const runtimeOptions = {
      ...configured,
      baseURL: baseUrl,
      secret: "session-revocation-test-secret-at-least-32-chars",
      database: memoryAdapter(database),
      advanced: { database: { generateId: "uuid" as const } },
      rateLimit: { enabled: false },
    };
    const cacheIssuer = betterAuth({
      ...runtimeOptions,
      plugins: [organizationPlugin!, testUtils()],
      session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    });
    const protectedAuth = betterAuth({
      ...runtimeOptions,
      plugins: [organizationPlugin!, testUtils()],
    });

    const issuerContext = await cacheIssuer.$context;
    const user = issuerContext.test!.createUser({
      email: "session-revocation@rendro.invalid",
      emailVerified: true,
      name: "Session Revocation",
    });
    await issuerContext.test!.saveUser(user);
    const organization = issuerContext.test!.createOrganization!({
      name: "Revocation Test",
      slug: "revocation-test",
    });
    await issuerContext.test!.saveOrganization!(organization);
    await issuerContext.test!.addMember!({
      userId: user.id,
      organizationId: String(organization.id),
      role: "owner",
    });
    const login = await issuerContext.test!.login({ userId: user.id });

    const cachedSessionResponse = await cacheIssuer.handler(new Request(
      `${baseUrl}/api/auth/get-session`,
      { headers: login.headers },
    ));
    expect(cachedSessionResponse.status).toBe(200);
    const cachedHeaders = appendResponseCookies(
      login.headers,
      cachedSessionResponse,
    );
    expect(cachedHeaders.get("cookie")).toMatch(/session_data/);

    const organizationUrl = `${baseUrl}/api/auth/organization/get-full-organization?organizationId=${encodeURIComponent(String(organization.id))}`;
    const beforeRevocation = await protectedAuth.handler(new Request(
      organizationUrl,
      { headers: cachedHeaders },
    ));
    expect(beforeRevocation.status).toBe(200);
    await expect(beforeRevocation.json()).resolves.toMatchObject({
      id: organization.id,
    });

    await issuerContext.internalAdapter.deleteSession(login.session.token);

    const afterRevocation = await protectedAuth.handler(new Request(
      organizationUrl,
      { headers: cachedHeaders },
    ));
    expect(afterRevocation.status).toBe(401);
  });
});
