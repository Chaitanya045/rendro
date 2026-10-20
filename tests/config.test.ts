import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requiredSettings = {
  CONVEX_INTERNAL_SECRET: "test-internal-secret-at-least-32-characters",
  IMAGE_PROXY_SECRET: "test-image-proxy-secret-at-least-32-chars",
  REPO_CAPABILITY_SECRET: "test-repo-capability-secret-at-least-32",
  REPO_CONTENT_KEY: "test-repo-content-key-at-least-32-chars",
};
const optionalSettings = [
  "NODE_ENV", "LOG_LEVEL", "CONVEX_URL", "CONVEX_SITE_URL", "REPO_CONTENT_KEY_PREVIOUS",
];

beforeEach(() => {
  vi.resetModules();
  for (const key of [...optionalSettings, "BASE_URL", "PORT", "AUTH_SECRET", "RETENTION_SECRET"]) {
    vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries(requiredSettings)) vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Worker environment validation", () => {
  it("loads with only the four required settings", async () => {
    const config = await import("../src/config");
    expect(config).toMatchObject({
      ...requiredSettings,
      NODE_ENV: "development",
      LOG_LEVEL: "debug",
      CONVEX_URL: "",
      CONVEX_SITE_URL: "",
      REPO_CONTENT_KEY_PREVIOUS: undefined,
    });
  });

  it("neither needs nor exports the share-signing and retention secrets that left with uploads (#286)", async () => {
    vi.stubEnv("AUTH_SECRET", "x");
    vi.stubEnv("RETENTION_SECRET", "x");
    const config = await import("../src/config");
    expect(Object.keys(config).filter(name => /AUTH_SECRET|RETENTION/.test(name))).toEqual([]);
  });

  it("starts the Worker and serves health without Convex URLs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: worker } = await import("../src/worker");
    const response = await worker.request("http://localhost/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("copies the Worker's string bindings into an unset process environment, never over a set one or a non-string binding", async () => {
    vi.stubEnv("RENDRO_TEST_BINDING", undefined);
    vi.stubEnv("RENDRO_TEST_PRESET", "kept");
    const { default: worker } = await import("../src/worker");
    const response = await worker.request("http://localhost/health", {}, { RENDRO_TEST_BINDING: "bound", RENDRO_TEST_PRESET: "ignored", RENDRO_TEST_OBJECT: {} });
    expect(response.status).toBe(200);
    expect(process.env.RENDRO_TEST_BINDING).toBe("bound");
    expect(process.env.RENDRO_TEST_PRESET).toBe("kept");
    expect(process.env.RENDRO_TEST_OBJECT).toBeUndefined();
  });

  it.each(Object.keys(requiredSettings))("rejects missing and empty %s", async (key) => {
    for (const value of [undefined, ""]) {
      vi.stubEnv(key, value);
      vi.resetModules();
      await expect(import("../src/config")).rejects.toThrow(new RegExp(`Invalid environment:[\\s\\S]*${key}`));
    }
  });

  it.each([
    ["CONVEX_INTERNAL_SECRET", 32],
    ["IMAGE_PROXY_SECRET", 32],
    ["REPO_CAPABILITY_SECRET", 32],
    ["REPO_CONTENT_KEY", 32],
    ["REPO_CONTENT_KEY_PREVIOUS", 32],
  ] as const)("enforces the minimum length of %s", async (key, minimum) => {
    vi.stubEnv(key, "x".repeat(minimum - 1));
    await expect(import("../src/config")).rejects.toThrow(`${key} must be at least ${minimum} characters`);
    vi.stubEnv(key, "x".repeat(minimum));
    vi.resetModules();
    await expect(import("../src/config")).resolves.toHaveProperty(key, "x".repeat(minimum));
  });

  it.each(["CONVEX_INTERNAL_SECRET", "IMAGE_PROXY_SECRET"])("refuses a repository capability secret that reuses %s", async (key) => {
    const shared = "a-secret-shared-by-two-settings-0123456789";
    vi.stubEnv(key, shared);
    vi.stubEnv("REPO_CAPABILITY_SECRET", shared);
    await expect(import("../src/config")).rejects.toThrow("REPO_CAPABILITY_SECRET must not reuse another secret");
  });

  it.each(["CONVEX_INTERNAL_SECRET", "IMAGE_PROXY_SECRET", "REPO_CAPABILITY_SECRET", "REPO_CONTENT_KEY_PREVIOUS"])(
    "refuses a repository content key that reuses %s", async (key) => {
      const shared = "a-content-key-shared-by-two-settings-0123456789";
      vi.stubEnv(key, shared);
      vi.stubEnv("REPO_CONTENT_KEY", shared);
      await expect(import("../src/config")).rejects.toThrow("REPO_CONTENT_KEY must not reuse another secret");
    },
  );

  it("accepts a previous content key during a rotation", async () => {
    vi.stubEnv("REPO_CONTENT_KEY_PREVIOUS", "test-repo-content-key-previous-0123456789");
    await expect(import("../src/config")).resolves.toMatchObject({ REPO_CONTENT_KEY_PREVIOUS: "test-repo-content-key-previous-0123456789" });
  });

  it("ignores an unused BASE_URL and the Node-only PORT", async () => {
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

  it("honors optional backend and logging overrides", async () => {
    const overrides = {
      CONVEX_SITE_URL: "https://backend.example.com",
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
    };
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
    await expect(import("../src/config")).resolves.toMatchObject(overrides);
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

  it("binds no upload bucket, no cron and no storage keys in any Wrangler environment", () => {
    // Uploads and their nightly retention purge are gone (#286); repository snapshots belong to the ingest Worker.
    const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").replace(/#.*$/gm, "");
    expect(wrangler).not.toMatch(/MINIO|S3_|ACCESS_KEY|SECRET_KEY|r2\.cloudflarestorage|r2\.dev/);
    expect(wrangler).not.toMatch(/r2_buckets|STORAGE|triggers|crons/);
    expect(wrangler).not.toMatch(/services|storage-faults|\[\[[^\]]*(?:service|durable)/i);
  });
});
