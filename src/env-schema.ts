// Hand-written validation rather than zod (#357): zod and its locales were about 46% of the serving
// Worker's bundle, and every new isolate parses all of it. The accept and reject rules, the defaults and
// the messages are the ones the zod schema produced; tests/config.test.ts pins each of them.

const NODE_ENVS = ["development", "production", "test"] as const;
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const SIGN_IN_SWITCH = ["on", "off"] as const;
/** The GitHub App's URL slug (#338). */
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MIN_SECRET_LENGTH = 32;

export interface Env {
  NODE_ENV: (typeof NODE_ENVS)[number];
  LOG_LEVEL: (typeof LOG_LEVELS)[number] | undefined;
  CONVEX_URL: string;
  CONVEX_SITE_URL: string | undefined;
  CONVEX_INTERNAL_SECRET: string;
  IMAGE_PROXY_SECRET: string;
  REPO_CAPABILITY_SECRET: string;
  REPO_CONTENT_KEY: string;
  REPO_CONTENT_KEY_PREVIOUS: string | undefined;
  GITHUB_APP_CLIENT_ID: string | undefined;
  AUTH_EMAIL_SIGN_IN: (typeof SIGN_IN_SWITCH)[number] | undefined;
  GITHUB_APP_SLUG: string | undefined;
}

/** zod measured string length in code points, so an emoji counts once, not as its two UTF-16 units. */
const codePoints = (value: string): number => Array.from(value).length;

/** Same rule as zod's `.url()`: whatever the URL parser accepts after trimming; tabs and newlines the parser ignores are dropped from the value. */
function cleanUrl(value: string): string | undefined {
  const trimmed = value.trim();
  return URL.canParse(trimmed) ? trimmed.replace(/[\t\n\r]/g, "") : undefined;
}

/**
 * Reads and checks the environment, reporting every problem at once. A missing value or an unknown
 * enum value also skips the cross-field checks (as the zod schema did); a short, malformed or reused
 * value does not.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const lines: string[] = [];
  let skipCrossChecks = false;
  const report = (key: string, message: string, fatal = false) => {
    lines.push(`  - ${key}: ${message}`);
    skipCrossChecks ||= fatal;
  };
  const oneOf = <T extends string>(key: string, options: readonly T[]): T | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if ((options as readonly string[]).includes(value)) return value as T;
    report(key, `Invalid option: expected one of ${options.map((option) => JSON.stringify(option)).join("|")}`, true);
    return undefined;
  };
  /** A string setting; `problem` names what is wrong with a present value. */
  const text = (key: string, required: boolean, problem?: (value: string) => string | undefined): string | undefined => {
    const value = raw[key];
    if (value === undefined) {
      if (required) report(key, "Invalid input: expected string, received undefined", true);
      return undefined;
    }
    const message = problem?.(value);
    if (message) report(key, message);
    return value;
  };
  const secret = (key: string, required: boolean) =>
    text(key, required, (value) => (codePoints(value) < MIN_SECRET_LENGTH ? `${key} must be at least ${MIN_SECRET_LENGTH} characters` : undefined));

  // The order of these reads is the order problems are listed in.
  const NODE_ENV = oneOf("NODE_ENV", NODE_ENVS) ?? "development";
  const LOG_LEVEL = oneOf("LOG_LEVEL", LOG_LEVELS);
  const CONVEX_URL = text("CONVEX_URL", false) ?? "";
  let CONVEX_SITE_URL = raw.CONVEX_SITE_URL;
  if (CONVEX_SITE_URL !== undefined) {
    const cleaned = cleanUrl(CONVEX_SITE_URL);
    if (cleaned === undefined) report("CONVEX_SITE_URL", "Invalid URL");
    else CONVEX_SITE_URL = cleaned;
  }
  const CONVEX_INTERNAL_SECRET = secret("CONVEX_INTERNAL_SECRET", true) as string;
  // Signs same-origin image proxy URLs (/img/<sig>/<url>) at ingest; dedicated, never reused.
  const IMAGE_PROXY_SECRET = secret("IMAGE_PROXY_SECRET", true) as string;
  // Signs repository capability cookies and asset tickets (#234). Its own secret: rotating it
  // only signs readers back in through the permission source.
  const REPO_CAPABILITY_SECRET = secret("REPO_CAPABILITY_SECRET", true) as string;
  // Seals private-repository content in R2 (#263): per-repository AES-256-GCM keys are derived
  // from it. Dedicated, and the same value on the ingest Worker. During a rotation the previous
  // key stays as REPO_CONTENT_KEY_PREVIOUS until no content sealed under it remains.
  const REPO_CONTENT_KEY = secret("REPO_CONTENT_KEY", true) as string;
  const REPO_CONTENT_KEY_PREVIOUS = secret("REPO_CONTENT_KEY_PREVIOUS", false);
  // GitHub sign-in (#338): the GitHub App's OAuth client ID. Set (with the client secret in Convex), the
  // sign-in page offers GitHub. AUTH_EMAIL_SIGN_IN=off then makes sign-in GitHub-only (Convex reads it too).
  const GITHUB_APP_CLIENT_ID = text("GITHUB_APP_CLIENT_ID", false);
  const AUTH_EMAIL_SIGN_IN = oneOf("AUTH_EMAIL_SIGN_IN", SIGN_IN_SWITCH);
  // The GitHub App's slug (#338): the home links to its installation page.
  const GITHUB_APP_SLUG = text("GITHUB_APP_SLUG", false, (value) => (APP_SLUG.test(value) ? undefined : "GITHUB_APP_SLUG must be the App's URL slug"));

  if (!skipCrossChecks) {
    if ([CONVEX_INTERNAL_SECRET, IMAGE_PROXY_SECRET].includes(REPO_CAPABILITY_SECRET)) {
      report("REPO_CAPABILITY_SECRET", "REPO_CAPABILITY_SECRET must not reuse another secret");
    }
    if ([CONVEX_INTERNAL_SECRET, IMAGE_PROXY_SECRET, REPO_CAPABILITY_SECRET, REPO_CONTENT_KEY_PREVIOUS].includes(REPO_CONTENT_KEY)) {
      report("REPO_CONTENT_KEY", "REPO_CONTENT_KEY must not reuse another secret");
    }
  }
  if (lines.length) throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  return {
    NODE_ENV, LOG_LEVEL, CONVEX_URL, CONVEX_SITE_URL, CONVEX_INTERNAL_SECRET, IMAGE_PROXY_SECRET, REPO_CAPABILITY_SECRET,
    REPO_CONTENT_KEY, REPO_CONTENT_KEY_PREVIOUS, GITHUB_APP_CLIENT_ID, AUTH_EMAIL_SIGN_IN, GITHUB_APP_SLUG,
  };
}
