import { authClientIpHeaders } from "@/auth-client-ip";
import type { WorkerPublication } from "../../shared/resolver-dto";
import { signResolverRequest } from "../../shared/resolver-auth";
import { ViewerBackendError, viewerBackendJson } from "@/viewer-backend";
import { viewerErrorCache, viewerErrorResponse } from "@/routes/viewer-unavailable";
import { assetError, assetHeaders, isHtmlAsset } from "@/routes/asset-headers";
import { decodeStoragePath, isCanonicalStorageKey } from "@/storage-boundary";
import { viewerScript } from "@/viewer/markup";
import { Hono } from "hono";
import { CONVEX_INTERNAL_SECRET, CONVEX_SITE_URL } from "@/config";
import { getObjectStream } from "@/minio";
import { renderScopedDocumentShell } from "@/routes/app";
import { renderNotFoundPage } from "@/routes/not-found";
import { injectMobileViewportScrollbarStyle } from "@/routes/document-html";
import { deploymentDocuments, openDeploymentIndex, validTreeDirectory } from "@/deployment-index";
import { treePageCursor } from "@/routes/tree-pages";

const app = new Hono();
app.use("/p/*", viewerErrorCache);
app.onError(viewerErrorResponse);

async function resolvePublication(slug: string, request: Request): Promise<WorkerPublication | null> {
  const url = `${CONVEX_SITE_URL}/api/rendro/publications/public?slug=${encodeURIComponent(slug)}`;
  const headers = await signResolverRequest(new Request(url), CONVEX_INTERNAL_SECRET);
  (await authClientIpHeaders(request, url, "GET")).forEach((value, name) => headers.set(name, value));
  headers.set("Accept", "application/json");
  const result = await viewerBackendJson<WorkerPublication>(url, { headers }, true);
  if (result && !result.deployment?.manifestKey) throw new ViewerBackendError();
  return result;
}

function publicationPath(result: WorkerPublication, path: string): string | null {
  if (!isCanonicalStorageKey(path)) return null;
  const prefix = result.publication.pathPrefix;
  return prefix ? `${prefix}/${path}` : path;
}

function objectKey(result: WorkerPublication, path: string): string {
  return `${result.deployment.manifestKey.slice(0, -"manifest.json".length)}files/${path}`;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value) output += decoder.decode(result.value, { stream: true });
  }
  return output + decoder.decode();
}

function injectNavigation(html: string, slug: string, path: string, url: string): string {
  html = injectMobileViewportScrollbarStyle(html);
  const basePath = `/p/${encodeURIComponent(slug)}/files/`;
  const script = viewerScript("navigation", { prefix: basePath, documentPath: path }, url);
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${script}</body>`) : html + script;
}

app.get("/p/:slug/files/*", async (c) => {
  const result = await resolvePublication(c.req.param("slug"), c.req.raw);
  if (!result) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const relativePath = decodeStoragePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  const fullPath = relativePath ? publicationPath(result, relativePath) : null;
  if (!relativePath || !fullPath) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const entry = await (await openDeploymentIndex(result.deployment.manifestKey))?.file(fullPath);
  if (!entry) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const stream = await getObjectStream(objectKey(result, fullPath));
  if (!stream) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const htmlAsset = isHtmlAsset(fullPath, entry.contentType);
  const headers = {
    "Cache-Control": "public, max-age=0, must-revalidate",
    // readStream fully decodes HTML as UTF-8; its output is re-encoded below.
    ...assetHeaders(fullPath, true, htmlAsset ? "text/html; charset=utf-8" : entry.contentType),
  };
  if (!htmlAsset) return new Response(stream, { headers });
  const html = injectNavigation(await readStream(stream), result.publication.slug, relativePath, c.req.url);
  return new Response(html, {
    headers: {
      ...headers,
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
});

app.get("/p/:slug/tree", async (c) => {
  const result = await resolvePublication(c.req.param("slug"), c.req.raw);
  if (!result) return c.json({ error: "Not found" }, 404);
  const prefix = result.publication.pathPrefix ? `${result.publication.pathPrefix}/` : "";
  const cache = { "Cache-Control": "public, max-age=0, must-revalidate" };
  const directory = c.req.query("dir");
  if (directory === undefined) {
    // Clients that predate directory pages list every document (rollout only).
    const all = await deploymentDocuments(result.deployment.manifestKey);
    if (!all) return c.json({ error: "Manifest unavailable" }, 404);
    const documents = all.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
    const offset = Math.max(0, Number.parseInt(c.req.query("cursor") ?? "0", 10) || 0);
    const page = documents.slice(offset, offset + 200);
    const cursor = offset + page.length < documents.length ? String(offset + page.length) : null;
    return c.json({ documents: page, cursor, total: documents.length }, 200, cache);
  }
  const pageNumber = treePageCursor(c.req.query("cursor"));
  // Directories are relative to the publication root, so a page never names
  // anything outside its path prefix.
  if (!validTreeDirectory(directory) || pageNumber === null) return c.json({ error: "Invalid tree page" }, 400);
  const index = await openDeploymentIndex(result.deployment.manifestKey);
  if (!index) return c.json({ error: "Manifest unavailable" }, 404);
  const page = await index.treePage(prefix + directory, pageNumber);
  return c.json({ children: page?.children ?? [], cursor: page?.more ? String(pageNumber + 1) : null }, 200, cache);
});

app.get("/p/:slug", async (c) => {
  const result = await resolvePublication(c.req.param("slug"), c.req.raw);
  if (!result) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const index = await openDeploymentIndex(result.deployment.manifestKey);
  if (!index) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const requested = c.req.query("doc");
  const selected = requested ?? result.publication.entryFile;
  const fullPath = selected ? publicationPath(result, selected) : null;
  const entry = fullPath ? await index.file(fullPath) : null;
  if (!fullPath || !entry || !isHtmlAsset(fullPath, entry.contentType)) {
    return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  }
  const slug = result.publication.slug;
  const title = result.publication.title;
  return c.html(renderScopedDocumentShell({
    user: null,
    namespace: slug,
    title,
    basePath: `/p/${encodeURIComponent(slug)}`,
    selectedPath: selected,
    publicDocument: true,
  }), 200, {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  });
});

export default app;
