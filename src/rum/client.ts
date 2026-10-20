/**
 * Real-user monitoring for the repository shell (#282), shipped as `/rum.js`.
 *
 * Collects web-vitals for the shell document, the lazy tree's in-shell
 * navigation measures (`rendro:navigation`: activation → frame swap → frame
 * load → next paint), and the browser-side and Server-Timing durations of
 * frame, tree and search responses. A document frame is an opaque origin, so
 * the shell cannot see its Server-Timing: the frame reports its own with its
 * `doc-loaded` announcement (`documentResponseTiming`). Events are queued and
 * sent with `navigator.sendBeacon` when the page is hidden (`visibilitychange`,
 * or `pagehide` on a hidden page; never `unload`, which would cost the
 * back/forward cache), or once the queue is full.
 *
 * Nothing of ours runs on a click: it only observes performance entries, which
 * the browser delivers asynchronously (web-vitals' one input listener ends the
 * LCP observation on the first click or key). Events carry enumerations and numbers
 * (`src/rum/schema.ts`), never a URL, path or identifier.
 */
import { onCLS, onFCP, onINP, onLCP, onTTFB, type MetricType } from "web-vitals";
import { isRumEvent, RUM_MAX_EVENTS, RUM_PATH, RUM_TIERS, type RumEvent, type RumNavigation, type RumRoute, type RumTier } from "./schema";

/** What the lazy tree writes into each `rendro:navigation` measure. */
interface NavigationDetail {
  kind: "cold" | "switch" | "history";
  url: string;
  preloaded: boolean;
  swap: number;
  load: number;
}

type TimedEntry = PerformanceResourceTiming | PerformanceNavigationTiming;
/** A frame's report of its own response; untrusted until each event built from it passes the schema. */
interface FrameTiming { url?: unknown; tier?: unknown; server?: unknown; response?: unknown }

const NAVIGATION_MEASURE = "rendro:navigation";
/** How web-vitals names the way a page was loaded, in the dataset's terms. */
const SHELL_NAVIGATIONS: Record<MetricType["navigationType"], RumNavigation> = {
  navigate: "cold", reload: "reload", prerender: "prerender", "back-forward": "back-forward",
  "back-forward-cache": "bfcache", restore: "reload", "soft-navigation": "switch",
};
/** Navigation Timing's types, likewise. */
const ENTRY_NAVIGATIONS: Record<NavigationTimingType, RumNavigation> = {
  navigate: "cold", reload: "reload", prerender: "prerender", back_forward: "back-forward",
};

const queue: RumEvent[] = [];
const observers: PerformanceObserver[] = [];
/**
 * Frames' reports of their own response, by document address (path and query), each kept until one
 * navigation uses it. A frame and the shell run apart, so a report can arrive before or after the
 * navigation it belongs to: a navigation without its report waits for it (`waiting`).
 */
const frameTimings = new Map<string, FrameTiming>();
const MAX_FRAME_TIMINGS = 16;
const waiting: Array<{ address: string; complete: (timing: FrameTiming) => void }> = [];

function send(): void {
  for (const observer of observers) observer.takeRecords().forEach(handle);
  // A frame that never reported (an engine without Navigation Timing, a failed load) still gets its navigation reported.
  for (const navigation of waiting.splice(0)) navigation.complete({});
  // Draining can queue more than a beacon holds (each event recorded past the limit sends again), so send in
  // beacon-sized parts. A string body is text/plain: a simple same-origin request. A refused beacon (quota) is dropped.
  while (queue.length) navigator.sendBeacon(RUM_PATH, JSON.stringify({ v: 1, events: queue.splice(0, RUM_MAX_EVENTS) }));
}

function record(event: RumEvent): void {
  if (!isRumEvent(event)) return;
  queue.push(event);
  if (queue.length >= RUM_MAX_EVENTS) send();
}

function knownTier(description: unknown): RumTier | undefined {
  return RUM_TIERS.find(tier => tier === description);
}

/** The `cache` tier a response's Server-Timing named, if it named one this schema knows. */
function tierOf(entry: TimedEntry | undefined): RumTier | undefined {
  return knownTier(entry?.serverTiming.find(timing => timing.name === "cache")?.description);
}

/** The response as the browser saw it, and the Worker's own total, when it sent one. */
function recordResponse(route: RumRoute, entry: TimedEntry, nav: RumNavigation, extra: Partial<RumEvent> = {}): void {
  const tier = tierOf(entry);
  if (route !== "shell") record({ route, metric: "response", value: entry.responseEnd - entry.startTime, nav, tier, ...extra });
  const total = entry.serverTiming.find(timing => timing.name === "total");
  if (total) record({ route, metric: "server", value: total.duration, nav, tier, ...extra });
}

