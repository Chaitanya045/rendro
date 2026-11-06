import { parseEnv } from "./env-schema";

const env = parseEnv({ ...process.env });

export const NODE_ENV = env.NODE_ENV;
export const LOG_LEVEL = env.LOG_LEVEL ?? (NODE_ENV === "production" ? "info" : "debug");
export const CONVEX_URL = env.CONVEX_URL;
export const CONVEX_INTERNAL_SECRET = env.CONVEX_INTERNAL_SECRET;
export const CONVEX_SITE_URL = env.CONVEX_SITE_URL
  ?? (CONVEX_URL.startsWith("http://127.0.0.1:3210")
    ? CONVEX_URL.replace(/:3210$/, ":3211")
    : CONVEX_URL.replace(/\.cloud$/, ".site"));

export const IMAGE_PROXY_SECRET = env.IMAGE_PROXY_SECRET;
export const REPO_CAPABILITY_SECRET = env.REPO_CAPABILITY_SECRET;
export const REPO_CONTENT_KEY = env.REPO_CONTENT_KEY;
export const REPO_CONTENT_KEY_PREVIOUS = env.REPO_CONTENT_KEY_PREVIOUS;

export interface SignInMethods {
  github: boolean;
  email: boolean;
}

/**
 * The sign-in methods the pages offer (#338). GitHub once the App's client is configured; email unless
 * `AUTH_EMAIL_SIGN_IN=off`, which counts only once GitHub is configured, so it never leaves no way in.
 */
export function signInMethods(): SignInMethods {
  const github = Boolean(process.env.GITHUB_APP_CLIENT_ID);
  return { github, email: !github || process.env.AUTH_EMAIL_SIGN_IN !== "off" };
}

/** Where a reader installs the GitHub App on more repositories (#338), or null without its slug. */
export function githubAppInstallUrl(): string | null {
  const slug = process.env.GITHUB_APP_SLUG;
  return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
}
