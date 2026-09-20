import { vi } from "vitest";

// Test env vars must be set before any imports that read config
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.AUTH_SECRET = "test-auth-secret-32-chars-long!!";
process.env.MINIO_ENDPOINT = "http://localhost:9000";
process.env.MINIO_ACCESS_KEY = "minioadmin";
process.env.MINIO_SECRET_KEY = "minioadmin";
process.env.BASE_URL = "http://localhost:3000";
process.env.SITE_URL = "http://localhost:3000";
process.env.SYNC_TOKEN = "test-sync-token";
process.env.NODE_ENV = "test";
process.env.CONVEX_URL = "http://127.0.0.1:3210";
process.env.CONVEX_INTERNAL_SECRET = "test-convex-internal-secret-32-chars";

const keyHashByOrg = new Map<string, string>();
const orgByKeyHash = new Map<string, string>();

globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.endsWith("/api/query") && !url.endsWith("/api/mutation")) {
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }

  const body = typeof init?.body === "string" ? init.body : "{}";
  const payload = JSON.parse(body) as {
    path?: string;
    args?: Array<{ orgSlug?: string; keyHash?: string }>;
  };
  const args = payload.args?.[0] ?? {};
  let value: unknown = null;
  if (payload.path === "apiKeys:create" && args.orgSlug && args.keyHash) {
    const previousHash = keyHashByOrg.get(args.orgSlug);
    if (previousHash) orgByKeyHash.delete(previousHash);
    keyHashByOrg.set(args.orgSlug, args.keyHash);
    orgByKeyHash.set(args.keyHash, args.orgSlug);
    value = true;
  } else if (payload.path === "apiKeys:validate" && args.keyHash) {
    value = orgByKeyHash.get(args.keyHash) ?? null;
  }
  return Promise.resolve(Response.json({ status: "success", value }));
}) as typeof fetch;

