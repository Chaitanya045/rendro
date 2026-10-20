/**
 * The real-user monitoring beacon (#282): what the repository shell may send,
 * and the strict check the endpoint applies before anything is written.
 *
 * Every field is an enumeration or a bounded number. There is deliberately no
 * field that could carry a user, repository, path, URL, session or address,
 * and an event with any other key is refused, so one cannot be added by a
 * client. Shared by the browser bundle (`src/rum/client.ts`) and the Worker
 * route (`src/rum/route.ts`); it imports nothing.
 */

/** Same-origin, outside `/r/`, so no repository capability path is involved. */
export const RUM_PATH = "/rum";
/** Events per beacon; the client flushes before it would exceed this. */
export const RUM_MAX_EVENTS = 32;
/** Bytes per beacon, well above 32 events of the longest valid shape. */
export const RUM_MAX_BYTES = 8 * 1024;

/** What was measured: the shell document, a document frame, or a scripted tree or search read. */
export const RUM_ROUTES = ["shell", "frame", "tree", "search"] as const;
export const RUM_METRICS = [
  // web-vitals, for the shell document.
  "LCP", "INP", "CLS", "FCP", "TTFB",
  // In-shell navigation, from activation: the frame swap, the frame's load, and the next paint (the total).
  "swap", "load", "switch",
  // A request as the browser saw it (start → response end), and the Server-Timing total the Worker reported.
  "response", "server",
] as const;
/**
 * How the measured view began. The shell's own load: `cold`, `reload`,
 * `prerender`, `back-forward` (refetched) or `bfcache` (restored). Inside
 * the shell: `switch` (a link, search result or confirmed document link)
 * and `history` (back/forward between documents of one shell).
 */
export const RUM_NAVIGATIONS = ["cold", "reload", "prerender", "back-forward", "bfcache", "switch", "history"] as const;
/** The `cache` Server-Timing description: the slowest tier the response needed. */
export const RUM_TIERS = ["memory", "shared", "colo", "r2"] as const;

export type RumRoute = typeof RUM_ROUTES[number];
export type RumMetric = typeof RUM_METRICS[number];
export type RumNavigation = typeof RUM_NAVIGATIONS[number];
export type RumTier = typeof RUM_TIERS[number];

export interface RumEvent {
  route: RumRoute;
  metric: RumMetric;
  value: number;
  nav: RumNavigation;
  tier?: RumTier;
  /** Navigation metrics only: whether the reader's frame was a preloaded sibling. */
  preloaded?: boolean;
}

export interface RumBeacon {
  v: 1;
  events: RumEvent[];
}

/** The routes each metric may be reported for. */
const METRIC_ROUTES: Readonly<Record<RumMetric, readonly RumRoute[]>> = {
  LCP: ["shell"], INP: ["shell"], CLS: ["shell"], FCP: ["shell"], TTFB: ["shell"],
  swap: ["frame"], load: ["frame"], switch: ["frame"],
  response: ["frame", "tree", "search"], server: ["shell", "frame", "tree", "search"],
};
const NAVIGATION_METRICS: ReadonlySet<RumMetric> = new Set(["swap", "load", "switch"]);
/** An hour in milliseconds; CLS is a unitless score. Anything larger is not a real measurement. */
const MAX_DURATION = 3_600_000;
const MAX_CLS = 100;
const EVENT_KEYS: ReadonlySet<string> = new Set(["route", "metric", "value", "nav", "tier", "preloaded"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** One event as the endpoint accepts it; the client drops anything else before it is queued. */
export function isRumEvent(value: unknown): value is RumEvent {
  if (!isRecord(value) || !Object.keys(value).every(key => EVENT_KEYS.has(key))) return false;
  const { route, metric, value: measured, nav, tier, preloaded } = value;
  if (!oneOf(RUM_METRICS, metric) || !oneOf(RUM_ROUTES, route) || !METRIC_ROUTES[metric].includes(route)) return false;
  if (!oneOf(RUM_NAVIGATIONS, nav)) return false;
  if (typeof measured !== "number" || !Number.isFinite(measured) || measured < 0 || measured > (metric === "CLS" ? MAX_CLS : MAX_DURATION)) return false;
  if (tier !== undefined && !oneOf(RUM_TIERS, tier)) return false;
  return preloaded === undefined || (typeof preloaded === "boolean" && NAVIGATION_METRICS.has(metric));
}

/** The events of a well-formed beacon, or null when anything about it is off: no partial acceptance. */
export function parseBeacon(text: string): RumEvent[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.v !== 1 || !Array.isArray(value.events)) return null;
  const { events } = value;
  if (events.length === 0 || events.length > RUM_MAX_EVENTS || !events.every(isRumEvent)) return null;
  return events;
}
