import { vi } from "vitest";

// Test env vars must be set before any imports that read config
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.AUTH_SECRET = "test-auth-secret-32-chars-long!!";
process.env.MINIO_ENDPOINT = "http://localhost:9000";
process.env.MINIO_ACCESS_KEY = "minioadmin";
process.env.MINIO_SECRET_KEY = "minioadmin";
process.env.BASE_URL = "http://localhost:3000";
process.env.SYNC_TOKEN = "test-sync-token";
process.env.NODE_ENV = "test";
process.env.CONVEX_URL = "http://127.0.0.1:3210";

// Mock the better-auth SDK so tests don't try to open a real SQLite DB
// and don't try to talk to Google.
vi.mock("@/auth", () => {
  const handler = vi.fn((_req: Request) => {
    return new Response(JSON.stringify({ user: null }), { status: 200 });
  });
  const api = {
    getSession: vi.fn(() => null),
  };
  return { auth: { handler, api } };
});
