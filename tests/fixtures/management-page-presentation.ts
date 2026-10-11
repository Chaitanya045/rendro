import type { MiddlewareHandler } from "hono";
import { vi } from "vitest";

// Presentation/runtime tests supply a signed-in user and exercise the HTML/JS.
// Real authorization and backend ID resolution run in management-page-access.test.ts.
vi.mock("@/routes/management-page-access", () => ({
  managementPageAccess: (async (_c, next) => { await next(); }) satisfies MiddlewareHandler,
}));
