import { vi } from "vitest";

// Test env vars must be set before any imports that read config. AUTH_SECRET is Better Auth's (Convex).
process.env.AUTH_SECRET = "test-auth-secret-32-chars-long!!";
process.env.NODE_ENV = "test";
process.env.CONVEX_URL = "http://127.0.0.1:3210";
process.env.CONVEX_INTERNAL_SECRET = "test-convex-internal-secret-32-chars";
process.env.IMAGE_PROXY_SECRET = "test-image-proxy-secret-32-chars!";
process.env.REPO_CAPABILITY_SECRET = "test-repo-capability-secret-32-chars";
process.env.REPO_CONTENT_KEY = "test-repo-content-key-0123456789abcdef";

// Convex auth tests still need these; the Worker config tests explicitly unset them.
process.env.SITE_URL = "http://localhost:3000";

// No permissive legacy credential/deletion emulator: tests must configure their backend.
globalThis.fetch = vi.fn(() => Promise.resolve(new Response("Not found", { status: 404 }))) as typeof fetch;
