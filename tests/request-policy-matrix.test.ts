import type { User } from "better-auth/types";
import { Hono } from "hono";
import { expect, it } from "vitest";
import http from "../convex/http";
import { httpActionPolicies } from "../shared/request-admission";
import { mountPublicRoutes, mountSessionRoutes } from "../src/app-routes";
import { workerMutationPolicies } from "../src/middleware/write-admission";

it("declares admission policy for every registered Convex HTTP route", () => {
  const routes = http.getRoutes();
  expect(routes.length).toBeGreaterThan(25);
  for (const [path, method, handler] of routes) {
    const policy = httpActionPolicies.get(handler);
    expect(policy, `${method} ${path}`).toBeDefined();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      expect(["cookie-json", "bearer", "mixed", "better-auth"], `${method} ${path}`).toContain(policy);
    }
  }
  // Pin security-sensitive assignments, rather than only testing membership.
  for (const [path, method, handler] of routes) {
    if (method === "POST" && /set-initial-password|projects$|credentials|shares/.test(path)) {
      expect(httpActionPolicies.get(handler), path).toBe("cookie-json");
    }
  }
});

it("enumerates every registered Worker mutation, including dedicated and wildcard proxies", () => {
  const app = new Hono<{ Variables: { user?: User } }>();
  mountPublicRoutes(app);
  mountSessionRoutes(app);
  const registered = new Set(app.routes.filter(route => ["POST", "PUT", "PATCH", "DELETE"].includes(route.method))
    .map(route => `${route.method} ${route.path}`));
  // Exact equality makes both new routes and stale policy entries visible.
  const policies = new Set(Object.keys(workerMutationPolicies));
  // These custom paths are handled by the registered Convex wildcard proxy.
  for (const path of ["/api/auth/set-initial-password", "/api/rendro/projects", "/api/rendro/credentials", "/api/rendro/credentials/revoke", "/api/rendro/shares/revoke"]) {
    policies.delete(`POST ${path}`);
  }
  expect([...registered].sort()).toEqual([...policies].sort());
});

it("inventories public state-changing RPCs, whose authority is explicit JWT or internal secret", async () => {
  const declared = {
    "deletedFiles:mark": "internal-secret",
    "documentReplies:add": "session-jwt", "documentReplies:remove": "session-jwt",
    "documentThreads:create": "session-jwt", "documentThreads:resolve": "session-jwt", "documentThreads:archive": "session-jwt", "documentThreads:remove": "session-jwt",
    "replies:add": "session-jwt", "replies:remove": "session-jwt",
    "threads:create": "session-jwt", "threads:resolve": "session-jwt", "threads:archive": "session-jwt", "threads:remove": "session-jwt",
    // Repository docs (#254): grants are written only by the read path and P5; comments need the reader's JWT and a grant.
    "repoCommentAccess:grant": "internal-secret", "repoCommentAccess:revokeUser": "internal-secret", "repoCommentAccess:removeRepos": "internal-secret",
    "repoComments:createThread": "session-jwt", "repoComments:resolve": "session-jwt", "repoComments:archive": "session-jwt",
    "repoComments:removeThread": "session-jwt", "repoComments:addReply": "session-jwt", "repoComments:removeReply": "session-jwt",
  };
  const registered: string[] = [];
  for (const [path, load] of Object.entries(import.meta.glob("../convex/**/*.ts"))) {
    if (path.endsWith(".config.ts") || path.includes("/_generated/") || path.includes("/betterAuth/")) continue;
    const exports = await load() as Record<string, unknown>;
    for (const [name, fn] of Object.entries(exports)) {
      if (typeof fn === "function" && "isPublic" in fn && fn.isPublic === true
        && (("isMutation" in fn && fn.isMutation === true) || ("isAction" in fn && fn.isAction === true))) {
        registered.push(`${path.slice("../convex/".length).replace(/\.ts$/, "")}:${name}`);
      }
    }
  }
  expect(registered.sort()).toEqual(Object.keys(declared).sort());
});
