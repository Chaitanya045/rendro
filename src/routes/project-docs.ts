import { evictRejectedSession } from "@/session-cache";
import { assetError, assetHeaders, isHtmlAsset } from "@/routes/asset-headers";
import { decodeStoragePath, isCanonicalStorageKey, modernStoragePrefix, modernStorageKey } from "@/storage-boundary";
import { Hono } from "hono";
import { createViewerTicket, readViewerTicket, viewerSessionCookie } from "@/viewer-ticket";
import { viewerScript, viewerUpdateNotice } from "@/viewer/markup";
import { COMMENTOR_VERSION } from "@/viewer/asset-versions";
import { escapeHtml } from "@/routes/html";
import type { User } from "better-auth/types";
import { CONVEX_SITE_URL, CONVEX_URL } from "@/config";
import { getObjectStream, type ObjectRange } from "@/minio";
import { renderScopedDocumentShell } from "@/routes/app";
import { unavailableResponse, type ViewerUnavailable } from "@/routes/viewer-unavailable";
import { renderNotFoundPage } from "@/routes/not-found";
import { injectViewerHeadStream } from "@/routes/document-html";
import { contentEtag, contentSize, serveObject } from "@/routes/object-delivery";
import { deploymentDocuments, openDeploymentIndex, validTreeDirectory } from "@/deployment-index";
import { treePageCursor } from "@/routes/tree-pages";
import { validDocumentSearch } from "@/lazy-tree/messages";

const app = new Hono<{ Variables: { user?: User } }>();

type ActiveDeployment = { project: { name: string }; deployment: { manifestKey: string } };

function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function activeDeployment(
  organizationId: string,
  projectId: string,
  cookie: string | undefined,
): Promise<ActiveDeployment | ViewerUnavailable | null> {
  const query = new URLSearchParams({ organizationId, projectId });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const unavailable: ViewerUnavailable = { unavailable: true, retryAfter: "1" };
  try {
    const response = await fetch(`${CONVEX_SITE_URL}/api/rendro/deployments/active?${query}`, {
      headers: { Accept: "application/json", Cookie: viewerSessionCookie(cookie ?? "") },
      signal: controller.signal,
      redirect: "manual",
    });
    await evictRejectedSession(cookie ?? "", response.status);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      // Hide both missing and inaccessible documents without masking outages.
      if ([401, 403, 404].includes(response.status)) return null;
      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const delay = Number.isFinite(seconds) ? seconds : (Date.parse(retryAfter) - Date.now()) / 1_000;
        if (Number.isFinite(delay)) unavailable.retryAfter = String(Math.max(1, Math.ceil(delay)));
      }
      return unavailable;
    }
    const active = await response.json() as Partial<ActiveDeployment> | null;
    if (active === null || (typeof active?.project?.name === "string" && active.deployment === null)) return null;
    if (typeof active?.project?.name !== "string" || typeof active.deployment?.manifestKey !== "string"
      || !active.deployment.manifestKey) return unavailable;
    if (!modernStoragePrefix({ organizationId, projectId, manifestKey: active.deployment.manifestKey })) return null;
    return active as ActiveDeployment;
  } catch {
    // Network errors, timeouts (including body reads), and malformed payloads
    // are retryable. Never expose exception text or ticket/session material.
    return unavailable;
  } finally {
    clearTimeout(timeout);
  }

}

