import { beforeEach, vi } from "vitest";

// Test env vars must be set before any imports that read config
process.env.AUTH_SECRET = "test-auth-secret-32-chars-long!!";
process.env.MINIO_ENDPOINT = "http://localhost:9000";
process.env.MINIO_ACCESS_KEY = "minioadmin";
process.env.MINIO_SECRET_KEY = "minioadmin";
process.env.NODE_ENV = "test";
process.env.CONVEX_URL = "http://127.0.0.1:3210";
process.env.CONVEX_INTERNAL_SECRET = "test-convex-internal-secret-32-chars";

// Convex auth tests still need these; the Worker config tests explicitly unset them.
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.SITE_URL = "http://localhost:3000";

// No permissive legacy credential/deletion emulator: tests must configure their backend.
globalThis.fetch = vi.fn(() => Promise.resolve(new Response("Not found", { status: 404 }))) as typeof fetch;

// Parsed deployment metadata is cached per isolate. Tests reuse manifest keys
// with different fixtures, so every test starts with an empty cache. Import it
// lazily so a test's module reset reaches its current instance.
beforeEach(async () => {
  (await import("../src/immutable-cache")).deploymentMetadataCache.clear();
});
