import { httpRouter } from "convex/server";
import { APIError } from "better-auth/api";
import { httpAction, failure } from "./httpErrors";
import { createAuth } from "./auth";
import { verifiedAuthRequest } from "../shared/auth-client-ip";
import { cacheJwksResponse } from "./authHttp";
import { sessionCookieHeaders } from "./sessionLifetime";
import {
  createProject,
  getProject,
  listProjects,
  managementAccess,
  managementTeamMembers,
  managementMembers,
} from "./rendroHttp";
import {
  createCredential,
  listCredentials,
  revokeCredential,
  validateCredential,
} from "./credentialHttp";

const http = httpRouter();
const setInitialPasswordHandler = httpAction(async (ctx, request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const newPassword = body && typeof body === "object" && "newPassword" in body
    ? body.newPassword
    : null;
  if (typeof newPassword !== "string") {
    return Response.json({ error: "Password is required" }, { status: 400 });
  }
  try {
    const auth = createAuth(ctx);
    const headers = sessionCookieHeaders(request.headers);
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    const { sessionConfig } = await auth.$context;
    const createdAt = session ? new Date(session.session.createdAt).getTime() : NaN;
    const age = Date.now() - createdAt;
    if (!Number.isFinite(age) || age < 0 || age >= sessionConfig.freshAge * 1000) {
      return Response.json({ error: "Sign in again before setting a password" }, { status: 403 });
    }
    await auth.api.setPassword({
      body: { newPassword },
      headers,
    });
    return Response.json({ status: true });
  } catch (error) {
    if (!(error instanceof APIError) || error.statusCode >= 500) return failure(error, 400, "setInitialPassword");
    return Response.json(
      { error: "Unable to set password. Sign in again and retry." },
      { status: 400 },
    );
  }
}, "cookie-json");

http.route({
  path: "/api/auth/set-initial-password",
  method: "POST",
  handler: setInitialPasswordHandler,
});

http.route({ path: "/api/rendro/projects", method: "GET", handler: listProjects });
http.route({ path: "/api/rendro/management/access", method: "GET", handler: managementAccess });
http.route({ path: "/api/rendro/management/team-members", method: "GET", handler: managementTeamMembers });
http.route({ path: "/api/rendro/management/members", method: "GET", handler: managementMembers });
http.route({ path: "/api/rendro/projects", method: "POST", handler: createProject });
http.route({ path: "/api/rendro/projects/get", method: "GET", handler: getProject });
http.route({ path: "/api/rendro/credentials", method: "GET", handler: listCredentials });
http.route({ path: "/api/rendro/credentials", method: "POST", handler: createCredential });
http.route({ path: "/api/rendro/credentials/revoke", method: "POST", handler: revokeCredential });
http.route({ path: "/api/rendro/credentials/validate", method: "GET", handler: validateCredential });

const authHandler = httpAction(async (ctx, request) => {
  const auth = createAuth(ctx);
  // Sessions are cookie-only. Better Auth's bundled bearer hook would otherwise
  // resolve the session outside the lifetime plugin's server-derived marker.
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  const verifiedRequest = await verifiedAuthRequest(new Request(request, { headers }), process.env.CONVEX_INTERNAL_SECRET);
  const response = await auth.handler(verifiedRequest);
  const isEmailSignUp = new URL(request.url).pathname.endsWith(
    "/api/auth/sign-up/email",
  );
  if (isEmailSignUp && (response.ok || response.status === 422)) {
    return Response.json({
      status: true,
      message: "If the address can be registered, check your email to continue.",
    });
  }
  return cacheJwksResponse(request, response);
}, "better-auth");
http.route({ pathPrefix: "/api/auth/", method: "GET", handler: authHandler });
http.route({ pathPrefix: "/api/auth/", method: "POST", handler: authHandler });

export default http;
