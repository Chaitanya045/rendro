import { createMessageRateLimit } from "./message-limits";
import { rewriteCssUrls } from "./css-urls";
import { createStylesheetRenewer } from "./stylesheets";

interface ParentConfig { base: string }
interface FrameConfig extends ParentConfig { prefix: string; manifestKey: string; deploymentId: string }
interface RenewalMessage { type?: string; requestId?: string; deploymentId?: string; manifestKey?: string; prefix?: string }

export function showViewerUpdateNotice(host: Window = window, message = "A newer version of this document was published."): void {
  const notice = host.document.getElementById("viewer-update-notice");
  // Repeated requests must not rewrite the live region or disturb the reader.
  if (!notice || !notice.hidden) return;
  notice.hidden = false;
  const status = notice.querySelector('[role="status"]');
  if (status) status.textContent = message;
}

/** Called only by the parent's authenticated Convex subscription. */
export function updateViewerActiveDeployment(deploymentId: string | null, host: Window = window): void {
  const frame = host.document.getElementById("content-frame");
  if (!frame) return;
  if (deploymentId === null) delete frame.dataset.activeDeployment;
  else frame.dataset.activeDeployment = deploymentId;
  if (frame.dataset.loadedDeployment && deploymentId && frame.dataset.loadedDeployment !== deploymentId) {
    showViewerUpdateNotice(host);
  }
}

export function installViewerParent(config: ParentConfig, host: Window = window): void {
  let pending = false;
  // Match the ticket/heartbeat clock while enforcing the budget in the parent.
  const allowRenewal = createMessageRateLimit(30_000, () => Date.now());
  let generation = 0;
  const notice = host.document.getElementById("viewer-update-notice");
  const reload = notice?.querySelector("button");
  reload?.addEventListener("click", () => {
    if (notice?.hidden || reload.disabled) return;
    reload.disabled = true;
    host.location.reload();
  });
  host.addEventListener("load", event => {
    if (event.target !== host.document.getElementById("content-frame")) return;
    generation++;
    const frame = host.document.getElementById("content-frame");
    if (frame) delete frame.dataset.loadedDeployment;
    if (notice) notice.hidden = true;
  }, true);
  host.addEventListener("message", (event: MessageEvent<RenewalMessage>) => {
    const frame = host.document.getElementById("content-frame") as HTMLIFrameElement | null;
    const data = event.data;
    if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== "null"
      || !data) return;
    const src = new URL(frame.src, host.location.href);
    if (src.origin !== host.location.origin || !src.pathname.startsWith(`${config.base}/files/`)) return;
    if (data.type === "viewer-loaded") {
      if (typeof data.deploymentId !== "string" || !data.deploymentId || data.deploymentId.length > 128) return;
      frame.dataset.loadedDeployment = data.deploymentId;
      updateViewerActiveDeployment(frame.dataset.activeDeployment ?? null, host);
      return;
    }
    if (data.type !== "viewer-renew" || typeof data.manifestKey !== "string" || data.manifestKey.length > 2048
      || typeof data.requestId !== "string" || data.requestId.length > 128 || pending || !allowRenewal()) return;
    pending = true;
    const source = frame.contentWindow;
    const requestedGeneration = generation;
    void (async () => {
      try {
        const query = new URLSearchParams({ manifestKey: data.manifestKey as string });
        const response = await host.fetch(`${config.base}/viewer-ticket?${query}`, {
          credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok && response.status !== 409) return;
        const result = await response.json() as { prefix?: unknown; code?: unknown };
        // A navigation (including a reload of the same path) invalidates replies
        // from the old frame. The notice never navigates or steals focus itself.
        if (frame.src !== src.href || generation !== requestedGeneration) return;
        if (response.status === 409) {
          if (result.code === "deployment_superseded") showViewerUpdateNotice(host);
          return;
        }
        // Never turn this into a general fetch or credential broker.
        if (frame.src === src.href && typeof result.prefix === "string" && result.prefix.startsWith(`${config.base}/view/`)) {
          source.postMessage({ type: "viewer-renewed", requestId: data.requestId, prefix: result.prefix }, "*");
        }
      } catch { /* Retry on the next heartbeat or resume. */ }
      finally { pending = false; }
    })();
  });
  // A fast iframe can finish before the shell's script executes. Ask it to
  // repeat its deployment; frames still loading will announce it on load.
  const frame = host.document.getElementById("content-frame") as HTMLIFrameElement | null;
  frame?.contentWindow?.postMessage({ type: "viewer-identify" }, "*");
}

