import { decodeStoragePath, isLegacyStorageKey, legacyStoragePrefix } from "@/storage-boundary";
import { CONVEX_URL } from "@/config";
import { viewerScript, viewerUpdateNotice } from "@/viewer/markup";
import { COMMENTOR_PARENT_VERSION, LAZY_TREE_VERSION } from "@/viewer/asset-versions";
import { renderCommentRecoveryLifecycle } from "../commentor/recovery-session";
import { nonceAttribute } from "@/middleware/html-nonce";
import { renderFaviconLinks } from "./favicon";
import { renderFontHead } from "./fonts";
import { Hono } from "hono";
import { headObject } from "@/minio";
import { logOrgAccess } from "@/orgs";
import type { User } from "better-auth/types";
import { legacyRequestMember, legacyUnavailable, retiredLegacy } from "@/legacy-access";
import { isDeleted } from "@/soft-delete";
import { renderNotFoundPage } from "@/routes/not-found";
import { renderLandingPage } from "@/routes/landing";
import { renderThemeAssets, renderThemeButton } from "./theme";
import { menuSurfaceStyles } from "../ui/menu-styles";
import { RETRY_AFTER_SOURCE } from "../../shared/retry-after";

const app = new Hono<{ Variables: { user?: User } }>();
app.onError(legacyUnavailable);

/**
 * The public root is the product landing page. Authenticated users enter
 * through the organization selector; organization membership, not email
 * domain derivation, determines every subsequent authorization decision.
 */
app.get("/", (c) => {
  const user = c.get("user");
  if (!user) {
    return c.html(renderLandingPage());
  }

  return c.redirect("/organizations");
});

app.get("/docs/:org", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent(c.req.path)}`);
  const org = c.req.param("org");
  if (!org || !legacyStoragePrefix(org) || c.req.param("org") !== org || !(await legacyRequestMember(c, org))) {
    return c.html(renderLegacyOrgNotFound(c.req.path), 404);
  }
  return c.html(renderOrgDocs(user, org));
});

app.get("/docs/:key{.+}", async (c) => {
  const user = c.get("user");
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent(c.req.path)}`);
  const selectedDoc = decodeStoragePath(c.req.path.slice("/docs/".length));
  if (!selectedDoc) return c.html(renderLegacyOrgNotFound(c.req.path), 404);
  const org = selectedDoc.split("/")[0];
  if (!isLegacyStorageKey(org, selectedDoc) || !await legacyRequestMember(c, org)) {
    return c.html(renderLegacyOrgNotFound(c.req.path), 404);
  }
  if (await isDeleted(selectedDoc) || !(await headObject(selectedDoc))) {
    return c.html(renderNotFoundPage({
      path: c.req.path,
      homeHref: `/docs/${encodeURIComponent(org)}`,
      homeLabel: "Open docs tree",
      message: "That document is not in the current docs tree. It may have moved, been deleted, or never existed.",
    }), 404);
  }
  return c.html(renderOrgDocs(user, org, selectedDoc));
});

app.post("/api/orgs", retiredLegacy);

// ----- HTML renderers -----


// Legacy docs remain readable during migration; new organizations use v2 onboarding.
function renderLegacyOrgNotFound(path: string): string {
  return renderNotFoundPage({
    path,
    homeHref: "/organizations?choose=1",
    homeLabel: "Manage organizations",
  });
}


export interface PublicShellPublication {
  orgSlug: string;
  slug: string;
  title: string;
  entryFile: string;
}

interface OrgTreePageOptions {
  publication?: PublicShellPublication;
  documentBase?: string;
  displayName?: string;
  backHref?: string;
  backLabel?: string;
  legacyCommentConfig?: { orgSlug: string; convexUrl: string };
  publicDocument?: boolean;
  shareConfig?: {
    organizationId: string;
    projectId: string;
    convexUrl?: string;
  };
}

export interface ScopedDocumentShellOptions {
  user: User | null;
  namespace: string;
  title: string;
  basePath: string;
  selectedPath: string;
  backHref?: string;
  backLabel?: string;
  publicDocument?: boolean;
  shareConfig?: {
    organizationId: string;
    projectId: string;
    convexUrl?: string;
  };
}

function renderOrgDocs(user: User, org: string, selectedDoc = ""): string {
  logOrgAccess(org, user.email, "view");
  return renderOrgTreePage(user, org, selectedDoc, { legacyCommentConfig: { orgSlug: org, convexUrl: CONVEX_URL } })
    .replace("</body>", viewerUpdateNotice() + viewerScript("parent", { base: `/legacy-view/${encodeURIComponent(org)}` }) + "</body>");
}

export function renderPublicOrgDocs(publication: PublicShellPublication, selectedPath: string): string {
  const selectedDoc = `${publication.orgSlug}/${selectedPath}`;
  return renderOrgTreePage(null, publication.orgSlug, selectedDoc, { publication });
}

export function renderScopedDocumentShell(options: ScopedDocumentShellOptions): string {
  const selectedDoc = options.selectedPath ? `${options.namespace}/${options.selectedPath}` : "";
  return renderOrgTreePage(options.user, options.namespace, selectedDoc, {
    documentBase: options.basePath,
    displayName: options.title,
    backHref: options.backHref,
    backLabel: options.backLabel,
    publicDocument: options.publicDocument,
    shareConfig: options.shareConfig,
  });
}