function basePath(organizationId: string, projectId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/docs`;
}

export function documentFeatures(
  options: {
    organizationId: string;
    projectId: string;
    legacyOrg?: string;
    documentPath: string;
    base: string;
    url: string;
  },
): string {
  const virtualPath = `${options.projectId}/${options.documentPath}`;
  return `<style data-rendro-mobile-viewport>
@media (max-width: 760px) {
  :root { scrollbar-width: none; }
  :root::-webkit-scrollbar { display: none; width: 0; height: 0; }
}
</style>
<script data-rendro-document-features>
(function(){
var p=window.parent;
document.addEventListener("keydown",function(e){var key=(e.key||"").toLowerCase();var shellShortcut=(key==="h"||e.code==="KeyH")&&(e.ctrlKey||e.metaKey)&&e.shiftKey&&!e.altKey&&!e.repeat&&!(e.getModifierState&&e.getModifierState("AltGraph"));if(shellShortcut&&!(e.target instanceof Element&&e.target.closest("input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable='']"))){e.preventDefault();p.postMessage({type:"shell-toggle"},"*");}});
})();
</script>
${viewerScript("navigation", { prefix: `${options.base}/files/`, ticketBase: `${options.base}/view/`, legacyPrefix: options.legacyOrg ? `/files/${encodeURIComponent(options.legacyOrg)}/` : undefined, documentPath: options.documentPath, loadedPath: virtualPath }, options.url)}
<script>window.COMMENTOR=${inlineJson({
    ...(options.legacyOrg ? { orgSlug: options.legacyOrg, filePath: `${options.legacyOrg}/${options.documentPath}` } : {}),
    organizationId: options.organizationId,
    projectId: options.projectId,
    documentPath: options.documentPath,
    transport: "parent",
    canWrite: true,
  })};</script>
<script defer src="/commentor.js?v=${COMMENTOR_VERSION}"></script>`;
}

app.get("/organizations/:organizationId/projects/:projectId/docs/tree", async (c) => {
  if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const active = await activeDeployment(organizationId, projectId, c.req.header("Cookie"));
  if (active && "unavailable" in active) return unavailableResponse(c, active, "json");
  if (!active) return c.json({ error: "Not found" }, 404);
  const directory = c.req.query("dir");
  if (directory === undefined) {
    // Clients that predate directory pages list every document (rollout only).
    const documents = await deploymentDocuments(active.deployment.manifestKey);
    if (!documents) return c.json({ error: "Manifest unavailable" }, 404);
    const offset = Math.max(0, Number.parseInt(c.req.query("cursor") ?? "0", 10) || 0);
    const page = documents.slice(offset, offset + 200);
    return c.json({ documents: page, cursor: offset + page.length < documents.length ? String(offset + page.length) : null });
  }
  const pageNumber = treePageCursor(c.req.query("cursor"));
  if (!validTreeDirectory(directory) || pageNumber === null) return c.json({ error: "Invalid tree page" }, 400);
  const index = await openDeploymentIndex(active.deployment.manifestKey);
  if (!index) return c.json({ error: "Manifest unavailable" }, 404);
  const page = await index.treePage(directory, pageNumber);
  return c.json({ children: page?.children ?? [], cursor: page?.more ? String(pageNumber + 1) : null });
});

// Only the trusted same-origin parent can read this cookie-authenticated response.
// A ticket alone cannot renew itself, even before its expiry.
app.get("/organizations/:organizationId/projects/:projectId/docs/viewer-ticket", async (c) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const cookie = viewerSessionCookie(c.req.header("Cookie") ?? "");
  if (!cookie) return c.json({ error: "Authentication required" }, 401);
  const active = await activeDeployment(organizationId, projectId, cookie);
  if (active && "unavailable" in active) return unavailableResponse(c, active, "json");
  const manifestKey = c.req.query("manifestKey");
  if (!active || !manifestKey || !modernStoragePrefix({ organizationId, projectId, manifestKey })) {
    return c.json({ error: "Not found" }, 404);
  }
  // Only disclose a deployment change after the backend has freshly authorized
  // the session, membership and project. Never issue a ticket across manifests.
  if (active.deployment.manifestKey !== manifestKey) {
    return c.json({ code: "deployment_superseded" }, 409);
  }
  const token = await createViewerTicket({ organizationId, projectId, manifestKey: active.deployment.manifestKey, cookie });
  return c.json({ prefix: `${basePath(organizationId, projectId)}/view/${token}/files/` });
});

app.on("GET", [
  "/organizations/:organizationId/projects/:projectId/docs/files/*",
  "/organizations/:organizationId/projects/:projectId/docs/view/:viewerToken/files/*",
], async (c) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const base = basePath(organizationId, projectId);
  // Never echo the request URL (which may contain a capability) in errors.
  const missing = () => assetError(c, () => renderNotFoundPage({ path: "Document unavailable", homeHref: base, homeLabel: "Open project docs" }));
  const viewerToken = c.req.param("viewerToken");
  const ticket = viewerToken ? await readViewerTicket(viewerToken, { organizationId, projectId }) : null;
  if (viewerToken ? !ticket : !c.get("user")) return missing();
  const cookie = ticket?.cookie ?? viewerSessionCookie(c.req.header("Cookie") ?? "");
  if (!cookie) return missing();
  const path = decodeStoragePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  if (!path) return missing();
  // No authorization cache: Convex checks persisted session, membership, and
  // project ownership on every request, including nested CSS and font requests.
  const active = await activeDeployment(organizationId, projectId, cookie);
  if (active && "unavailable" in active) return unavailableResponse(c, active, "asset");
  if (!active || (ticket && ticket.manifestKey !== active.deployment.manifestKey)) return missing();
  const entry = await (await openDeploymentIndex(active.deployment.manifestKey))?.file(path);
  if (!entry) return missing();
  const key = modernStorageKey({ organizationId, projectId, manifestKey: active.deployment.manifestKey }, path);
  if (!key) return missing();
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    ...assetHeaders(path, Boolean(ticket), entry.contentType, true),
  };
  const open = (...range: [ObjectRange?]) => getObjectStream(key, ...range);
  const delivery = { request: c.req.raw, headers, open, missing };
  if (!isHtmlAsset(path, entry.contentType)) {
    return serveObject({ ...delivery, etag: contentEtag(entry.sha256), size: contentSize(entry.size) });
  }
  // The injected ticket makes these bytes differ per request: no validator, no ranges.
  const token = viewerToken ?? await createViewerTicket({ organizationId, projectId, manifestKey: active.deployment.manifestKey, cookie });
  const frameBase = `${base}/view/${token}/files/`;
  const documentUrl = `${frameBase}${path.split("/").map(encodeURIComponent).join("/")}`;
  const features = viewerScript("frame", {
    base, prefix: frameBase, manifestKey: active.deployment.manifestKey,
    // The storage boundary above validated this deployment-scoped key.
    deploymentId: active.deployment.manifestKey.split("/").at(-2),
  }, c.req.url) + documentFeatures({ organizationId, projectId, documentPath: path, base, url: c.req.url });
  // Keep the iframe's canonical src so tree/deep links and comment authorization
  // retain their existing identity. Relative resources inherit the ticket base.
  return serveObject({ ...delivery, transform: stream => injectViewerHeadStream(stream, publisherBase => {
    let href = documentUrl;
    if (publisherBase !== undefined) {
      // Preserve publisher base semantics. A base resolving inside this private
      // file tree gets the same path through the ticket; external/out-of-tree
      // bases remain publisher-controlled and don't get a scoped replacement.
      const canonical = new URL(`${base}/files/${path.split("/").map(encodeURIComponent).join("/")}`, c.req.url);
      try {
        const resolved = new URL(publisherBase, canonical);
        if (resolved.origin !== canonical.origin || !resolved.pathname.startsWith(`${base}/files/`)) return features;
        href = frameBase + resolved.pathname.slice(`${base}/files/`.length) + resolved.search + resolved.hash;
      } catch { return features; }
    }
    return `<base data-rendro-viewer href="${escapeHtml(href)}">` + features;
  }) });
});

app.get("/organizations/:organizationId/projects/:projectId/docs", async (c) => {
  const user = c.get("user");
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const base = basePath(organizationId, projectId);
  if (!user) {
    // Sign-in returns to the document that was asked for. Only well-formed selectors travel; the sign-in page still
    // accepts nothing but a same-origin relative path.
    const wanted = c.req.query("doc");
    const query = new URLSearchParams();
    if (wanted && isCanonicalStorageKey(wanted)) {
      query.set("doc", wanted);
      const publisherQuery = c.req.query("docQuery");
      if (publisherQuery && validDocumentSearch(publisherQuery)) query.set("docQuery", publisherQuery);
    }
    return c.redirect(`/sign-in?returnTo=${encodeURIComponent(query.size ? `${base}?${query}` : base)}`);
  }
  const active = await activeDeployment(organizationId, projectId, c.req.header("Cookie"));
  if (active && "unavailable" in active) return unavailableResponse(c, active);
  if (!active) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const index = await openDeploymentIndex(active.deployment.manifestKey);
  if (!index) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const isDocument = async (path: string) => {
    const entry = await index.file(path);
    return !!entry && isHtmlAsset(path, entry.contentType);
  };
  // Hono has already decoded the query parameter; validate the literal key.
  const requested = c.req.query("doc");
  const selectedPath = requested
    ? (isCanonicalStorageKey(requested) ? requested : null)
    : await isDocument("index.html") ? "index.html" : index.firstDocument;
  if (!selectedPath || !await isDocument(selectedPath)) {
    return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  }
  const projectBase = base.replace(/\/docs$/, "");
  const shell = renderScopedDocumentShell({
    user,
    namespace: projectId,
    title: active.project.name,
    basePath: base,
    selectedPath,
    backHref: projectBase,
    backLabel: "Project",
    shareConfig: { organizationId, projectId, convexUrl: CONVEX_URL },
  });
  return c.html(shell.replace("</body>", viewerUpdateNotice() + viewerScript("parent", { base }) + "</body>"));
});

export default app;
