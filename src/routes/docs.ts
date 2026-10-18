import { viewerErrorResponse } from "@/routes/viewer-unavailable";
import { assetError, assetHeaders, isHtmlAsset } from "@/routes/asset-headers";
import { decodeStoragePath, isLegacyStorageKey, isLegacyStoragePrefix, legacyStoragePrefix } from "@/storage-boundary";
import { Hono } from "hono";
import { getObjectStream, headObject, listImmediate, buildTree, type ObjectRange } from "@/storage";
import { legacyMember, legacyRequestMember, legacyUnavailable, retiredLegacy } from "@/legacy-access";
import { markDeleted, isDeleted } from "@/soft-delete";
import type { User } from "better-auth/types";
import { createShareUrl, isShareableDocKey } from "@/share-links";
import { renderNotFoundPage } from "@/routes/not-found";
import { injectViewerHeadStream } from "@/routes/document-html";
import { contentSize, serveObject } from "@/routes/object-delivery";
import { createLegacyViewerTicket, readLegacyViewerTicket, viewerSessionCookie } from "@/viewer-ticket";
import { viewerScript } from "@/viewer/markup";
import { documentFeatures } from "@/routes/project-docs";
import { escapeHtml } from "@/routes/html";

const app = new Hono<{ Variables: { user?: User } }>();
app.onError((error, c) => {
  if (c.req.path.startsWith("/legacy-view/")) return viewerErrorResponse(error, c);
  return legacyUnavailable(error, c);
});

// GET /api/share/create?key=:org/:path — create a signed public document URL.
app.get("/api/share/create", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Sign in first", 401);

  const key = c.req.query("key");
  if (!key) return c.text("Missing key", 400);
  const org = key.split("/")[0];
  if (!await legacyRequestMember(c, org)) return c.text("Not found", 404);
  if (!isLegacyStorageKey(org, key) || !isShareableDocKey(key)) {
    return c.text("Forbidden", 403);
  }
  if (await isDeleted(key)) return c.text("Not found", 404);
  if (!(await headObject(key))) return c.text("Not found", 404);

  return c.json({ url: createShareUrl(new URL(c.req.url).origin, key) });
});

// Old bookmarks enter the trusted shell; the shell owns comment authentication.
app.get("/files/:key{.+}", async c => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  const user = c.get("user");
  if (!user) return c.text("Sign in first", 401);
  const key = decodeStoragePath(c.req.path.slice("/files/".length));
  const org = key?.split("/")[0];
  if (!org || !key || !isLegacyStorageKey(org, key)) return c.text("Forbidden", 403);
  if (!await legacyRequestMember(c, org)) return c.text("Not found", 404);
  if (await isDeleted(key) || !await headObject(key)) return c.text("Not found", 404);
  const search = new URL(c.req.url).search;
  // Publisher parameters (including doc/docQuery) are data, not shell controls.
  const query = search ? `?${new URLSearchParams({ docQuery: search })}` : "";
  return c.redirect(`/docs/${key.split("/").map(encodeURIComponent).join("/")}${query}`);
});

app.get("/legacy-view/:org/viewer-ticket", async c => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  const org = c.req.param("org");
  const user = c.get("user");
  const cookie = viewerSessionCookie(c.req.header("Cookie") ?? "");
  if (!user || !cookie) return c.text("Unauthorized", 401);
  if (!legacyStoragePrefix(org) || c.req.query("manifestKey") !== org) return c.text("Not found", 404);
  if (!await legacyMember(org, cookie)) return c.text("Not found", 404);
  const token = await createLegacyViewerTicket(org, cookie);
  return c.json({ prefix: `/legacy-view/${encodeURIComponent(org)}/view/${token}/files/` });
});

