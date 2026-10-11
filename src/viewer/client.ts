import { rewriteCssUrls } from "./css-urls";
import { createStylesheetRenewer } from "./stylesheets";

interface ParentConfig { base: string }
interface FrameConfig extends ParentConfig { prefix: string; manifestKey: string }
interface RenewalMessage { type?: string; requestId?: string; manifestKey?: string; prefix?: string }

export function installViewerParent(config: ParentConfig, host: Window = window): void {
  let pending = false;
  host.addEventListener("message", (event: MessageEvent<RenewalMessage>) => {
    const frame = host.document.getElementById("content-frame") as HTMLIFrameElement | null;
    const data = event.data;
    if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== "null"
      || !data || data.type !== "viewer-renew" || typeof data.requestId !== "string" || data.requestId.length > 128
      || typeof data.manifestKey !== "string" || data.manifestKey.length > 2048 || pending) return;
    const src = new URL(frame.src, host.location.href);
    if (src.origin !== host.location.origin || !src.pathname.startsWith(`${config.base}/files/`)) return;
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
        // Never turn this into a general fetch or credential broker.
        if (frame.src === src.href && typeof result.prefix === "string" && result.prefix.startsWith(`${config.base}/view/`)) {
          source.postMessage({ type: "viewer-renewed", requestId: data.requestId, prefix: result.prefix }, "*");
        }
      } catch { /* Retry on the next heartbeat or resume. */ }
      finally { pending = false; }
    })();
  });
}

export function installViewerFrame(config: FrameConfig, host: Window = window): void {
  const doc = host.document;
  const base = doc.querySelector<HTMLBaseElement>("base[data-rendro-viewer]");
  if (!base) return;
  const origin = new URL(base.href).origin;
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
