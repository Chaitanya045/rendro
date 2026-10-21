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
import type * as auth from "../auth.js";
import type * as authEmails from "../authEmails.js";
import type * as authHttp from "../authHttp.js";
import type * as commentOperations from "../commentOperations.js";
import type * as crons from "../crons.js";
import type * as githubAuth from "../githubAuth.js";
import type * as http from "../http.js";
import type * as httpErrors from "../httpErrors.js";
import type * as publicErrors from "../publicErrors.js";
import type * as publicFunctions from "../publicFunctions.js";
import type * as publicPagination from "../publicPagination.js";
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
  auth: typeof auth;
  authEmails: typeof authEmails;
  authHttp: typeof authHttp;
  commentOperations: typeof commentOperations;
  crons: typeof crons;
  githubAuth: typeof githubAuth;
  http: typeof http;
  httpErrors: typeof httpErrors;
  publicErrors: typeof publicErrors;
  publicFunctions: typeof publicFunctions;
  publicPagination: typeof publicPagination;
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
