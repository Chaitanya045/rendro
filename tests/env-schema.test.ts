import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env-schema";

// The accept and reject rules the zod schema defined before #357 removed it from the serving Worker's bundle.
const secret = (character: string, length = 32) => character.repeat(length);
const valid = {
  CONVEX_INTERNAL_SECRET: secret("a"),
  IMAGE_PROXY_SECRET: secret("b"),
  REPO_CAPABILITY_SECRET: secret("c"),
  REPO_CONTENT_KEY: secret("d"),
};
const problems = (raw: Record<string, string | undefined>): string => {
  try {
    parseEnv(raw);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
};
const invalid = (lines: string[]) => `Invalid environment:\n${lines.map((line) => `  - ${line}`).join("\n")}`;

describe("parseEnv accepts", () => {
  it("the four required secrets alone, with every default", () => {
    expect(parseEnv(valid)).toEqual({
      ...valid,
      NODE_ENV: "development",
      LOG_LEVEL: undefined,
      CONVEX_URL: "",
      CONVEX_SITE_URL: undefined,
      REPO_CONTENT_KEY_PREVIOUS: undefined,
      GITHUB_APP_CLIENT_ID: undefined,
      AUTH_EMAIL_SIGN_IN: undefined,
      GITHUB_APP_SLUG: undefined,
    });
  });

  it("every setting at once, and ignores keys it does not know", () => {
    const all = {
      ...valid,
      NODE_ENV: "production", LOG_LEVEL: "silent", CONVEX_URL: "https://a.convex.cloud", CONVEX_SITE_URL: "https://a.convex.site",
      REPO_CONTENT_KEY_PREVIOUS: secret("e"), GITHUB_APP_CLIENT_ID: "Iv1.abc", AUTH_EMAIL_SIGN_IN: "off", GITHUB_APP_SLUG: "rendro-app",
    };
    expect(parseEnv({ ...all, PORT: "not a port", BASE_URL: "not a URL" })).toEqual(all);
  });

  it.each(["development", "production", "test"])("NODE_ENV=%s", (value) => {
    expect(parseEnv({ ...valid, NODE_ENV: value }).NODE_ENV).toBe(value);
  });

  it.each(["fatal", "error", "warn", "info", "debug", "trace", "silent"])("LOG_LEVEL=%s", (value) => {
    expect(parseEnv({ ...valid, LOG_LEVEL: value }).LOG_LEVEL).toBe(value);
  });

  it.each(["on", "off"])("AUTH_EMAIL_SIGN_IN=%s", (value) => {
    expect(parseEnv({ ...valid, AUTH_EMAIL_SIGN_IN: value }).AUTH_EMAIL_SIGN_IN).toBe(value);
  });

  it("an empty CONVEX_URL and GITHUB_APP_CLIENT_ID, which are plain strings", () => {
    expect(parseEnv({ ...valid, CONVEX_URL: "", GITHUB_APP_CLIENT_ID: "" })).toMatchObject({ CONVEX_URL: "", GITHUB_APP_CLIENT_ID: "" });
  });

  it.each([
    ["https://a.convex.site", "https://a.convex.site"],
    [" https://a.convex.site \n", "https://a.convex.site"],
    ["https://a\n.convex\t.site\r", "https://a.convex.site"],
    ["http://127.0.0.1:3211", "http://127.0.0.1:3211"],
    ["mailto:ops@example.com", "mailto:ops@example.com"],
    ["//still-not-a-url", undefined],
  ])("CONVEX_SITE_URL %j as %j", (value, expected) => {
    if (expected === undefined) expect(problems({ ...valid, CONVEX_SITE_URL: value })).toBe(invalid(["CONVEX_SITE_URL: Invalid URL"]));
    else expect(parseEnv({ ...valid, CONVEX_SITE_URL: value }).CONVEX_SITE_URL).toBe(expected);
  });

  it.each(["a", "rendro", "rendro-app", "0-9", "a".repeat(100)])("the App slug %j", (value) => {
    expect(parseEnv({ ...valid, GITHUB_APP_SLUG: value }).GITHUB_APP_SLUG).toBe(value);
  });

  it("a secret measured in characters, not UTF-16 units: 32 emoji pass and 16 do not", () => {
    expect(parseEnv({ ...valid, REPO_CONTENT_KEY: "😀".repeat(32) }).REPO_CONTENT_KEY).toBe("😀".repeat(32));
    expect(problems({ ...valid, REPO_CONTENT_KEY: "😀".repeat(16) })).toBe(invalid(["REPO_CONTENT_KEY: REPO_CONTENT_KEY must be at least 32 characters"]));
    expect(parseEnv({ ...valid, REPO_CONTENT_KEY: "é".repeat(32) }).REPO_CONTENT_KEY).toBe("é".repeat(32));
  });
});

describe("parseEnv rejects", () => {
  it.each(Object.keys(valid))("a missing %s", (key) => {
    expect(problems({ ...valid, [key]: undefined })).toBe(invalid([`${key}: Invalid input: expected string, received undefined`]));
  });

  it.each(Object.keys(valid))("an empty %s and one a character short", (key) => {
    const message = invalid([`${key}: ${key} must be at least 32 characters`]);
    expect(problems({ ...valid, [key]: "" })).toBe(message);
    expect(problems({ ...valid, [key]: "x".repeat(31) })).toBe(message);
  });

  it("a short previous content key, but not an absent one", () => {
    expect(problems({ ...valid, REPO_CONTENT_KEY_PREVIOUS: "" })).toBe(invalid(["REPO_CONTENT_KEY_PREVIOUS: REPO_CONTENT_KEY_PREVIOUS must be at least 32 characters"]));
  });

  it.each([
    ["NODE_ENV", "", '"development"|"production"|"test"'],
    ["NODE_ENV", "Production", '"development"|"production"|"test"'],
    ["NODE_ENV", "staging", '"development"|"production"|"test"'],
    ["LOG_LEVEL", "", '"fatal"|"error"|"warn"|"info"|"debug"|"trace"|"silent"'],
    ["LOG_LEVEL", "INFO", '"fatal"|"error"|"warn"|"info"|"debug"|"trace"|"silent"'],
    ["LOG_LEVEL", "verbose", '"fatal"|"error"|"warn"|"info"|"debug"|"trace"|"silent"'],
    ["AUTH_EMAIL_SIGN_IN", "", '"on"|"off"'],
    ["AUTH_EMAIL_SIGN_IN", "ON", '"on"|"off"'],
    ["AUTH_EMAIL_SIGN_IN", "true", '"on"|"off"'],
  ])("%s=%j", (key, value, options) => {
    expect(problems({ ...valid, [key]: value })).toBe(invalid([`${key}: Invalid option: expected one of ${options}`]));
  });

  it.each(["", " ", "not a URL", "https://", "http://exa mple.com", "example.com", "http:", "/relative"])("CONVEX_SITE_URL=%j", (value) => {
    expect(problems({ ...valid, CONVEX_SITE_URL: value })).toBe(invalid(["CONVEX_SITE_URL: Invalid URL"]));
  });

  it.each(["", "-a", "A", "a b", "a\n", "rendro_app", "é", "a".repeat(101)])("the App slug %j", (value) => {
    expect(problems({ ...valid, GITHUB_APP_SLUG: value })).toBe(invalid(["GITHUB_APP_SLUG: GITHUB_APP_SLUG must be the App's URL slug"]));
  });

  it.each(["CONVEX_INTERNAL_SECRET", "IMAGE_PROXY_SECRET"])("a capability secret that reuses %s", (key) => {
    expect(problems({ ...valid, [key]: valid.REPO_CAPABILITY_SECRET })).toBe(invalid(["REPO_CAPABILITY_SECRET: REPO_CAPABILITY_SECRET must not reuse another secret"]));
  });

  it.each(["CONVEX_INTERNAL_SECRET", "IMAGE_PROXY_SECRET", "REPO_CAPABILITY_SECRET", "REPO_CONTENT_KEY_PREVIOUS"])("a content key that reuses %s", (key) => {
    expect(problems({ ...valid, REPO_CONTENT_KEY_PREVIOUS: secret("e"), [key]: valid.REPO_CONTENT_KEY }))
      .toContain("REPO_CONTENT_KEY: REPO_CONTENT_KEY must not reuse another secret");
  });

  it("all problems at once, in the order of the settings", () => {
    const shared = secret("s");
    expect(problems({
      NODE_ENV: "x", LOG_LEVEL: "x", CONVEX_SITE_URL: "x", GITHUB_APP_SLUG: "-", AUTH_EMAIL_SIGN_IN: "x",
      CONVEX_INTERNAL_SECRET: "short", IMAGE_PROXY_SECRET: undefined, REPO_CAPABILITY_SECRET: shared, REPO_CONTENT_KEY: shared,
    })).toBe(invalid([
      'NODE_ENV: Invalid option: expected one of "development"|"production"|"test"',
      'LOG_LEVEL: Invalid option: expected one of "fatal"|"error"|"warn"|"info"|"debug"|"trace"|"silent"',
      "CONVEX_SITE_URL: Invalid URL",
      "CONVEX_INTERNAL_SECRET: CONVEX_INTERNAL_SECRET must be at least 32 characters",
      "IMAGE_PROXY_SECRET: Invalid input: expected string, received undefined",
      'AUTH_EMAIL_SIGN_IN: Invalid option: expected one of "on"|"off"',
      "GITHUB_APP_SLUG: GITHUB_APP_SLUG must be the App's URL slug",
    ]));
  });

  it("reuse checks still run beside a merely short secret, and are skipped beside a missing or unknown value", () => {
    const shared = secret("s");
    const reuse = { ...valid, REPO_CAPABILITY_SECRET: shared, REPO_CONTENT_KEY: shared };
    expect(problems({ ...reuse, CONVEX_SITE_URL: "x" })).toBe(invalid([
      "CONVEX_SITE_URL: Invalid URL", "REPO_CONTENT_KEY: REPO_CONTENT_KEY must not reuse another secret",
    ]));
    expect(problems({ ...reuse, IMAGE_PROXY_SECRET: "short" })).toBe(invalid([
      "IMAGE_PROXY_SECRET: IMAGE_PROXY_SECRET must be at least 32 characters", "REPO_CONTENT_KEY: REPO_CONTENT_KEY must not reuse another secret",
    ]));
    expect(problems({ ...reuse, IMAGE_PROXY_SECRET: undefined })).toBe(invalid(["IMAGE_PROXY_SECRET: Invalid input: expected string, received undefined"]));
    expect(problems({ ...reuse, NODE_ENV: "x" })).toBe(invalid(['NODE_ENV: Invalid option: expected one of "development"|"production"|"test"']));
  });
});
