import { Hono } from "hono";
import type { User } from "better-auth/types";
import { CONVEX_SITE_URL } from "@/config";
import { getObjectStream, getObjectText } from "@/minio";
import { renderNotFoundPage } from "@/routes/not-found";

const app = new Hono<{ Variables: { user?: User } }>();

type ActiveDeployment = { project: { name: string }; deployment: { manifestKey: string } };
type Manifest = { files: Array<{ path: string; contentType: string }> };

function safePath(value: string): string | null {
  let path: string;
  try { path = decodeURIComponent(value).replace(/^\/+/, ""); } catch { return null; }
  return path && !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..") ? path : null;
}

async function activeDeployment(
  organizationId: string,
  projectId: string,
  cookie: string | undefined,
): Promise<ActiveDeployment | null> {
  const query = new URLSearchParams({ organizationId, projectId });
  const response = await fetch(`${CONVEX_SITE_URL}/api/rendro/deployments/active?${query}`, {
    headers: cookie ? { Accept: "application/json", Cookie: cookie } : { Accept: "application/json" },
  });
  return response.ok ? response.json() as Promise<ActiveDeployment> : null;
}

async function activeManifest(result: ActiveDeployment): Promise<Manifest | null> {
  const text = await getObjectText(result.deployment.manifestKey);
  if (!text) return null;
  try { return JSON.parse(text) as Manifest; } catch { return null; }
}

function basePath(organizationId: string, projectId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/docs`;
}

app.get("/organizations/:organizationId/projects/:projectId/docs/tree", async (c) => {
  if (!c.get("user")) return c.json({ error: "Authentication required" }, 401);
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const active = await activeDeployment(organizationId, projectId, c.req.header("Cookie"));
  if (!active) return c.json({ error: "Not found" }, 404);
  const manifest = await activeManifest(active);
  if (!manifest) return c.json({ error: "Manifest unavailable" }, 404);
  const documents = manifest.files.filter((file) => file.contentType.startsWith("text/html")).map((file) => file.path);
  const offset = Math.max(0, Number.parseInt(c.req.query("cursor") ?? "0", 10) || 0);
  const page = documents.slice(offset, offset + 200);
  return c.json({ documents: page, cursor: offset + page.length < documents.length ? String(offset + page.length) : null });
});

app.get("/organizations/:organizationId/projects/:projectId/docs/files/*", async (c) => {
  if (!c.get("user")) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const path = safePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  if (!path) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const active = await activeDeployment(organizationId, projectId, c.req.header("Cookie"));
  if (!active) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const manifest = await activeManifest(active);
  const entry = manifest?.files.find((file) => file.path === path);
  if (!entry) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const key = `${active.deployment.manifestKey.slice(0, -"manifest.json".length)}files/${path}`;
  const stream = await getObjectStream(key);
  if (!stream) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  return new Response(stream, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": entry.contentType,
      "Content-Security-Policy": entry.contentType.startsWith("text/html")
        ? "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'"
        : "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

app.get("/organizations/:organizationId/projects/:projectId/docs", async (c) => {
  const user = c.get("user");
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const base = basePath(organizationId, projectId);
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent(base)}`);
  const active = await activeDeployment(organizationId, projectId, c.req.header("Cookie"));
  if (!active) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const state = JSON.stringify({ organizationId, projectId, base }).replace(/</g, "\\u003c");
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${active.project.name.replace(/[&<>"']/g, "")} — Rendro</title><style>:root{--side:280px;--surface:#fff;--page:#fafafa;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#f97316}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--text);font-family:Inter,ui-sans-serif,system-ui}.bar{height:56px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--border);background:var(--surface)}.brand{font-weight:750;text-decoration:none;margin-right:auto}.brand i{font-style:normal;color:var(--accent)}.button{height:34px;border:1px solid var(--border);border-radius:7px;background:var(--surface);font-size:11px;font-weight:650;padding:0 11px;cursor:pointer}.layout{height:calc(100vh - 56px);display:grid;grid-template-columns:var(--side) 1fr}.side{padding:12px;overflow:auto;border-right:1px solid var(--border);background:var(--surface)}.doc,.more{display:block;width:100%;border:0;background:transparent;text-align:left;padding:8px;border-radius:6px;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}.doc:hover,.doc.active{background:#f4f4f5;color:var(--text)}.frame{width:100%;height:100%;border:0;background:#fff}@media(max-width:700px){:root{--side:205px}}</style></head><body><header class="bar"><a class="brand" href="/">Rendro<i>.</i></a><button class="button" id="share" disabled>Share document</button><a class="button" href="${base.replace(/\/docs$/, "")}">Project</a></header><main class="layout"><aside class="side" id="docs">Loading…</aside><iframe class="frame" id="frame" sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"></iframe></main><script>window.__DOCS_STATE__=${state};</script><script>(function(){var state=window.__DOCS_STATE__,docs=document.getElementById("docs"),frame=document.getElementById("frame"),share=document.getElementById("share"),paths=[],selected="",cursor="0";function open(path){selected=path;frame.src=state.base+"/files/"+path.split("/").map(encodeURIComponent).join("/");share.disabled=false;render();}function render(){docs.innerHTML="";paths.forEach(function(path){var button=document.createElement("button");button.className="doc"+(path===selected?" active":"");button.textContent=path;button.title=path;button.onclick=function(){open(path);};docs.append(button);});if(cursor){var more=document.createElement("button");more.className="more";more.textContent="Load more";more.onclick=load;docs.append(more);}}async function load(){var response=await fetch(state.base+"/tree?cursor="+encodeURIComponent(cursor||"0")),data=await response.json();paths=paths.concat(data.documents);cursor=data.cursor;if(!selected&&paths[0])open(paths[0]);else render();}share.onclick=async function(){share.disabled=true;var response=await fetch("/api/rendro/shares",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({organizationId:state.organizationId,projectId:state.projectId,documentPath:selected,expiresInSeconds:604800})}),data=await response.json();if(response.ok){await navigator.clipboard.writeText(location.origin+data.url);share.textContent="Link copied";}else{share.textContent=data.error||"Share failed";}setTimeout(function(){share.textContent="Share document";share.disabled=false;},1800);};load();})();</script></body></html>`);
});

export default app;
