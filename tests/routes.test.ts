import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler, Context } from "hono";
import appRoutes from "@/routes/app";
import type { User } from "better-auth/types";
import * as minio from "@/minio";
import * as orgs from "@/orgs";
import { verifySyncToken } from "@/config";


const apiKeyOrgsByHash = new Map<string, string>();

const convexFetchMock: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/api/")) return new Response("unexpected fetch", { status: 500 });

  const body = JSON.parse(String(init?.body ?? "{}")) as {
    path?: string;
    args?: [{ orgSlug?: string; keyHash?: string }];
  };
  const args = body.args?.[0] ?? {};

  if (url.endsWith("/api/mutation") && body.path === "apiKeys:create") {
    if (!args.orgSlug || !args.keyHash) {
      return new Response(JSON.stringify({ status: "error" }), { status: 400 });
    }
    for (const [hash, orgSlug] of apiKeyOrgsByHash) {
      if (orgSlug === args.orgSlug) apiKeyOrgsByHash.delete(hash);
    }
    apiKeyOrgsByHash.set(args.keyHash, args.orgSlug);
    return Response.json({ status: "success", value: null });
  }

  if (url.endsWith("/api/query") && body.path === "apiKeys:validate") {
    return Response.json({ status: "success", value: args.keyHash ? apiKeyOrgsByHash.get(args.keyHash) ?? null : null });
  }

  if (url.endsWith("/api/query") && body.path === "apiKeys:existsForOrg") {
    return Response.json({
      status: "success",
      value: args.orgSlug ? [...apiKeyOrgsByHash.values()].includes(args.orgSlug) : false,
    });
  }

  return new Response("unexpected fetch", { status: 500 });
};

vi.stubGlobal("fetch", convexFetchMock);

beforeEach(() => {
  apiKeyOrgsByHash.clear();
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", convexFetchMock);
});
// ────────────────────────────────────────────────────
// 1. verifySyncToken — config level
// ────────────────────────────────────────────────────
describe("verifySyncToken", () => {
  it("accepts correct token", async () => expect(verifySyncToken("test-sync-token")).toBe(true));
  it("rejects wrong token", async () => expect(verifySyncToken("wrong-token")).toBe(false));
  it("rejects empty token", async () => expect(verifySyncToken("")).toBe(false));
  it("rejects different-length token", async () => expect(verifySyncToken("x")).toBe(false));
  it("rejects case-different token", async () => expect(verifySyncToken("TEST-SYNC-TOKEN")).toBe(false));
});

// ────────────────────────────────────────────────────
// 2. API keys — generation, validation, org binding
// ────────────────────────────────────────────────────
describe("api-keys", () => {
  let createOrgApiKey: (slug: string) => Promise<string>;
  let validateApiKey: (key: string) => Promise<string | null>;
  let orgHasApiKey: (slug: string) => Promise<boolean>;

  beforeEach(async () => {
    // Dynamic import needed because api-keys module eagerly connects to SQLite.
    // The test setup already creates the tables, so this is safe.
    const mod = await import("@/api-keys");
    createOrgApiKey = mod.createOrgApiKey;
    validateApiKey = mod.validateApiKey;
    orgHasApiKey = mod.orgHasApiKey;
  });

  it("generates a key with rendro_ prefix", async () => {
    const key = await createOrgApiKey("test-org");
    expect(key).toMatch(/^rendro_/);
  });

  it("validates the generated key and returns org slug", async () => {
    const key = await createOrgApiKey("acme-corp");
    expect(await validateApiKey(key)).toBe("acme-corp");
  });

  it("returns null for an invalid key", async () => {
    expect(await validateApiKey("rendro_invalid_key")).toBeNull();
  });

  it("replaces existing key for same org", async () => {
    const key1 = await createOrgApiKey("replace-test");
    const key2 = await createOrgApiKey("replace-test");
    expect(await validateApiKey(key1)).toBeNull();
    expect(await validateApiKey(key2)).toBe("replace-test");
  });
  it("detects whether an org has an API key row", async () => {
    expect(await orgHasApiKey("missing-org")).toBe(false);
    await createOrgApiKey("keyed-org");
    expect(await orgHasApiKey("keyed-org")).toBe(true);
  });
});

// ────────────────────────────────────────────────────
// 3. App root — API key recovery
// ────────────────────────────────────────────────────
describe("app root API key recovery", () => {
  it("generates a new API key screen when the org exists but its key row is missing", async () => {
    vi.spyOn(minio, "listObjects").mockResolvedValue([
      { key: "gmail/index.html", name: "index.html", size: 1, lastModified: new Date("2025-01-01") },
    ]);

    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", async (c, next) => {
      c.set("user", { email: "owner@gmail.com", name: "Owner" } as User);
      await next();
    });
    app.route("/", appRoutes);

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("API key generated");
    expect(html).toContain("rendro_");
    expect([...apiKeyOrgsByHash.values()]).toContain("gmail");
  });

  it("also generates a new API key screen on /docs/:org when the key row is missing", async () => {
    vi.spyOn(minio, "listObjects").mockResolvedValue([
      { key: "gmail/index.html", name: "index.html", size: 1, lastModified: new Date("2025-01-01") },
    ]);

    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", async (c, next) => {
      c.set("user", { email: "owner@gmail.com", name: "Owner" } as User);
      await next();
    });
    app.route("/", appRoutes);

    const res = await app.request("/docs/gmail");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("API key generated");
    expect(html).toContain("rendro_");
    expect([...apiKeyOrgsByHash.values()]).toContain("gmail");
  });

});

