import { assetHeaders } from "@/routes/asset-headers";
import { Hono } from "hono";
import { createViewerTicket, readViewerTicket, viewerSessionCookie } from "@/viewer-ticket";
import { viewerScript } from "@/viewer/markup";
import { escapeHtml } from "@/routes/html";
import type { User } from "better-auth/types";
import { CONVEX_SITE_URL, CONVEX_URL } from "@/config";
import { getObjectStream, getObjectText } from "@/minio";
import { renderScopedDocumentShell } from "@/routes/app";
import { renderNotFoundPage } from "@/routes/not-found";
import { injectViewerHeadStream } from "@/routes/document-html";
import { parseStoredManifest, type StoredManifest } from "@/stored-manifest";

const app = new Hono<{ Variables: { user?: User } }>();

type ActiveDeployment = { project: { name: string }; deployment: { manifestKey: string } };

function safePath(value: string): string | null {
  let path: string;
  try { path = decodeURIComponent(value).replace(/^\/+/, ""); } catch { return null; }
  return path && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..") ? path : null;
}
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function activeDeployment(
  organizationId: string,
  projectId: string,
  cookie: string | undefined,
): Promise<ActiveDeployment | null> {
  const query = new URLSearchParams({ organizationId, projectId });
  const response = await fetch(`${CONVEX_SITE_URL}/api/rendro/deployments/active?${query}`, {
    headers: cookie ? { Accept: "application/json", Cookie: cookie } : { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const active = await response.json() as ActiveDeployment | null;
  return active?.project && active.deployment?.manifestKey ? active : null;
}

async function activeManifest(result: ActiveDeployment): Promise<StoredManifest | null> {
  const text = await getObjectText(result.deployment.manifestKey);
  return parseStoredManifest(text);
}

function basePath(organizationId: string, projectId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/docs`;
}

function documentFeatures(
  options: {
    organizationId: string;
    projectId: string;
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
${viewerScript("navigation", { prefix: `${options.base}/files/`, ticketBase: `${options.base}/view/`, documentPath: options.documentPath, loadedPath: virtualPath }, options.url)}
<script>window.COMMENTOR=${inlineJson({
    organizationId: options.organizationId,
    projectId: options.projectId,
    documentPath: options.documentPath,
    transport: "parent",
    canWrite: true,
  })};</script>
<script defer src="/commentor.js?v=41"></script>`;
}

app.get("/organizations/:organizationId/projects/:projectId/docs/tree", async (c) => {
  if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const active = await activeDeployment(organizationId, projectId, c.req.header("Cookie"));
  if (!active) return c.json({ error: "Not found" }, 404);
  const manifest = await activeManifest(active);
  if (!manifest) return c.json({ error: "Manifest unavailable" }, 404);
  const documents = manifest.files.filter((file) => file.contentType.startsWith("text/html")).map((file) => file.path);
  const offset = Math.max(0, Number.parseInt(c.req.query("cursor") ?? "0", 10) || 0);
  const page = documents.slice(offset, offset + 200);
  return c.json({ documents: page, cursor: offset + page.length < documents.length ? String(offset + page.length) : null });
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
  if (!active || active.deployment.manifestKey !== c.req.query("manifestKey")) {
    return c.json({ error: "Not found" }, 404);
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
  const missing = () => c.html(renderNotFoundPage({ path: "Document unavailable", homeHref: base, homeLabel: "Open project docs" }), 404);
  const viewerToken = c.req.param("viewerToken");
  const ticket = viewerToken ? await readViewerTicket(viewerToken, { organizationId, projectId }) : null;
  if (viewerToken ? !ticket : !c.get("user")) return missing();
  const cookie = ticket?.cookie ?? viewerSessionCookie(c.req.header("Cookie") ?? "");
  if (!cookie) return missing();
  const path = safePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  if (!path) return missing();
  // No authorization cache: Convex checks persisted session, membership, and
  // project ownership on every request, including nested CSS and font requests.
  const active = await activeDeployment(organizationId, projectId, cookie);
  if (!active || (ticket && ticket.manifestKey !== active.deployment.manifestKey)) return missing();
  const manifest = await activeManifest(active);
  const entry = manifest?.files.find((file) => file.path === path);
  if (!entry) return missing();
  const key = `${active.deployment.manifestKey.slice(0, -"manifest.json".length)}files/${path}`;
  const stream = await getObjectStream(key);
  if (!stream) return missing();
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    ...assetHeaders(path, Boolean(ticket), entry.contentType),
    "Content-Security-Policy": entry.contentType.startsWith("text/html")
      ? "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'"
      : "default-src 'none'",
  };
  if (!entry.contentType.startsWith("text/html")) return new Response(stream, { headers });
  const token = viewerToken ?? await createViewerTicket({ organizationId, projectId, manifestKey: active.deployment.manifestKey, cookie });
  const frameBase = `${base}/view/${token}/files/`;
  const documentUrl = `${frameBase}${path.split("/").map(encodeURIComponent).join("/")}`;
  const features = viewerScript("frame", {
    base, prefix: frameBase, manifestKey: active.deployment.manifestKey,
  }, c.req.url) + documentFeatures({ organizationId, projectId, documentPath: path, base, url: c.req.url });
  // Keep the iframe's canonical src so tree/deep links and comment authorization
  // retain their existing identity. Relative resources inherit the ticket base.
  return new Response(injectViewerHeadStream(stream, publisherBase => {
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
  }), { headers });
});

app.get("/organizations/:organizationId/projects/:projectId/docs", async (c) => {
  const user = c.get("user");
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const base = basePath(organizationId, projectId);
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent(base)}`);
  const active = await activeDeployment(organizationId, projectId, c.req.header("Cookie"));
  if (!active) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const manifest = await activeManifest(active);
  if (!manifest) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const documents = manifest.files
    .filter((file) => file.contentType.startsWith("text/html"))
    .map((file) => file.path);
  const requested = c.req.query("doc");
  const selectedPath = requested
    ? safePath(requested)
    : documents.includes("index.html") ? "index.html" : documents[0];
  if (!selectedPath || !documents.includes(selectedPath)) {
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
  return c.html(shell.replace("</body>", viewerScript("parent", { base }) + "</body>"));
});

export default app;
