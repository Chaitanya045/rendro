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
import type * as apiKeyHttp from "../apiKeyHttp.js";
import type * as apiKeyRateLimitBuckets from "../apiKeyRateLimitBuckets.js";
import type * as apiKeyRateLimits from "../apiKeyRateLimits.js";
import type * as apiKeys from "../apiKeys.js";
import type * as auth from "../auth.js";
import type * as authEmails from "../authEmails.js";
import type * as authHttp from "../authHttp.js";
import type * as authorization from "../authorization.js";
import type * as commentOperations from "../commentOperations.js";
import type * as credentialHash from "../credentialHash.js";
import type * as credentialHttp from "../credentialHttp.js";
import type * as crons from "../crons.js";
import type * as deletedFiles from "../deletedFiles.js";
import type * as deploymentHttp from "../deploymentHttp.js";
import type * as deployments from "../deployments.js";
import type * as documentReplies from "../documentReplies.js";
import type * as documentThreads from "../documentThreads.js";
import type * as http from "../http.js";
import type * as httpErrors from "../httpErrors.js";
import type * as ids from "../ids.js";
import type * as legacyComments from "../legacyComments.js";
import type * as migrationHttp from "../migrationHttp.js";
import type * as organizationLifecycle from "../organizationLifecycle.js";
import type * as projects from "../projects.js";
import type * as publicErrors from "../publicErrors.js";
import type * as publicFunctions from "../publicFunctions.js";
import type * as publicPagination from "../publicPagination.js";
import type * as publicationHttp from "../publicationHttp.js";
import type * as publicationsV2 from "../publicationsV2.js";
import type * as qaPermissionFixtures from "../qaPermissionFixtures.js";
import type * as qaWorkspaceFixtures from "../qaWorkspaceFixtures.js";
import type * as rendroHttp from "../rendroHttp.js";
import type * as replies from "../replies.js";
import type * as retention from "../retention.js";
import type * as retentionHttp from "../retentionHttp.js";
import type * as security from "../security.js";
import type * as sessionReadLimit from "../sessionReadLimit.js";
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
  apiKeyHttp: typeof apiKeyHttp;
  apiKeyRateLimitBuckets: typeof apiKeyRateLimitBuckets;
  apiKeyRateLimits: typeof apiKeyRateLimits;
  apiKeys: typeof apiKeys;
  auth: typeof auth;
  authEmails: typeof authEmails;
  authHttp: typeof authHttp;
  authorization: typeof authorization;
  commentOperations: typeof commentOperations;
  credentialHash: typeof credentialHash;
  credentialHttp: typeof credentialHttp;
  crons: typeof crons;
  deletedFiles: typeof deletedFiles;
  deploymentHttp: typeof deploymentHttp;
  deployments: typeof deployments;
  documentReplies: typeof documentReplies;
  documentThreads: typeof documentThreads;
  http: typeof http;
  httpErrors: typeof httpErrors;
  ids: typeof ids;
  legacyComments: typeof legacyComments;
  migrationHttp: typeof migrationHttp;
  organizationLifecycle: typeof organizationLifecycle;
  projects: typeof projects;
  publicErrors: typeof publicErrors;
  publicFunctions: typeof publicFunctions;
  publicPagination: typeof publicPagination;
  publicationHttp: typeof publicationHttp;
  publicationsV2: typeof publicationsV2;
  qaPermissionFixtures: typeof qaPermissionFixtures;
  qaWorkspaceFixtures: typeof qaWorkspaceFixtures;
  rendroHttp: typeof rendroHttp;
  replies: typeof replies;
  retention: typeof retention;
  retentionHttp: typeof retentionHttp;
  security: typeof security;
  sessionReadLimit: typeof sessionReadLimit;
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
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
