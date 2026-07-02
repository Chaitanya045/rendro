import { Hono } from "hono";
import type { Context } from "hono";
import { getObjectStream, putObject, headObject, listAllKeys, listImmediate, buildTree } from "@/minio";
import { MINIO_BUCKET, CONVEX_URL } from "@/config";
import { validateApiKey } from "@/api-keys";
import { markDeleted, isDeleted, unmarkDeleted, filterDeleted } from "@/soft-delete";
import { emailToOrgSlug } from "@/orgs";
import type { User } from "better-auth/types";
import { logger } from "@/logger";

const app = new Hono<{ Variables: { user?: User } }>();

// GET /files/:key{.+} — stream a file (session-based auth)
app.get("/files/:key{.+}", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Sign in first", 401);
  const org = emailToOrgSlug(user.email);
  if (!org) return c.text("Invalid email", 400);
  const rawKey = c.req.param("key");
  if (!rawKey) return c.text("Bad request", 400);
  const key = decodeURIComponent(rawKey);
  if (!key.startsWith(`${org}/`)) { logger.warn({ email: user.email, key }, "cross-org"); return c.text("Forbidden", 403); }
  try {
    const stream = await getObjectStream(key);
    if (!stream) return c.text("Not found", 404);
    // Read full body for commentor injection
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const result: { done?: boolean; value?: Uint8Array } = await reader.read();
      if (result.done) break;
      if (result.value) chunks.push(result.value);
    }
    const decoder = new TextDecoder();
    let html = chunks.map(c => decoder.decode(c)).join("");
    if (CONVEX_URL) html = injectCommentor(html, org, key, user);
    return c.html(html);
  } catch (err) { logger.error({ err, key }, "stream failed"); return c.text("Stream failed", 500); }
});

function injectCommentor(html: string, org: string, filePath: string, user: User): string {
  const navScript = `<script>
(function(){var p=window.parent;if(p!==window){p.postMessage({type:"doc-loaded",path:${JSON.stringify(filePath)}},"*");}
document.addEventListener("click",function(e){var a=e.target.closest("a");if(!a||!a.href)return;var u=new URL(a.href);var prefix="/files/${org}/";if(!u.pathname.startsWith(prefix))return;var targetPath=u.pathname.slice(prefix.length);if(!targetPath)return;e.preventDefault();p.postMessage({type:"doc-navigate",path:targetPath},"*");});})();
</script>
<script>
window.COMMENTOR = ${JSON.stringify({
  convexUrl: CONVEX_URL,
  orgSlug: org,
  filePath,
  author: { email: user.email, name: user.name },
})};
</script>
<script src="/commentor.js?v=4"></script>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", navScript + "</body>");
  }
  return html + navScript;
}

// ----- Sync API (CLI) — per-org API key auth -----

function authOrg(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return validateApiKey(header.slice(7));
}

// POST /api/sync/upload — uploads + clears deleted status
app.post("/api/sync/upload", async (c) => {
  const org = authOrg(c);
  if (!org) return c.text("Unauthorized", 401);
  const body = await c.req.json<{ key: string; content: string; contentType?: string }>();
  if (!body.key || body.content === undefined) return c.text("Missing key or content", 400);
  if (!body.key.startsWith(`${org}/`)) return c.text(`Key must start with "${org}/"`, 400);
  await putObject(body.key, body.content, body.contentType ?? "text/html");
  unmarkDeleted(body.key);
  return c.json({ ok: true, key: body.key, bucket: MINIO_BUCKET });
});

// GET /api/sync/check — checks existence + hash, respects soft-delete
app.get("/api/sync/check", async (c) => {
  const org = authOrg(c);
  if (!org) return c.text("Unauthorized", 401);
  const key = c.req.query("key");
  const hash = c.req.query("hash");
  if (!key) return c.text("Missing key", 400);
  if (!key.startsWith(`${org}/`)) return c.text(`Key must start with "${org}/"`, 400);
  if (isDeleted(key)) return c.json({ exists: false, deleted: true });
  const obj = await headObject(key);
  if (!obj) return c.json({ exists: false });
  return c.json({ exists: true, etag: obj.etag, size: obj.size, match: hash ? obj.etag === hash : true });
});

// GET /api/sync/list — list all files, filtered by soft-delete
app.get("/api/sync/list", async (c) => {
  const org = authOrg(c);
  if (!org) return c.text("Unauthorized", 401);
  const keys = await listAllKeys(`${org}/`);
  return c.json({ keys: filterDeleted(keys) });
});

// DELETE /api/sync/delete — soft-delete (marks, doesn't remove)
app.delete("/api/sync/delete", (c) => {
  const org = authOrg(c);
  if (!org) return c.text("Unauthorized", 401);
  const key = c.req.query("key");
  if (!key) return c.text("Missing key", 400);
  if (!key.startsWith(`${org}/`) || key.includes("..")) return c.text(`Key must be under ${org}/`, 400);
  markDeleted(org, key);
  return c.json({ deleted: true, key });
});


// GET /api/tree/:org — returns children of a folder for lazy-load tree UI
app.get("/api/tree/:org", async (c) => {
  const org = c.req.param("org");
  const prefix = c.req.query("prefix") || `${org}/`;
  if (!prefix.startsWith(`${org}/`)) return c.text(`Prefix must be under ${org}/`, 400);
  if (prefix.includes("..")) return c.text("Invalid path", 400);

  const limit = parseInt(c.req.query("limit") || "100", 10);
  const startAfter = c.req.query("startAfter") || undefined;

  const { entries, isTruncated, nextStartAfter } = await listImmediate(prefix, {
    maxKeys: Math.min(limit, 1000),
    startAfter,
  });

  const active = entries.filter((e) => !isDeleted(e.key));
  const tree = buildTree(active, prefix);
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
