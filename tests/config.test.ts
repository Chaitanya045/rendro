import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredSettings = {
  CONVEX_INTERNAL_SECRET: "test-internal-secret-at-least-32-characters",
  AUTH_SECRET: "test-share-signing-secret",
};
const optionalSettings = [
  "NODE_ENV", "LOG_LEVEL", "CONVEX_URL", "CONVEX_SITE_URL", "RETENTION_SECRET",
];

beforeEach(() => {
  vi.resetModules();
  for (const key of [...optionalSettings, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "BASE_URL", "PORT"]) {
    vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries(requiredSettings)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Worker environment validation", () => {
  it("loads with only the two required settings, without Google credentials", async () => {
    const config = await import("../src/config");
    expect(config).toMatchObject({
      ...requiredSettings,
      NODE_ENV: "development",
      LOG_LEVEL: "debug",
      CONVEX_URL: "",
      CONVEX_SITE_URL: "",
      RETENTION_SECRET: undefined,
    });
  });

  it("starts the Worker and serves health without Google credentials or Convex URLs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: worker } = await import("../src/worker");
    const response = await worker.request("http://localhost/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it.each(Object.keys(requiredSettings))("rejects missing and empty %s", async (key) => {
    for (const value of [undefined, ""]) {
      vi.stubEnv(key, value);
      vi.resetModules();
      await expect(import("../src/config")).rejects.toThrow(new RegExp(`Invalid environment:[\\s\\S]*${key}`));
    }
  });

  it.each([
    ["AUTH_SECRET", 16],
    ["CONVEX_INTERNAL_SECRET", 32],
  ] as const)("enforces the minimum length of %s", async (key, minimum) => {
    vi.stubEnv(key, "x".repeat(minimum - 1));
    await expect(import("../src/config")).rejects.toThrow(`${key} must be at least ${minimum} characters`);
    vi.stubEnv(key, "x".repeat(minimum));
    vi.resetModules();
    await expect(import("../src/config")).resolves.toHaveProperty(key, "x".repeat(minimum));
  });

  it("ignores unused Google/BASE_URL settings and the Node-only PORT", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("BASE_URL", "not a URL");
    vi.stubEnv("PORT", "not a port");
    await expect(import("../src/config")).resolves.toMatchObject(requiredSettings);
  });

  it.each([
    ["https://example.convex.cloud", "https://example.convex.site"],
    ["http://127.0.0.1:3210", "http://127.0.0.1:3211"],
  ])("derives the HTTP action URL from %s", async (url, siteUrl) => {
    vi.stubEnv("CONVEX_URL", url);
    await expect(import("../src/config")).resolves.toHaveProperty("CONVEX_SITE_URL", siteUrl);
  });

  it("honors optional backend, retention, and logging overrides", async () => {
    const overrides = {
      CONVEX_SITE_URL: "https://backend.example.com",
      RETENTION_SECRET: "r".repeat(32),
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
    };
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
    await expect(import("../src/config")).resolves.toMatchObject(overrides);
  });

  it("enforces the minimum length of the optional RETENTION_SECRET", async () => {
    vi.stubEnv("RETENTION_SECRET", "x".repeat(31));
    await expect(import("../src/config")).rejects.toThrow("RETENTION_SECRET must be at least 32 characters");
  });

  it("exports no storage endpoint or credential setting, and ignores any left in the environment", async () => {
    for (const key of ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET"]) vi.stubEnv(key, "leftover");
    const config = await import("../src/config");
    expect(Object.keys(config).filter(name => /MINIO|S3|ACCESS_KEY|SECRET_KEY|ENDPOINT/.test(name))).toEqual([]);
  });

  it("defaults production logging to info", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(import("../src/config")).resolves.toHaveProperty("LOG_LEVEL", "info");
  });

  it.each([
    ["NODE_ENV", "invalid"],
    ["LOG_LEVEL", "invalid"],
    ["CONVEX_SITE_URL", "not a URL"],
  ])("rejects invalid %s", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(import("../src/config")).rejects.toThrow(key);
  });

  it("declares exactly the startup-required settings in every Wrangler environment", () => {
    const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const declarations = [...wrangler.matchAll(/^\[((?:env\.[\w-]+\.)?secrets)\]\n([^[]*)required = (\[[^\n]+\])/gm)];
    expect(declarations.map((match) => match[1])).toEqual(["secrets", "env.development.secrets"]);
    for (const declaration of declarations) {
      expect((JSON.parse(declaration[3]) as string[]).sort()).toEqual(Object.keys(requiredSettings).sort());
    }
  });

  it("binds a private R2 bucket and the retention cron in every Wrangler environment, with no storage keys", () => {
    const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").replace(/#.*$/gm, "");
    expect(wrangler).not.toMatch(/MINIO|S3_|ACCESS_KEY|SECRET_KEY|r2\.cloudflarestorage|r2\.dev/);
    const buckets = [...wrangler.matchAll(/^\[\[((?:env\.[\w-]+\.)?r2_buckets)\]\]\nbinding = "(\w+)"\nbucket_name = "([\w-]+)"/gm)];
    expect(buckets.map(match => [match[1], match[2]])).toEqual([["r2_buckets", "STORAGE"], ["env.development.r2_buckets", "STORAGE"]]);
    expect(new Set(buckets.map(match => match[3])).size).toBe(2);
    // The E2E-only storage-faults service exists solely in the generated harness config (e2e/global-setup.ts), never in a deployable one.
    expect(wrangler).not.toMatch(/services|storage-faults|\[\[[^\]]*(?:service|durable)/i);
    expect([...wrangler.matchAll(/^\[((?:env\.[\w-]+\.)?triggers)\]\ncrons = \["23 3 \* \* \*"\]/gm)].map(match => match[1])).toEqual(["triggers", "env.development.triggers"]);
  });
});
