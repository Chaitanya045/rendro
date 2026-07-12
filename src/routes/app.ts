import { Hono } from "hono";
import { listImmediate, buildTree, putObject } from "@/minio";
import type { DocTree } from "@/minio";
import { emailToOrgSlug, orgExists, logOrgAccess } from "@/orgs";
import type { User } from "better-auth/types";
import { logger } from "@/logger";
import { createOrgApiKey } from "@/api-keys";
import { isDeleted } from "@/soft-delete";

const app = new Hono<{ Variables: { user?: User } }>();

/**
 * GET / — the main entry. Behavior depends on the user's session:
 *
 *   no session           → "Sign in with Google" page
 *   session, org exists → doc tree
 *   session, no org     → "Create your org" form (org pre-populated from email domain)
 */
app.get("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.html(renderSignIn());
  }

  try {
    const email = user.email;
    const org = emailToOrgSlug(email);
    if (!org) {
      return c.html(renderEmailUnsupported(user));
    }

    if (await orgExists(org)) {
      return c.html(await renderOrgDocs(user, org));
    }

    return c.html(renderCreateOrg(user, org));
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error({ err: e.message, stack: e.stack, email: user.email }, "root handler error");
    const s3Err = err as { message?: string; name?: string; $metadata?: { httpStatusCode?: number } };
    return c.json({
      error: s3Err.message ?? e.message,
      code: s3Err.name ?? e.name,
      statusCode: s3Err.$metadata?.httpStatusCode,
    }, 500);
  }
});

/**
 * GET /api/auth/me — current user info (handy for client-side checks)
 */
app.get("/api/auth/me", (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null }, 200);
  return c.json({ user });
});

/**
 * POST /api/orgs — create the org folder in MinIO.
 */

app.post("/api/orgs", async (c) => {
  const user = c.get("user");
  if (!user) return c.text("Sign in first", 401);

  const body = await c.req.json<{ org?: string; displayName?: string }>()
    .catch((): { org?: string; displayName?: string } => ({}));
  const org = (body.org ?? emailToOrgSlug(user.email) ?? "").toLowerCase();
  const displayName = body.displayName?.trim() || org;

  if (!org.match(/^[a-z0-9]+(-[a-z0-9]+)*$/)) {
    return c.text("Invalid org slug. Use lowercase letters, numbers, and hyphens.", 400);
  }
  if (await orgExists(org)) {
    return c.redirect(`/?org=${encodeURIComponent(org)}`, 303);
  }

  const apiKey = await createOrgApiKey(org);
  const indexHtml = renderInitialIndex(user, org, displayName);
  await putObject(`${org}/index.html`, indexHtml, "text/html");
  logOrgAccess(org, user.email, "create");
  logger.info({ org, user: user.email }, "org created");

  return c.html(renderApiKeyPage(user, org, apiKey));
});

// ----- HTML renderers -----