function renderOrgTreePage(user: User | null, org: string, selectedDoc = "", options: OrgTreePageOptions = {}): string {
  const publication = options.publication;
  const isPublicDocument = Boolean(publication || options.publicDocument);
  const documentBase = options.documentBase ?? (publication
    ? `/public/${encodeURIComponent(publication.orgSlug)}/${encodeURIComponent(publication.slug)}`
    : "");
  const displayName = options.displayName ?? publication?.title ?? org;
  const email = user ? escapeHtml(user.email) : "Public documentation";
  const orgEsc = escapeHtml(org);
  const displayNameEsc = escapeHtml(displayName);
  // Match the management shell's account avatar: first character of the
  // display name (or email), so one account reads the same everywhere.
  const initials = user ? escapeHtml((user.name || user.email).trim().charAt(0).toUpperCase() || "R") : "";
  const shareLabel = isPublicDocument ? "Copy public URL" : options.shareConfig ? "Share document" : "Copy signed URL";
  const sharePendingLabel = isPublicDocument ? "Copying public URL…" : options.shareConfig ? "Creating share…" : "Creating signed URL…";
  const shareDoneLabel = isPublicDocument ? "Public URL copied!" : options.shareConfig ? "Share link copied!" : "Signed URL copied!";
  const sandboxAttribute = ' sandbox="allow-scripts allow-forms allow-popups allow-downloads"';
  const backMarkup = options.backHref
    ? `<a class="topbar-btn topbar-btn-back" href="${escapeHtml(options.backHref)}" aria-label="${escapeHtml(options.backLabel ?? "Back")}"><span class="material-symbols-outlined" aria-hidden="true">arrow_back</span><span class="topbar-back-label">${escapeHtml(options.backLabel ?? "Back")}</span></a>`
    : "";
  const avatarMarkup = user
    ? `<div class="avatar-wrap">
      <button class="topbar-avatar" id="avatar-btn" type="button" title="${escapeHtml(email)}" aria-label="Open account menu" aria-expanded="false">${initials}</button>
      <div class="avatar-menu" id="avatar-menu" hidden>
        <div class="avatar-menu-email">${escapeHtml(email)}</div>
        <a href="/account/security" class="avatar-menu-item"><span class="material-symbols-outlined" aria-hidden="true">shield</span> Account security</a>
        <form method="post" action="/api/auth/sign-out"><button type="submit" class="avatar-menu-item"><span class="material-symbols-outlined" aria-hidden="true">logout</span> Sign out</button></form>
      </div>
    </div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>${renderFaviconLinks()}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${displayNameEsc} — Rendro</title>
${renderFontHead({ icons: true, weights: [400, 600, 700] })}
${renderThemeAssets()}
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<script${nonceAttribute()}>
tailwind.config={darkMode:"class",theme:{extend:{colors:{"outline-variant":"#e4e4e7","background":"#ffffff","surface-container-high":"#f4f4f5","on-secondary-fixed":"#09090b","on-surface-variant":"#71717a","primary":"#c2410c","primary-fixed-dim":"#fed7aa","surface":"#ffffff","surface-container-low":"#fafafa","secondary-container":"#ffedd5","on-secondary-container":"#09090b","on-surface":"#09090b","outline":"#71717a","on-primary":"#ffffff","surface-container":"#f4f4f5"},fontFamily:{"body-md":["Inter"]},fontSize:{"body-md":["14px",{lineHeight:"20px",fontWeight:"400"}],"headline-sm":["20px",{lineHeight:"28px",fontWeight:"600"}],"headline-md":["24px",{lineHeight:"32px",fontWeight:"600"}]}}}}
</script>
<style${nonceAttribute()}>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--sidebar-expanded-width:280px;--sidebar-width:var(--sidebar-expanded-width);--tree-row-height:33px;--viewer-focus:#c2410c}
  body{display:flow-root;font-family:Inter,system-ui,sans-serif;background:#fff;color:#09090b;overflow:hidden;height:100vh;font-size:14px;line-height:20px}
  .material-symbols-outlined{font-variation-settings:'FILL'0,'wght'400,'GRAD'0,'opsz'24;vertical-align:middle;font-size:20px}
  ::-webkit-scrollbar{width:6px} ::-webkit-scrollbar-track{background:transparent} ::-webkit-scrollbar-thumb{background:#e4e4e7;border-radius:10px}

  .topbar-btn.topbar-btn-back{color:#52525b;background:transparent;border:1px solid #e4e4e7;text-decoration:none}
  .topbar-btn-back:hover{background:#f4f4f5;color:#09090b;border-color:#d4d4d8}
  .topbar-btn-icon.mobile-tree-toggle{display:none}
  .mobile-tree-backdrop{display:none}
  .topbar{position:fixed;top:0;z-index:50;width:100%;height:56px;background:#fff;border-bottom:1px solid #e4e4e7;display:flex;align-items:center;justify-content:space-between;padding:0 24px;transition:transform .3s cubic-bezier(.4,0,.2,1),opacity .2s cubic-bezier(.4,0,.2,1);will-change:transform,opacity}
  .topbar-left{display:flex;align-items:center;gap:10px;min-width:0;flex:1;margin-right:16px}
  .topbar-logo{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:24px;font-weight:700;color:#c2410c;line-height:32px}
  .topbar-left>.topbar-btn-back{flex-shrink:0}
  .topbar-search{display:flex;align-items:center;gap:8px;background:#f4f4f5;padding:6px 12px;border-radius:4px;border:1px solid #e4e4e7;width:256px;transition:border-color .15s}
  .topbar-search:focus-within{border-color:#c2410c}
  .topbar-search input{border:0;outline:0;background:transparent;font-size:14px;color:#09090b;width:100%;font-family:Inter}
  .topbar-search input::placeholder{color:#71717a}
  .topbar-actions{display:flex;align-items:center;gap:16px;flex:none}
  .mobile-more{display:none;position:relative}
  .mobile-more-menu{position:absolute;top:48px;right:0;width:min(280px,calc(100vw - 20px));max-height:calc(100vh - 68px);overflow:auto;background:#fff;border:1px solid #e4e4e7;border-radius:10px;box-shadow:0 12px 32px rgba(24,24,27,.18);padding:6px;z-index:120}
  .mobile-more-menu[hidden]{display:none}
  .mobile-action-label{display:none}
  .topbar-btn{min-height:36px;padding:6px 12px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;border:0;font-family:Inter;display:flex;align-items:center;gap:6px;transition:background-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1)}
  .topbar-btn:focus-visible,.avatar-menu-item:focus-visible,.load-more-btn:focus-visible{outline:2px solid var(--viewer-focus);outline-offset:2px}
  .topbar-btn-back:active,.avatar-menu-item:active{transform:scale(.98)}
  .topbar-btn-share{color:#52525b;background:transparent;border:1px solid #e4e4e7;min-width:172px;justify-content:center;overflow:hidden}
  .topbar-btn-share:hover:not(:disabled){background:#f4f4f5;color:#09090b;border-color:#d4d4d8}
  .topbar-btn-share:active:not(:disabled){transform:scale(.98);background:#e4e4e7}
  .topbar-btn-share:focus-visible{outline:2px solid #c2410c;outline-offset:2px}
  .share-icon-window{width:18px;height:18px;line-height:18px;overflow:hidden;display:inline-flex;align-items:flex-start;justify-content:center;flex:0 0 18px}
  .share-icon-track{display:flex;flex-direction:column;align-items:center;transition:transform .3s cubic-bezier(.4,0,.2,1);will-change:transform}
  .share-icon-row{width:18px;height:18px;line-height:18px;display:flex;align-items:center;justify-content:center;flex:0 0 18px;font-size:18px}
  .share-loader{width:14px;height:14px;box-sizing:border-box;border:2px solid currentColor;border-right-color:transparent;border-radius:999px}
  @keyframes shareLoaderSpin{to{transform:rotate(360deg)}}
  .share-label-window{width:136px;height:16px;line-height:16px;overflow:hidden;display:inline-flex;align-items:flex-start;justify-content:center;flex:0 0 136px}
  .share-label-track{width:100%;display:flex;flex-direction:column;align-items:center;transition:transform .3s cubic-bezier(.4,0,.2,1);will-change:transform}
  .share-label{height:16px;white-space:nowrap}
  .topbar-btn-share.is-feedback{background:#f4f4f5;color:#09090b;border-color:#d4d4d8}
  .topbar-btn-share.is-loading .share-label-track{transform:translateY(-16px)}
  .topbar-btn-share.is-feedback .share-label-track{transform:translateY(-32px)}
  .topbar-btn-share.is-loading .share-icon-track{transform:translateY(-18px)}
  .topbar-btn-share.is-loading .share-loader{animation:shareLoaderSpin .8s linear infinite}
  .topbar-btn-share.is-feedback .share-icon-track{transform:translateY(-36px)}
  .share-error{position:fixed;z-index:150;top:64px;right:16px;width:360px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:16px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;color:#09090b;box-shadow:0 4px 16px rgba(0,0,0,.12);font-size:14px;line-height:20px}
  .share-error[hidden],.share-error [hidden]{display:none}
  .share-error-actions{display:flex;gap:8px;margin-top:12px}
  .share-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
  .share-error button:disabled{opacity:.5;cursor:not-allowed}
  .dark .share-error{background:#09090b;color:#fafafa;border-color:#27272a}
  #share-feedback-icon{transition:transform .18s cubic-bezier(.4,0,.2,1)}
  .topbar-btn-share.is-feedback #share-feedback-icon{transform:scale(1.08)}
  .shortcut-tooltip-wrap{position:relative;display:inline-flex}
  .shortcut-tooltip{position:absolute;top:40px;right:0;display:flex;align-items:center;gap:12px;pointer-events:none;opacity:0;transform:translateY(-4px) scale(.98);transition:opacity 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1);z-index:120;background:#09090b;color:#fafafa;border-radius:8px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:16px;white-space:nowrap}
  .shortcut-tooltip-label{font-weight:600}
  .shortcut-keys{display:inline-flex;align-items:center;gap:4px;color:#d4d4d8}
  .shortcut-key{min-width:18px;height:18px;padding:0 5px;border-radius:4px;background:#27272a;color:#fafafa;display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:18px;font-weight:600;box-shadow:inset 0 -1px 0 rgba(255,255,255,.14)}
  .shortcut-tooltip-wrap:hover .shortcut-tooltip,.shortcut-tooltip-wrap:focus-within .shortcut-tooltip{opacity:1;transform:translateY(0) scale(1)}
  html.dark .shortcut-tooltip{background:#fafafa;color:#09090b;box-shadow:0 8px 24px rgba(0,0,0,.34)}
  html.dark .shortcut-keys{color:#52525b}
  html.dark .shortcut-key{background:#e4e4e7;color:#09090b;box-shadow:inset 0 -1px 0 rgba(9,9,11,.12)}
  .topbar-btn-create{background:#c2410c;color:#fff}
  .topbar-btn-create:hover{background:#9a3412;opacity:1}
  .topbar-avatar{width:36px;height:36px;flex:none;border-radius:50%;background:#ffedd5;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#c2410c;cursor:pointer;border:1px solid rgba(194,65,12,.24);transition:background-color 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1)}
  .topbar-avatar:hover:not(:disabled){background:#f4f4f5;color:#09090b;border-color:#d4d4d8}
  .topbar-avatar:active:not(:disabled){transform:scale(.98)}

  .sidebar{position:fixed;top:56px;left:0;bottom:0;z-index:40;width:var(--sidebar-width);background:#fff;border-right:1px solid #e4e4e7;display:flex;flex-direction:column;overflow:hidden;padding:16px 0;transition:top .3s cubic-bezier(.4,0,.2,1),width .3s cubic-bezier(.4,0,.2,1),opacity .2s cubic-bezier(.4,0,.2,1),transform .3s cubic-bezier(.4,0,.2,1);will-change:top,width,transform,opacity}
  .sidebar-org{padding:0 24px;margin-bottom:16px}
  .sidebar-org-row{display:flex;align-items:center;gap:12px;cursor:pointer}
  .sidebar-org-icon{width:32px;height:32px;border-radius:4px;background:#c2410c;display:flex;align-items:center;justify-content:center}
  .sidebar-org-icon .material-symbols-outlined{color:#fff;font-size:18px}
  .sidebar-org-name{font-size:20px;font-weight:600;line-height:28px;color:#09090b}
  .sidebar-org-meta{font-size:12px;font-weight:600;color:#71717a;letter-spacing:.05em;line-height:16px}
  .sidebar-divider{padding:8px 12px;font-size:10px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:.05em}
  .sidebar-footer{padding:12px 16px;border-top:1px solid #e4e4e7;margin-top:auto}
  .sidebar-tree{flex:1;padding:0 12px;overflow-y:auto;--sidebar-bg:#fff;scrollbar-width:thin;scrollbar-color:rgba(161,161,170,.35) transparent}
  .sidebar-tree::-webkit-scrollbar{width:1.5px}
  .sidebar-tree::-webkit-scrollbar-track{background:transparent}
  .sidebar-tree::-webkit-scrollbar-thumb{background:rgba(161,161,170,.35);border-radius:999px}
  .sidebar-tree::-webkit-scrollbar-thumb:hover{background:rgba(113,113,122,.55)}
  .sidebar-footer a:hover{color:#09090b}
  .sidebar-resizer{--resizer-origin-y:50%;--resizer-spark-a:#facc15;--resizer-spark-b:#fb923c;position:fixed;top:56px;bottom:0;left:calc(var(--sidebar-width) - 5px);width:10px;z-index:45;cursor:col-resize;touch-action:none;display:flex;align-items:stretch;justify-content:center;overflow:visible;transition:top .3s cubic-bezier(.4,0,.2,1),left .3s cubic-bezier(.4,0,.2,1),opacity .2s cubic-bezier(.4,0,.2,1),transform .3s cubic-bezier(.4,0,.2,1)}
  .sidebar-resizer::before{content:"";width:2px;height:100%;background:#c2410c;border-radius:999px;opacity:0;transform:scaleY(0);transform-origin:center var(--resizer-origin-y);transition:transform .5s cubic-bezier(.4,0,.2,1),opacity .18s cubic-bezier(.4,0,.2,1),box-shadow .18s cubic-bezier(.4,0,.2,1),width .18s cubic-bezier(.4,0,.2,1)}
  .resizer-sparks{position:absolute;left:50%;width:3px;height:3px;border-radius:999px;pointer-events:none;opacity:0;background:var(--resizer-spark-a);transform:translateX(-50%);filter:drop-shadow(0 0 5px rgba(249,115,22,.75));box-shadow:0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0)}
  .resizer-sparks-top{top:0;transform:translate(-50%,-50%)}
  .resizer-sparks-bottom{bottom:0;transform:translate(-50%,50%)}
  .sidebar-resizer:hover::before,.sidebar-resizer:focus-visible::before,html.sidebar-resizing .sidebar-resizer::before{width:3px;opacity:1;transform:scaleY(1);box-shadow:0 0 0 3px rgba(194,65,12,.12)}
  @keyframes resizerImpactTop{0%{opacity:0;box-shadow:0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0)}18%{opacity:1;box-shadow:-4px 3px 0 0 var(--resizer-spark-a),5px 4px 0 0 var(--resizer-spark-b),-2px 7px 0 0 var(--resizer-spark-b),3px 9px 0 0 var(--resizer-spark-a),-6px 1px 0 0 var(--resizer-spark-a),7px 2px 0 0 var(--resizer-spark-b)}100%{opacity:0;box-shadow:-24px 22px 0 0 rgba(250,204,21,0),26px 24px 0 0 rgba(251,146,60,0),-14px 42px 0 0 rgba(251,146,60,0),16px 48px 0 0 rgba(250,204,21,0),-34px 10px 0 0 rgba(250,204,21,0),36px 12px 0 0 rgba(251,146,60,0)}}
  @keyframes resizerImpactBottom{0%{opacity:0;box-shadow:0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0)}18%{opacity:1;box-shadow:-4px -3px 0 0 var(--resizer-spark-a),5px -4px 0 0 var(--resizer-spark-b),-2px -7px 0 0 var(--resizer-spark-b),3px -9px 0 0 var(--resizer-spark-a),-6px -1px 0 0 var(--resizer-spark-a),7px -2px 0 0 var(--resizer-spark-b)}100%{opacity:0;box-shadow:-24px -22px 0 0 rgba(250,204,21,0),26px -24px 0 0 rgba(251,146,60,0),-14px -42px 0 0 rgba(251,146,60,0),16px -48px 0 0 rgba(250,204,21,0),-34px -10px 0 0 rgba(250,204,21,0),36px -12px 0 0 rgba(251,146,60,0)}}
  @keyframes resizerTopTrailLeft{0%{opacity:0;box-shadow:0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0)}12%{opacity:1;box-shadow:-5px 2px 0 0 var(--resizer-spark-a),-7px 5px 0 0 var(--resizer-spark-b),-4px 8px 0 0 var(--resizer-spark-a),-9px 10px 0 0 var(--resizer-spark-b),-3px 13px 0 0 var(--resizer-spark-a),-11px 15px 0 0 var(--resizer-spark-b)}100%{opacity:0;box-shadow:-52px 10px 0 0 rgba(250,204,21,0),-62px 20px 0 0 rgba(251,146,60,0),-42px 32px 0 0 rgba(250,204,21,0),-70px 42px 0 0 rgba(251,146,60,0),-34px 54px 0 0 rgba(250,204,21,0),-76px 64px 0 0 rgba(251,146,60,0)}}
  @keyframes resizerBottomTrailLeft{0%{opacity:0;box-shadow:0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0)}12%{opacity:1;box-shadow:-5px -2px 0 0 var(--resizer-spark-a),-7px -5px 0 0 var(--resizer-spark-b),-4px -8px 0 0 var(--resizer-spark-a),-9px -10px 0 0 var(--resizer-spark-b),-3px -13px 0 0 var(--resizer-spark-a),-11px -15px 0 0 var(--resizer-spark-b)}100%{opacity:0;box-shadow:-52px -10px 0 0 rgba(250,204,21,0),-62px -20px 0 0 rgba(251,146,60,0),-42px -32px 0 0 rgba(250,204,21,0),-70px -42px 0 0 rgba(251,146,60,0),-34px -54px 0 0 rgba(250,204,21,0),-76px -64px 0 0 rgba(251,146,60,0)}}
  @keyframes resizerTopTrailRight{0%{opacity:0;box-shadow:0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0)}12%{opacity:1;box-shadow:5px 2px 0 0 var(--resizer-spark-a),7px 5px 0 0 var(--resizer-spark-b),4px 8px 0 0 var(--resizer-spark-a),9px 10px 0 0 var(--resizer-spark-b),3px 13px 0 0 var(--resizer-spark-a),11px 15px 0 0 var(--resizer-spark-b)}100%{opacity:0;box-shadow:52px 10px 0 0 rgba(250,204,21,0),62px 20px 0 0 rgba(251,146,60,0),42px 32px 0 0 rgba(250,204,21,0),70px 42px 0 0 rgba(251,146,60,0),34px 54px 0 0 rgba(250,204,21,0),76px 64px 0 0 rgba(251,146,60,0)}}
  @keyframes resizerBottomTrailRight{0%{opacity:0;box-shadow:0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0),0 0 0 0 rgba(250,204,21,0),0 0 0 0 rgba(251,146,60,0)}12%{opacity:1;box-shadow:5px -2px 0 0 var(--resizer-spark-a),7px -5px 0 0 var(--resizer-spark-b),4px -8px 0 0 var(--resizer-spark-a),9px -10px 0 0 var(--resizer-spark-b),3px -13px 0 0 var(--resizer-spark-a),11px -15px 0 0 var(--resizer-spark-b)}100%{opacity:0;box-shadow:52px -10px 0 0 rgba(250,204,21,0),62px -20px 0 0 rgba(251,146,60,0),42px -32px 0 0 rgba(250,204,21,0),70px -42px 0 0 rgba(251,146,60,0),34px -54px 0 0 rgba(250,204,21,0),76px -64px 0 0 rgba(251,146,60,0)}}
  .sidebar-resizer.resizer-impact-sparks .resizer-sparks-top{animation:resizerImpactTop .42s cubic-bezier(.4,0,.2,1) .46s 1 both}
  .sidebar-resizer.resizer-impact-sparks .resizer-sparks-bottom{animation:resizerImpactBottom .42s cubic-bezier(.4,0,.2,1) .46s 1 both}
  html.sidebar-resizing-moving.sidebar-resizing-trail-left .sidebar-resizer .resizer-sparks-top{animation:resizerTopTrailLeft .36s cubic-bezier(.2,0,.2,1) infinite}
  html.sidebar-resizing-moving.sidebar-resizing-trail-left .sidebar-resizer .resizer-sparks-bottom{animation:resizerBottomTrailLeft .36s cubic-bezier(.2,0,.2,1) infinite}
  html.sidebar-resizing-moving.sidebar-resizing-trail-right .sidebar-resizer .resizer-sparks-top{animation:resizerTopTrailRight .36s cubic-bezier(.2,0,.2,1) infinite}
  html.sidebar-resizing-moving.sidebar-resizing-trail-right .sidebar-resizer .resizer-sparks-bottom{animation:resizerBottomTrailRight .36s cubic-bezier(.2,0,.2,1) infinite}
  .sidebar-resizer:focus-visible{outline:0}
  html.sidebar-resizing,.sidebar-resizing body{cursor:col-resize;user-select:none}
  html:not(.sidebar-ready) .sidebar,html:not(.sidebar-ready) .main,html:not(.sidebar-ready) .sidebar-resizer{transition:none}
  html.sidebar-resizing .sidebar,html.sidebar-resizing .main,html.sidebar-resizing .sidebar-resizer{transition:none}

  .shell-hotzone{position:fixed;z-index:60;pointer-events:none;background:transparent}
  .shell-hotzone-top{top:0;left:0;right:0;height:12px}
  .shell-hotzone-left{top:0;bottom:0;left:0;width:12px}
  html.shell-hidden .shell-hotzone{pointer-events:auto}
  html.shell-hidden .topbar{transform:translateY(-100%);opacity:0;pointer-events:none}
  html.shell-hidden.shell-header-revealed .topbar{transform:translateY(0);opacity:1;pointer-events:auto}
  html.shell-hidden .sidebar,html.shell-hidden .sidebar-resizer{top:0;transform:translateX(calc((var(--sidebar-width) + 16px) * -1));opacity:0;pointer-events:none}
  html.shell-hidden.shell-sidebar-revealed .sidebar,html.shell-hidden.shell-sidebar-revealed .sidebar-resizer{transform:translateX(0);opacity:1;pointer-events:auto}
  html.shell-hidden .main{margin-left:0;margin-top:0;height:100vh}

  /* The collapse wrapper animates a 0fr→1fr row, so an open folder is exactly as tall as its rows, however many pages are loaded. */
  .tree-folder-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .4s cubic-bezier(.34,1.56,.64,1),opacity .3s ease;opacity:0}
  .tree-folder.open>.tree-folder-collapse{grid-template-rows:1fr;opacity:1}
  .tree-folder-content{min-height:0;overflow:hidden}
  .tree-folder.open>.tree-folder-collapse>.tree-folder-content{overflow:visible}
  /* ── sticky folder headers (VS Code-style stacking) ── */
  .tree-folder.open>.tree-item{position:sticky;background:var(--sidebar-bg,#fff)}
  .tree-folder[data-depth="0"].open>.tree-item{top:0;z-index:10}
  .tree-folder[data-depth="1"].open>.tree-item{top:var(--tree-row-height);z-index:9}
  .tree-folder[data-depth="2"].open>.tree-item{top:calc(var(--tree-row-height) * 2);z-index:8}
  .tree-folder[data-depth="3"].open>.tree-item{top:calc(var(--tree-row-height) * 3);z-index:7}
  .tree-folder[data-depth="4"].open>.tree-item{top:calc(var(--tree-row-height) * 4);z-index:6}
  .tree-folder[data-depth="5"].open>.tree-item{top:calc(var(--tree-row-height) * 5);z-index:5}
  .document-navigation-notice{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:1000;width:max-content;max-width:calc(100vw - 32px);padding:12px 16px;border:1px solid #e4e4e7;border-radius:8px;background:#fff;color:#09090b;box-shadow:0 4px 16px #0002}
  html.dark .document-navigation-notice{background:#09090b;color:#fafafa;border-color:#27272a}
  .load-more-btn{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:6px 10px;border:1px solid #e4e4e7;border-radius:6px;background:transparent;color:#c2410c;font:600 12px/20px Inter,system-ui,sans-serif;text-decoration:none;cursor:pointer;transition:background-color 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1)}
  .load-more-btn:hover:not(:disabled){background:#f4f4f5;border-color:#d4d4d8}
  .load-more-btn:active:not(:disabled){transform:scale(.98)}
  .load-more-btn:disabled{color:#71717a;cursor:not-allowed;opacity:.5}
  @keyframes treeItemIn{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
  @keyframes treeFolderLoading{0%{background-position:-200% 50%}100%{background-position:200% 50%}}
  .tree-item{position:relative;display:flex;align-items:center;gap:8px;min-height:var(--tree-row-height);padding:6px 12px;border-radius:4px;color:#71717a;cursor:pointer;overflow:hidden;transition:translate .15s cubic-bezier(.4,0,.2,1),background-color .2s,color .2s}
  .tree-item:focus-visible,.tree-item:has(.tree-link:focus-visible){outline:2px solid var(--viewer-focus);outline-offset:-2px}
  .tree-link:focus-visible{outline:none}
  .tree-item>*{position:relative;z-index:1}
  .tree-item.tree-item-entering{animation:treeItemIn .32s cubic-bezier(.4,0,.2,1) both;animation-delay:calc(var(--tree-index,0) * 35ms)}
  .tree-folder.loading>.tree-item{cursor:progress}
  .tree-folder.loading>.tree-item .folder-icon,.tree-folder.loading>.tree-item .font-body-md{color:transparent;background:linear-gradient(90deg,#7c2d12 0%,#f97316 32%,#9a3412 55%,#fb923c 76%,#7c2d12 100%);background-size:200% 100%;background-clip:text;-webkit-background-clip:text;-webkit-text-fill-color:transparent;animation:treeFolderLoading 1.1s cubic-bezier(.4,0,.2,1) infinite}
  .tree-item:hover{background:#f4f4f5;color:#09090b}
  .tree-item.active{background:#ffedd5;color:#c2410c}
  .tree-item[data-path]>.material-symbols-outlined{transition:transform .15s cubic-bezier(.4,0,.2,1),color .15s}
  .tree-item[data-path]:hover,.tree-item[data-path]:focus-within{translate:0 -1px}
  .tree-item[data-path]:hover>.material-symbols-outlined,.tree-item[data-path]:focus-within>.material-symbols-outlined{color:#c2410c;transform:translateX(2px) scale(1.06)}
  .tree-link{color:inherit;text-decoration:none}
  .tree-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tree-size{color:#71717a;font-size:11px;flex-shrink:0}
  .tree-empty{color:#71717a;padding:6px 12px;font-size:12px}
  .tree-empty-create{padding:0 12px 8px}
  .tree-error{color:#b42318;padding:4px 8px;font-size:11px}
  .caret-icon{transition:transform .3s cubic-bezier(.4,0,.2,1),translate .15s cubic-bezier(.4,0,.2,1),color .15s}
  .tree-folder.open>.tree-item .caret-icon{transform:rotate(90deg)}
  .tree-folder>.tree-item .folder-icon{transition:color .15s}
  .tree-folder>.tree-item:hover .caret-icon,.tree-folder>.tree-item:focus-within .caret-icon{color:#c2410c;translate:2px 0}
  .tree-folder>.tree-item:hover .folder-icon,.tree-folder>.tree-item:focus-within .folder-icon{color:#c2410c}
  .active-indicator{position:absolute;left:0;width:4px;height:32px;background:#c2410c;transition:transform .3s cubic-bezier(.4,0,.2,1),opacity .2s ease;border-radius:4px;pointer-events:none;z-index:1}
  @keyframes docRowShimmer{0%{background-position:180% 0}100%{background-position:-180% 0}}
  @keyframes docPillRecoil{0%,100%{transform:translateX(0) scale(1)}7%{transform:translateX(-4px) scaleX(.982)}17%{transform:translateX(2px) scaleX(1.006)}34%{transform:translateX(0) scale(1)}}
  html.doc-loading .tree-item.active{animation:docPillRecoil 1.1s cubic-bezier(.4,0,.2,1) infinite;transform-origin:left center;will-change:transform}
  html.doc-loading .tree-item.active::before{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(90deg,rgba(194,65,12,0) 0%,rgba(254,215,170,.72) 42%,rgba(251,146,60,.28) 56%,rgba(255,237,213,.5) 72%,rgba(194,65,12,0) 100%);background-size:220% 100%;animation:docRowShimmer 1.1s cubic-bezier(.4,0,.2,1) infinite;z-index:0}
  html.doc-loading-error .tree-item.active::before{content:"";position:absolute;inset:0;border-radius:inherit;background:rgba(180,35,24,.1);z-index:0}

  @keyframes treeSkeletonShimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
  .tree-skeleton{padding:0}
  .tree-skeleton-node{margin-top:2px}
  .tree-skeleton-node:first-child{margin-top:0}
  .tree-skeleton-item{height:33px;display:flex;align-items:center;gap:8px;padding:6px 12px;border-radius:4px;box-sizing:border-box}
  .tree-skeleton-icon,.tree-skeleton-label{display:block;flex-shrink:0;background:linear-gradient(90deg,#f4f4f5 25%,#ffedd5 45%,#f4f4f5 65%);background-size:200% 100%;animation:treeSkeletonShimmer 1.1s cubic-bezier(.4,0,.2,1) infinite}
  .tree-skeleton-icon{width:18px;height:18px;border-radius:4px}
  .tree-skeleton-caret{width:18px;height:18px;clip-path:polygon(35% 20%,75% 50%,35% 80%)}
  .tree-skeleton-label{height:12px;border-radius:999px;min-width:0}
  .tree-skeleton-label.w-sm{width:42%}
  .tree-skeleton-label.w-md{width:58%}
  .tree-skeleton-label.w-lg{width:72%}
  .tree-skeleton-item:nth-child(2n) .tree-skeleton-icon,.tree-skeleton-item:nth-child(2n) .tree-skeleton-label{animation-delay:.08s}
  .tree-skeleton-node:nth-child(2) .tree-skeleton-icon,.tree-skeleton-node:nth-child(2) .tree-skeleton-label{animation-delay:.16s}
  .main{margin-left:var(--sidebar-width);margin-top:56px;height:calc(100vh - 56px);overflow:hidden;background:#fafafa;position:relative;transition:margin-left .3s cubic-bezier(.4,0,.2,1),margin-top .3s cubic-bezier(.4,0,.2,1),height .3s cubic-bezier(.4,0,.2,1);will-change:margin-left,margin-top,height}
  .main-placeholder{display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;text-align:center;padding:3rem}
  .main-placeholder h2{font-size:24px;font-weight:600;color:#09090b;margin-bottom:8px}
  .main-placeholder p{font-size:16px;color:#71717a;max-width:320px}
  .ph-icon{width:64px;height:64px;border-radius:50%;background:#f4f4f5;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px}
  .content-frame{display:block;width:100%;height:100%;border:0;background:#fff}
  @media (prefers-reduced-motion: reduce){.tree-skeleton-icon,.tree-skeleton-label{animation:none;background:#f4f4f5}}
  @media (prefers-reduced-motion: reduce){.topbar,.sidebar,.main,.sidebar-resizer,.share-label-track,.shortcut-tooltip,.sidebar-resizer::before{transition:none}.sidebar-resizer::before{transform:scaleY(1)}.resizer-sparks{display:none}}
  @media (prefers-reduced-motion: reduce){.share-icon-track{transition:none}.share-loader{animation:none!important}}
  @media (prefers-reduced-motion: reduce){.tree-folder-collapse,.active-indicator{transition:none!important}}
  .avatar-wrap{position:relative}
  @keyframes viewerMenuIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .avatar-menu{position:absolute;top:44px;right:0;background:#fff;border:1px solid #e4e4e7;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.12);padding:4px;width:230px;max-width:calc(100vw - 20px);z-index:100}
  .avatar-menu:not([hidden]),.mobile-more-menu:not([hidden]){animation:viewerMenuIn 200ms cubic-bezier(.4,0,.2,1)}
  .avatar-menu-email{padding:8px 12px;font-size:12px;color:#71717a;border-bottom:1px solid #e4e4e7;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .avatar-menu-item{display:flex;align-items:center;gap:8px;padding:9px 10px;font-size:14px;line-height:20px;color:#09090b;text-decoration:none;border-radius:4px;cursor:pointer;border:0;background:transparent;width:100%;font-family:Inter;transition:background-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1)}
  .avatar-menu-item:hover{background:#f4f4f5}
  .avatar-menu-item:active{background:#f4f4f5}

  .topbar-btn-icon{width:36px;height:36px;flex:none;border-radius:6px;border:0;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#71717a;transition:background-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1)}
  .topbar-btn-icon:hover:not(:disabled){background:#f4f4f5;color:#09090b}
  .topbar-btn-icon:active:not(:disabled){transform:scale(.98)}
  .topbar-btn:disabled,.topbar-btn-icon:disabled,.topbar-avatar:disabled{opacity:.5;cursor:not-allowed;transform:none}
  .topbar-btn-icon:focus-visible,.topbar-avatar:focus-visible{outline:2px solid #c2410c;outline-offset:2px}
  .topbar-avatar:focus-visible{border-color:#d4d4d8}
  @media(prefers-reduced-motion:reduce){.topbar-btn-icon,.topbar-avatar{transition:none}.topbar-btn-icon:active,.topbar-avatar:active{transform:none!important}}
  @media(prefers-reduced-motion:reduce){.topbar-btn,.avatar-menu-item,.load-more-btn{transition:none}.topbar-btn:active,.avatar-menu-item:active,.load-more-btn:active{transform:none!important}.avatar-menu,.mobile-more-menu{animation:none!important}.topbar-btn-share.is-feedback #share-feedback-icon{transform:none}#share-feedback-icon,.mobile-tree-backdrop{transition:none!important}}
  @media (prefers-reduced-motion: reduce){.tree-item.tree-item-entering{animation:none!important;animation-delay:0s!important;opacity:1!important;transform:none!important}.tree-folder.loading>.tree-item .folder-icon,.tree-folder.loading>.tree-item .font-body-md{animation:none!important;background:none!important;color:#c2410c!important;-webkit-text-fill-color:currentColor!important}html.doc-loading .tree-item.active{animation:none!important;transform:none!important}html.doc-loading .tree-item.active::before{animation:none!important}html.dark .tree-folder.loading>.tree-item .folder-icon,html.dark .tree-folder.loading>.tree-item .font-body-md{color:#fb923c!important}}
  @media (prefers-reduced-motion: reduce){.tree-item[data-path],.tree-item[data-path]>.material-symbols-outlined{transition-property:background-color,color!important}.tree-item[data-path]:hover,.tree-item[data-path]:focus-within{translate:none!important}.tree-item[data-path]:hover>.material-symbols-outlined,.tree-item[data-path]:focus-within>.material-symbols-outlined{transform:none!important}}
  @media (prefers-reduced-motion: reduce){.tree-folder>.tree-item .caret-icon,.tree-folder>.tree-item .folder-icon{transition-property:color!important}.tree-folder>.tree-item:hover .caret-icon,.tree-folder>.tree-item:focus-within .caret-icon{translate:none!important}}

  /* ── dark mode (shadcn-style neutral palette) ── */
  html.dark{--viewer-focus:#fb923c;background:#09090b;color:#fafafa}
  html.dark body{background:#09090b;color:#fafafa}
  html.dark ::-webkit-scrollbar-thumb{background:#27272a}
  html.dark .topbar{background:#09090b;border-bottom-color:#27272a}
  html.dark .topbar-logo{color:#fb923c}
  html.dark .topbar-search{background:#18181b;border-color:#27272a}
  html.dark .topbar-search:focus-within{border-color:#fb923c}
  html.dark .topbar-search input{color:#fafafa}
  html.dark .topbar-search input::placeholder{color:#a1a1aa}
  html.dark .sidebar-resizer{--resizer-spark-a:#fed7aa;--resizer-spark-b:#fb923c}
  html.dark .sidebar-resizer::before{background:#fb923c}
  html.dark .sidebar-resizer:hover::before,html.dark .sidebar-resizer:focus-visible::before,html.dark.sidebar-resizing .sidebar-resizer::before{box-shadow:0 0 0 3px rgba(251,146,60,.16)}
  html.dark .topbar-btn-icon{color:#a1a1aa}
  html.dark .topbar-btn-share{color:#a1a1aa;border-color:#27272a}
  html.dark .topbar-btn-share:hover:not(:disabled){background:#18181b;color:#fafafa;border-color:#3f3f46}
  html.dark .topbar-btn-share:active:not(:disabled),html.dark .topbar-btn-share.is-feedback{background:#18181b;color:#fafafa;border-color:#3f3f46}
  html.dark .topbar-btn-share:focus-visible,html.dark .topbar-btn-icon:focus-visible,html.dark .topbar-avatar:focus-visible{outline-color:#fb923c}
  html.dark .topbar-avatar:focus-visible{border-color:#3f3f46}
  html.dark .topbar-btn-icon:hover:not(:disabled){background:#18181b;color:#fafafa}
  html.dark .topbar-btn-create{background:#fb923c;color:#09090b}
  html.dark .topbar-btn-create:hover{background:#fdba74;opacity:1}
  html.dark .sidebar-tree{--sidebar-bg:#09090b;scrollbar-color:#3f3f46 transparent}
  html.dark .sidebar-tree::-webkit-scrollbar-thumb{background:#3f3f46}
  html.dark .sidebar-tree::-webkit-scrollbar-thumb:hover{background:#52525b}
  html.dark .topbar-avatar{background:rgba(251,146,60,.16);color:#fb923c;border-color:rgba(251,146,60,.35)}
  html.dark .topbar-avatar:hover:not(:disabled){background:#18181b;color:#fafafa;border-color:#3f3f46}
  html.dark .sidebar{background:#09090b;border-right-color:#27272a}
  html.dark .sidebar-org-name{color:#fafafa}
  html.dark .sidebar-org-meta{color:#a1a1aa}
  html.dark .sidebar-org-icon{background:#fb923c}
  html.dark .sidebar-org-icon .material-symbols-outlined{color:#18181b}
  html.dark .sidebar-divider{color:#a1a1aa}
  html.dark .sidebar-footer{border-top-color:#27272a}
  html.dark .sidebar-footer a{color:#a1a1aa}
  html.dark .sidebar-footer a:hover{color:#fafafa}
  html.dark .tree-item{color:#a1a1aa}
  html.dark .tree-item:hover{background:#18181b;color:#fafafa}
  html.dark .tree-item[data-path]:hover>.material-symbols-outlined,html.dark .tree-item[data-path]:focus-within>.material-symbols-outlined{color:#fb923c}
  html.dark .tree-folder>.tree-item:hover .caret-icon,html.dark .tree-folder>.tree-item:focus-within .caret-icon,html.dark .tree-folder>.tree-item:hover .folder-icon,html.dark .tree-folder>.tree-item:focus-within .folder-icon{color:#fb923c}
  html.dark .tree-item.active{background:rgba(251,146,60,.16);color:#fb923c}
  html.dark.doc-loading .tree-item.active::before{background:linear-gradient(90deg,rgba(251,146,60,0) 0%,rgba(251,146,60,.18) 38%,rgba(253,186,116,.32) 56%,rgba(251,146,60,.14) 72%,rgba(251,146,60,0) 100%);background-size:220% 100%}
  html.dark.doc-loading-error .tree-item.active::before{background:rgba(252,165,165,.14)}
  html.dark .tree-folder.loading>.tree-item .folder-icon,html.dark .tree-folder.loading>.tree-item .font-body-md{background:linear-gradient(90deg,#fb923c 0%,#ffedd5 32%,#f97316 55%,#fed7aa 76%,#fb923c 100%);background-size:200% 100%;background-clip:text;-webkit-background-clip:text}
  html.dark .active-indicator{background:#fb923c}
  html.dark .tree-size{color:#a1a1aa}
  html.dark .tree-empty{color:#a1a1aa}
  html.dark .tree-skeleton-icon,html.dark .tree-skeleton-label{background:linear-gradient(90deg,#18181b 25%,rgba(251,146,60,.16) 45%,#18181b 65%);background-size:200% 100%}
  @media (prefers-reduced-motion: reduce){html.dark .tree-skeleton-icon,html.dark .tree-skeleton-label{background:#18181b}}
  html.dark .tree-error{color:#fca5a5}
  html.dark .main{background:#09090b}
  html.dark .main-placeholder h2{color:#fafafa}
  html.dark .main-placeholder p{color:#a1a1aa}
  html.dark .ph-icon{background:#18181b}
  html.dark .ph-icon .material-symbols-outlined{color:#a1a1aa!important}
  html.dark .avatar-menu-item{color:#fafafa}
  html.dark .avatar-menu-item:hover{background:#18181b}
  html.dark .avatar-menu-item:active{background:#18181b}
  html.dark .load-more-btn{color:#fb923c;border-color:#27272a}
  html.dark .load-more-btn:hover:not(:disabled){background:#18181b;border-color:#3f3f46}
  html.dark .load-more-btn:disabled{color:#a1a1aa}
  html.dark .avatar-menu{background:#09090b;border-color:#27272a;box-shadow:0 8px 24px rgba(0,0,0,.48)}
  html.dark .avatar-menu-email{color:#a1a1aa;border-bottom-color:#27272a}
  html.dark .avatar-menu-item{color:#fafafa}
  html.dark .avatar-menu-item:hover{background:#18181b}
  html.dark .topbar-btn.topbar-btn-back{color:#a1a1aa;border-color:#27272a}
  html.dark .topbar-btn-back:hover{background:#18181b;color:#fafafa;border-color:#3f3f46}
  html.dark .mobile-more-menu{background:#09090b;border-color:#27272a;box-shadow:0 16px 40px rgba(0,0,0,.5)}
  @media(max-width:760px){
    :root{--tree-row-height:44px}
    .tree-item{min-height:44px}
    .tree-item .tree-link{min-height:32px;line-height:32px}
    .avatar-menu-item,.load-more-btn{min-height:44px}
    .sidebar-tree{scrollbar-width:none}
    .sidebar-tree::-webkit-scrollbar{display:none}
    .topbar{padding:0 10px}
    .topbar-left{min-width:0;gap:6px;flex:1;margin-right:6px}
    .topbar-logo{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px}
    .topbar-actions{gap:4px}
    .mobile-more{display:block}
    .mobile-more-menu .topbar-btn-back,.mobile-more-menu .shortcut-tooltip-wrap,.mobile-more-menu .avatar-wrap{display:flex;width:100%}
    .mobile-more-menu .topbar-btn-back,.mobile-more-menu #shell-toggle,.mobile-more-menu #avatar-btn{height:44px;width:100%;padding:0 12px;border:0;border-radius:6px;justify-content:flex-start;gap:10px;background:transparent;color:#52525b;font-size:14px;font-weight:600;text-decoration:none}
    .mobile-more-menu .topbar-btn-back:hover,.mobile-more-menu #shell-toggle:hover:not(:disabled),.mobile-more-menu #avatar-btn:hover:not(:disabled){background:#f4f4f5;color:#09090b}
    .mobile-more-menu .topbar-btn-back .topbar-back-label{display:inline}
    .mobile-more-menu .mobile-action-label{display:inline}
    .mobile-more-menu #avatar-btn::after{content:"Account"}
    .mobile-more-menu #avatar-btn{border-radius:6px}
    .mobile-more-menu .shortcut-tooltip{display:none}
    .mobile-more-menu .avatar-wrap{display:block}
    .mobile-more-menu .avatar-menu{position:static;width:100%;min-width:0;margin-top:2px;box-shadow:none;border-radius:6px}
    html.dark .mobile-more-menu .topbar-btn-back,html.dark .mobile-more-menu #shell-toggle,html.dark .mobile-more-menu #avatar-btn{color:#d4d4d8}
    html.dark .mobile-more-menu .topbar-btn-back:hover,html.dark .mobile-more-menu #shell-toggle:hover:not(:disabled),html.dark .mobile-more-menu #avatar-btn:hover:not(:disabled){background:#18181b;color:#fafafa}
    .topbar-btn-icon.mobile-tree-toggle{width:44px;height:44px;display:flex;flex:0 0 44px}
    .topbar-btn-back{width:44px;height:44px;flex:0 0 44px;padding:0;justify-content:center}
    .topbar-btn-back .topbar-back-label{display:none}
    .topbar-btn-share{width:44px;min-width:44px;height:44px;padding:0}
    .topbar-btn-share .share-label-window{display:none}
    .topbar-btn-icon{width:44px;height:44px}
    .topbar-avatar{width:44px;height:44px}
    .sidebar{z-index:70;width:min(320px,86vw);transform:translateX(-102%);opacity:0;pointer-events:none;box-shadow:0 18px 48px rgba(24,24,27,.18)}
    .sidebar-resizer{display:none}
    .main{margin-left:0}
    .mobile-tree-backdrop{position:fixed;z-index:65;inset:56px 0 0;display:block;border:0;background:rgba(9,9,11,.42);opacity:0;pointer-events:none;transition:opacity .3s cubic-bezier(.4,0,.2,1)}
    html.tree-mobile-open .sidebar{transform:translateX(0);opacity:1;pointer-events:auto}
    html.tree-mobile-open .mobile-tree-backdrop{opacity:1;pointer-events:auto}
    html.shell-hidden.tree-mobile-open .sidebar{transform:translateX(0);opacity:1;pointer-events:auto}
  }
  ${menuSurfaceStyles}
</style>
<body>

<header class="topbar">
  <div class="topbar-left">
    <button class="topbar-btn-icon mobile-tree-toggle" id="mobile-tree-toggle" type="button" aria-label="Open document tree" aria-expanded="false"><span class="material-symbols-outlined" aria-hidden="true">menu</span></button>
    <h1 class="topbar-logo">${displayNameEsc}</h1>
    ${backMarkup}
  </div>
  <div class="topbar-actions">
    <span class="shortcut-tooltip-wrap"><button class="topbar-btn-icon shell-toggle" id="shell-toggle" type="button" aria-label="Hide app shell, keyboard shortcut Ctrl Shift H" aria-describedby="shell-shortcut-tooltip" aria-pressed="false"><span class="material-symbols-outlined" aria-hidden="true">fullscreen</span><span class="mobile-action-label" id="shell-mobile-label">Enter reading mode</span></button><span class="shortcut-tooltip" id="shell-shortcut-tooltip" role="tooltip"><span class="shortcut-tooltip-label">Hide app shell</span><span class="shortcut-keys" id="shell-shortcut-keys" aria-hidden="true"><span class="shortcut-key">Ctrl</span><span class="shortcut-key">Shift</span><span class="shortcut-key">H</span></span></span></span>
    <button class="topbar-btn topbar-btn-share" id="share-btn" type="button" aria-label="${shareLabel}">
      <span class="share-icon-window" aria-hidden="true"><span class="share-icon-track"><span class="material-symbols-outlined share-icon-row">link</span><span class="share-icon-row"><span class="share-loader"></span></span><span class="material-symbols-outlined share-icon-row" id="share-feedback-icon">check</span></span></span>
      <span class="share-label-window" aria-hidden="true"><span class="share-label-track"><span class="share-label">${shareLabel}</span><span class="share-label">${sharePendingLabel}</span><span class="share-label" id="share-feedback-label">${shareDoneLabel}</span></span></span>
    </button>
    ${renderThemeButton()}
    ${avatarMarkup}
    <div class="mobile-more" id="mobile-more">
      <button class="topbar-btn-icon" id="mobile-more-btn" type="button" aria-label="More document actions" aria-haspopup="dialog" aria-controls="mobile-more-menu" aria-expanded="false"><span class="material-symbols-outlined" aria-hidden="true">more_vert</span></button>
      <div class="mobile-more-menu" id="mobile-more-menu" role="dialog" aria-label="More document actions" hidden></div>
    </div>
  </div>
</header>
<div class="share-live" id="share-live" role="status" aria-live="polite" aria-atomic="true"></div>
<aside class="share-error" id="share-error" aria-label="Sharing feedback" hidden>
  <div id="share-error-message" aria-hidden="true"><span id="share-error-text"></span><span id="share-quota" hidden>Too many shares right now; try again in <span id="share-count"></span><span id="share-unit"> seconds</span>.</span></div>
  <div class="share-error-actions"><button type="button" class="topbar-btn" id="share-retry">Retry</button><button type="button" class="topbar-btn" id="share-dismiss">Dismiss</button></div>
</aside>
<div class="shell-hotzone shell-hotzone-top" id="shell-hotzone-top" aria-hidden="true"></div>
<div class="shell-hotzone shell-hotzone-left" id="shell-hotzone-left" aria-hidden="true"></div>
<button class="mobile-tree-backdrop" id="mobile-tree-backdrop" type="button" aria-label="Close document tree"></button>

<aside class="sidebar" id="doc-sidebar" aria-labelledby="doc-sidebar-title">
  <div class="sidebar-divider" id="doc-sidebar-title">Docs</div>
  <div class="sidebar-tree" data-tree-org="${orgEsc}"${documentBase ? ` data-document-base="${escapeHtml(documentBase)}"` : ""}>
    <div class="space-y-0.5 relative" id="tree-container" style="position:relative">
      <div class="active-indicator" id="active-indicator" style="opacity:0;transition:none"></div>
      ${renderTreeSkeleton()}
    </div>
  </div>
</aside>

<main class="main">
<div class="sidebar-resizer" id="sidebar-resizer" role="separator" aria-orientation="vertical" aria-controls="doc-sidebar" aria-label="Resize document tree" aria-valuemin="220" aria-valuemax="420" aria-valuenow="280" aria-valuetext="Document tree 280 pixels wide" tabindex="0"><span class="resizer-sparks resizer-sparks-top" aria-hidden="true"></span><span class="resizer-sparks resizer-sparks-bottom" aria-hidden="true"></span></div>
  <div class="main-placeholder" id="main-placeholder">
    <div class="ph-icon"><span class="material-symbols-outlined" aria-hidden="true" style="font-size:32px;color:#71717a">edit_document</span></div>
    <h2>Select a document</h2>
    <p>Choose a document from the sidebar to view its contents, or create a new page to start writing.</p>
  </div>
  <iframe name="content-frame" id="content-frame" class="content-frame"
    src="about:blank" title="Document content" style="display:none"${sandboxAttribute}></iframe>
</main>

<script${nonceAttribute()}>
(function(){
  var root=document.documentElement;
  function normalizedTheme(){return window.RendroTheme.getMode();}
  function notifyTheme(mode){var frame=document.getElementById("content-frame");if(frame&&frame.contentWindow)frame.contentWindow.postMessage({type:"rendro-theme",theme:mode},"*");}
  window.RendroTheme.mount(document.getElementById("theme-toggle"),notifyTheme);

  var MIN_WIDTH=220;
  var MAX_WIDTH=420;
  var DEFAULT_WIDTH=280;
  var STEP=24;
  var sidebar=document.getElementById("doc-sidebar");
  var resizer=document.getElementById("sidebar-resizer");
  var topbar=document.querySelector(".topbar");
  var shellToggle=document.getElementById("shell-toggle");
  var shellToggleIcon=shellToggle&&shellToggle.querySelector(".material-symbols-outlined");
  var shellToggleMobileLabel=document.getElementById("shell-mobile-label");
  var shellShortcutKeys=document.getElementById("shell-shortcut-keys");
  var mobileTreeToggle=document.getElementById("mobile-tree-toggle");
  var mobileTreeBackdrop=document.getElementById("mobile-tree-backdrop");
  var shellShortcutText="Ctrl Shift H";
  if(shellToggle&&shellShortcutKeys){
    var platform=(navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||"";
    var isMac=/mac|iphone|ipad|ipod/i.test(platform);
    shellShortcutText=isMac?"⌘ Shift H":"Ctrl Shift H";
    shellShortcutKeys.innerHTML=isMac?'<span class="shortcut-key">⌘</span><span class="shortcut-key">Shift</span><span class="shortcut-key">H</span>':'<span class="shortcut-key">Ctrl</span><span class="shortcut-key">Shift</span><span class="shortcut-key">H</span>';
  }
  var topHotzone=document.getElementById("shell-hotzone-top");
  var leftHotzone=document.getElementById("shell-hotzone-left");
  var shellSidebarHideTimer;
  var shellHeaderHideTimer;
  var storedWidth=Number(localStorage.getItem("rendro-sidebar-width"));
  var expandedWidth=Number.isFinite(storedWidth)&&storedWidth>0?storedWidth:DEFAULT_WIDTH;

  function maxForViewport(){return Math.max(MIN_WIDTH,Math.min(MAX_WIDTH,window.innerWidth-360));}
  function clampWidth(value){return Math.max(MIN_WIDTH,Math.min(maxForViewport(),Math.round(value)));}
  function mobileTreeMode(){return window.matchMedia("(max-width:760px)").matches;}
  function setMobileTree(open){
    var active=mobileTreeMode()&&open;
    root.classList.toggle("tree-mobile-open",active);
    if(mobileTreeToggle){
      mobileTreeToggle.setAttribute("aria-expanded",String(active));
      mobileTreeToggle.setAttribute("aria-label",active?"Close document tree":"Open document tree");
    }
    if(sidebar){
      sidebar.setAttribute("aria-hidden",String(mobileTreeMode()&&!active));
      if("inert" in sidebar)sidebar.inert=mobileTreeMode()&&!active;
    }
  }
  function updateSidebarAria(){
    var width=clampWidth(expandedWidth);
    if(resizer){
      resizer.setAttribute("aria-valuemin",String(MIN_WIDTH));
      resizer.setAttribute("aria-valuemax",String(maxForViewport()));
      resizer.setAttribute("aria-valuenow",String(width));
      resizer.setAttribute("aria-valuetext","Document tree "+width+" pixels wide");
      resizer.tabIndex=mobileTreeMode()?-1:0;
    }
    if(sidebar&&!mobileTreeMode()){sidebar.setAttribute("aria-hidden","false");if("inert" in sidebar)sidebar.inert=false;}
  }
  function setSidebarWidth(value,persist){
    expandedWidth=clampWidth(value);
    root.style.setProperty("--sidebar-expanded-width",expandedWidth+"px");
    if(persist)localStorage.setItem("rendro-sidebar-width",String(expandedWidth));
    updateSidebarAria();
    notifyShellLayout();
  }
  function notifyShellLayout(){
    document.dispatchEvent(new CustomEvent("rendro:shell-layout"));
    requestAnimationFrame(function(){document.dispatchEvent(new CustomEvent("rendro:shell-layout"));});
  }
  function setShellHidden(hidden,persist){
    root.classList.toggle("shell-hidden",hidden);
    if(persist!==false)localStorage.setItem("rendro-shell-hidden",hidden?"1":"0");
    if(!hidden){
      root.classList.remove("shell-header-revealed");
      root.classList.remove("shell-sidebar-revealed");
    }
    if(shellToggle){
      shellToggle.setAttribute("aria-pressed",String(hidden));
      shellToggle.setAttribute("aria-label",(mobileTreeMode()?(hidden?"Exit reading mode":"Enter reading mode"):(hidden?"Show app shell":"Hide app shell"))+", keyboard shortcut "+shellShortcutText);
    }
    if(shellToggleMobileLabel)shellToggleMobileLabel.textContent=hidden?"Exit reading mode":"Enter reading mode";
    if(shellToggleIcon)shellToggleIcon.textContent=hidden?"fullscreen_exit":"fullscreen";
    if(hidden&&shellToggle)shellToggle.blur();
    notifyShellLayout();
  }
  function focusShellControl(){if(mobileTreeMode()&&mobileMoreButton)mobileMoreButton.focus();else if(shellToggle)shellToggle.focus();}
  function updateShellAutoReveal(e){
    if(!root.classList.contains("shell-hidden"))return;
    var wasHeader=root.classList.contains("shell-header-revealed");
    var wasSidebar=root.classList.contains("shell-sidebar-revealed");
    var headerLimit=wasHeader?72:12;
    var headerHovered=topbar&&topbar.matches(":hover");
    root.classList.toggle("shell-header-revealed",e.clientY<=headerLimit||!!headerHovered);
    var sidebarLimit=wasSidebar?clampWidth(expandedWidth)+24:12;
    var sidebarHovered=sidebar&&sidebar.matches(":hover");
    var resizerHovered=resizer&&resizer.matches(":hover");
    var revealSidebar=e.clientX<=sidebarLimit||!!sidebarHovered||!!resizerHovered;
    root.classList.toggle("shell-sidebar-revealed",revealSidebar);
    if(wasHeader!==root.classList.contains("shell-header-revealed")||wasSidebar!==root.classList.contains("shell-sidebar-revealed"))notifyShellLayout();
  }
  function scheduleHideShellHeader(){
    if(!root.classList.contains("shell-hidden"))return;
    if(shellHeaderHideTimer!==undefined)window.clearTimeout(shellHeaderHideTimer);
    shellHeaderHideTimer=window.setTimeout(function(){
      var headerHovered=topbar&&topbar.matches(":hover");
      var hotzoneHovered=topHotzone&&topHotzone.matches(":hover");
      if(!headerHovered&&!hotzoneHovered&&root.classList.contains("shell-header-revealed")){
        root.classList.remove("shell-header-revealed");
        notifyShellLayout();
      }
    },80);
  }
  function revealShellHeader(){
    if(root.classList.contains("shell-hidden")&&!root.classList.contains("shell-header-revealed")){root.classList.add("shell-header-revealed");notifyShellLayout();}
  }
  function hideShellHeader(){
    if(root.classList.contains("shell-hidden")&&root.classList.contains("shell-header-revealed")){root.classList.remove("shell-header-revealed");notifyShellLayout();}
  }
  function revealShellSidebar(){
    if(root.classList.contains("shell-hidden")&&!root.classList.contains("shell-sidebar-revealed")){root.classList.add("shell-sidebar-revealed");notifyShellLayout();}
  }
  function scheduleHideShellSidebar(){
    if(!root.classList.contains("shell-hidden"))return;
    if(shellSidebarHideTimer!==undefined)window.clearTimeout(shellSidebarHideTimer);
    shellSidebarHideTimer=window.setTimeout(function(){
      var sidebarHovered=sidebar&&sidebar.matches(":hover");
      var resizerHovered=resizer&&resizer.matches(":hover");
      if(!sidebarHovered&&!resizerHovered&&root.classList.contains("shell-sidebar-revealed")){
        root.classList.remove("shell-sidebar-revealed");
        notifyShellLayout();
      }
    },80);
  }

  setSidebarWidth(expandedWidth,false);
  setMobileTree(false);
  root.getBoundingClientRect();
  root.classList.add("sidebar-ready");
  setShellHidden(localStorage.getItem("rendro-shell-hidden")==="1",false);

  if(resizer){
    var dragging=false;
    var impactSparkTimer;
    var moveSparkTimer;
    function updateResizerOrigin(e){
      var rect=resizer.getBoundingClientRect();
      var y=Math.max(0,Math.min(rect.height,e.clientY-rect.top));
      resizer.style.setProperty("--resizer-origin-y",y+"px");
    }
    function triggerImpactSparks(){
      if(dragging)return;
      resizer.classList.remove("resizer-impact-sparks");
      resizer.offsetWidth;
      resizer.classList.add("resizer-impact-sparks");
      if(impactSparkTimer!==undefined)window.clearTimeout(impactSparkTimer);
      impactSparkTimer=window.setTimeout(function(){resizer.classList.remove("resizer-impact-sparks");},1000);
    }
    var lastResizeX=0;
    function stopResizeMoving(){
      root.classList.remove("sidebar-resizing-moving");
      root.classList.remove("sidebar-resizing-trail-left");
      root.classList.remove("sidebar-resizing-trail-right");
    }
    function markResizeMoving(deltaX){
      if(Math.abs(deltaX)<1)return;
      root.classList.add("sidebar-resizing-moving");
      root.classList.toggle("sidebar-resizing-trail-left",deltaX>0);
      root.classList.toggle("sidebar-resizing-trail-right",deltaX<0);
      if(moveSparkTimer!==undefined)window.clearTimeout(moveSparkTimer);
      moveSparkTimer=window.setTimeout(stopResizeMoving,120);
    }
    resizer.addEventListener("pointerenter",function(e){updateResizerOrigin(e);triggerImpactSparks();});
    resizer.addEventListener("pointermove",function(e){
      updateResizerOrigin(e);
      if(dragging){
        var deltaX=e.clientX-lastResizeX;
        setSidebarWidth(e.clientX,false);
        markResizeMoving(deltaX);
        lastResizeX=e.clientX;
      }
    });
    resizer.addEventListener("pointerdown",function(e){
      updateResizerOrigin(e);
      resizer.classList.remove("resizer-impact-sparks");
      lastResizeX=e.clientX;
      stopResizeMoving();
      dragging=true;
      root.classList.add("sidebar-resizing");
      resizer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    function finishResize(e){
      if(!dragging)return;
      dragging=false;
      root.classList.remove("sidebar-resizing");
      stopResizeMoving();
      if(moveSparkTimer!==undefined)window.clearTimeout(moveSparkTimer);
      setSidebarWidth(expandedWidth,true);
      try{resizer.releasePointerCapture(e.pointerId)}catch(_){}
    }
    resizer.addEventListener("pointerup",finishResize);
    resizer.addEventListener("pointercancel",finishResize);
    resizer.addEventListener("keydown",function(e){
      if(e.key==="ArrowLeft"){e.preventDefault();setSidebarWidth(expandedWidth-STEP,true);}
      else if(e.key==="ArrowRight"){e.preventDefault();setSidebarWidth(expandedWidth+STEP,true);}
      else if(e.key==="Home"){e.preventDefault();setSidebarWidth(MIN_WIDTH,true);}
      else if(e.key==="End"){e.preventDefault();setSidebarWidth(maxForViewport(),true);}
    });
  }
  window.addEventListener("resize",function(){setSidebarWidth(expandedWidth,false);setMobileTree(root.classList.contains("tree-mobile-open"));});
  if(shellToggle)shellToggle.addEventListener("click",function(){setShellHidden(!root.classList.contains("shell-hidden"));});
  if(mobileTreeToggle)mobileTreeToggle.addEventListener("click",function(){setMobileTree(!root.classList.contains("tree-mobile-open"));});
  if(mobileTreeBackdrop)mobileTreeBackdrop.addEventListener("click",function(){setMobileTree(false);});
  if(sidebar)sidebar.addEventListener("click",function(e){if(e.target instanceof Element&&e.target.closest(".tree-item[data-path]"))setMobileTree(false);});
  document.addEventListener("pointermove",updateShellAutoReveal,{passive:true});
  if(topHotzone){topHotzone.addEventListener("pointerenter",revealShellHeader);topHotzone.addEventListener("pointerleave",scheduleHideShellHeader);}
  if(leftHotzone){leftHotzone.addEventListener("pointerenter",revealShellSidebar);leftHotzone.addEventListener("pointerleave",scheduleHideShellSidebar);}
  if(topbar)topbar.addEventListener("mouseleave",scheduleHideShellHeader);
  if(sidebar)sidebar.addEventListener("mouseleave",scheduleHideShellSidebar);
  if(resizer)resizer.addEventListener("mouseleave",scheduleHideShellSidebar);
  document.addEventListener("keydown",function(e){
    var key=(e.key||"").toLowerCase();
    var shellShortcut=(key==="h"||e.code==="KeyH")&&(e.ctrlKey||e.metaKey)&&e.shiftKey&&!e.altKey&&!e.repeat&&!(e.getModifierState&&e.getModifierState("AltGraph"));
    if(shellShortcut&&!(e.target instanceof Element&&e.target.closest("input,textarea,select,[contenteditable='true'],[contenteditable='plaintext-only'],[contenteditable='']"))){
      e.preventDefault();
      setShellHidden(!root.classList.contains("shell-hidden"));
      if(!root.classList.contains("shell-hidden"))focusShellControl();
      return;
    }
    if(e.key==="Escape"&&root.classList.contains("tree-mobile-open")){
      e.preventDefault();
      setMobileTree(false);
      if(mobileTreeToggle)mobileTreeToggle.focus();
      return;
    }
    if(e.key==="Escape"&&root.classList.contains("shell-hidden")){
      e.preventDefault();
      setShellHidden(false);
      focusShellControl();
    }
  });
  var lastFrameToggle=-Infinity,lastThemeReady=-Infinity;
  window.addEventListener("message",function(e){
    var allowedOrigin=e.origin===window.location.origin||(window.RENDRO_DOCUMENT_BASE&&e.origin==="null");
    if(!allowedOrigin||!e.data)return;
    if(e.data.type==="commentor-theme-ready"){
      var themeFrame=document.getElementById("content-frame");
      if(!themeFrame||e.source!==themeFrame.contentWindow)return;
      if(performance.now()-lastThemeReady<100)return;
      lastThemeReady=performance.now();
      notifyTheme(root.dataset.theme||normalizedTheme());
      return;
    }
    if(e.data.type!=="shell-toggle")return;
    var shellFrame=document.getElementById("content-frame");
    if(!shellFrame||e.source!==shellFrame.contentWindow)return;
    if(!navigator.userActivation||navigator.userActivation.isActive!==true)return;
    if(performance.now()-lastFrameToggle<1000)return;
    lastFrameToggle=performance.now();
    setShellHidden(!root.classList.contains("shell-hidden"));
    if(!root.classList.contains("shell-hidden"))focusShellControl();
  });

  var mobileMoreButton=document.getElementById("mobile-more-btn"),mobileMoreMenu=document.getElementById("mobile-more-menu");
  var mobileMoreMedia=window.matchMedia("(max-width:760px)");
  var mobileMoreItems=[document.querySelector(".topbar-btn-back"),document.querySelector(".shortcut-tooltip-wrap"),document.getElementById("theme-toggle"),document.querySelector(".avatar-wrap")].filter(Boolean);
  var mobileMoreSlots=mobileMoreItems.map(function(item){var slot=document.createComment("mobile-more-slot");item.parentNode.insertBefore(slot,item);return {item:item,slot:slot};});
  var mobileMoreSyncedMode=null;
  function setMobileMore(open,restoreFocus){
    if(!mobileMoreButton||!mobileMoreMenu)return;
    var active=mobileMoreMedia.matches&&open;
    mobileMoreMenu.hidden=!active;
    mobileMoreButton.setAttribute("aria-expanded",String(active));
    if(active){var first=mobileMoreMenu.querySelector("a,button");if(first)first.focus();}
    if(!active&&restoreFocus)mobileMoreButton.focus();
  }
  function syncMobileMore(){
    var mobileMode=mobileMoreMedia.matches;
    if(mobileMoreSyncedMode===mobileMode)return;
    mobileMoreSyncedMode=mobileMode;
    if(!mobileMoreMenu)return;
    setMobileMore(false,false);
    mobileMoreSlots.forEach(function(entry){
      if(mobileMode)mobileMoreMenu.appendChild(entry.item);
      else entry.slot.parentNode.insertBefore(entry.item,entry.slot.nextSibling);
    });
    setShellHidden(root.classList.contains("shell-hidden"),false);
  }
  syncMobileMore();
  if(mobileMoreMedia.addEventListener)mobileMoreMedia.addEventListener("change",syncMobileMore);
  else mobileMoreMedia.addListener(syncMobileMore);
  window.addEventListener("resize",function(){if(mobileMoreMedia.matches!==mobileMoreSyncedMode)syncMobileMore();});
  if(mobileMoreButton)mobileMoreButton.addEventListener("click",function(e){e.stopPropagation();setMobileMore(mobileMoreMenu.hidden,false);});
  mobileMoreItems.slice(0,3).forEach(function(item){item.addEventListener("click",function(){setMobileMore(false,false);});});

  var avatarButton=document.getElementById("avatar-btn"),avatarMenu=document.getElementById("avatar-menu");
  function setAvatarMenu(open){if(!avatarButton||!avatarMenu)return;avatarMenu.hidden=!open;avatarButton.setAttribute("aria-expanded",String(open));}
  if(avatarButton)avatarButton.addEventListener("click",function(e){e.stopPropagation();setAvatarMenu(avatarMenu.hidden);});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"){var restore=Boolean(mobileMoreMenu&&!mobileMoreMenu.hidden);setAvatarMenu(false);setMobileMore(false,restore);}});
  var shareBtn=document.getElementById("share-btn");
  var shareFeedbackLabel=document.getElementById("share-feedback-label");
  var shareFeedbackIcon=document.getElementById("share-feedback-icon");
  var shareFeedbackTimer,shareRetryTimer,shareRetryUntil=0,shareAnnouncements=0;
  var shareError=document.getElementById("share-error"),shareErrorText=document.getElementById("share-error-text"),shareQuota=document.getElementById("share-quota"),shareCount=document.getElementById("share-count"),shareUnit=document.getElementById("share-unit"),shareLive=document.getElementById("share-live"),shareRetry=document.getElementById("share-retry"),shareDismiss=document.getElementById("share-dismiss");
  ${RETRY_AFTER_SOURCE}
  // The live region exists, empty, from page load. It is written only when a notice appears and when a delay ends; the visible per-second countdown is aria-hidden.
  function announceShare(text){shareLive.textContent=text+(shareAnnouncements++%2?"\u00a0":"");}
  function clearShareError(){clearTimeout(shareRetryTimer);shareRetryUntil=0;shareError.hidden=true;shareErrorText.textContent="";shareQuota.hidden=true;shareLive.textContent="";shareBtn.removeAttribute("aria-disabled");}
  function resetShareButton(){clearTimeout(shareFeedbackTimer);shareBtn.classList.remove("is-loading","is-feedback");shareBtn.removeAttribute("aria-busy");shareBtn.setAttribute("aria-label",${JSON.stringify(shareLabel)});}
  function quotaText(seconds){return "Too many shares right now; try again in "+seconds+(seconds===1?" second.":" seconds.");}
  function updateShareQuota(initial){
    var seconds=Math.max(0,Math.ceil((shareRetryUntil-Date.now())/1000));
    shareRetry.disabled=seconds>0;
    if(seconds){
      shareQuota.hidden=false;shareErrorText.textContent="";shareCount.textContent=String(seconds);shareUnit.textContent=seconds===1?" second":" seconds";
      if(initial)announceShare(quotaText(seconds));
      shareBtn.setAttribute("aria-disabled","true");shareRetryTimer=setTimeout(updateShareQuota,Math.min(1000,shareRetryUntil-Date.now()));
    }else{
      shareQuota.hidden=true;shareErrorText.textContent="You can share again now.";announceShare("You can share again now.");
      shareBtn.removeAttribute("aria-disabled");
    }
  }
  function showShareError(message,retry,delay,accountWide){
    if(signedOut)return;
    // A failure for a document the reader has already left must not label the new one. Quota applies to the whole account.
    if(!accountWide&&shareDoc!==(window.RENDRO_CURRENT_DOC||"")){resetShareButton();return;}
    clearShareError();resetShareButton();
    shareError.hidden=false;shareRetry.hidden=!retry;shareRetry.disabled=false;
    if(delay>0){shareRetryUntil=Date.now()+delay;updateShareQuota(true);}
    else{shareErrorText.textContent=message;announceShare(message);}
  }
  function dismissShareError(){shareError.hidden=true;shareBtn.focus();}
  shareDismiss.addEventListener("click",dismissShareError);
  shareRetry.addEventListener("click",function(){shareBtn.focus();shareBtn.click();});
  document.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&!shareError.hidden&&(shareError.contains(document.activeElement)||document.activeElement===shareBtn))dismissShareError();
  });
  // The lazy tree assigns the current document on every navigation; assignment announces the change.
  var currentDocument=window.RENDRO_CURRENT_DOC;
  Object.defineProperty(window,"RENDRO_CURRENT_DOC",{configurable:true,enumerable:true,get:function(){return currentDocument;},set:function(value){var changed=value!==currentDocument;currentDocument=value;if(changed)window.dispatchEvent(new Event("rendro:document-change"));}});
  // Quota is account-wide and keeps counting; every other notice describes one document.
  addEventListener("rendro:document-change",function(){if(Date.now()>=shareRetryUntil)clearShareError();});
  var shareLimitMessages={assets:"This document references too many assets to share. Reduce its assets before trying again."};
  var shareLimitDefault="This document is too large or complex to share. Simplify it or reduce its size before trying again.";
  // Only the stable code and a known sub-reason select wording; server text is never displayed.
  function shareFailure(status,data){
    if(status!==400||!data||typeof data!=="object")return null;
    if(data.code==="share_busy")return {message:"Sharing is taking longer than expected right now. Please try again.",retry:true};
    if(data.code==="share_unavailable")return {message:"This document cannot be shared because it, or a file it needs, is unavailable.",retry:false};
    // Workers deployed before the stable code existed reported only this text.
    if(data.code==="share_limit"||data.error==="document too complex to share")return {message:shareLimitMessages[data.reason]||shareLimitDefault,retry:false};
    return null;
  }
  var sharePending=false,shareController=new AbortController(),signedOut=false,shareDoc="";
  addEventListener("commentor-sign-out",function(){signedOut=true;shareController.abort();clearShareError();clearTimeout(shareFeedbackTimer);setAvatarMenu(false);setMobileMore(false,false);});
  function setShareLoading(){if(!shareBtn)return;if(shareFeedbackTimer!==undefined)window.clearTimeout(shareFeedbackTimer);shareBtn.classList.remove("is-feedback");shareBtn.classList.add("is-loading");shareBtn.setAttribute("aria-busy","true");shareBtn.setAttribute("aria-label",${JSON.stringify(sharePendingLabel)});}
  function setShareFeedback(message){if(signedOut||!shareBtn||!shareFeedbackLabel)return;shareBtn.classList.remove("is-loading");shareBtn.removeAttribute("aria-busy");shareFeedbackLabel.textContent=message;if(shareFeedbackIcon)shareFeedbackIcon.textContent=message.endsWith("copied!")?"check":"error";shareBtn.classList.add("is-feedback");shareBtn.setAttribute("aria-label",message);if(shareFeedbackTimer!==undefined)window.clearTimeout(shareFeedbackTimer);shareFeedbackTimer=window.setTimeout(function(){shareBtn.classList.remove("is-feedback");shareBtn.setAttribute("aria-label",${JSON.stringify(shareLabel)});if(shareFeedbackIcon)shareFeedbackIcon.textContent="check";},1800);}
  async function copyText(text){if(signedOut)return;try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}}catch(_){}if(signedOut)return;var ta=document.createElement("textarea");ta.value=text;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.top="-999px";ta.style.left="-999px";document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,text.length);try{if(!document.execCommand("copy"))throw new Error("copy failed");}finally{ta.remove();}}
  if(shareBtn)shareBtn.addEventListener("click",async function(e){
    e.stopPropagation();if(signedOut||sharePending)return;
    if(Date.now()<shareRetryUntil){shareError.hidden=false;return;}
    var doc=window.RENDRO_CURRENT_DOC||"";
    shareDoc=doc;
    if(!doc){showShareError("Select a document first.",false,0);return;}
    clearShareError();sharePending=true;setShareLoading();var copying=false;
    try{
      var relativeDoc=doc.indexOf(window.RENDRO_ORG+"/")===0?doc.slice(window.RENDRO_ORG.length+1):doc;
      var publicBase=window.RENDRO_PUBLICATION_BASE||"",shareConfig=window.RENDRO_SHARE_CONFIG;
      if(publicBase){
        var publicUrl=new URL(publicBase,window.location.origin);publicUrl.searchParams.set("doc",relativeDoc);
        copying=true;await copyText(publicUrl.href);setShareFeedback("Public URL copied!");
      }else if(shareConfig){
        var res=await fetch("/api/rendro/shares",{signal:shareController.signal,method:"POST",headers:{"Content-Type":"application/json",accept:"application/json"},body:JSON.stringify({organizationId:shareConfig.organizationId,projectId:shareConfig.projectId,documentPath:relativeDoc,expiresInSeconds:604800})});
        if(signedOut)return;
        if(res.status===429){showShareError("Too many shares right now; please try again later.",true,parseRetryAfterMs(res.headers.get("Retry-After"),Date.now()),true);return;}
        var data=await res.json();
        if(signedOut)return;
        var failure=shareFailure(res.status,data);
        if(failure){showShareError(failure.message,failure.retry,0);return;}
        if(!res.ok||!data||!data.url)throw new Error("share failed");
        copying=true;await copyText(new URL(data.url,window.location.origin).href);setShareFeedback("Share link copied!");
      }else{
        var legacyRes=await fetch("/api/share/create?key="+encodeURIComponent(doc),{signal:shareController.signal,headers:{accept:"application/json"}});
        if(!legacyRes.ok)throw new Error("share failed");var legacyData=await legacyRes.json();if(signedOut)return;
        copying=true;await copyText(legacyData.url);setShareFeedback("Signed URL copied!");
      }
    }catch(_){showShareError(copying?"The link could not be copied. Please try again.":"The share link could not be created. Please try again.",true,0);}
    finally{sharePending=false;}
  });
  document.addEventListener("click",function(){setAvatarMenu(false);setMobileMore(false,false);});
  // The document is another frame: a click inside it never reaches this page's click handler, but it moves focus into the
  // frame and blurs this window. Keyboard use of the menus keeps focus in this page, so nothing closes then.
  window.addEventListener("blur",function(){if(document.activeElement===document.getElementById("content-frame")){setAvatarMenu(false);setMobileMore(false,false);}});
})();
</script>
<script${nonceAttribute()}>window.RENDRO_INITIAL_DOC=${inlineJson(selectedDoc)};window.RENDRO_ORG=${inlineJson(org)};window.RENDRO_DOCUMENT_BASE=${inlineJson(documentBase)};window.RENDRO_PUBLICATION_BASE=${inlineJson(isPublicDocument ? documentBase : "")};window.RENDRO_SHARE_CONFIG=${inlineJson(options.shareConfig ?? null)};window.RENDRO_LEGACY_COMMENT_CONFIG=${inlineJson(options.legacyCommentConfig ?? null)};</script>
${renderCommentRecoveryLifecycle(user?.id ?? null, nonceAttribute())}
${options.shareConfig?.convexUrl || options.legacyCommentConfig?.convexUrl ? `<script${nonceAttribute()} src="/commentor-parent.js?v=${COMMENTOR_PARENT_VERSION}"></script>` : ""}
<script${nonceAttribute()} src="/lazy-tree.js?v=${LAZY_TREE_VERSION}"></script>
</body>
</html>`;
}


