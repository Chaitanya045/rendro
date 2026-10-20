/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admissionBuckets from "../admissionBuckets.js";
import type * as apiKeyCredentials from "../apiKeyCredentials.js";
import type * as apiKeyHttp from "../apiKeyHttp.js";
import type * as apiKeyRateLimitBuckets from "../apiKeyRateLimitBuckets.js";
import type * as apiKeyRateLimits from "../apiKeyRateLimits.js";
import type * as auth from "../auth.js";
import type * as authEmails from "../authEmails.js";
import type * as authHttp from "../authHttp.js";
import type * as authorization from "../authorization.js";
import type * as commentOperations from "../commentOperations.js";
import type * as credentialHash from "../credentialHash.js";
import type * as credentialHttp from "../credentialHttp.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as httpErrors from "../httpErrors.js";
import type * as ids from "../ids.js";
import type * as organizationLifecycle from "../organizationLifecycle.js";
import type * as organizationPolicy from "../organizationPolicy.js";
import type * as projects from "../projects.js";
import type * as publicErrors from "../publicErrors.js";
import type * as publicFunctions from "../publicFunctions.js";
import type * as publicPagination from "../publicPagination.js";
import type * as qaPermissionFixtures from "../qaPermissionFixtures.js";
import type * as qaWorkspaceFixtures from "../qaWorkspaceFixtures.js";
import type * as rendroHttp from "../rendroHttp.js";
import type * as repoCommentAccess from "../repoCommentAccess.js";
import type * as repoComments from "../repoComments.js";
import type * as security from "../security.js";
import type * as sessionLifetime from "../sessionLifetime.js";
import type * as sessionReadLimit from "../sessionReadLimit.js";
import type * as writeQuotas from "../writeQuotas.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admissionBuckets: typeof admissionBuckets;
  apiKeyCredentials: typeof apiKeyCredentials;
  apiKeyHttp: typeof apiKeyHttp;
  apiKeyRateLimitBuckets: typeof apiKeyRateLimitBuckets;
  apiKeyRateLimits: typeof apiKeyRateLimits;
  auth: typeof auth;
  authEmails: typeof authEmails;
  authHttp: typeof authHttp;
  authorization: typeof authorization;
  commentOperations: typeof commentOperations;
  credentialHash: typeof credentialHash;
  credentialHttp: typeof credentialHttp;
  crons: typeof crons;
  http: typeof http;
  httpErrors: typeof httpErrors;
  ids: typeof ids;
  organizationLifecycle: typeof organizationLifecycle;
  organizationPolicy: typeof organizationPolicy;
  projects: typeof projects;
  publicErrors: typeof publicErrors;
  publicFunctions: typeof publicFunctions;
  publicPagination: typeof publicPagination;
  qaPermissionFixtures: typeof qaPermissionFixtures;
  qaWorkspaceFixtures: typeof qaWorkspaceFixtures;
  rendroHttp: typeof rendroHttp;
  repoCommentAccess: typeof repoCommentAccess;
  repoComments: typeof repoComments;
  security: typeof security;
  sessionLifetime: typeof sessionLifetime;
  sessionReadLimit: typeof sessionReadLimit;
  writeQuotas: typeof writeQuotas;
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
