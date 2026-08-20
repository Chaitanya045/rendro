import { Hono } from "hono";
import { CONVEX_SITE_URL } from "@/config";
import { getObjectStream } from "@/minio";
import { renderNotFoundPage } from "@/routes/not-found";

const app = new Hono();

type ShareResolution = {
  grant: { documentPath: string; expiresAt: number };
  deployment: { manifestKey: string };
  project: { name: string };
};

async function resolveShare(token: string): Promise<ShareResolution | null> {
  const response = await fetch(
    `${CONVEX_SITE_URL}/api/rendro/shares/public?token=${encodeURIComponent(token)}`,
    { headers: { Accept: "application/json" } },
  );
  return response.ok ? response.json() as Promise<ShareResolution> : null;
}

function safePath(value: string): string | null {
  let path: string;
  try { path = decodeURIComponent(value).replace(/^\/+/, ""); } catch { return null; }
  return path && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..")
    ? path
    : null;
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return ({
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

app.get("/s/:token/files/*", async (c) => {
  const resolution = await resolveShare(c.req.param("token"));
  const path = safePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  if (!resolution || !path) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const documentPath = resolution.grant.documentPath;
  const directory = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/") + 1) : "";
  const type = contentType(path);
  const isExactDocument = path === documentPath;
  const isSameTreeAsset = !type.startsWith("text/html") && path.startsWith(directory);
  if (!isExactDocument && !isSameTreeAsset) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const key = `${resolution.deployment.manifestKey.slice(0, -"manifest.json".length)}files/${path}`;
  const stream = await getObjectStream(key);
  if (!stream) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  return new Response(stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": type,
      "Content-Security-Policy": type.startsWith("text/html")
        ? "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'"
        : "default-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
});

app.get("/s/:token", async (c) => {
  const token = c.req.param("token");
  const resolution = await resolveShare(token);
  if (!resolution) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const fileUrl = `/s/${encodeURIComponent(token)}/files/${resolution.grant.documentPath.split("/").map(encodeURIComponent).join("/")}`;
  const title = resolution.project.name.replace(/[&<>"']/g, "");
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${title} — Shared via Rendro</title><script>try{var m=localStorage.getItem("commentor-theme"),q=matchMedia("(prefers-color-scheme:dark)"),r=m==="dark"||m==="light"?m:(q.matches?"dark":"light");document.documentElement.classList.toggle("dark",r==="dark");}catch(_error){}</script><style>:root{color-scheme:light;--page:#fafafa;--surface:#fff;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#c2410c}html.dark{color-scheme:dark;--page:#09090b;--surface:#18181b;--text:#fafafa;--muted:#a1a1aa;--border:#27272a;--accent:#fb923c}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);font-family:Inter,ui-sans-serif,system-ui}.bar{height:48px;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 16px;border-bottom:1px solid var(--border);background:var(--surface);font-size:12px}.brand{font-weight:750;white-space:nowrap}.brand i{font-style:normal;color:var(--accent)}.expiry{overflow:hidden;color:var(--muted);text-overflow:ellipsis;white-space:nowrap}.frame{display:block;width:100%;height:calc(100vh - 48px);border:0;background:#fff}@media(max-width:520px){.bar{padding:0 12px}.share-label{display:none}.expiry{font-size:11px}}</style></head><body><header class="bar"><div class="brand">Rendro<i>.</i><span class="share-label"> secure share</span></div><div class="expiry">Expires ${new Date(resolution.grant.expiresAt).toISOString().slice(0, 10)}</div></header><iframe class="frame" title="Shared documentation" src="${fileUrl}" sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin" referrerpolicy="no-referrer"></iframe><script>try{var q=matchMedia("(prefers-color-scheme:dark)");q.addEventListener("change",function(){var m=localStorage.getItem("commentor-theme");if(m!=="dark"&&m!=="light")document.documentElement.classList.toggle("dark",q.matches);});}catch(_error){}</script></body></html>`, 200, {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
});

export default app;
