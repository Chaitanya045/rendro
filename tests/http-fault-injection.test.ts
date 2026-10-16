import { apiKeyRateLimiter } from "../convex/apiKeyHttp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("../convex/authorization", () => ({ authorizeHttpOrganization: auth.authorize, httpOrganizationAccess: auth.authorize }));
import { commitDeployment, getActiveDeployment, getStagingDeployment, startDeployment } from "../convex/deploymentHttp";
import { createCredential, listCredentials, revokeCredential } from "../convex/credentialHttp";
import { createShareGrant, listShareGrants, revokeShareGrant, resolveShareGrant } from "../convex/shareGrantHttp";
import { createPublication, listPublications } from "../convex/publicationHttp";
import { createProject, getProject, managementAccess, managementMembers } from "../convex/rendroHttp";
import { failure } from "../convex/httpErrors";

type HttpAction = typeof getStagingDeployment;

const secret = "private-session-token-do-not-log";
const fault = new Error(`Infrastructure failure containing ${secret}`);
const identity = { organizationId: "org", projectId: "project", deploymentId: "deployment" };
const creation = { ...identity, manifestSha256: "a".repeat(64), fileCount: 0, byteCount: 0, provenance: {} };
const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });
const routes = [
  { name: "staging query", action: getStagingDeployment, init: {}, status: 404 },
  { name: "commit mutation", action: commitDeployment, init: post(identity), status: 409 },
  { name: "start mutation", action: startDeployment, init: post(creation), status: 400 },
  { name: "credential create", action: createCredential, init: post({ organizationId: "org", name: "key", scopes: ["docs:read"] }), status: 403 },
  { name: "credential list", action: listCredentials, init: {}, status: 403 },
  { name: "credential revoke", action: revokeCredential, init: post({ organizationId: "org", keyId: "key" }), status: 403 },
  { name: "share create", action: createShareGrant, init: post({ ...identity, documentPath: "index.html", assetPaths: [], expiresInSeconds: 60 }), status: 403 },
  { name: "share list", action: listShareGrants, init: {}, status: 403 },
  { name: "share revoke", action: revokeShareGrant, init: post({ organizationId: "org", grantId: "grant" }), status: 403 },
  { name: "publication create", action: createPublication, init: post({ ...identity, slug: "docs", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" }), status: 400 },
  { name: "project create", action: createProject, init: post({ organizationId: "org", name: "Docs", slug: "docs" }), status: 400 },
  { name: "project get", action: getProject, init: {}, status: 404 },
];

beforeEach(() => {
  vi.spyOn(apiKeyRateLimiter, "limit").mockResolvedValue({ ok: true });
  auth.authorize.mockResolvedValue({ user: { _id: "owner" } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

async function invoke(action: HttpAction, init: RequestInit, error: Error, apiKey = true) {
  const runQuery = vi.fn((reference: FunctionReference<"query">) => {
    if (getFunctionName(reference) === "apiKeyCredentials:verifiedIdInternal") return Promise.resolve("credential-id");
    if (getFunctionName(reference) === "apiKeyCredentials:validateInternal") {
      return Promise.resolve({ principal: { keyId: "key" }, credentialId: "credential-id", recordUsage: false });
    }
    return Promise.reject(error);
  });
  const runMutation = vi.fn((reference: FunctionReference<"mutation">) => {
    if (getFunctionName(reference) === "anonymousAdmission:consume") return Promise.resolve({ ok: true });
    return Promise.reject(error);
  });
  const ctx = { runQuery, runMutation };
  const handler = (action as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler;
  const response = await handler(ctx, new Request(`https://rendro.test/test?${new URLSearchParams({ ...identity, token: secret })}`, {
    ...init, headers: { origin: process.env.SITE_URL!, "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${secret}` } : {}) },
  }));
  return { response, runQuery, runMutation };
}
async function expectPrivateFailure(response: Response) {
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "Request failed" });
  expect(console.error).toHaveBeenCalledWith("HTTP request failed", { operation: expect.any(String), category: "Error", status: 500 });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
}

describe("HTTP fault injection", () => {
  it.each(routes)("keeps unexpected $name failures inside local catches as 500", async ({ action, init }) => {
    const { response, runQuery, runMutation } = await invoke(action, init, fault);
    await expectPrivateFailure(response);
    expect(runQuery.mock.calls.length + runMutation.mock.calls.length).toBeGreaterThan(0);
  });

  it.each(routes)("keeps explicitly classified $name errors as 4xx", async ({ action, init, status }) => {
    const error = new ConvexError("Controlled application failure");
    error.message = secret;
    const { response } = await invoke(action, init, error);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "Controlled application failure" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([getActiveDeployment, listPublications, managementAccess, managementMembers, createCredential, createShareGrant])("does not turn authorization-service outages into permission failures (%#)", async action => {
    auth.authorize.mockRejectedValue(fault);
    const init = action === createCredential ? post({ organizationId: "org", name: "key", scopes: ["docs:read"] })
      : action === createShareGrant ? post({ ...identity, documentPath: "index.html", assetPaths: [], expiresInSeconds: 60 }) : {};
    const { response } = await invoke(action, init, fault, false);
    await expectPrivateFailure(response);
  });

  it("catches a query fault outside any local catch", async () => {
    const { response, runQuery } = await invoke(resolveShareGrant, {}, fault);
    expect(runQuery).toHaveBeenCalledOnce();
    await expectPrivateFailure(response);
  });

  it.each([400, 403, 404, 409])("does not classify arbitrary strings or message matches as %s", async status => {
    for (const error of [secret, new Error(`Authentication required: ${secret}`), new Error(`A project with this slug already exists: ${secret}`)]) {
      const response = failure(error, status);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Request failed" });
    }
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
  });
});
