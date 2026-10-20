/**
 * The real-user monitoring endpoint (#282): `POST /rum`, written to a Workers
 * Analytics Engine dataset. Mounted before the session middleware; it reads no
 * cookie and sets none.
 *
 * In order: refuse a cross-site post; without the dataset or the rate-limit
 * binding, accept and drop; cap the body; parse the strict schema; take one
 * token from the in-colo rate limiter keyed on the verified client address
 * (an exhausted or failing limiter drops the beacon); write one data point per
 * event. A data point holds the event's enumerations, its value and the colo
 * that received it, and nothing else: no user, repository, path, address or
 * session. See docs/TECHNICAL.md, "Real-user monitoring".
 */
import { Hono, type MiddlewareHandler } from "hono";
import { BodyTooLargeError, readBoundedBody } from "@/bounded-body";
import { authClientIp } from "@/auth-client-ip";
import { parseBeacon, RUM_MAX_BYTES, RUM_PATH, type RumEvent } from "./schema";

/** The Workers Analytics Engine dataset binding surface used here. */
export interface AnalyticsDataset {
  writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void;
}

/** The Workers Rate Limiting binding surface used here (`[[ratelimits]]`). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const NO_STORE = { "Cache-Control": "private, no-store" };
/** Requests whose address the ingress did not register share one bucket, as Convex's limiter does for unverified callers. */
const UNVERIFIED_KEY = "unverified";
const COLO = /^[A-Z]{3}$/;
const beacons = new WeakMap<Request, RumEvent[]>();

function binding<T>(env: unknown, name: string, method: string): T | null {
  const value = (env as Record<string, unknown> | undefined)?.[name];
  return typeof (value as Record<string, unknown> | undefined)?.[method] === "function" ? value as T : null;
}

const dataset = (env: unknown) => binding<AnalyticsDataset>(env, "RUM_ANALYTICS", "writeDataPoint");
const limiter = (env: unknown) => binding<RateLimiter>(env, "RUM_LIMIT", "limit");

function siteOrigin(fallback: string): string | null {
  try {
    return new URL(process.env.SITE_URL ?? fallback).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a post comes from Rendro's own pages. The repository shell's
 * `no-referrer` policy makes a beacon's `Origin` the string "null", so where a
 * browser sends `Sec-Fetch-Site` it decides (and any real `Origin` must still
 * match); without it, only an exact `Origin` passes.
 */
export function sameOriginPost(request: Request, site: string | null): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (site === null) return false;
  if (fetchSite !== null) return fetchSite === "same-origin" && (origin === null || origin === "null" || origin === site);
  return origin === site;
}

/** The colo that received the beacon (`request.cf.colo`), or empty where there is none (Node, tests). */
function colo(request: Request): string {
  const value = (request as Request & { cf?: { colo?: unknown } }).cf?.colo;
  return typeof value === "string" && COLO.test(value) ? value : "";
}

/** One Analytics Engine data point; blob and double positions are the dataset's schema (docs/TECHNICAL.md). */
export function dataPoint(event: RumEvent, receivedBy: string): { indexes: string[]; blobs: string[]; doubles: number[] } {
  const preloaded = event.preloaded === undefined ? "" : event.preloaded ? "1" : "0";
  return {
    indexes: [event.metric],
    blobs: [event.route, event.metric, event.nav, event.tier ?? "", preloaded, receivedBy],
    doubles: [event.value],
  };
}

/** A refused or dropped beacon is not read; a cancel that fails changes nothing. */
function discard(request: Request): void {
  void request.body?.cancel().catch(() => {});
}

const admit: MiddlewareHandler = async (c, next) => {
  if (!sameOriginPost(c.req.raw, siteOrigin(c.req.url))) {
    discard(c.req.raw);
    return c.body(null, 403, NO_STORE);
  }
  // Not configured (production, until its deploy adds the bindings): accepted and dropped unread.
  if (!dataset(c.env) || !limiter(c.env)) {
    discard(c.req.raw);
    return c.body(null, 204, NO_STORE);
  }
  const type = c.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "text/plain" && type !== "application/json") {
    discard(c.req.raw);
    return c.body(null, 415, NO_STORE);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(c.req.raw, RUM_MAX_BYTES);
  } catch (error) {
    return c.body(null, error instanceof BodyTooLargeError ? 413 : 400, NO_STORE);
  }
  const events = parseBeacon(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  if (!events) return c.body(null, 400, NO_STORE);
  beacons.set(c.req.raw, events);
  await next();
};

/**
 * One token per beacon from the colo's limiter, keyed on the verified client
 * address. The address is the limiter's key only; it is never written. An
 * exhausted or failing limiter drops the beacon: monitoring never retries.
 */
async function admitted(request: Request, env: unknown): Promise<boolean> {
  try {
    return (await (limiter(env) as RateLimiter).limit({ key: authClientIp(request) ?? UNVERIFIED_KEY })).success;
  } catch {
    return false;
  }
}

const app = new Hono();
// Validation runs first, so only a beacon that would be written spends a token.
app.post(RUM_PATH, admit, async (c) => {
  if (!await admitted(c.req.raw, c.env)) return c.body(null, 204, NO_STORE);
  const target = dataset(c.env) as AnalyticsDataset;
  const receivedBy = colo(c.req.raw);
  for (const event of beacons.get(c.req.raw) as RumEvent[]) target.writeDataPoint(dataPoint(event, receivedBy));
  return c.body(null, 204, NO_STORE);
});

export default app;
