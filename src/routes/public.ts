import { legacyOrganization, legacyUnavailable } from "@/legacy-access";
import { assetHeaders } from "@/routes/asset-headers";
import { decodeStoragePath, legacyStoragePrefix } from "@/storage-boundary";
import { viewerScript } from "@/viewer/markup";
import { Hono } from "hono";
import { getObjectStream } from "@/storage";
import { isDeleted } from "@/soft-delete";
import {
  getPublication,
  listPublishedDocumentPaths,
  normalizeDocumentPath,
  resolvePublishedKey,
  type Publication,
} from "@/publications";
import { renderNotFoundPage } from "@/routes/not-found";
import { logger } from "@/logger";
import { renderPublicOrgDocs } from "@/routes/app";
import { injectMobileViewportScrollbarStyle } from "@/routes/document-html";

const app = new Hono();
app.onError(legacyUnavailable);

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value) html += decoder.decode(result.value, { stream: true });
  }
  return html + decoder.decode();
}

function injectPublicNavigation(html: string, publication: Publication, documentPath: string, url: string): string {
  html = injectMobileViewportScrollbarStyle(html);
  const basePath = `/public/${encodeURIComponent(publication.orgSlug)}/${encodeURIComponent(publication.slug)}/files/`;
  const fullPath = `${publication.orgSlug}/${documentPath}`;
  const navigation = `<script>
(function(){
var p=window.parent;
document.addEventListener("keydown",function(e){var key=(e.key||"").toLowerCase();var shellShortcut=(key==="h"||e.code==="KeyH")&&(e.ctrlKey||e.metaKey)&&e.shiftKey&&!e.altKey&&!e.repeat&&!(e.getModifierState&&e.getModifierState("AltGraph"));if(shellShortcut&&!(e.target instanceof Element&&e.target.closest("input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable='']"))){e.preventDefault();p.postMessage({type:"shell-toggle"},"*");}});
})();
</script>
${viewerScript("navigation", { prefix: basePath, documentPath, loadedPath: fullPath }, url)}`;
  const bodyClose = /<\/body\s*>/i;
  return bodyClose.test(html) ? html.replace(bodyClose, (match) => navigation + match) : html + navigation;
}


async function publicationFromRoute(orgSlug: string, slug: string): Promise<Publication | null> {
  if (!legacyStoragePrefix(orgSlug.toLowerCase())) return null;
  if (!await legacyOrganization(orgSlug.toLowerCase())) return null;
  return getPublication(orgSlug.toLowerCase(), slug.toLowerCase());
}

app.get("/public/:org/:slug/files/:path{.+}", async (c) => {
  const publication = await publicationFromRoute(c.req.param("org"), c.req.param("slug"));
  if (!publication) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const documentPath = decodeStoragePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  const key = documentPath ? resolvePublishedKey(publication, documentPath) : null;
  if (!documentPath || !key || (await isDeleted(key))) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  try {
    const stream = await getObjectStream(key);
    if (!stream) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
    // The whole document is decoded as UTF-8 and re-encoded by c.html.
    const html = injectPublicNavigation(await readStream(stream), publication, documentPath, c.req.url);
    return c.html(html, 200, {
      "Cache-Control": "public, max-age=0, must-revalidate",
      ...assetHeaders(documentPath, false, "text/html; charset=utf-8"),
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  } catch {
    logger.error({ category: "StorageError" }, "public document stream failed");
    return legacyUnavailable(new Error("Storage unavailable"), c);
  }
});

app.get("/public/:org/:slug/tree", async (c) => {
  const publication = await publicationFromRoute(c.req.param("org"), c.req.param("slug"));
  if (!publication) return c.json({ error: "Not found" }, 404);
  const documents = await listPublishedDocumentPaths(publication);
  return c.json({ title: publication.title, entryFile: publication.entryFile, documents }, 200, {
    "Cache-Control": "public, max-age=0, must-revalidate",
  });
});

app.get("/public/:org/:slug/sitemap.xml", async (c) => {
  const publication = await publicationFromRoute(c.req.param("org"), c.req.param("slug"));
  if (!publication) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const documents = await listPublishedDocumentPaths(publication);
  const base = `${new URL(c.req.url).origin}/public/${encodeURIComponent(publication.orgSlug)}/${encodeURIComponent(publication.slug)}`;
  const locations = [base, ...documents.map((path) => `${base}?doc=${encodeURIComponent(path)}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map((location) => `\n  <url><loc>${escapeHtml(location)}</loc></url>`).join("")}\n</urlset>`;
  return c.body(xml, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=0, must-revalidate",
  });
});

app.get("/public/:org/:slug", async (c) => {
  const publication = await publicationFromRoute(c.req.param("org"), c.req.param("slug"));
  if (!publication) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const documents = await listPublishedDocumentPaths(publication);
  const requested = c.req.query("doc");
  const selectedPath = requested ? normalizeDocumentPath(requested) : publication.entryFile;
  if (!selectedPath || !documents.includes(selectedPath)) {
    return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  }
  return c.html(renderPublicOrgDocs(publication, selectedPath), 200, {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  });
});

export default app;
