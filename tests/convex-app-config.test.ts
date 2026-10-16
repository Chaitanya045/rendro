import { describe, expect, it, vi } from "vitest";

// The Convex CLI stamps imported component definitions with their install path
// while bundling convex.config.ts; outside that bundler only the stamp is missing.
vi.mock("../convex/betterAuth/convex.config", () => ({ default: { componentDefinitionPath: "./betterAuth", defaultName: "betterAuth" } }));
vi.mock("@convex-dev/rate-limiter/convex.config.js", () => ({ default: { componentDefinitionPath: "@convex-dev/rate-limiter/convex.config.js", defaultName: "rateLimiter" } }));

describe("Convex app composition", () => {
  it("installs exactly the Better Auth and rate limiter components under stable names", async () => {
    const { default: app } = await import("../convex/convex.config");
    const exported = (app as unknown as { export(): unknown }).export() as { definitionType: unknown; childComponents: Array<{ name: string; path: string; args: unknown }> };
    expect(exported.childComponents.map(({ name, path }) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "betterAuth", path: "./betterAuth" },
      { name: "rateLimiter", path: "@convex-dev/rate-limiter/convex.config.js" },
    ]);
  });
});
