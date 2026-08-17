import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { createAuth } from "./auth";
import {
  createProject,
  getProject,
  listProjects,
} from "./rendroHttp";
import {
  createCredential,
  listCredentials,
  revokeCredential,
  validateCredential,
} from "./credentialHttp";
import {
  commitDeployment,
  failDeployment,
  getActiveDeployment,
  getStagingDeployment,
  listDeployments,
  startDeployment,
} from "./deploymentHttp";
import {
  createPublication,
  listPublications,
  removePublication,
  resolvePublicPublication,
} from "./publicationHttp";
import {
  createShareGrant,
  listShareGrants,
  resolveShareGrant,
  revokeShareGrant,
} from "./shareGrantHttp";
import { listRetentionCandidates, markRetentionPurged } from "./retentionHttp";
import { ensureMigrationProject } from "./migrationHttp";

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
    await auth.api.setPassword({
      body: { newPassword },
      headers: request.headers,
    });
    return Response.json({ status: true });
  } catch {
    return Response.json(
      { error: "Unable to set password. Sign in again and retry." },
      { status: 400 },
    );
  }
});

http.route({
  path: "/api/auth/set-initial-password",
  method: "POST",
  handler: setInitialPasswordHandler,
});

http.route({ path: "/api/rendro/projects", method: "GET", handler: listProjects });
http.route({ path: "/api/rendro/projects", method: "POST", handler: createProject });
http.route({ path: "/api/rendro/projects/get", method: "GET", handler: getProject });
http.route({ path: "/api/rendro/credentials", method: "GET", handler: listCredentials });
http.route({ path: "/api/rendro/credentials", method: "POST", handler: createCredential });
http.route({ path: "/api/rendro/credentials/revoke", method: "POST", handler: revokeCredential });
http.route({ path: "/api/rendro/credentials/validate", method: "GET", handler: validateCredential });
http.route({ path: "/api/rendro/deployments/start", method: "POST", handler: startDeployment });
http.route({ path: "/api/rendro/deployments/active", method: "GET", handler: getActiveDeployment });
http.route({ path: "/api/rendro/deployments/staging", method: "GET", handler: getStagingDeployment });
http.route({ path: "/api/rendro/deployments/commit", method: "POST", handler: commitDeployment });
http.route({ path: "/api/rendro/deployments/fail", method: "POST", handler: failDeployment });
http.route({ path: "/api/rendro/deployments", method: "GET", handler: listDeployments });
http.route({ path: "/api/rendro/publications", method: "GET", handler: listPublications });
http.route({ path: "/api/rendro/publications", method: "POST", handler: createPublication });
http.route({ path: "/api/rendro/publications/remove", method: "POST", handler: removePublication });
http.route({ path: "/api/rendro/publications/public", method: "GET", handler: resolvePublicPublication });
http.route({ path: "/api/rendro/shares", method: "GET", handler: listShareGrants });
http.route({ path: "/api/rendro/shares", method: "POST", handler: createShareGrant });
http.route({ path: "/api/rendro/shares/revoke", method: "POST", handler: revokeShareGrant });
http.route({ path: "/api/rendro/shares/public", method: "GET", handler: resolveShareGrant });
http.route({ path: "/api/rendro/retention/candidates", method: "GET", handler: listRetentionCandidates });
http.route({ path: "/api/rendro/retention/purged", method: "POST", handler: markRetentionPurged });
http.route({ path: "/api/rendro/migration/project", method: "POST", handler: ensureMigrationProject });






const authHandler = httpAction(async (ctx, request) => {
  const auth = createAuth(ctx);
  const response = await auth.handler(request);
  const isEmailSignUp = new URL(request.url).pathname.endsWith(
    "/api/auth/sign-up/email",
  );
  if (isEmailSignUp && (response.ok || response.status === 422)) {
    return Response.json({
      status: true,
      message: "If the address can be registered, check your email to continue.",
    });
  }
  return response;
});
http.route({ pathPrefix: "/api/auth/", method: "GET", handler: authHandler });
http.route({ pathPrefix: "/api/auth/", method: "POST", handler: authHandler });

export default http;