const navigation = performance.getEntriesByType("navigation")[0] as (PerformanceNavigationTiming & { activationStart?: number }) | undefined;
/** Navigation start → activation, for a prerendered shell; the reader saw nothing before it. */
const activationStart = navigation?.activationStart ?? 0;
/** How this shell was loaded; a restore from the back/forward cache changes it. */
let shellNavigation: RumNavigation = activationStart > 0 ? "prerender" : ENTRY_NAVIGATIONS[navigation?.type ?? "navigate"];

function handle(entry: PerformanceEntry): void {
  if (entry.entryType === "measure") {
    if (entry.name === NAVIGATION_MEASURE) handleNavigation(entry as PerformanceMeasure);
    return;
  }
  const resource = entry as PerformanceResourceTiming;
  const url = new URL(resource.name);
  if (url.origin !== location.origin || !url.pathname.startsWith("/r/")) return;
  if (url.pathname.endsWith("/tree")) recordResponse("tree", resource, shellNavigation);
  else if (url.pathname.endsWith("/search")) recordResponse("search", resource, shellNavigation);
}

/** A document address as both the lazy tree and the frame's own location write it. */
function address(href: string): string {
  const url = new URL(href, location.href);
  return url.pathname + url.search;
}

function handleNavigation(measure: PerformanceMeasure): void {
  const detail = measure.detail as NavigationDetail;
  // The shell's first document starts at navigation start; a prerendered one counts from activation.
  const cold = detail.kind === "cold";
  const shift = cold ? activationStart : 0;
  const nav = cold ? shellNavigation : detail.kind;
  const complete = (timing: FrameTiming) => {
    const common = { route: "frame" as const, nav, tier: knownTier(timing.tier), preloaded: detail.preloaded };
    record({ ...common, metric: "swap", value: Math.max(0, detail.swap - shift) });
    record({ ...common, metric: "load", value: Math.max(0, detail.load - shift) });
    // A cold measure starts at 0, so its duration is its end.
    record({ ...common, metric: "switch", value: Math.max(0, measure.duration - shift) });
    // Requests carry no preload flag: for a preload, the request ran before the click.
    record({ ...common, preloaded: undefined, metric: "response", value: timing.response as number });
    record({ ...common, preloaded: undefined, metric: "server", value: timing.server as number });
  };
  const key = address(detail.url);
  const timing = frameTimings.get(key);
  if (!timing) {
    waiting.push({ address: key, complete });
    return;
  }
  frameTimings.delete(key);
  complete(timing);
}

/** A document frame's `doc-loaded` announcement: only its timing is read, and only from a frame of this shell. */
function handleMessage(event: MessageEvent): void {
  const data = event.data as { type?: unknown; timing?: FrameTiming } | null;
  const fromFrame = Array.from(document.querySelectorAll("iframe")).some(frame => frame.contentWindow === event.source);
  if (!fromFrame || data?.type !== "doc-loaded" || typeof data.timing?.url !== "string") return;
  const timing = data.timing;
  const url = timing.url as string;
  const index = waiting.findIndex(navigation => navigation.address === url);
  if (index !== -1) {
    waiting.splice(index, 1)[0].complete(timing);
    return;
  }
  frameTimings.delete(url);
  frameTimings.set(url, timing);
  if (frameTimings.size > MAX_FRAME_TIMINGS) frameTimings.delete(frameTimings.keys().next().value as string);
}

function vital(metric: MetricType): void {
  const nav = SHELL_NAVIGATIONS[metric.navigationType];
  // A restored page made no request, so it has no tier.
  record({ route: "shell", metric: metric.name, value: metric.value, nav, tier: nav === "bfcache" ? undefined : tierOf(navigation) });
}

function observe(type: "measure" | "resource"): void {
  const observer = new PerformanceObserver(list => list.getEntries().forEach(handle));
  observer.observe({ type, buffered: true });
  observers.push(observer);
}

function start(): void {
  if (navigation) recordResponse("shell", navigation, shellNavigation);
  addEventListener("message", handleMessage);
  observe("measure");
  observe("resource");
  for (const report of [onCLS, onFCP, onINP, onLCP, onTTFB]) report(vital);
  addEventListener("pageshow", event => {
    if (event.persisted) shellNavigation = "bfcache";
  });
  // After web-vitals' own capture-phase listeners, so the metrics they finalize on hiding are queued first.
  const sendIfHidden = () => {
    if (document.visibilityState === "hidden") send();
  };
  document.addEventListener("visibilitychange", sendIfHidden);
  // Leaving fires pagehide while still visible, then visibilitychange: one beacon, sent once web-vitals has
  // finalized. A page that was already hidden (closed from the background) sends what it gathered since.
  addEventListener("pagehide", sendIfHidden);
}

// A prerendered shell starts collecting once the reader actually opens it (the event is the document's; it does not bubble).
if (document.prerendering) document.addEventListener("prerenderingchange", start, { once: true });
else start();