// ────────────────────────────────────────────────────
// 3. Sync API routes — per-org key + org prefix enforcement
// ────────────────────────────────────────────────────
describe("sync API", () => {
  let createOrgApiKey: (slug: string) => Promise<string>;
  let validateApiKey: (key: string) => Promise<string | null>;

  beforeEach(async () => {
    const mod = await import("@/api-keys");
    createOrgApiKey = mod.createOrgApiKey;
    validateApiKey = mod.validateApiKey;
  });

  function makeSyncApp() {
    const app = new Hono();
    const authOrg = async (c: Context): Promise<string | null> => {
      const h = c.req.header("Authorization");
      if (!h?.startsWith("Bearer ")) return null;
      return await validateApiKey(h.slice(7));
    };

    app.post("/api/sync/upload", async (c) => {
      const org = await authOrg(c);
      if (!org) return c.text("Unauthorized", 401);
      const body = await c.req.json<{ key: string; content: string; contentType?: string }>();
      if (!body.key) return c.text("Missing key", 400);
      if (!body.key.startsWith(`${org}/`)) return c.text(`Must start with "${org}/"`, 400);
      return c.json({ ok: true });
    });

    app.get("/api/sync/check", async (c) => {
      const org = await authOrg(c);
      if (!org) return c.text("Unauthorized", 401);
      const key = c.req.query("key");
      if (!key) return c.text("Missing key", 400);
      if (!key.startsWith(`${org}/`)) return c.text(`Must start with "${org}/"`, 400);
      return c.json({ exists: false });
    });

    return app;
  }

  it("rejects upload without Authorization header", async () => {
    const app = makeSyncApp();
    const res = await app.request("/api/sync/upload", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "demo-org/x.html", content: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects upload with invalid API key", async () => {
    const app = makeSyncApp();
    const res = await app.request("/api/sync/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer invalid" },
      body: JSON.stringify({ key: "demo-org/x.html", content: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects upload to wrong org prefix", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeSyncApp();
    const res = await app.request("/api/sync/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ key: "acme-corp/hack.html", content: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects sync check without key param", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeSyncApp();
    const res = await app.request("/api/sync/check", {
      headers: { "Authorization": `Bearer ${key}` },
    });
    expect(res.status).toBe(400);
  });

  it("allows sync check with valid key on own org prefix", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeSyncApp();
    const res = await app.request("/api/sync/check?key=demo-org/index.html", {
      headers: { "Authorization": `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects sync check on wrong org prefix", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeSyncApp();
    const res = await app.request("/api/sync/check?key=acme-corp/index.html", {
      headers: { "Authorization": `Bearer ${key}` },
    });
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────────────
// 3b. Sync API — LIST + DELETE (sync-deletes)
// ────────────────────────────────────────────────────
describe("sync API — list + delete (sync-deletes)", () => {
  let createOrgApiKey: (slug: string) => Promise<string>;
  let validateApiKey: (key: string) => Promise<string | null>;

  beforeEach(async () => {
    const mod = await import("@/api-keys");
    createOrgApiKey = mod.createOrgApiKey;
    validateApiKey = mod.validateApiKey;
  });

  function makeApp() {
    const app = new Hono();
    const authOrg = async (c: Context): Promise<string | null> => {
      const h = c.req.header("Authorization");
      if (!h?.startsWith("Bearer ")) return null;
      return await validateApiKey(h.slice(7));
    };

    const serverKeys = [
      "demo-org/rendro-test/index.html",
      "demo-org/rendro-test/guides/index.html",
      "demo-org/rendro-api/index.html",
      "demo-org/rendro-api/guides/index.html",
    ];
    const syncPrefixForOrg = (org: string, prefix?: string): string | null => {
      if (!prefix) return `${org}/`;
      if (!prefix.startsWith(`${org}/`)) return null;
      if (!prefix.endsWith("/") || prefix.includes("..") || prefix.includes("\\") || prefix.includes("\0")) return null;
      return prefix;
    };

    app.get("/api/sync/list", async (c) => {
      const org = await authOrg(c);
      if (!org) return c.text("Unauthorized", 401);
      const prefix = syncPrefixForOrg(org, c.req.query("prefix"));
      if (!prefix) return c.text(`Prefix must be under ${org}/`, 400);
      return c.json({ keys: serverKeys.filter((key) => key.startsWith(prefix)) });
    });

    app.delete("/api/sync/delete", async (c) => {
      const org = await authOrg(c);
      if (!org) return c.text("Unauthorized", 401);
      const key = c.req.query("key");
      if (!key) return c.text("Missing key", 400);
      if (!key.startsWith(`${org}/`) || key.includes("..")) return c.text("Bad key", 400);
      return c.json({ deleted: true, key });
    });

    return app;
  }

  // LIST tests
  it("LIST returns 401 without auth", async () => {
    const app = makeApp();
    const res = await app.request("/api/sync/list");
    expect(res.status).toBe(401);
  });

  it("LIST returns only the authed org's prefix", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/list", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[] };
    expect(body.keys.every((k) => k.startsWith("demo-org/"))).toBe(true);
  });

  it("LIST scopes deletes to one repo prefix and preserves same filenames in sibling repos", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/list?prefix=demo-org/rendro-test/", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[] };
    expect(body.keys).toEqual([
      "demo-org/rendro-test/index.html",
      "demo-org/rendro-test/guides/index.html",
    ]);
    expect(body.keys).not.toContain("demo-org/rendro-api/index.html");

    const localKeys = new Set(["demo-org/rendro-test/index.html"]);
    const deleteCandidates = body.keys.filter((serverKey) => !localKeys.has(serverKey));
    expect(deleteCandidates).toEqual(["demo-org/rendro-test/guides/index.html"]);
  });

  it("LIST rejects cross-org repo prefixes", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/list?prefix=acme-corp/rendro-test/", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(400);
  });

  it("LIST rejects path traversal in repo prefixes", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/list?prefix=demo-org/../rendro-test/", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(400);
  });

  // DELETE tests
  it("DELETE returns 401 without auth", async () => {
    const app = makeApp();
    const res = await app.request("/api/sync/delete?key=demo-org/x.html", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("DELETE returns 400 for cross-org key", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/delete?key=acme-corp/x.html", {
      method: "DELETE", headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE returns 400 for path traversal", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/delete?key=demo-org/../../acme-corp/x.html", {
      method: "DELETE", headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE returns 200 for valid same-org key", async () => {
    const key = await createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/delete?key=demo-org/old-file.html", {
      method: "DELETE", headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────
// 4. Session middleware — dev bypass
// ────────────────────────────────────────────────────
describe("session middleware", () => {
  let sessionMiddleware: MiddlewareHandler;

  beforeEach(async () => {
    const mod = await import("@/middleware/session");
    sessionMiddleware = mod.sessionMiddleware;
  });

  it("sets user from X-Dev-User header in development", async () => {
    process.env.NODE_ENV = "development";
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", sessionMiddleware);
    app.get("/me", (c) => c.json(c.get("user") ?? null));

    const res = await app.request("/me", { headers: { "X-Dev-User": "alice@acme-corp.com" } });
    const body = (await res.json()) as { email: string } | null;
    expect(body).toBeTruthy();
    expect(body!.email).toBe("alice@acme-corp.com");
  });

  it("sets user and dev cookie from dev_user query in development", async () => {
    process.env.NODE_ENV = "development";
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", sessionMiddleware);
    app.get("/me", (c) => c.json(c.get("user") ?? null));

    const first = await app.request("/me?dev_user=carol%40acme-corp.com");
    const firstBody = (await first.json()) as { email: string } | null;
    expect(firstBody?.email).toBe("carol@acme-corp.com");
    const setCookie = first.headers.get("set-cookie");
    expect(setCookie).toContain("rendro-dev-user=carol%40acme-corp.com");

    const second = await app.request("/me", { headers: { cookie: setCookie ?? "" } });
    const secondBody = (await second.json()) as { email: string } | null;
    expect(secondBody?.email).toBe("carol@acme-corp.com");
  });

  it("sets user from rendro-dev-user cookie in development", async () => {
    process.env.NODE_ENV = "development";
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", sessionMiddleware);
    app.get("/me", (c) => c.json(c.get("user") ?? null));

    const res = await app.request("/me", { headers: { cookie: "rendro-dev-user=bob%40acme-corp.com" } });
    const body = (await res.json()) as { email: string } | null;
    expect(body).toBeTruthy();
    expect(body!.email).toBe("bob@acme-corp.com");
  });

  it("leaves user null when no session and no dev header", async () => {
    process.env.NODE_ENV = "development";
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", sessionMiddleware);
    app.get("/me", (c) => c.json(c.get("user") ?? null));

    const res = await app.request("/me");
    const body = await res.json();
    expect(body).toBeNull();
  });
});

// ────────────────────────────────────────────────────
// 5. orgExists — MinIO integration
// ────────────────────────────────────────────────────
describe("orgExists", () => {
  it("returns true when files exist under org prefix", async () => {
    const spied = vi.spyOn(minio, "listObjects");
    spied.mockResolvedValueOnce([{ key: "test-org/x.html", name: "x", size: 10, lastModified: new Date() }]);
    expect(await orgs.orgExists("test-org")).toBe(true);
    spied.mockRestore();
  });

  it("returns false when no files exist", async () => {
    const spied = vi.spyOn(minio, "listObjects");
    spied.mockResolvedValueOnce([]);
    expect(await orgs.orgExists("empty-org")).toBe(false);
    spied.mockRestore();
  });
});
