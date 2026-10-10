import { Hono } from "hono";
import type { User } from "better-auth/types";
import { CONVEX_SITE_URL, CONVEX_URL } from "@/config";
import { getObjectStream, getObjectText } from "@/minio";
import { renderScopedDocumentShell } from "@/routes/app";
import { renderNotFoundPage } from "@/routes/not-found";
import { injectHtmlHeadStream } from "@/routes/document-html";
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
  return response.ok ? response.json() as Promise<ActiveDeployment> : null;
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
    user: User;
  },
): string {
  const frameBase = `${options.base}/files/`;
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
function loaded(){if(p!==window){p.postMessage({type:"doc-loaded",path:${inlineJson(virtualPath)}},"*");}}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",loaded,{once:true});else loaded();
document.addEventListener("keydown",function(e){var key=(e.key||"").toLowerCase();var shellShortcut=(key==="h"||e.code==="KeyH")&&(e.ctrlKey||e.metaKey)&&e.shiftKey&&!e.altKey&&!e.repeat&&!(e.getModifierState&&e.getModifierState("AltGraph"));if(shellShortcut&&!(e.target instanceof Element&&e.target.closest("input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable='']"))){e.preventDefault();p.postMessage({type:"shell-toggle"},"*");}});
document.addEventListener("click",function(e){var a=e.target.closest("a");if(!a||!a.href)return;var u=new URL(a.href);var prefix=${inlineJson(frameBase)};if(u.origin!==location.origin||!u.pathname.startsWith(prefix))return;var targetPath=u.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");if(!targetPath)return;e.preventDefault();p.postMessage({type:"doc-navigate",path:targetPath},"*");});
})();
</script>
<script>window.COMMENTOR=${inlineJson({
    organizationId: options.organizationId,
    projectId: options.projectId,
    documentPath: options.documentPath,
    transport: "parent",
    canWrite: true,
  })};</script>
<script defer src="/commentor.js?v=35"></script>`;
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

app.get("/organizations/:organizationId/projects/:projectId/docs/files/*", async (c) => {
  const user = c.get("user");
  if (!user) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const base = basePath(organizationId, projectId);
  const path = safePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  if (!path) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const active = await activeDeployment(organizationId, projectId, c.req.header("Cookie"));
  if (!active) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const manifest = await activeManifest(active);
  const entry = manifest?.files.find((file) => file.path === path);
  if (!entry) return c.html(renderNotFoundPage({ path: c.req.path, homeHref: base, homeLabel: "Open project docs" }), 404);
  const key = `${active.deployment.manifestKey.slice(0, -"manifest.json".length)}files/${path}`;
  const stream = await getObjectStream(key);
  if (!stream) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const headers = {
    "Cache-Control": "private, no-store",
    "Content-Type": entry.contentType,
    "Content-Security-Policy": entry.contentType.startsWith("text/html")
      ? "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'"
      : "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
  };
  if (!entry.contentType.startsWith("text/html")) return new Response(stream, { headers });
  const features = documentFeatures({
    organizationId,
    projectId,
    documentPath: path,
    base,
    user,
  });
  // Stored publisher bytes are pristine on every request. Do not use a raw
  // substring marker for idempotence: a code sample or script can legitimately
  // contain our attribute name and must not disable the integration.
  return new Response(injectHtmlHeadStream(stream, features), { headers });
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
  return c.html(renderScopedDocumentShell({
    user,
    namespace: projectId,
    title: active.project.name,
    basePath: base,
    selectedPath,
    backHref: projectBase,
    backLabel: "Project",
    shareConfig: { organizationId, projectId, convexUrl: CONVEX_URL },
  }));
});

export default app;