app.on("GET", ["/legacy-view/:org/files/*", "/legacy-view/:org/view/:viewerToken/files/*"], async c => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  const org = c.req.param("org");
  const base = `/legacy-view/${encodeURIComponent(org)}`;
  const missing = () => assetError(c, () => renderNotFoundPage({ path: "Document unavailable", homeHref: `/docs/${encodeURIComponent(org)}`, homeLabel: "Open docs tree" }));
  if (!legacyStoragePrefix(org)) return missing();
  const token = c.req.param("viewerToken");
  const ticket = token ? await readLegacyViewerTicket(token, org) : null;
  if (token && !ticket) return missing();
  const cookie = ticket?.cookie ?? viewerSessionCookie(c.req.header("Cookie") ?? "");
  if (!cookie) return missing();
  if (!await legacyMember(org, cookie)) return missing();
  const path = decodeStoragePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  if (!path) return missing();
  const key = `${org}/${path}`;
  if (!isLegacyStorageKey(org, key) || (ticket && !key.startsWith(ticket.storagePrefix))) return missing();
  if (await isDeleted(key)) return missing();
  const object = await headObject(key);
  if (!object) return missing();
  const html = isHtmlAsset(path, object.contentType ?? "text/html");
  const headers = {
    ...assetHeaders(path, Boolean(ticket), object.contentType ?? "text/html"),
    "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
  };
  const delivery = { request: c.req.raw, headers, missing, open: (...range: [ObjectRange?]) => getObjectStream(key, ...range) };
  // Legacy objects are mutable and carry no manifest hash: the store's own
  // entity tag and length (from the HEAD above) validate exactly the bytes sent.
  if (!html) return serveObject({ ...delivery, etag: object.etag ? `"s3-${object.etag}"` : undefined, size: contentSize(object.size) });
  const frameToken = token ?? await createLegacyViewerTicket(org, cookie);
  const prefix = `${base}/view/${frameToken}/files/`;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const features = viewerScript("frame", { base, prefix, manifestKey: org }, c.req.url)
    + documentFeatures({ organizationId: org, projectId: org, legacyOrg: org, documentPath: path, base, url: c.req.url });
  return serveObject({ ...delivery, transform: stream => injectViewerHeadStream(stream, publisherBase => {
    let href = prefix + encodedPath;
    if (publisherBase !== undefined) {
      // Resolve legacy authored bases against the original /files URL.
      const canonical = new URL(`/files/${encodeURIComponent(org)}/${encodedPath}`, c.req.url);
      try {
        const resolved = new URL(publisherBase, canonical);
        const originalPrefix = `/files/${encodeURIComponent(org)}/`;
        if (resolved.origin !== canonical.origin || !resolved.pathname.startsWith(originalPrefix)) return features;
        href = prefix + resolved.pathname.slice(originalPrefix.length) + resolved.search + resolved.hash;
      } catch { return features; }
    }
    return `<base data-rendro-viewer href="${escapeHtml(href)}">` + features;
  }) });
});

// Legacy credentials no longer authorize any operation.
app.post("/api/sync/upload", retiredLegacy);
app.delete("/api/sync/delete", retiredLegacy);
app.get("/api/sync/check", retiredLegacy);
app.get("/api/sync/list", retiredLegacy);

// Owner/admin content deletion also revokes every signed legacy share of the target.
app.delete("/api/legacy/content", async c => {
  const key = c.req.query("key");
  const org = key?.split("/")[0];
  if (!org || !key || !isLegacyStorageKey(org, key)) return c.text("Not found", 404);
  if (!await legacyRequestMember(c, org, true)) return c.text("Not found", 404);
  await markDeleted(org, key);
  return c.json({ deleted: true });
});

// GET /api/tree/:org — returns children of a folder for lazy-load tree UI
app.get("/api/tree/:org", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Unauthorized", 401);
  const org = c.req.param("org");
  if (!await legacyRequestMember(c, org)) return c.text("Not found", 404);
  const prefix = c.req.query("prefix") || `${org}/`;
  if (!isLegacyStoragePrefix(org, prefix)) return c.text(`Prefix must be under ${org}/`, 400);
  if (prefix.includes("..")) return c.text("Invalid path", 400);

  const limit = parseInt(c.req.query("limit") || "100", 10);
  const startAfter = c.req.query("startAfter") || undefined;

  const { entries, isTruncated, nextStartAfter } = await listImmediate(prefix, { maxKeys: Math.min(limit, 1000), startAfter });
  const deleted = await Promise.all(entries.map((entry) => isDeleted(entry.key)));
  const tree = buildTree(entries.filter((_, i) => !deleted[i]), prefix);
  const children = tree.map((node) => ({
    name: node.name,
    path: node.path,
    type: node.type,
    size: "size" in node ? node.size : undefined,
    lastModified: "lastModified" in node ? node.lastModified : undefined,
  }));
  return c.json({ children, prefix, isTruncated, nextStartAfter });
});
export default app;
