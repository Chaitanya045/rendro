import {
  createClient,
  type GenericCtx,
} from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import {
  betterAuth,
  type BetterAuthOptions,
} from "better-auth/minimal";
import { organization } from "better-auth/plugins";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import {
  sendAuthLinkEmail,
  sendExistingAccountNotice,
  sendOrganizationInvitationEmail,
} from "./authEmails";
import authSchema from "./betterAuth/schema";

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
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ]) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
}

export function createAuthOptions(ctx: GenericCtx<DataModel>) {
  const siteUrl = process.env.SITE_URL ?? "http://localhost:3000";
  return {
    appName: "rendro",
    baseURL: siteUrl,
    secret: optionEnv("AUTH_SECRET"),
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    socialProviders: {
      google: {
        clientId: optionEnv("GOOGLE_CLIENT_ID"),
        clientSecret: optionEnv("GOOGLE_CLIENT_SECRET"),
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
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 20,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60 * 60, max: 5 },
        "/request-password-reset": { window: 60 * 60, max: 5 },
        "/send-verification-email": { window: 60 * 60, max: 5 },
      },
    },
    plugins: [
      organization({
        teams: { enabled: true },
        requireEmailVerificationOnInvitation: true,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        async sendInvitationEmail(data) {
          await sendOrganizationInvitationEmail({
            email: data.email,
            inviterName: data.inviter.user.name,
            organizationName: data.organization.name,
            invitationUrl: `${siteUrl}/accept-invitation/${encodeURIComponent(data.id)}`,
          });
        },
      }),
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
