/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as apiKeyCredentials from "../apiKeyCredentials.js";
import type * as apiKeys from "../apiKeys.js";
import type * as auth from "../auth.js";
import type * as authEmails from "../authEmails.js";
import type * as authorization from "../authorization.js";
import type * as credentialHttp from "../credentialHttp.js";
import type * as deletedFiles from "../deletedFiles.js";
import type * as deploymentHttp from "../deploymentHttp.js";
import type * as deployments from "../deployments.js";
import type * as http from "../http.js";
import type * as migrationHttp from "../migrationHttp.js";
import type * as projects from "../projects.js";
import type * as publicationHttp from "../publicationHttp.js";
import type * as publicationsV2 from "../publicationsV2.js";
import type * as rendroHttp from "../rendroHttp.js";
import type * as replies from "../replies.js";
import type * as retention from "../retention.js";
import type * as retentionHttp from "../retentionHttp.js";
import type * as security from "../security.js";
import type * as shareGrantHttp from "../shareGrantHttp.js";
import type * as shareGrants from "../shareGrants.js";
import type * as threads from "../threads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  apiKeyCredentials: typeof apiKeyCredentials;
  apiKeys: typeof apiKeys;
  auth: typeof auth;
  authEmails: typeof authEmails;
  authorization: typeof authorization;
  credentialHttp: typeof credentialHttp;
  deletedFiles: typeof deletedFiles;
  deploymentHttp: typeof deploymentHttp;
  deployments: typeof deployments;
  http: typeof http;
  migrationHttp: typeof migrationHttp;
  projects: typeof projects;
  publicationHttp: typeof publicationHttp;
  publicationsV2: typeof publicationsV2;
  rendroHttp: typeof rendroHttp;
  replies: typeof replies;
  retention: typeof retention;
  retentionHttp: typeof retentionHttp;
  security: typeof security;
  shareGrantHttp: typeof shareGrantHttp;
  shareGrants: typeof shareGrants;
  threads: typeof threads;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