function renderSignIn(): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rendro — Sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; background:#fafafa; color:#1a1a1a; }
  .card { background:#fff; padding:2.5rem 3rem; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.1); text-align:center; max-width:420px; }
  h1 { margin:0 0 0.5rem; font-size:1.5rem; }
  p { color:#666; margin:0 0 1.5rem; }
  a.btn { display:inline-block; background:#1a1a1a; color:#fff; padding:0.75rem 1.5rem; border-radius:6px; text-decoration:none; font-weight:500; }
  a.btn:hover { background:#333; }
</style>
</head><body>
<div class="card">
  <h1>Rendro</h1>
  <p>Sign in to read your team's docs.</p>
  <form id="sf" method="post" action="/api/auth/sign-in/social" style="display:none"><input type="hidden" name="provider" value="google"><input type="hidden" name="callbackURL" id="sf-cb"></form>
  <script>document.getElementById('sf-cb').value=location.href</script>
  <button onclick="fetch('/api/auth/sign-in/social',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'google',callbackURL:location.href})}).then(r=>r.json()).then(d=>{if(d.url)location.href=d.url}).catch(()=>document.getElementById('sf').submit())" style="background:#1a1a1a;color:#fff;padding:0.75rem 1.5rem;border:0;border-radius:6px;font-weight:500;cursor:pointer;font-size:1rem">Sign in with Google</button>
</div>
</body></html>`;
}

function renderEmailUnsupported(user: User): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Rendro</title></head>
<body style="font-family:system-ui;padding:2rem">
<h1>Unsupported email domain</h1>
<p>Your email <code>${escapeHtml(user.email)}</code> doesn't have a valid org slug. Use a work email like <code>you@company.com</code>.</p>
<p><a href="/api/auth/sign-out">Sign out</a></p>
</body></html>`;
}

function renderCreateOrg(user: User, org: string): string {
  const email = escapeHtml(user.email);
  const orgEsc = escapeHtml(org);
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${orgEsc} — Rendro</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background:#fafafa; color:#1a1a1a; margin:0; }
  .container { max-width: 600px; margin: 4rem auto; padding: 0 1rem; }
  .card { background:#fff; padding:2rem 2.5rem; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
  h1 { margin:0 0 0.25rem; font-size:1.5rem; }
  .meta { color:#666; font-size:0.875rem; margin:0 0 1.5rem; }
  label { display:block; font-weight:500; margin: 1rem 0 0.25rem; }
  input { width:100%; padding:0.5rem 0.75rem; border:1px solid #ccc; border-radius:4px; font-size:0.95rem; box-sizing:border-box; }
  button { margin-top:1.5rem; background:#1a1a1a; color:#fff; padding:0.75rem 1.5rem; border:0; border-radius:6px; font-weight:500; cursor:pointer; }
  a.logout { float:right; color:#666; font-size:0.875rem; }
</style>
</head><body>
<div class="container">
  <a class="logout" href="/api/auth/sign-out">Sign out</a>
  <div class="card">
    <h1>Create your org</h1>
    <p class="meta">Signed in as ${email}</p>
    <p>No docs found for <code>${orgEsc}</code>. Create the org to get started.</p>
    <form method="post" action="/api/orgs">
      <label for="org">Org slug</label>
      <input id="org" name="org" value="${orgEsc}" readonly>
      <label for="displayName">Display name</label>
      <input id="displayName" name="displayName" value="${orgEsc}">
      <button type="submit">Create org</button>
    </form>
  </div>
</div>
</body></html>`;
}


async function renderOrgDocs(user: User, org: string): Promise<string> {
  const { entries } = await listImmediate(`${org}/`);
  const deleted = await Promise.all(entries.map(e => isDeleted(e.key)));
  const active = entries.filter((_, i) => !deleted[i]);
  const tree = buildTree(active, `${org}/`);
  logOrgAccess(org, user.email, "view");
  return renderOrgTreePage(user, org, tree);
}

function renderOrgTreePage(user: User, org: string, tree: DocTree[]): string {
  const email = escapeHtml(user.email);
  const orgEsc = escapeHtml(org);
  const initials = (user.name || email).split(/[@\s]/)[0].slice(0, 2).toUpperCase();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${orgEsc} — Rendro</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<script>
tailwind.config={darkMode:"class",theme:{extend:{colors:{"outline-variant":"#e5e7eb","background":"#ffffff","surface-container-high":"#f0f0f3","on-secondary-fixed":"#111418","on-surface-variant":"#6b7280","primary":"#0a66c2","primary-fixed-dim":"#b2c5ff","surface":"#ffffff","surface-container-low":"#f8f9fa","secondary-container":"#e8f0fe","on-secondary-container":"#111418","on-surface":"#111418","outline":"#6b7280","on-primary":"#ffffff","surface-container":"#f3f4f6"},fontFamily:{"body-md":["Inter"]},fontSize:{"body-md":["14px",{lineHeight:"20px",fontWeight:"400"}],"headline-sm":["20px",{lineHeight:"28px",fontWeight:"600"}],"headline-md":["24px",{lineHeight:"32px",fontWeight:"600"}]}}}}
</script>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Inter,system-ui,sans-serif;background:#fff;color:#111418;overflow:hidden;height:100vh;font-size:14px;line-height:20px}
  .material-symbols-outlined{font-variation-settings:'FILL'0,'wght'400,'GRAD'0,'opsz'24;vertical-align:middle;font-size:20px}
  ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:#e5e7eb;border-radius:10px}

  .topbar{position:fixed;top:0;z-index:50;width:100%;height:56px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;padding:0 24px}
  .topbar-left{display:flex;align-items:center;gap:24px}
  .topbar-logo{font-size:24px;font-weight:700;color:#0a66c2;line-height:32px}
  .topbar-search{display:flex;align-items:center;gap:8px;background:#f3f4f6;padding:6px 12px;border-radius:4px;border:1px solid #e5e7eb;width:256px;transition:border-color .15s}
  .topbar-search:focus-within{border-color:#0a66c2}
  .topbar-search input{border:0;outline:0;background:transparent;font-size:14px;color:#111418;width:100%;font-family:Inter}
  .topbar-search input::placeholder{color:#6b7280}
  .topbar-actions{display:flex;align-items:center;gap:16px}
  .topbar-btn{padding:6px 12px;font-size:12px;font-weight:600;border-radius:4px;cursor:pointer;border:0;font-family:Inter;display:flex;align-items:center;gap:6px}
  .topbar-btn-share{color:#0a66c2;background:transparent}
  .topbar-btn-share:hover{background:#f3f4f6}
  .topbar-btn-create{background:#0a66c2;color:#fff}
  .topbar-btn-create:hover{opacity:.8}
  .topbar-avatar{width:32px;height:32px;border-radius:50%;background:#e8f0fe;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#111418;cursor:pointer;border:1px solid #e5e7eb}

  .sidebar{position:fixed;top:56px;left:0;bottom:0;width:280px;background:#fff;border-right:1px solid #e5e7eb;display:flex;flex-direction:column;overflow-y:auto;padding:16px 0}
  .sidebar-org{padding:0 24px;margin-bottom:16px}
  .sidebar-org-row{display:flex;align-items:center;gap:12px;cursor:pointer}
  .sidebar-org-icon{width:32px;height:32px;border-radius:4px;background:#0a66c2;display:flex;align-items:center;justify-content:center}
  .sidebar-org-icon .material-symbols-outlined{color:#fff;font-size:18px}
  .sidebar-org-name{font-size:20px;font-weight:600;line-height:28px;color:#111418}
  .sidebar-org-meta{font-size:12px;font-weight:600;color:#6b7280;letter-spacing:.05em;line-height:16px}
  .sidebar-divider{padding:8px 12px;font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  .sidebar-footer{padding:12px 16px;border-top:1px solid #e5e7eb;margin-top:auto}
  .sidebar-tree{flex:1;padding:0 12px;overflow-y:auto;--sidebar-bg:#fff}
  .sidebar-footer a:hover{color:#111418}

  .tree-folder-content{overflow:hidden;transition:max-height .4s cubic-bezier(.34,1.56,.64,1),opacity .3s ease;max-height:0;opacity:0}
  .tree-folder.open>.tree-folder-content{max-height:2000px;opacity:1;overflow:visible}
  /* ── sticky folder headers (VS Code-style stacking) ── */
  .tree-folder.open>.tree-item{position:sticky;background:var(--sidebar-bg,#fff)}
  .tree-folder[data-depth="0"].open>.tree-item{top:0;z-index:10}
  .tree-folder[data-depth="1"].open>.tree-item{top:30px;z-index:9}
  .tree-folder[data-depth="2"].open>.tree-item{top:60px;z-index:8}
  .tree-folder[data-depth="3"].open>.tree-item{top:90px;z-index:7}
  .tree-folder[data-depth="4"].open>.tree-item{top:120px;z-index:6}
  .tree-folder[data-depth="5"].open>.tree-item{top:150px;z-index:5}
  .load-more-btn:disabled{color:#6b7280;cursor:default}
  .tree-item{display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:4px;color:#6b7280;cursor:pointer;transition:transform .2s cubic-bezier(.4,0,.2,1),background-color .2s,color .2s}
  .tree-item:hover{background:#f0f0f3;color:#111418}
  .tree-item.active{background:#e8f0fe;color:#0a66c2}
  .tree-link{color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tree-size{color:#6b7280;font-size:11px;flex-shrink:0}
  .tree-empty{color:#6b7280;padding:6px 12px;font-size:12px}
  .tree-error{color:#ba1a1a;padding:4px 8px;font-size:11px}
  .caret-icon{transition:transform .3s cubic-bezier(.4,0,.2,1)}
  .tree-folder.open>.tree-item .caret-icon{transform:rotate(90deg)}
  .active-indicator{position:absolute;left:0;width:4px;height:32px;background:#0a66c2;transition:transform .3s cubic-bezier(.4,0,.2,1),opacity .2s ease;border-radius:4px;pointer-events:none}

  .main{margin-left:280px;margin-top:56px;height:calc(100vh - 56px);overflow:hidden;background:#f8f9fa;position:relative}
  .main-placeholder{display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;text-align:center;padding:3rem}
  .main-placeholder h2{font-size:24px;font-weight:600;color:#111418;margin-bottom:8px}
  .main-placeholder p{font-size:16px;color:#6b7280;max-width:320px}
  .ph-icon{width:64px;height:64px;border-radius:50%;background:#f0f0f3;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px}
  .content-frame{width:100%;height:100%;border:0;background:#fff}
  /* ── loader — 3px line at top of iframe/content area, never covering the document ── */
  .doc-loader{position:absolute;top:0;left:0;right:0;height:3px;display:block;z-index:3;pointer-events:none;overflow:hidden;background:transparent}
  .doc-loader-bar{position:absolute;top:0;bottom:0;left:0;width:38%;border-radius:999px;background:linear-gradient(90deg,transparent,#0a66c2,transparent);animation:docLoaderSweep 1.1s cubic-bezier(.4,0,.2,1) infinite}
  .doc-loader.error .doc-loader-bar{width:100%;background:#b42318;animation:none;opacity:.9}
  @keyframes docLoaderSweep{0%{transform:translateX(-100%)}100%{transform:translateX(265%)}}
  html.dark .doc-loader-bar{background:linear-gradient(90deg,transparent,#fafafa,transparent)}
  html.dark .doc-loader.error .doc-loader-bar{background:#fca5a5}
  @media (prefers-reduced-motion: reduce){.doc-loader-bar{width:100%;opacity:.65;animation:none}}
  .avatar-wrap{position:relative}
  .avatar-menu{position:absolute;top:42px;right:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.12);padding:4px;min-width:200px;z-index:100}
  .avatar-menu-email{padding:8px 12px;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .avatar-menu-item{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:14px;color:#111418;text-decoration:none;border-radius:4px;cursor:pointer;border:0;background:0;width:100%;font-family:Inter}
  .avatar-menu-item:hover{background:#f3f4f6}

  .share-wrap{position:relative}
  .share-menu{position:absolute;top:38px;right:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.12);padding:4px;min-width:160px;z-index:100}
  .share-menu-item{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:14px;color:#111418;border:0;background:0;width:100%;border-radius:4px;cursor:pointer;font-family:Inter}
  .share-menu-item:hover{background:#f3f4f6}

  .toast{position:fixed;bottom:24px;right:24px;background:#111418;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;font-family:Inter;z-index:200;opacity:0;transition:opacity .2s;pointer-events:none}
  .toast.show{opacity:1}
  .topbar-btn-icon{width:32px;height:32px;border-radius:4px;border:0;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#6b7280;transition:background .15s}
  .topbar-btn-icon:hover{background:#f3f4f6}

  /* ── dark mode (shadcn-style neutral palette) ── */
  html.dark{background:#09090b;color:#fafafa}
  html.dark body{background:#09090b;color:#fafafa}
  html.dark ::-webkit-scrollbar-thumb{background:#27272a}
  html.dark .topbar{background:#09090b;border-bottom-color:#27272a}
  html.dark .topbar-logo{color:#fafafa}
  html.dark .topbar-search{background:#18181b;border-color:#27272a}
  html.dark .topbar-search:focus-within{border-color:#52525b}
  html.dark .topbar-search input{color:#fafafa}
  html.dark .topbar-search input::placeholder{color:#a1a1aa}
  html.dark .topbar-btn-icon{color:#a1a1aa}
  html.dark .topbar-btn-icon:hover{background:#18181b;color:#fafafa}
  html.dark .topbar-btn-share{color:#fafafa}
  html.dark .topbar-btn-share:hover{background:#18181b}
  html.dark .topbar-btn-create{background:#fafafa;color:#09090b}
  html.dark .topbar-btn-create:hover{background:#e4e4e7;opacity:1}
  html.dark .sidebar-tree{--sidebar-bg:#09090b}
  html.dark .topbar-avatar{background:#18181b;color:#fafafa;border-color:#27272a}
  html.dark .sidebar{background:#09090b;border-right-color:#27272a}
  html.dark .sidebar-org-name{color:#fafafa}
  html.dark .sidebar-org-meta{color:#a1a1aa}
  html.dark .sidebar-org-icon{background:#fafafa}
  html.dark .sidebar-org-icon .material-symbols-outlined{color:#18181b}
  html.dark .sidebar-divider{color:#a1a1aa}
  html.dark .sidebar-footer{border-top-color:#27272a}
  html.dark .sidebar-footer a{color:#a1a1aa}
  html.dark .sidebar-footer a:hover{color:#fafafa}
  html.dark .tree-item{color:#a1a1aa}
  html.dark .tree-item:hover{background:#18181b;color:#fafafa}
  html.dark .tree-item.active{background:#18181b;color:#fafafa}
  html.dark .active-indicator{background:#fafafa}
  html.dark .tree-size{color:#a1a1aa}
  html.dark .tree-empty{color:#a1a1aa}
  html.dark .tree-error{color:#fca5a5}
  html.dark .main{background:#09090b}
  html.dark .main-placeholder h2{color:#fafafa}
  html.dark .main-placeholder p{color:#a1a1aa}
  html.dark .ph-icon{background:#18181b}
  html.dark .ph-icon .material-symbols-outlined{color:#a1a1aa!important}
  html.dark .avatar-menu-item{color:#fafafa}
  html.dark .avatar-menu-item:hover{background:#18181b}
  html.dark .share-menu{background:#09090b;border-color:#27272a;box-shadow:0 8px 24px rgba(0,0,0,.48)}
  html.dark .share-menu-item{color:#fafafa}
  html.dark .share-menu-item:hover{background:#18181b}
  html.dark .toast{background:#fafafa;color:#09090b}
  html.dark .load-more-btn{color:#fafafa}
  html.dark .load-more-btn:hover{background:#18181b}
  html.dark .load-more-btn:disabled{color:#71717a}
  html.dark .avatar-menu{background:#09090b;border-color:#27272a;box-shadow:0 8px 24px rgba(0,0,0,.48)}
  html.dark .avatar-menu-email{color:#a1a1aa;border-bottom-color:#27272a}
  html.dark .avatar-menu-item{color:#fafafa}
  html.dark .avatar-menu-item:hover{background:#18181b}
</style>
<body>

<header class="topbar">
  <div class="topbar-left">
    <span class="topbar-logo">Rendro</span>
  </div>
  <div class="topbar-actions">
    <div class="share-wrap">
      <button class="topbar-btn topbar-btn-share" id="share-btn"><span class="material-symbols-outlined" style="font-size:18px">share</span> Share</button>
      <div class="share-menu" id="share-menu" style="display:none">
        <button class="share-menu-item" id="copy-link-btn"><span class="material-symbols-outlined" style="font-size:18px">link</span> Copy link</button>
      </div>
    </div>
    <button class="topbar-btn-icon" id="theme-toggle" title="Toggle theme"><span class="material-symbols-outlined" style="font-size:20px">dark_mode</span></button>
    <div class="avatar-wrap">
      <div class="topbar-avatar" id="avatar-btn" title="${escapeHtml(email)}">${initials}</div>
      <div class="avatar-menu" id="avatar-menu" style="display:none">
        <div class="avatar-menu-email">${escapeHtml(email)}</div>
        <a href="/api/auth/sign-out" class="avatar-menu-item"><span class="material-symbols-outlined" style="font-size:18px">logout</span> Sign out</a>
      </div>
    </div>
  </div>
</header>

<aside class="sidebar">
  <div class="sidebar-divider">Docs</div>
  <div class="sidebar-tree" data-tree-org="${orgEsc}">
    <div class="space-y-0.5 relative" id="tree-container" style="position:relative">
      <div class="active-indicator" id="active-indicator" style="opacity:0;transition:none"></div>
      ${renderTree(tree)}
    </div>
  </div>
</aside>

<main class="main">
  <div class="doc-loader" id="doc-loader" style="display:none" role="progressbar" aria-label="Loading document"><div class="doc-loader-bar"></div></div>
  <div class="main-placeholder" id="main-placeholder">
    <div class="ph-icon"><span class="material-symbols-outlined" style="font-size:32px;color:#6b7280">edit_document</span></div>
    <h2>Select a document</h2>
    <p>Choose a document from the sidebar to view its contents, or create a new page to start writing.</p>
  </div>
  <iframe name="content-frame" id="content-frame" class="content-frame"
    src="about:blank" title="Document content" style="display:none"></iframe>
</main>

<script>
(function(){var t=localStorage.getItem("commentor-theme");var d=t==="dark"||(!t&&matchMedia("(prefers-color-scheme:dark)").matches);
if(d)document.documentElement.classList.add("dark");
function up(){var i=document.querySelector("#theme-toggle .material-symbols-outlined");if(i)i.textContent=document.documentElement.classList.contains("dark")?"light_mode":"dark_mode";}
up();document.getElementById("theme-toggle")?.addEventListener("click",function(){var h=document.documentElement;h.classList.toggle("dark");localStorage.setItem("commentor-theme",h.classList.contains("dark")?"dark":"light");up();});
document.getElementById("avatar-btn")?.addEventListener("click",function(e){e.stopPropagation();var m=document.getElementById("avatar-menu");m.style.display=m.style.display==="block"?"none":"block";});
document.getElementById("share-btn")?.addEventListener("click",function(e){e.stopPropagation();var m=document.getElementById("share-menu");m.style.display=m.style.display==="block"?"none":"block";});
document.getElementById("copy-link-btn")?.addEventListener("click",function(){navigator.clipboard.writeText(location.href).catch(function(){});var t=document.createElement("div");t.className="toast";t.textContent="Link copied";document.body.appendChild(t);t.offsetHeight;t.classList.add("show");setTimeout(function(){t.classList.remove("show");setTimeout(function(){t.remove()},200)},1500)});
document.addEventListener("click",function(){var m=document.getElementById("avatar-menu");if(m)m.style.display="none";var s=document.getElementById("share-menu");if(s)s.style.display="none";});})();
</script>
<script src="/lazy-tree.js?v=18"></script>
</body>
</html>`;
}


function renderTree(nodes: DocTree[]): string {
  if (nodes.length === 0) return '<div class="tree-empty">No documents yet.</div>';
  return nodes
    .map((node) => {
      if (node.type === "folder") {
        const folderPath = node.path.endsWith("/") ? node.path : `${node.path}/`;
        return `<div class="tree-folder" data-path="${escapeHtml(folderPath)}" data-depth="0">
    <div class="tree-item flex items-center gap-2 px-3 py-1.5 rounded-lg text-on-surface-variant cursor-pointer">
      <span class="material-symbols-outlined text-[18px] caret-icon flex-shrink-0">chevron_right</span>
      <span class="material-symbols-outlined text-[18px] folder-icon flex-shrink-0">folder</span>
      <span class="font-body-md flex-1 min-w-0">${escapeHtml(node.name)}</span>
    </div>
    <div class="tree-folder-content ml-4 space-y-0.5 border-l border-outline-variant/30 pl-2"></div>
  </div>`;
      }
      const filePath = `/files/${node.path}`;
      return `<div class="tree-item flex items-center gap-2 px-3 py-1.5 rounded-lg text-on-surface-variant cursor-pointer" data-path="${escapeHtml(node.path)}">
    <span class="material-symbols-outlined text-[18px] flex-shrink-0">article</span>
    <a href="${escapeHtml(filePath)}" class="tree-link flex-1 min-w-0" target="content-frame">${escapeHtml(node.name.replace(/\.html$/, ""))}</a>
</div>`;
    })
    .join("\n");
}
function renderInitialIndex(_user: User, org: string, displayName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(displayName)}</title>
<style>body{font-family:system-ui;max-width:720px;margin:3rem auto;padding:0 1.5rem;line-height:1.6;color:#1a1a1a}</style>
</head>
<body>
<h1>${escapeHtml(displayName)}</h1>
<p>This is the <code>${escapeHtml(org)}</code> documentation space on Rendro.</p>
<p>Push your first docs with the CLI (set DOCSYNC_API_KEY in your CI):</p>
<pre><code>rendro push --source ./docs --org ${escapeHtml(org)}</code></pre>
<p>Or start writing HTML directly in the bucket under <code>${escapeHtml(org)}/</code>.</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function renderApiKeyPage(user: User, org: string, apiKey: string): string {
  const email = escapeHtml(user.email);
  const orgEsc = escapeHtml(org);
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${orgEsc} — Rendro</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #fafafa; color: #1a1a1a; margin:0; }
  .container { max-width: 600px; margin: 4rem auto; padding: 0 1rem; }
  .card { background: #fff; padding: 2rem 2.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
  .meta { color: #666; font-size: 0.875rem; margin: 0 0 1.5rem; }
  .key-box { background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 6px; padding: 1rem; font-family: monospace; font-size: 0.8rem; word-break: break-all; user-select: all; margin: 0.5rem 0 1rem; }
  .warning { background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 0.75rem 1rem; margin: 1rem 0; font-size: 0.9rem; }
  code { background: #f0f0f0; padding: 0.15rem 0.3rem; border-radius: 3px; font-size: 0.9em; }
  pre { background: #2d2d2d; color: #f8f8f2; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; }
  .copy-btn { background: #e8e8e8; border: 1px solid #ccc; border-radius: 4px; padding: 0.3rem 0.75rem; cursor: pointer; font-size: 0.85rem; margin-bottom: 0.5rem; }
  .copy-btn:hover { background: #d8d8d8; }
</style>
</head><body>
<div class="container">
  <div class="card">
    <h1>${orgEsc} — Created!</h1>
    <p class="meta">Signed in as ${email}</p>
    <p>Here's your API key for the CLI. Copy it now — it won't be shown again.</p>
    <div class="key-box" id="api-key">${escapeHtml(apiKey)}</div>
    <button type="button" class="copy-btn" onclick="copyKey()">Copy</button>
    <div class="warning">
      <strong>Store this securely.</strong> Add it to your CI environment as
      <code>DOCSYNC_API_KEY</code>. Anyone with this key can push docs to
      your org.
    </div>
    <pre><code># In your CI pipeline:
rendro push --source ./docs --org ${orgEsc}
# Set DOCSYNC_API_KEY in your CI secrets</code></pre>
    <a class="btn" href="/">View your docs →</a>
  </div>
</div>
<script>
function copyKey() {
  const el = document.getElementById('api-key');
  const btn = document.querySelector('.copy-btn');
  if (!el || !btn) return;
  navigator.clipboard.writeText(el.textContent || '')
    .then(() => { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); })
    .catch(() => { btn.textContent = 'Copy failed'; });
}
</script>
</body></html>`;
}
export default app;
