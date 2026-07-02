import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler, Context } from "hono";
import type { User } from "better-auth/types";
import * as minio from "@/minio";
import * as orgs from "@/orgs";
import { verifySyncToken } from "@/config";

// ────────────────────────────────────────────────────
// 1. verifySyncToken — config level
// ────────────────────────────────────────────────────
describe("verifySyncToken", () => {
  it("accepts correct token", () => expect(verifySyncToken("test-sync-token")).toBe(true));
  it("rejects wrong token", () => expect(verifySyncToken("wrong-token")).toBe(false));
  it("rejects empty token", () => expect(verifySyncToken("")).toBe(false));
  it("rejects different-length token", () => expect(verifySyncToken("x")).toBe(false));
  it("rejects case-different token", () => expect(verifySyncToken("TEST-SYNC-TOKEN")).toBe(false));
});

// ────────────────────────────────────────────────────
// 2. API keys — generation, validation, org binding
// ────────────────────────────────────────────────────
describe("api-keys", () => {
  let createOrgApiKey: (slug: string) => string;
  let validateApiKey: (key: string) => string | null;

  beforeEach(async () => {
    // Dynamic import needed because api-keys module eagerly connects to SQLite.
    // The test setup already creates the tables, so this is safe.
    const mod = await import("@/api-keys");
    createOrgApiKey = mod.createOrgApiKey;
    validateApiKey = mod.validateApiKey;
  });

  it("generates a key with docsk_ prefix", () => {
    const key = createOrgApiKey("test-org");
    expect(key).toMatch(/^docsk_/);
  });

  it("validates the generated key and returns org slug", () => {
    const key = createOrgApiKey("acme-corp");
    expect(validateApiKey(key)).toBe("acme-corp");
  });

  it("returns null for an invalid key", () => {
    expect(validateApiKey("docsk_invalid_key")).toBeNull();
  });

  it("replaces existing key for same org", () => {
    const key1 = createOrgApiKey("replace-test");
    const key2 = createOrgApiKey("replace-test");
    expect(validateApiKey(key1)).toBeNull();
    expect(validateApiKey(key2)).toBe("replace-test");
  });
});

// ────────────────────────────────────────────────────
// 3. Sync API routes — per-org key + org prefix enforcement
// ────────────────────────────────────────────────────
describe("sync API", () => {
  let createOrgApiKey: (slug: string) => string;
  let validateApiKey: (key: string) => string | null;

  beforeEach(async () => {
    const mod = await import("@/api-keys");
    createOrgApiKey = mod.createOrgApiKey;
    validateApiKey = mod.validateApiKey;
  });

  function makeSyncApp() {
    const app = new Hono();
    const authOrg = (c: Context): string | null => {
      const h = c.req.header("Authorization");
      if (!h?.startsWith("Bearer ")) return null;
      return validateApiKey(h.slice(7));
    };

    app.post("/api/sync/upload", async (c) => {
      const org = authOrg(c);
      if (!org) return c.text("Unauthorized", 401);
      const body = await c.req.json<{ key: string; content: string; contentType?: string }>();
      if (!body.key) return c.text("Missing key", 400);
      if (!body.key.startsWith(`${org}/`)) return c.text(`Must start with "${org}/"`, 400);
      return c.json({ ok: true });
    });

    app.get("/api/sync/check", (c) => {
      const org = authOrg(c);
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
    const key = createOrgApiKey("demo-org");
    const app = makeSyncApp();
    const res = await app.request("/api/sync/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ key: "acme-corp/hack.html", content: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects sync check without key param", async () => {
    const key = createOrgApiKey("demo-org");
    const app = makeSyncApp();
    const res = await app.request("/api/sync/check", {
      headers: { "Authorization": `Bearer ${key}` },
    });
    expect(res.status).toBe(400);
  });

  it("allows sync check with valid key on own org prefix", async () => {
    const key = createOrgApiKey("demo-org");
    const app = makeSyncApp();
    const res = await app.request("/api/sync/check?key=demo-org/index.html", {
      headers: { "Authorization": `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects sync check on wrong org prefix", async () => {
    const key = createOrgApiKey("demo-org");
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
  let createOrgApiKey: (slug: string) => string;
  let validateApiKey: (key: string) => string | null;

  beforeEach(async () => {
    const mod = await import("@/api-keys");
    createOrgApiKey = mod.createOrgApiKey;
    validateApiKey = mod.validateApiKey;
  });

  function makeApp() {
    const app = new Hono();
    const authOrg = (c: Context): string | null => {
      const h = c.req.header("Authorization");
      if (!h?.startsWith("Bearer ")) return null;
      return validateApiKey(h.slice(7));
    };

    app.get("/api/sync/list", (c) => {
      const org = authOrg(c);
      if (!org) return c.text("Unauthorized", 401);
      return c.json({ keys: [`${org}/a.html`, `${org}/b.html`] });
    });

    app.delete("/api/sync/delete", (c) => {
      const org = authOrg(c);
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
    const key = createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/list", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: string[] };
    expect(body.keys.every((k) => k.startsWith("demo-org/"))).toBe(true);
  });

  // DELETE tests
  it("DELETE returns 401 without auth", async () => {
    const app = makeApp();
    const res = await app.request("/api/sync/delete?key=demo-org/x.html", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("DELETE returns 400 for cross-org key", async () => {
    const key = createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/delete?key=acme-corp/x.html", {
      method: "DELETE", headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE returns 400 for path traversal", async () => {
    const key = createOrgApiKey("demo-org");
    const app = makeApp();
    const res = await app.request("/api/sync/delete?key=demo-org/../../acme-corp/x.html", {
      method: "DELETE", headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(400);
  });

  it("DELETE returns 200 for valid same-org key", async () => {
    const key = createOrgApiKey("demo-org");
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