function renderTreeSkeleton(): string {
  return `<div class="tree-skeleton" aria-label="Loading documents" aria-busy="true">
    <div class="tree-skeleton-node">
      <div class="tree-skeleton-item">
        <span class="tree-skeleton-icon"></span>
        <span class="tree-skeleton-label w-lg"></span>
      </div>
    </div>
    <div class="tree-skeleton-node">
      <div class="tree-skeleton-item">
        <span class="tree-skeleton-icon tree-skeleton-caret"></span>
        <span class="tree-skeleton-icon"></span>
        <span class="tree-skeleton-label w-md"></span>
      </div>
    </div>
    <div class="tree-skeleton-node">
      <div class="tree-skeleton-item">
        <span class="tree-skeleton-icon tree-skeleton-caret"></span>
        <span class="tree-skeleton-icon"></span>
        <span class="tree-skeleton-label w-md"></span>
      </div>
    </div>
    <div class="tree-skeleton-node">
      <div class="tree-skeleton-item">
        <span class="tree-skeleton-icon tree-skeleton-caret"></span>
        <span class="tree-skeleton-icon"></span>
        <span class="tree-skeleton-label w-lg"></span>
      </div>
    </div>
    <div class="tree-skeleton-node">
      <div class="tree-skeleton-item">
        <span class="tree-skeleton-icon tree-skeleton-caret"></span>
        <span class="tree-skeleton-icon"></span>
        <span class="tree-skeleton-label w-md"></span>
      </div>
    </div>
  </div>`;
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


export default app;
