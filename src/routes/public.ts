import { Hono } from "hono";
import { getObjectStream } from "@/minio";
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

const app = new Hono();

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

function injectPublicNavigation(html: string, publication: Publication, documentPath: string): string {
  const basePath = `/public/${encodeURIComponent(publication.orgSlug)}/${encodeURIComponent(publication.slug)}/files/`;
  const fullPath = `${publication.orgSlug}/${documentPath}`;
  const navigation = `<script>
(function(){
var p=window.parent;
if(p!==window)p.postMessage({type:"doc-loaded",path:${JSON.stringify(fullPath)}},"*");
document.addEventListener("keydown",function(e){var key=(e.key||"").toLowerCase();var shellShortcut=(key==="h"||e.code==="KeyH")&&(e.ctrlKey||e.metaKey)&&e.shiftKey&&!e.altKey&&!e.repeat&&!(e.getModifierState&&e.getModifierState("AltGraph"));if(shellShortcut&&!(e.target instanceof Element&&e.target.closest("input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable='']"))){e.preventDefault();p.postMessage({type:"shell-toggle"},"*");}});
document.addEventListener("click",function(e){var a=e.target.closest("a");if(!a||!a.href)return;var u=new URL(a.href);var prefix=${JSON.stringify(basePath)};if(u.origin!==location.origin||!u.pathname.startsWith(prefix))return;var targetPath=u.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");if(!targetPath)return;e.preventDefault();p.postMessage({type:"doc-navigate",path:targetPath},"*");});
})();
</script>`;
  const bodyClose = /<\/body\s*>/i;
  return bodyClose.test(html) ? html.replace(bodyClose, (match) => navigation + match) : html + navigation;
}


async function publicationFromRoute(orgSlug: string, slug: string): Promise<Publication | null> {
  return getPublication(orgSlug.toLowerCase(), slug.toLowerCase());
}

app.get("/public/:org/:slug/files/:path{.+}", async (c) => {
  const publication = await publicationFromRoute(c.req.param("org"), c.req.param("slug"));
  if (!publication) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const documentPath = normalizeDocumentPath(c.req.param("path"));
  const key = resolvePublishedKey(publication, c.req.param("path"));
  if (!documentPath || !key || (await isDeleted(key))) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  try {
    const stream = await getObjectStream(key);
    if (!stream) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
    const html = injectPublicNavigation(await readStream(stream), publication, documentPath);
    return c.html(html, 200, {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  } catch (error) {
    logger.error({ error, key }, "public document stream failed");
    return c.text("Stream failed", 500);
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
