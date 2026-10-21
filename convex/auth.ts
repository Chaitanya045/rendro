import {
  createClient,
  type GenericCtx,
} from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import {
  betterAuth,
  type BetterAuthOptions,
} from "better-auth/minimal";
import { sessionReadLimit } from "./sessionReadLimit";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { AUTH_CLIENT_IP_HEADER } from "../shared/auth-client-ip";
import { authCookiePrefix } from "../shared/auth-cookies";
import { sendAuthLinkEmail, sendExistingAccountNotice } from "./authEmails";
import authSchema from "./betterAuth/schema";
import { boundSessionLifetime, sessionLifetime } from "./sessionLifetime";
import {
  EMAIL_SIGN_IN_PATHS, emailSignInEnabled, githubHandOff, githubSignInConfig, githubUserInfo, handOffCapture, withoutOAuthTokens,
} from "./githubAuth";

export const authComponent = createClient<DataModel, typeof authSchema>(
  components.betterAuth,
  { local: { schema: authSchema } },
);

function optionEnv(name: string): string {
  return process.env[name] ?? `schema-generation-${name.toLowerCase()}`;
}

function assertRuntimeEnvironment(): void {
  for (const name of [
    "SITE_URL",
    "AUTH_SECRET",
  ]) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
}

export function createAuthOptions(ctx: GenericCtx<DataModel>) {
  const siteUrl = process.env.SITE_URL ?? "http://localhost:3000";
  const github = githubSignInConfig();
  // What this request's GitHub sign-in, link or unlink hands the control Worker (convex/githubAuth.ts).
  const capture = handOffCapture();
  return {
    appName: "rendro",
    // Better Auth diagnostics can include callback URLs and raw exceptions.
    // Keep a fixed signal; request failures have structured HTTP status logs.
    logger: { log: () => console.error("Auth diagnostic", { category: "AuthDiagnostic" }) },
    baseURL: siteUrl,
    secret: optionEnv("AUTH_SECRET"),
    trustedOrigins: [siteUrl],
    database: (options: BetterAuthOptions) => boundSessionLifetime(withoutOAuthTokens(authComponent.adapter(ctx)(options), capture)),
    // `AUTH_EMAIL_SIGN_IN=off` (with GitHub configured): sign-in is GitHub-only.
    disabledPaths: emailSignInEnabled(github) ? [] : EMAIL_SIGN_IN_PATHS,
    advanced: {
      // HTTPS: host-only `__Host-better-auth.*` cookies (Secure, Path=/, no
      // Domain). Better Auth only knows `__Secure-`, so its automatic prefix is
      // off and the prefix is part of the name. Local HTTP stays unprefixed.
      useSecureCookies: false,
      cookiePrefix: authCookiePrefix(siteUrl),
      defaultCookieAttributes: { secure: siteUrl.startsWith("https://") },
      ipAddress: { ipAddressHeaders: [AUTH_CLIENT_IP_HEADER] },
      database: {
        generateId: false,
      },
    },
    session: {
      additionalFields: { rememberMe: { type: "boolean", required: false, input: false } },
      cookieCache: {
        // Authenticated requests must re-check persisted sessions so expiry and
        // revocation take effect immediately on every protected route.
        enabled: false,
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 15,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) =>
        sendAuthLinkEmail("password-reset", user, url),
      onExistingUserSignUp: ({ user }) =>
        sendExistingAccountNotice(user),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      sendVerificationEmail: ({ user, url }) =>
        sendAuthLinkEmail("verification", user, url),
    },
    // The GitHub App's user-to-server OAuth (#338), only when its client is configured.
    socialProviders: github ? {
      github: {
        clientId: github.clientId,
        clientSecret: github.clientSecret,
        // GitHub App permissions come from the App, not from OAuth scopes.
        disableDefaultScope: true,
        getUserInfo: githubUserInfo(capture),
      },
    } : {},
    account: {
      accountLinking: {
        enabled: true,
        // GitHub links to an account with the same address, but only one whose address was verified here,
        // and only with an address GitHub verified (githubUserInfo).
        trustedProviders: ["github"],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        // Verifier traffic is shared across users; token refresh is already
        // session-authenticated. Exact paths keep credential endpoints limited.
        "/convex/jwks": false,
        "/convex/token": false,
        "/token": false,
        "/convex/.well-known/openid-configuration": false,
        // The plugin applies real fixed windows; Better Auth resets only
        // after inactivity and would exhaust a busy shared IP indefinitely.
        "/get-session": false,
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-in/social": { window: 60, max: 10 },
        "/sign-up/email": { window: 60 * 60, max: 5 },
        "/request-password-reset": { window: 60 * 60, max: 5 },
        "/send-verification-email": { window: 60 * 60, max: 5 },
      },
    },
    plugins: [
      sessionReadLimit((key) => {
        if (!("runMutation" in ctx)) throw new Error("Session HTTP reads require a mutation-capable context");
        return ctx.runMutation(components.betterAuth.sessionReadLimit.consume, { key });
      }),
      sessionLifetime(),
      githubHandOff(capture, process.env.CONVEX_INTERNAL_SECRET),
      convex({ authConfig }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(
  ctx: GenericCtx<DataModel>,
  schemaGeneration = false,
) {
  if (!schemaGeneration) assertRuntimeEnvironment();
  return betterAuth(createAuthOptions(ctx));
}
