import { shellFrameNavigation } from "./content-frame";
import { createMessageRateLimit } from "./message-limits";

interface ParentConfig { base: string }
interface FrameConfig extends ParentConfig {
  prefix: string;
  manifestKey: string;
  /**
   * Private repository frames (#293) name their ticket only in their images' URLs. They say when it was issued
   * (a frame may come from the HTTP cache) and how long after that to renew it.
   */
  ticket?: { issuedAt: number; renewAfter: number };
}
interface RenewalMessage { type?: string; requestId?: string; manifestKey?: string; prefix?: string }

export function showViewerUpdateNotice(host: Window, message: string): void {
  const notice = host.document.getElementById("viewer-update-notice");
  // Repeated requests must not rewrite the live region or disturb the reader.
  if (!notice || !notice.hidden) return;
  notice.hidden = false;
  const status = notice.querySelector('[role="status"]');
  if (status) status.textContent = message;
}

export function installViewerParent(config: ParentConfig, host: Window = window): void {
  let pending = false;
  // Match the ticket/heartbeat clock while enforcing the budget in the parent.
  const allowRenewal = createMessageRateLimit(30_000, () => Date.now());
  const notice = host.document.getElementById("viewer-update-notice");
  const reload = notice?.querySelector("button");
  reload?.addEventListener("click", () => {
    if (notice?.hidden || reload.disabled) return;
    reload.disabled = true;
    host.location.reload();
  });
  // On the document: a frame's load never reaches the window.
  host.document.addEventListener("load", event => {
    const frame = host.document.getElementById("content-frame");
    if (!frame || event.target !== frame) return;
    if (notice) notice.hidden = true;
  }, true);
  host.addEventListener("message", (event: MessageEvent<RenewalMessage>) => {
    const frame = host.document.getElementById("content-frame") as HTMLIFrameElement | null;
    const data = event.data;
    if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== "null"
      || !data) return;
    // Only a document the shell loaded may hold a ticket (#296).
    const navigation = shellFrameNavigation(frame);
    if (navigation === null) return;
    const src = new URL(frame.src, host.location.href);
    if (src.origin !== host.location.origin || !src.pathname.startsWith(`${config.base}/files/`)) return;
    if (data.type !== "viewer-renew" || typeof data.manifestKey !== "string" || data.manifestKey.length > 2048
      || typeof data.requestId !== "string" || data.requestId.length > 128 || pending || !allowRenewal()) return;
    pending = true;
    const source = frame.contentWindow;
    void (async () => {
      try {
        const query = new URLSearchParams({ manifestKey: data.manifestKey as string });
        const response = await host.fetch(`${config.base}/viewer-ticket?${query}`, {
          credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) return;
        const result = await response.json() as { prefix?: unknown };
        // A navigation (including a reload of the same path, by the shell or not) invalidates replies from the old frame.
        if (frame.src !== src.href || shellFrameNavigation(frame) !== navigation) return;
        // Never turn this into a general fetch or credential broker.
        if (typeof result.prefix === "string" && result.prefix.startsWith(`${config.base}/view/`)) {
          source.postMessage({ type: "viewer-renewed", requestId: data.requestId, prefix: result.prefix }, "*");
        }
      } catch { /* Retry on the next heartbeat or resume. */ }
      finally { pending = false; }
    })();
  });
}

export function installViewerFrame(config: FrameConfig, host: Window = window): void {
  const doc = host.document;
  // Location is the actual response URL even in an opaque sandbox.
  const origin = host.location.origin;
  if (!config.ticket) return;
  const { renewAfter } = config.ticket;
  let prefix = config.prefix;
  let renewedAt = config.ticket.issuedAt;
  let requestedAt = 0;
  let requestId = "";
  // A resource failure that happened while hidden; the next visible moment retries it.
  let forceOnResume = false;
  function renew(force = false) {
    if (host.parent === host) return;
    // Hidden documents neither heartbeat nor renew; becoming visible settles it.
    if (doc.visibilityState === "hidden") { forceOnResume ||= force; return; }
    if (Date.now() - requestedAt < 30_000) return;
    if (!force && Date.now() - renewedAt < renewAfter) return;
    requestedAt = Date.now();
    requestId = crypto.randomUUID();
    host.parent.postMessage({ type: "viewer-renew", manifestKey: config.manifestKey, requestId }, origin);
  }
  host.addEventListener("message", (event: MessageEvent<RenewalMessage>) => {
    const data = event.data;
    if (event.source !== host.parent || event.origin !== origin || !data
      || data.type !== "viewer-renewed" || data.requestId !== requestId
      || typeof data.prefix !== "string" || !data.prefix.startsWith(`${config.base}/view/`)
      || !/^[-\w.]+\/files\/$/.test(data.prefix.slice(`${config.base}/view/`.length))) return;
    const next = data.prefix;
    // The sanitized document (#234) names a ticket only in its images' sources (#293): refresh them in place, with
    // no document reload, lost scroll, or lost comment drafts.
    for (const image of doc.querySelectorAll<HTMLImageElement>("img[src]")) {
      const url = new URL(image.src);
      if (url.origin !== origin || !url.pathname.startsWith(prefix)) continue;
      url.pathname = next + url.pathname.slice(prefix.length);
      image.setAttribute("src", url.href);
    }
    prefix = next;
    renewedAt = Date.now();
    requestId = "";
  });
  // The heartbeat only exists while the document is visible: a hidden tab
  // holds no timer and issues no renewals, whatever its throttling policy.
  let heartbeat: ReturnType<Window["setInterval"]> | undefined;
  const startHeartbeat = () => { heartbeat ??= host.setInterval(() => renew(), 60_000); };
  if (doc.visibilityState !== "hidden") startHeartbeat();
  host.addEventListener("pageshow", () => renew());
  host.addEventListener("focus", () => renew());
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") {
      if (heartbeat !== undefined) host.clearInterval(heartbeat);
      heartbeat = undefined;
      return;
    }
    startHeartbeat();
    // Wall-clock age decides: a ticket that is near expiry or already expired
    // is replaced now, without waiting for the next heartbeat.
    const force = forceOnResume;
    forceOnResume = false;
    renew(force);
  });
  // Covers a suspended tab resuming after ticket expiry before its timer fires.
  doc.addEventListener("error", () => renew(true), true);
}
