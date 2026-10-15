import { sessionCache } from "@/session-cache";
import { viewerBackendJson } from "@/viewer-backend";
import { viewerErrorResponse } from "@/routes/viewer-unavailable";
import { assetError, assetHeaders, isHtmlAsset } from "@/routes/asset-headers";
import { decodeStoragePath, isLegacyStorageKey, isLegacyStoragePrefix, legacyStoragePrefix } from "@/storage-boundary";
import { Hono } from "hono";
import type { Context } from "hono";
import { getObjectStream, putObject, headObject, listAllKeys, listImmediate, buildTree } from "@/minio";
import { MINIO_BUCKET, CONVEX_SITE_URL } from "@/config";
import { validateApiKey } from "@/api-keys";
import { markDeleted, isDeleted, unmarkDeleted, filterDeleted } from "@/soft-delete";
import { emailToOrgSlug } from "@/orgs";
import type { User } from "better-auth/types";
import { createShareUrl, isShareableDocKey } from "@/share-links";
import { renderNotFoundPage } from "@/routes/not-found";
import { injectViewerHeadStream } from "@/routes/document-html";
import { createLegacyViewerTicket, readLegacyViewerTicket, viewerSessionCookie } from "@/viewer-ticket";
import { viewerScript } from "@/viewer/markup";
import { documentFeatures } from "@/routes/project-docs";
import { escapeHtml } from "@/routes/html";

const app = new Hono<{ Variables: { user?: User } }>();
app.onError((error, c) => {
  if (c.req.path.startsWith("/legacy-view/")) return viewerErrorResponse(error, c);
  throw error;
});

// GET /api/share/create?key=:org/:path — create a signed public document URL.
app.get("/api/share/create", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Sign in first", 401);
  const org = emailToOrgSlug(user.email);
  if (!org) return c.text("Invalid email", 400);

  const key = c.req.query("key");
  if (!key) return c.text("Missing key", 400);
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
  const org = emailToOrgSlug(user.email);
  const key = decodeStoragePath(c.req.path.slice("/files/".length));
  if (!org || !key || !isLegacyStorageKey(org, key)) return c.text("Forbidden", 403);
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
  if (!user || !cookie || emailToOrgSlug(user.email) !== org) return c.text("Unauthorized", 401);
  if (!legacyStoragePrefix(org) || c.req.query("manifestKey") !== org) return c.text("Not found", 404);
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
  let user = c.get("user");
  if (ticket) {
    // Revalidate the persisted legacy session on every resource request. Never
    // trust ambient cookies in place of the identity bound into the ticket.
    const session = await viewerBackendJson<{ user?: User }>(`${CONVEX_SITE_URL}/api/auth/get-session?disableCookieCache=true`, {
      headers: { cookie, accept: "application/json" }, redirect: "manual",
    });
    if (session !== null && (typeof session?.user?.id !== "string" || typeof session?.user?.email !== "string")) {
      throw new Error("Invalid session response");
    }
    if (session === null) await sessionCache.evict(cookie);
    user = session?.user;
  }
  if (!user || typeof user.email !== "string" || emailToOrgSlug(user.email) !== org) return missing();
  const path = decodeStoragePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  if (!path) return missing();
  const key = `${org}/${path}`;
  if (!isLegacyStorageKey(org, key) || (ticket && !key.startsWith(ticket.storagePrefix))) return missing();
  if (await isDeleted(key, true)) return missing();
  const object = await headObject(key);
  if (!object) return missing();
  const stream = await getObjectStream(key);
  if (!stream) return missing();
  const html = isHtmlAsset(path, object.contentType ?? "text/html");
  const headers = {
    ...assetHeaders(path, Boolean(ticket), object.contentType ?? "text/html"),
    "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
  };
  if (!html) return new Response(stream, { headers });
  const frameToken = token ?? await createLegacyViewerTicket(org, cookie);
  const prefix = `${base}/view/${frameToken}/files/`;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const features = viewerScript("frame", { base, prefix, manifestKey: org }, c.req.url)
    + documentFeatures({ organizationId: org, projectId: org, legacyOrg: org, documentPath: path, base, url: c.req.url });
  return new Response(injectViewerHeadStream(stream, publisherBase => {
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
  }), { headers });
});

// ----- Sync API (CLI) — per-org API key auth -----

async function authOrg(c: Context): Promise<string | null> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const org = await validateApiKey(header.slice(7));
  return org && legacyStoragePrefix(org) ? org : null;
}

// POST /api/sync/upload — uploads + clears deleted status
app.post("/api/sync/upload", async (c) => {
  const org = await authOrg(c);
  if (!org) return c.text("Unauthorized", 401);
  const body = await c.req.json<{ key: string; content: string; contentType?: string }>();
  if (!body.key || body.content === undefined) return c.text("Missing key or content", 400);
  if (!isLegacyStorageKey(org, body.key)) return c.text(`Key must start with "${org}/"`, 400);
  await putObject(body.key, body.content, body.contentType ?? "text/html");
  await unmarkDeleted(body.key);
  return c.json({ ok: true, key: body.key, bucket: MINIO_BUCKET });
});

// GET /api/sync/check — checks existence + hash, respects soft-delete
app.get("/api/sync/check", async (c) => {
  const org = await authOrg(c);
  if (!org) return c.text("Unauthorized", 401);
  const key = c.req.query("key");
  const hash = c.req.query("hash");
  if (!key) return c.text("Missing key", 400);
  if (!isLegacyStorageKey(org, key)) return c.text(`Key must start with "${org}/"`, 400);
  if (await isDeleted(key)) return c.json({ exists: false, deleted: true });
  const obj = await headObject(key);
  if (!obj) return c.json({ exists: false });
  return c.json({ exists: true, etag: obj.etag, size: obj.size, match: hash ? obj.etag === hash : true });
});

// GET /api/sync/list — list all files, filtered by soft-delete
app.get("/api/sync/list", async (c) => {
  const org = await authOrg(c);
  if (!org) return c.text("Unauthorized", 401);
  const prefix = c.req.query("prefix") || `${org}/`;
  if (!isLegacyStoragePrefix(org, prefix)) return c.text(`Prefix must be under ${org}/`, 400);
  if (prefix.includes("..")) return c.text("Invalid path", 400);
  const keys = await listAllKeys(prefix);
  return c.json({ keys: await filterDeleted(keys) });
});

// DELETE /api/sync/delete — soft-delete (marks, doesn't remove)
app.delete("/api/sync/delete", async (c) => {
  const org = await authOrg(c);
  if (!org) return c.text("Unauthorized", 401);
  const key = c.req.query("key");
  if (!key) return c.text("Missing key", 400);
  if (!isLegacyStorageKey(org, key) || key.includes("..")) return c.text(`Key must be under ${org}/`, 400);
  await markDeleted(org, key);
  return c.json({ deleted: true, key });
});


// GET /api/tree/:org — returns children of a folder for lazy-load tree UI
app.get("/api/tree/:org", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Unauthorized", 401);
  const userOrg = emailToOrgSlug(user.email);
  if (!userOrg || userOrg !== c.req.param("org")) return c.text("Forbidden", 403);
  const org = c.req.param("org");
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
