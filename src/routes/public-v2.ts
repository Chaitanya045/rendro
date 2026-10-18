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
import { getObjectStream, type ObjectRange } from "@/minio";
import { renderScopedDocumentShell } from "@/routes/app";
import { renderNotFoundPage } from "@/routes/not-found";
import { HEAD_INJECTION_VERSION, injectMobileViewportScrollbarStream, injectViewerHeadStream } from "@/routes/document-html";
import { contentEtag, contentSize, serveObject, transformedEtag } from "@/routes/object-delivery";
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

app.get("/p/:slug/files/*", async (c) => {
  const result = await resolvePublication(c.req.param("slug"), c.req.raw);
  if (!result) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const relativePath = decodeStoragePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  const fullPath = relativePath ? publicationPath(result, relativePath) : null;
  if (!relativePath || !fullPath) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const entry = await (await openDeploymentIndex(result.deployment.manifestKey))?.file(fullPath);
  if (!entry) return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
  const key = objectKey(result, fullPath);
  const htmlAsset = isHtmlAsset(fullPath, entry.contentType);
  const headers = {
    "Cache-Control": "public, max-age=0, must-revalidate",
    ...assetHeaders(fullPath, true, entry.contentType),
    ...(htmlAsset ? { "Referrer-Policy": "strict-origin-when-cross-origin" } : {}),
  };
  const delivery = {
    request: c.req.raw, headers, missing: () => assetError(c, () => renderNotFoundPage({ path: "Document unavailable" })),
    open: (...range: [ObjectRange?]) => getObjectStream(key, ...range),
  };
  if (!htmlAsset) return serveObject({ ...delivery, etag: contentEtag(entry.sha256), size: contentSize(entry.size) });
  // The navigation script is the same for every reader of this document, so the
  // injected representation has a validator of its own (source hash + markup).
  const markup = viewerScript("navigation", { prefix: `/p/${encodeURIComponent(result.publication.slug)}/files/`, documentPath: relativePath }, c.req.url);
  return serveObject({
    ...delivery,
    etag: await transformedEtag(entry.sha256, HEAD_INJECTION_VERSION, markup),
    transform: stream => injectViewerHeadStream(injectMobileViewportScrollbarStream(stream), () => markup),
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
