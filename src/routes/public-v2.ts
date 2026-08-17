import { Hono } from "hono";
import { CONVEX_SITE_URL } from "@/config";
import { getObjectStream, getObjectText } from "@/minio";
import { renderNotFoundPage } from "@/routes/not-found";

const app = new Hono();

type PublicResolution = {
  publication: {
    slug: string;
    pathPrefix: string;
    entryFile: string;
    title?: string;
    description?: string;
  };
  project: { name: string; slug: string };
  deployment: { manifestKey: string; manifestSha256: string };
};

type Manifest = {
  version: 1;
  files: Array<{ path: string; sha256: string; size: number; contentType: string }>;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character] ?? character);
}

function safePath(value: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  const path = decoded.replace(/^\/+/, "");
  if (!path || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return path;
}

async function resolvePublication(slug: string): Promise<PublicResolution | null> {
  const response = await fetch(
    `${CONVEX_SITE_URL}/api/rendro/publications/public?slug=${encodeURIComponent(slug)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  return response.json() as Promise<PublicResolution>;
}

async function manifestFor(result: PublicResolution): Promise<Manifest | null> {
  const text = await getObjectText(result.deployment.manifestKey);
  if (!text) return null;
  try { return JSON.parse(text) as Manifest; } catch { return null; }
}

function publicationPath(result: PublicResolution, path: string): string | null {
  const relative = safePath(path);
  if (!relative) return null;
  const prefix = result.publication.pathPrefix;
  return prefix ? `${prefix}/${relative}` : relative;
}

function objectKey(result: PublicResolution, path: string): string {
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

function injectNavigation(html: string, slug: string, path: string): string {
  const basePath = `/p/${encodeURIComponent(slug)}/files/`;
  const script = `<script>(function(){var parentWindow=window.parent;if(parentWindow!==window)parentWindow.postMessage({type:"doc-loaded",path:${JSON.stringify(path)}},location.origin);document.addEventListener("click",function(event){var anchor=event.target.closest("a");if(!anchor||!anchor.href)return;var url=new URL(anchor.href);var prefix=${JSON.stringify(basePath)};if(url.origin!==location.origin||!url.pathname.startsWith(prefix))return;var next=url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");if(!next)return;event.preventDefault();parentWindow.postMessage({type:"doc-navigate",path:next},location.origin);});})();</script>`;
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${script}</body>`) : html + script;
}

app.get("/p/:slug/files/*", async (c) => {
  const result = await resolvePublication(c.req.param("slug"));
  if (!result) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const relativePath = safePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  const fullPath = relativePath ? publicationPath(result, relativePath) : null;
  if (!relativePath || !fullPath) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const manifest = await manifestFor(result);
  const entry = manifest?.files.find((file) => file.path === fullPath);
  if (!entry) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const stream = await getObjectStream(objectKey(result, fullPath));
  if (!stream) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const headers = {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Content-Type": entry.contentType,
    "X-Content-Type-Options": "nosniff",
  };
  if (!entry.contentType.startsWith("text/html")) return new Response(stream, { headers });
  const html = injectNavigation(await readStream(stream), result.publication.slug, relativePath);
  return new Response(html, {
    headers: {
      ...headers,
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
});

app.get("/p/:slug/tree", async (c) => {
  const result = await resolvePublication(c.req.param("slug"));
  if (!result) return c.json({ error: "Not found" }, 404);
  const manifest = await manifestFor(result);
  if (!manifest) return c.json({ error: "Manifest unavailable" }, 404);
  const prefix = result.publication.pathPrefix ? `${result.publication.pathPrefix}/` : "";
  const documents = manifest.files
    .filter((file) => file.contentType.startsWith("text/html") && file.path.startsWith(prefix))
    .map((file) => file.path.slice(prefix.length));
  const offset = Math.max(0, Number.parseInt(c.req.query("cursor") ?? "0", 10) || 0);
  const page = documents.slice(offset, offset + 200);
  const cursor = offset + page.length < documents.length ? String(offset + page.length) : null;
  return c.json({ documents: page, cursor, total: documents.length }, 200, {
    "Cache-Control": "public, max-age=0, must-revalidate",
  });
});

app.get("/p/:slug", async (c) => {
  const result = await resolvePublication(c.req.param("slug"));
  if (!result) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const manifest = await manifestFor(result);
  if (!manifest) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const requested = c.req.query("doc");
  const selected = requested ? safePath(requested) : result.publication.entryFile;
  const fullPath = selected ? publicationPath(result, selected) : null;
  if (!selected || !fullPath || !manifest.files.some((file) => file.path === fullPath)) {
    return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  }
  const slug = result.publication.slug;
  const title = result.publication.title || result.project.name;
  const state = JSON.stringify({ slug, selected }).replace(/</g, "\\u003c");
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — Rendro</title><style>:root{--sidebar:280px;--surface:#fff;--page:#fafafa;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#f97316}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);font-family:Inter,ui-sans-serif,system-ui}.topbar{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid var(--border);background:var(--surface)}.brand{font-weight:760;letter-spacing:-.03em}.brand i{font-style:normal;color:var(--accent)}.title{font-size:12px;color:var(--muted)}.layout{display:grid;grid-template-columns:var(--sidebar) 1fr;height:calc(100vh - 56px)}.sidebar{background:var(--surface);border-right:1px solid var(--border);overflow:auto;padding:14px}.search{width:100%;height:36px;border:1px solid var(--border);border-radius:7px;padding:0 10px;margin-bottom:10px}.docs{display:grid;gap:2px}.doc,.more{border:0;background:transparent;color:var(--muted);text-align:left;padding:8px 9px;border-radius:6px;font-size:12px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.doc:hover,.doc.active{background:#f4f4f5;color:var(--text)}.doc.active{font-weight:650;border-left:2px solid var(--accent)}.frame{width:100%;height:100%;border:0;background:#fff}.status{padding:20px;color:var(--muted);font-size:12px}@media(max-width:700px){:root{--sidebar:210px}.title{display:none}}</style></head><body><header class="topbar"><div class="brand">Rendro<i>.</i></div><div class="title">${escapeHtml(title)}</div></header><main class="layout"><aside class="sidebar"><input class="search" id="search" placeholder="Filter loaded documents" aria-label="Filter documents"><div class="docs" id="docs"><div class="status">Loading documents…</div></div></aside><iframe class="frame" id="frame" title="${escapeHtml(title)} documentation" sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"></iframe></main><script>window.__PUBLIC_STATE__=${state};</script><script>(function(){var state=window.__PUBLIC_STATE__,docs=document.getElementById("docs"),frame=document.getElementById("frame"),search=document.getElementById("search"),paths=[],cursor="0";function frameUrl(path){return "/p/"+encodeURIComponent(state.slug)+"/files/"+path.split("/").map(encodeURIComponent).join("/");}function select(path,push){state.selected=path;frame.src=frameUrl(path);document.querySelectorAll(".doc").forEach(function(node){node.classList.toggle("active",node.dataset.path===path);});if(push)history.pushState({path:path},"","?doc="+encodeURIComponent(path));}function render(){var query=search.value.toLowerCase();docs.innerHTML="";paths.filter(function(path){return path.toLowerCase().includes(query);}).forEach(function(path){var button=document.createElement("button");button.className="doc"+(path===state.selected?" active":"");button.dataset.path=path;button.textContent=path;button.title=path;button.onclick=function(){select(path,true);};docs.append(button);});if(cursor){var more=document.createElement("button");more.className="more";more.textContent="Load more";more.onclick=load;docs.append(more);}}async function load(){var response=await fetch("/p/"+encodeURIComponent(state.slug)+"/tree?cursor="+encodeURIComponent(cursor||"0")),data=await response.json();paths=paths.concat(data.documents);cursor=data.cursor;render();}search.addEventListener("input",render);addEventListener("message",function(event){if(event.origin!==location.origin||!event.data)return;if(event.data.type==="doc-navigate")select(event.data.path,true);});addEventListener("popstate",function(event){if(event.state&&event.state.path)select(event.state.path,false);});select(state.selected,false);load();})();</script></body></html>`, 200, {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  });
});

export default app;