export function installViewerFrame(config: FrameConfig, host: Window = window): void {
  const doc = host.document;
  // Location is the actual response URL even in an opaque sandbox. Unlike
  // document.baseURI or base.href, a publisher <base> cannot redirect it.
  const origin = host.location.origin;
  const reportDeployment = () => host.parent.postMessage({ type: "viewer-loaded", deploymentId: config.deploymentId }, origin);
  host.addEventListener("load", reportDeployment, { once: true });
  host.addEventListener("message", (event: MessageEvent<RenewalMessage>) => {
    if (event.source === host.parent && event.origin === origin && event.data?.type === "viewer-identify") reportDeployment();
  });
  const base = doc.querySelector<HTMLBaseElement>("base[data-rendro-viewer]");
  if (!base) return;
  let prefix = config.prefix;
  let managedCssUrls = new Set<string>();
  const renewStylesheet = createStylesheetRenewer();
  let renewedAt = Date.now();
  let requestedAt = 0;
  let requestId = "";
  function renew(force = false) {
    if (host.parent === host || Date.now() - requestedAt < 30_000) return;
    if (!force && Date.now() - renewedAt < 5 * 60_000) return;
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
    const oldBase = base.href;
    function replace(value: string): string {
      if (value.trimStart().startsWith("#")) return value;
      try {
        const url = new URL(value, oldBase);
        if (url.origin === origin && url.pathname.startsWith(prefix)) {
          url.pathname = next + url.pathname.slice(prefix.length);
          return url.href;
        }
      } catch { /* Leave publisher URLs outside this scope alone. */ }
      return value;
    }
    // Refresh resource URLs in place: no document reload, lost scroll, or lost
    // comment drafts. Reloading stylesheets also renews @import/url()/font URLs.
    const updates: Array<() => void> = [];
    for (const element of doc.querySelectorAll("img,source,video,audio,link,object,input[type=image]")) {
      for (const attribute of ["src", "href", "poster", "data"]) {
        if (attribute === "href" && element.tagName === "LINK" && (element as HTMLLinkElement).relList.contains("stylesheet")) {
          renewStylesheet(element as HTMLLinkElement, replace);
          continue;
        }
        const value = element.getAttribute(attribute);
        if (value === null) continue;
        const replacement = replace(value);
        if (replacement !== value) updates.push(() => element.setAttribute(attribute, replacement));
      }
      const srcset = element.getAttribute("srcset");
      if (srcset && !srcset.includes("data:")) {
        const replacement = srcset.split(",").map(candidate => {
          const [url, ...descriptor] = candidate.trim().split(/\s+/);
          return [replace(url), ...descriptor].join(" ");
        }).join(", ");
        updates.push(() => element.setAttribute("srcset", replacement));
      }
    }
    // Chromium retains the original base in parsed CSS. Resolve each scoped
    // URL explicitly, so even a resource first used after expiry gets the new
    // ticket. Reassigning identical relative CSS text is not sufficient.
    base.href = replace(oldBase);
    const nextCssUrls = new Set<string>();
    function replaceCssUrl(value: string): string {
      // Absolute publisher URLs do not inherit a ticket. Only absolute URLs
      // emitted by this client in the preceding renewal belong to this rewrite.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value.trimStart()) && !managedCssUrls.has(value)) return value;
      const replacement = replace(value);
      if (replacement !== value) nextCssUrls.add(replacement);
      return replacement;
    }
    for (const element of doc.querySelectorAll("[style],style")) {
      const style = element.getAttribute("style");
      if (style !== null) {
        const replacement = rewriteCssUrls(style, replaceCssUrl);
        if (replacement !== style) element.setAttribute("style", replacement);
      }
      if (element.tagName === "STYLE" && element.textContent) {
        renewStylesheet(element as HTMLStyleElement, css => rewriteCssUrls(css, replaceCssUrl));
      }
    }
    managedCssUrls = nextCssUrls;
    for (const update of updates) update();
    prefix = next;
    renewedAt = Date.now();
    requestId = "";
  });
  host.setInterval(() => renew(), 60_000);
  host.addEventListener("pageshow", () => renew());
  host.addEventListener("focus", () => renew());
  doc.addEventListener("visibilitychange", () => { if (!doc.hidden) renew(); });
  // Covers a suspended tab resuming after ticket expiry before its timer fires.
  doc.addEventListener("error", () => renew(true), true);
}
