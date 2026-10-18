import { authClientIpHeaders } from "@/auth-client-ip";
import { openDeploymentIndex } from "@/deployment-index";
import { isShareDocument } from "@/share-assets";
import type { WorkerShare } from "../../shared/resolver-dto";
import { signResolverRequest } from "../../shared/resolver-auth";
import { ViewerBackendError, viewerBackendJson } from "@/viewer-backend";
import { viewerErrorCache, viewerErrorResponse } from "@/routes/viewer-unavailable";
import { decodeStoragePath } from "@/storage-boundary";
import { validDocumentSearch } from "@/lazy-tree/messages";
import { escapeHtml } from "@/routes/html";
import { normalizeMediaType, assetError, assetHeaders } from "@/routes/asset-headers";
import { nonceAttribute } from "@/middleware/html-nonce";
import { viewerScript } from "@/viewer/markup";
import { renderFaviconLinks } from "./favicon";
import { renderThemeAssets } from "./theme";
import { Hono } from "hono";
import { CONVEX_INTERNAL_SECRET, CONVEX_SITE_URL } from "@/config";
import { getObjectStream, type ObjectRange } from "@/minio";
import { renderNotFoundPage } from "@/routes/not-found";
import { injectMobileViewportScrollbarStream, injectViewerHeadStream } from "@/routes/document-html";
import { contentEtag, contentSize, serveObject } from "@/routes/object-delivery";

const app = new Hono();
app.use("/s/*", viewerErrorCache);
app.onError(viewerErrorResponse);

async function resolveShare(token: string, request: Request): Promise<WorkerShare | null> {
  const url = `${CONVEX_SITE_URL}/api/rendro/shares/public?token=${encodeURIComponent(token)}`;
  const headers = await signResolverRequest(new Request(url), CONVEX_INTERNAL_SECRET);
  (await authClientIpHeaders(request, url, "GET")).forEach((value, name) => headers.set(name, value));
  headers.set("Accept", "application/json");
  const result = await viewerBackendJson<WorkerShare>(url, { headers }, true);
  if (result && !result.deployment?.manifestKey) throw new ViewerBackendError();
  return result;
}

app.get("/s/:token/files/*", async (c) => {
  const resolution = await resolveShare(c.req.param("token"), c.req.raw);
  const path = decodeStoragePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  if (!resolution || !path) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const documentPath = resolution.grant.documentPath;
  const directory = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/") + 1) : "";
  // The grant was resolved freshly above; only immutable metadata is cached.
  const entry = await (await openDeploymentIndex(resolution.deployment.manifestKey))?.file(path);
  if (!entry) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const type = normalizeMediaType(entry.contentType);
  const isExactDocument = path === documentPath;
  const allowedAsset = !isShareDocument(type) && (resolution.grant.assetPaths === undefined
    ? path.slice(0, path.lastIndexOf("/") + 1) === directory && (type === "text/css" || type.startsWith("image/") || type.startsWith("font/"))
    : resolution.grant.assetPaths.includes(path));
  if (!isExactDocument && !allowedAsset) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const key = `${resolution.deployment.manifestKey.slice(0, -"manifest.json".length)}files/${path}`;
  const headers = {
    "Cache-Control": "private, no-store",
    ...assetHeaders(path, true, entry.contentType, true),
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
  const delivery = {
    request: c.req.raw, headers, missing: () => assetError(c, () => renderNotFoundPage({ path: "Document unavailable" })),
    open: (...range: [ObjectRange?]) => getObjectStream(key, ...range),
  };
  // Capability responses stay private/no-store; validators only save bandwidth.
  // Head-injected HTML embeds this token's navigation config: whole, unvalidated.
  if (type !== "text/html") return serveObject({ ...delivery, etag: contentEtag(entry.sha256), size: contentSize(entry.size) });
  return serveObject({ ...delivery, transform: stream => injectViewerHeadStream(injectMobileViewportScrollbarStream(stream), () => viewerScript("navigation", {
    prefix: `/s/${encodeURIComponent(c.req.param("token"))}/files/`, documentPath, singleDocument: true,
  }, c.req.url)) });
});

app.get("/s/:token", async (c) => {
  const token = c.req.param("token");
  const resolution = await resolveShare(token, c.req.raw);
  if (!resolution) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  // The grant alone chooses the file. A copied shell URL may name that exact
  // document, but cannot expand its scope; publisher query keys stay nested.
  const documentPath = c.req.query("doc");
  if (documentPath !== undefined && documentPath !== resolution.grant.documentPath) {
    return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  }
  const search = c.req.query("docQuery") ?? "";
  if (!validDocumentSearch(search)) return c.text("Invalid document query", 400);
  const fileUrl = `/s/${encodeURIComponent(token)}/files/${resolution.grant.documentPath.split("/").map(encodeURIComponent).join("/")}${search}`;
  const title = resolution.project.name.replace(/[&<>"']/g, "");
  return c.html(`<!DOCTYPE html><html lang="en"><head>${renderFaviconLinks()}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${title} — Shared via Rendro</title>${renderThemeAssets()}<style${nonceAttribute()}>:root{color-scheme:light;--page:#fafafa;--surface:#fff;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#c2410c}html.dark{color-scheme:dark;--page:#09090b;--surface:#18181b;--text:#fafafa;--muted:#a1a1aa;--border:#27272a;--accent:#fb923c}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);font-family:Inter,ui-sans-serif,system-ui}.bar{height:48px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 16px;border-bottom:1px solid var(--border);background:var(--surface);font-size:12px}.brand{font-weight:750;white-space:nowrap}.brand i{font-style:normal;color:var(--accent)}.expiry{overflow:hidden;color:var(--muted);text-overflow:ellipsis;white-space:nowrap}.frame{display:block;width:100%;height:calc(100vh - 48px);border:0;background:#fff}@media(max-width:520px){.bar{padding:0 12px}.share-label{display:none}.expiry{font-size:11px}}</style></head><body><header class="bar"><div class="brand">Rendro<i>.</i><span class="share-label"> secure share</span></div><div class="expiry">Expires ${new Date(resolution.grant.expiresAt).toISOString().slice(0, 10)}</div></header><main><iframe id="content-frame" class="frame" title="Shared documentation" src="${escapeHtml(fileUrl)}" sandbox="allow-scripts allow-forms allow-popups allow-downloads" referrerpolicy="no-referrer"></iframe></main>${viewerScript("share", { prefix: `/s/${encodeURIComponent(token)}/files/`, documentPath: resolution.grant.documentPath })}</body></html>`, 200, {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
});

export default app;
