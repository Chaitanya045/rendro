import type { User } from "better-auth/types";

export type ControlPlaneSection =
  | "overview"
  | "projects"
  | "people"
  | "teams"
  | "api-keys"
  | "settings";

interface ControlPlanePageOptions {
  user: User;
  title: string;
  eyebrow: string;
  heading: string;
  description: string;
  content: string;
  script: string;
  state?: unknown;
  actions?: string;
  organizationId?: string;
  projectId?: string;
  active?: ControlPlaneSection;
  focused?: boolean;
  pageClass?: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

export function jsonState(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
export function renderLoadingState(label: string, content: string): string {
  return `<div class="loading-view" aria-busy="true" aria-label="${escapeHtml(label)}">${content}<span class="sr-only">${escapeHtml(label)}</span></div>`;
}
export function renderTableLoading(label: string, columns: number, rows = 4): string {
  const cells = (row: number) => Array.from({ length: columns }, (_, column) => {
    const width = column === 0 ? "long" : (row + column) % 3 === 0 ? "short" : "medium";
    return `<td><span class="skeleton skeleton-line ${column === 0 ? "strong " : ""}${width}"></span></td>`;
  }).join("");
  return `<tr class="loading-announcement"><td colspan="${columns}"><span class="sr-only">${escapeHtml(label)}</span></td></tr>${Array.from({ length: rows }, (_, row) => `<tr class="skeleton-table-row" aria-hidden="true">${cells(row)}</tr>`).join("")}`;
}



function navLink(
  href: string,
  label: string,
  icon: string,
  section: ControlPlaneSection,
  active?: ControlPlaneSection,
): string {
  const current = active === section;
  return `<a class="cp-nav-link${current ? " active" : ""}" href="${href}"${current ? ' aria-current="page"' : ""}><span class="material-symbols-outlined" aria-hidden="true">${icon}</span><span>${label}</span></a>`;
}

function controlNavigation(organizationId: string, active?: ControlPlaneSection): string {
  const org = encodeURIComponent(organizationId);
  return `<nav class="cp-nav" aria-label="Organization navigation">
    <div class="cp-nav-group">
      ${navLink(`/organizations/${org}`, "Overview", "space_dashboard", "overview", active)}
      ${navLink(`/organizations/${org}/projects`, "Projects", "folder_open", "projects", active)}
    </div>
    <div class="cp-nav-group">
      <p class="cp-nav-label">Organization</p>
      ${navLink(`/organizations/${org}/people`, "People", "group", "people", active)}
      ${navLink(`/organizations/${org}/teams`, "Teams", "groups", "teams", active)}
      ${navLink(`/organizations/${org}/settings`, "Settings", "settings", "settings", active)}
    </div>
    <div class="cp-nav-group">
      <p class="cp-nav-label">Developer</p>
      ${navLink(`/organizations/${org}/api-keys`, "API keys", "key", "api-keys", active)}
    </div>
  </nav>`;
}

const controlPlaneStyles = String.raw`
:root{
  color-scheme:light;
  --cp-page:#fafafa;
  --cp-surface:#fff;
  --cp-container:#f4f4f5;
  --cp-surface-2:var(--cp-container);
  --cp-container-strong:#e4e4e7;
  --cp-text:#18181b;
  --cp-strong:#09090b;
  --cp-muted:#71717a;
  --cp-border:#e4e4e7;
  --cp-border-strong:#d4d4d8;
  --cp-accent:#c2410c;
  --cp-accent-hover:#9a3412;
  --cp-accent-soft:#ffedd5;
  --cp-on-accent:#fff;
  --cp-danger:#b42318;
  --cp-danger-soft:#fef3f2;
  --cp-success:#15803d;
  --cp-success-soft:#f0fdf4;
  --cp-warning:#a16207;
  --cp-warning-soft:#fefce8;
  --cp-focus:rgba(194,65,12,.2);
  --cp-shadow:0 18px 48px rgba(24,24,27,.1);
  --cp-ease:cubic-bezier(.4,0,.2,1);
  --cp-instant:150ms;
  --cp-fast:200ms;
  --cp-base:300ms;
}
html.dark{
  color-scheme:dark;
  --cp-page:#09090b;
  --cp-surface:#09090b;
  --cp-container:#18181b;
  --cp-container-strong:#27272a;
  --cp-text:#e4e4e7;
  --cp-surface-2:var(--cp-container);
  --cp-strong:#fafafa;
  --cp-muted:#a1a1aa;
  --cp-border:#27272a;
  --cp-border-strong:#3f3f46;
  --cp-accent:#fb923c;
  --cp-accent-hover:#fdba74;
  --cp-accent-soft:rgba(251,146,60,.16);
  --cp-on-accent:#09090b;
  --cp-danger:#fca5a5;
  --cp-danger-soft:rgba(180,35,24,.16);
  --cp-success:#86efac;
  --cp-success-soft:rgba(21,128,61,.16);
  --cp-warning:#fde68a;
  --cp-warning-soft:rgba(161,98,7,.18);
  --cp-focus:rgba(251,146,60,.23);
  --cp-shadow:0 22px 58px rgba(0,0,0,.42);
}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--cp-page)}
body{margin:0;min-height:100vh;background:var(--cp-page);color:var(--cp-text);font:400 14px/20px Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
button,input,select,textarea{font:inherit}
button,a,input,select,textarea{outline:none}
a{color:inherit}
.material-symbols-outlined{font-family:"Material Symbols Outlined";font-size:20px;font-style:normal;font-weight:400;line-height:1;font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 24}
:focus-visible{border-color:var(--cp-accent)!important;box-shadow:0 0 0 3px var(--cp-focus)!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

.cp-topbar{position:fixed;inset:0 0 auto;z-index:60;height:56px;border-bottom:1px solid var(--cp-border);background:var(--cp-surface)}
.cp-topbar-inner{height:100%;display:flex;align-items:center;gap:8px;padding:0 24px}
.cp-brand{width:200px;flex:none;color:var(--cp-strong);font-size:24px;font-weight:700;line-height:32px;letter-spacing:-.04em;text-decoration:none}
.cp-brand i{color:var(--cp-accent);font-style:normal}
.cp-mobile-menu{display:none!important}
.cp-org-switcher{min-width:0;height:36px;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px solid var(--cp-border);border-radius:6px;background:var(--cp-surface);color:var(--cp-strong);font-weight:600;text-decoration:none;transition:background var(--cp-instant) var(--cp-ease),border-color var(--cp-instant) var(--cp-ease)}
.cp-org-switcher:hover{border-color:var(--cp-border-strong);background:var(--cp-container)}
.cp-org-mark{width:22px;height:22px;display:grid;place-items:center;border-radius:4px;background:var(--cp-accent-soft);color:var(--cp-accent);font-size:11px;font-weight:800}
.cp-org-name{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-org-caret{color:var(--cp-muted);font-size:11px}
.cp-top-spacer{flex:1}
.cp-top-action,.cp-icon-button,.cp-avatar{height:36px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--cp-border);border-radius:6px;background:var(--cp-surface);color:var(--cp-text);text-decoration:none;cursor:pointer;transition:background var(--cp-instant) var(--cp-ease),border-color var(--cp-instant) var(--cp-ease),color var(--cp-instant) var(--cp-ease),transform var(--cp-instant) var(--cp-ease)}
.cp-top-action{gap:6px;padding:0 12px;font-weight:600}
.cp-icon-button{width:36px;padding:0}
.cp-theme-window{width:20px;height:20px;overflow:hidden;display:inline-flex;align-items:flex-start;justify-content:center}
.cp-theme-track{display:flex;flex-direction:column;transition:transform var(--cp-base) var(--cp-ease);will-change:transform}
.cp-theme-icon{width:20px;height:20px;display:flex;flex:0 0 20px;align-items:center;justify-content:center;font-size:20px}
@supports (view-transition-name:root){
  ::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal}
  ::view-transition-image-pair(root){isolation:isolate}
  html.theme-rippling::view-transition-new(root){clip-path:circle(0 at var(--theme-ripple-x,50%) var(--theme-ripple-y,50%))}
}
.cp-avatar{width:36px;border-radius:50%;border-color:rgba(194,65,12,.24);background:var(--cp-accent-soft);color:var(--cp-accent);font-weight:700}
.cp-top-action:hover,.cp-icon-button:hover,.cp-avatar:hover{border-color:var(--cp-border-strong);background:var(--cp-container);color:var(--cp-strong)}
.cp-top-action:active,.cp-icon-button:active,.cp-avatar:active,.button:active{transform:scale(.98)}
.cp-account{position:relative}
.cp-account-menu{position:absolute;right:0;top:44px;width:230px;padding:4px;border:1px solid var(--cp-border);border-radius:8px;background:var(--cp-surface);box-shadow:var(--cp-shadow);visibility:hidden;opacity:0;transform:translateY(-4px);pointer-events:none;transition:opacity var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease),visibility 0s var(--cp-fast)}
.cp-account.open .cp-account-menu{visibility:visible;opacity:1;transform:none;pointer-events:auto;transition-delay:0s}
.cp-account-email{display:block;padding:9px 10px 10px;border-bottom:1px solid var(--cp-border);color:var(--cp-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cp-account-menu a{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:4px;text-decoration:none}
.cp-account-menu a:hover{background:var(--cp-container)}

.cp-sidebar{position:fixed;z-index:50;left:0;top:56px;bottom:0;width:232px;padding:18px 12px;border-right:1px solid var(--cp-border);background:var(--cp-surface)}
.cp-nav{display:grid;gap:20px}
.cp-nav-group{display:grid;gap:2px}
.cp-nav-label{margin:0 12px 7px;color:var(--cp-muted);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.cp-nav-link{position:relative;min-height:38px;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:4px;color:var(--cp-muted);font-weight:500;text-decoration:none;transition:background var(--cp-fast) var(--cp-ease),color var(--cp-fast) var(--cp-ease),padding var(--cp-fast) var(--cp-ease)}
.cp-nav-link::before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:4px;border-radius:0 4px 4px 0;background:var(--cp-accent);opacity:0;transform:scaleY(.5);transition:opacity var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease)}
.cp-nav-link .material-symbols-outlined{font-size:19px}
.cp-nav-link:hover{background:var(--cp-container);color:var(--cp-strong)}
.cp-nav-link.active{padding-left:16px;background:var(--cp-accent-soft);color:var(--cp-accent);font-weight:600}
.cp-nav-link.active::before{opacity:1;transform:none}

.cp-main{min-height:100vh;padding:92px 32px 54px 264px}
.cp-main.focused{padding-left:32px}
.cp-content{width:min(1120px,100%);margin:0 auto}
.motion-ready .cp-content{animation:cpPageIn var(--cp-fast) var(--cp-ease) both}
@keyframes cpPageIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.cp-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:24px}
.cp-page-copy{max-width:680px}
.eyebrow{margin:0 0 5px;color:var(--cp-accent);font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.cp-page-head h1{margin:0;color:var(--cp-strong);font-size:28px;line-height:34px;letter-spacing:-.03em}
.cp-page-description{margin:7px 0 0;color:var(--cp-muted);font-size:14px;line-height:22px}
.cp-page-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}

.button{min-height:36px;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:7px 12px;border:1px solid var(--cp-border-strong);border-radius:6px;background:var(--cp-surface);color:var(--cp-strong);font-weight:600;text-decoration:none;cursor:pointer;transition:background var(--cp-instant) var(--cp-ease),border-color var(--cp-instant) var(--cp-ease),color var(--cp-instant) var(--cp-ease),transform var(--cp-instant) var(--cp-ease),opacity var(--cp-instant) var(--cp-ease)}
.button:hover{border-color:var(--cp-muted);background:var(--cp-container)}
.button.primary{border-color:var(--cp-accent);background:var(--cp-accent);color:var(--cp-on-accent)}
.button.primary:hover{border-color:var(--cp-accent-hover);background:var(--cp-accent-hover)}
.button.danger{border-color:color-mix(in srgb,var(--cp-danger) 35%,var(--cp-border));color:var(--cp-danger)}
.button.danger:hover{background:var(--cp-danger-soft)}
.button.ghost{border-color:transparent;background:transparent}
.button.small{min-height:32px;padding:5px 10px;font-size:12px}
.button:disabled,.button[aria-disabled=true]{cursor:not-allowed;opacity:.5;transform:none}
.button[aria-busy=true] .button-label{opacity:.65}
.button[aria-busy=true]::after{content:"";width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:cpSpin .7s linear infinite}
@keyframes cpSpin{to{transform:rotate(360deg)}}

.panel{border:1px solid var(--cp-border);border-radius:8px;background:var(--cp-surface)}
.panel-pad{padding:20px}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.panel-head h2,.section-title{margin:0;color:var(--cp-strong);font-size:17px;line-height:24px;letter-spacing:-.015em}
.panel-head p{margin:4px 0 0;color:var(--cp-muted)}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.metric{padding:16px 18px}
.metric strong{display:block;color:var(--cp-strong);font-size:23px;line-height:28px;letter-spacing:-.025em}
.metric span{color:var(--cp-muted)}
.stack{display:grid;gap:14px}

.field{display:grid;gap:6px}
.field>span,.field>label{color:var(--cp-strong);font-size:13px;font-weight:600}
.field small{color:var(--cp-muted)}
.input,.select,.textarea{width:100%;min-height:40px;padding:8px 10px;border:1px solid var(--cp-border-strong);border-radius:6px;background:var(--cp-surface);color:var(--cp-strong);transition:border-color var(--cp-instant) var(--cp-ease),box-shadow var(--cp-instant) var(--cp-ease),background var(--cp-instant) var(--cp-ease)}
.textarea{min-height:92px;resize:vertical}
.input:hover,.select:hover,.textarea:hover{border-color:var(--cp-muted)}
.input:focus,.select:focus,.textarea:focus{border-color:var(--cp-accent);box-shadow:0 0 0 3px var(--cp-focus)}
.input[aria-invalid=true]{border-color:var(--cp-danger);box-shadow:0 0 0 3px var(--cp-danger-soft)}
.form-grid{display:grid;gap:15px}
.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.check{display:flex;align-items:flex-start;gap:9px;color:var(--cp-text);cursor:pointer}
.check input{width:16px;height:16px;margin-top:2px;accent-color:var(--cp-accent)}
.message{min-height:20px;margin:9px 0 0;color:var(--cp-muted);font-size:13px}
.message.error{color:var(--cp-danger)}
.message.success{color:var(--cp-success)}

.table-wrap{overflow:auto}
.data-table{width:100%;border-collapse:collapse}
.data-table th{padding:10px 14px;border-bottom:1px solid var(--cp-border);color:var(--cp-muted);font-size:10px;font-weight:700;letter-spacing:.07em;text-align:left;text-transform:uppercase;white-space:nowrap}
.data-table td{height:54px;padding:10px 14px;border-bottom:1px solid var(--cp-border);vertical-align:middle}
.data-table tbody tr:last-child td{border-bottom:0}
.data-table tbody tr{transition:background var(--cp-instant) var(--cp-ease)}
.data-table tbody tr:hover{background:var(--cp-container)}
.cell-primary{display:grid;gap:2px;color:var(--cp-strong);font-weight:600}
.cell-secondary{color:var(--cp-muted);font-size:12px;font-weight:400}
.badge{min-height:23px;display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;background:var(--cp-container);color:var(--cp-muted);font-size:11px;font-weight:700;white-space:nowrap}
.badge.success{background:var(--cp-success-soft);color:var(--cp-success)}
.badge.warning{background:var(--cp-warning-soft);color:var(--cp-warning)}
.badge.danger{background:var(--cp-danger-soft);color:var(--cp-danger)}
.badge.accent{background:var(--cp-accent-soft);color:var(--cp-accent)}
.row-actions{display:flex;justify-content:flex-end;gap:7px}

.empty{min-height:220px;display:grid;place-items:center;padding:36px;text-align:center}
.empty.compact{min-height:180px}
.empty-mark{width:44px;height:44px;display:grid;place-items:center;margin-bottom:13px;border-radius:8px;background:var(--cp-container);color:var(--cp-accent);font-weight:700}
.empty-mark.material-symbols-outlined{font-size:22px;font-weight:400}
.empty h2,.empty h3{margin:0;color:var(--cp-strong)}
.empty p{max-width:440px;margin:7px 0 17px;color:var(--cp-muted)}
.loading-view{display:grid;gap:14px;pointer-events:none}
.loading-view .panel{overflow:hidden}
.skeleton{position:relative;overflow:hidden;background:var(--cp-container)}
.skeleton::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--cp-surface) 72%,transparent),transparent);animation:cpSkeleton 1.1s infinite}
@keyframes cpSkeleton{to{transform:translateX(100%)}}
.loading-panel{min-height:180px;border-radius:8px}
.skeleton-line{height:10px;border-radius:999px}
.skeleton-line.strong{height:14px}
.skeleton-line.short{width:28%}
.skeleton-line.medium{width:52%}
.skeleton-line.long{width:76%}
.skeleton-icon{width:38px;height:38px;flex:none;border-radius:7px}
.skeleton-pill{width:72px;height:24px;border-radius:999px}
.skeleton-button{width:112px;height:36px;border-radius:6px}
.skeleton-field{height:40px;border-radius:6px}
.skeleton-copy{display:grid;gap:8px}
.skeleton-card{display:grid;gap:13px;padding:18px}
.skeleton-card-head{display:flex;align-items:center;gap:12px}
.skeleton-list{display:grid}
.skeleton-row{min-height:55px;display:flex;align-items:center;gap:14px;padding:10px 14px;border-bottom:1px solid var(--cp-border)}
.skeleton-row:last-child{border-bottom:0}
.skeleton-row .skeleton-copy{min-width:120px;flex:1}
.skeleton-row .skeleton-line{max-width:100%}
.skeleton-table-head{height:39px;border-bottom:1px solid var(--cp-border);background:color-mix(in srgb,var(--cp-container) 45%,var(--cp-surface))}
.skeleton-tabs{display:flex;gap:7px;padding:0 0 12px;border-bottom:1px solid var(--cp-border)}
.skeleton-tabs .skeleton-line{width:88px;height:30px;border-radius:5px}
.loading-announcement td{height:0!important;padding:0!important;border:0!important}
.skeleton-table-row{pointer-events:none}
.skeleton-table-row .skeleton-line{display:block;min-width:42px}

.tabs{display:flex;gap:4px;margin-bottom:18px;padding:3px;border:1px solid var(--cp-border);border-radius:7px;background:var(--cp-surface);overflow:auto}
.tab{min-height:34px;padding:7px 11px;border-radius:4px;color:var(--cp-muted);font-weight:600;text-decoration:none;white-space:nowrap;transition:color var(--cp-instant) var(--cp-ease),background var(--cp-instant) var(--cp-ease)}
.tab:hover{color:var(--cp-strong)}
.tab.active{background:var(--cp-accent-soft);color:var(--cp-accent)}

dialog.cp-dialog{width:min(540px,calc(100vw - 28px));max-height:calc(100vh - 40px);padding:0;border:1px solid var(--cp-border);border-radius:10px;background:var(--cp-surface);color:var(--cp-text);box-shadow:var(--cp-shadow);opacity:0;transform:translateY(8px) scale(.985);transition:opacity var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease),overlay var(--cp-fast) allow-discrete,display var(--cp-fast) allow-discrete}
dialog.cp-dialog[open]{opacity:1;transform:none}
@starting-style{dialog.cp-dialog[open]{opacity:0;transform:translateY(8px) scale(.985)}}
dialog.cp-dialog::backdrop{background:rgba(9,9,11,.48);opacity:0;transition:opacity var(--cp-fast) var(--cp-ease),overlay var(--cp-fast) allow-discrete,display var(--cp-fast) allow-discrete}
dialog.cp-dialog[open]::backdrop{opacity:1}
@starting-style{dialog.cp-dialog[open]::backdrop{opacity:0}}
.dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:19px 20px 14px;border-bottom:1px solid var(--cp-border)}
.dialog-head h2{margin:0;color:var(--cp-strong);font-size:19px;line-height:26px}
.dialog-head p{margin:4px 0 0;color:var(--cp-muted)}
.dialog-close{width:36px;height:36px;flex:none;border:0;border-radius:6px;background:transparent;color:var(--cp-muted);font-size:0;cursor:pointer}
.dialog-close::before{content:"close";font:400 20px/1 "Material Symbols Outlined"}
.dialog-close:hover{background:var(--cp-container);color:var(--cp-strong)}
.dialog-body{padding:20px}
.dialog-footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--cp-border);background:var(--cp-page)}

.toast-region{position:fixed;z-index:100;right:18px;bottom:18px;width:min(380px,calc(100vw - 36px));display:grid;gap:8px}
.toast{padding:12px 14px;border:1px solid var(--cp-border);border-radius:7px;background:var(--cp-surface);box-shadow:var(--cp-shadow);color:var(--cp-strong);opacity:0;transform:translateY(8px);transition:opacity var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease)}
.toast.visible{opacity:1;transform:none}
.toast.error{border-color:color-mix(in srgb,var(--cp-danger) 40%,var(--cp-border));color:var(--cp-danger)}
.cp-backdrop{display:none}

.onboarding{width:min(760px,100%);margin:18px auto}
.stepper{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:22px}
.step{position:relative;display:grid;justify-items:center;gap:7px;color:var(--cp-muted);font-size:12px;font-weight:600;text-align:center}
.step:not(:last-child)::after{content:"";position:absolute;z-index:-1;top:15px;left:calc(50% + 18px);right:calc(-50% + 18px);height:2px;background:var(--cp-border)}
.step.complete:not(:last-child)::after{background:var(--cp-accent)}
.step-dot{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--cp-border-strong);border-radius:50%;background:var(--cp-surface);color:var(--cp-muted);transition:background var(--cp-fast) var(--cp-ease),color var(--cp-fast) var(--cp-ease),border-color var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease)}
.step.active .step-dot,.step.complete .step-dot{border-color:var(--cp-accent);background:var(--cp-accent);color:var(--cp-on-accent)}
.step.complete .step-dot{transform:scale(1.03)}
.command{display:grid;gap:10px;padding:15px;border:1px solid #27272a;border-radius:7px;background:#09090b;color:#f4f4f5}
.command code{overflow:auto;white-space:pre-wrap;font-family:"SFMono-Regular",Consolas,monospace;font-size:12px}
.secret-box{display:grid;gap:12px;padding:15px;border:1px solid color-mix(in srgb,var(--cp-accent) 45%,var(--cp-border));border-radius:7px;background:var(--cp-accent-soft)}
.secret-value{display:flex;align-items:center;gap:9px}
.secret-value code{min-width:0;flex:1;overflow:auto;padding:10px;border-radius:5px;background:var(--cp-surface);color:var(--cp-strong);font-family:"SFMono-Regular",Consolas,monospace;white-space:nowrap}
.progress-state{display:flex;align-items:flex-start;gap:12px;padding:14px;border:1px solid var(--cp-border);border-radius:7px;background:var(--cp-container)}
.progress-dot{width:10px;height:10px;flex:none;margin-top:5px;border-radius:50%;background:var(--cp-accent);box-shadow:0 0 0 5px var(--cp-accent-soft);animation:cpPulse 1.1s var(--cp-ease) infinite}
@keyframes cpPulse{50%{transform:scale(.75);opacity:.65}}

@media(max-width:1120px){
  .cp-main{padding-right:24px;padding-left:256px}
  .cp-brand{width:200px}
}
@media(max-width:900px){
  .grid-3{grid-template-columns:1fr 1fr}
  .cp-org-name{max-width:150px}
}
@media(max-width:760px){
  .cp-topbar-inner{gap:6px;padding:0 10px}
  .cp-brand{width:auto;font-size:20px;line-height:28px}
  .cp-mobile-menu{width:44px;height:44px;display:inline-flex!important}
  .cp-org-switcher{max-width:190px;height:44px}
  .cp-org-name{max-width:110px}
  .cp-top-action{display:none}
  .cp-icon-button,.cp-avatar{width:44px;height:44px}
  .cp-sidebar{top:0;z-index:80;width:min(320px,86vw);padding-top:76px;visibility:hidden;transform:translateX(-102%);box-shadow:var(--cp-shadow);transition:transform var(--cp-base) var(--cp-ease),visibility 0s var(--cp-base)}
  body.nav-open .cp-sidebar{visibility:visible;transform:none;transition-delay:0s}
  .cp-backdrop{position:fixed;z-index:70;inset:0;display:block;border:0;background:rgba(9,9,11,.42);opacity:0;pointer-events:none;transition:opacity var(--cp-base) var(--cp-ease)}
  body.nav-open .cp-backdrop{opacity:1;pointer-events:auto}
  .cp-main,.cp-main.focused{padding:82px 14px 38px}
  .cp-page-head{align-items:stretch;flex-direction:column;gap:16px;margin-bottom:20px}
  .cp-page-head h1{font-size:26px;line-height:32px}
  .cp-page-actions{justify-content:flex-start}
  .grid-2,.grid-3{grid-template-columns:1fr}
  .panel-pad{padding:17px}
  .button{min-height:44px}
  .input,.select{min-height:44px}
  .data-table thead{display:none}
  .data-table,.data-table tbody,.data-table tr,.data-table td{display:block;width:100%}
  .data-table tr{padding:11px 13px;border-bottom:1px solid var(--cp-border)}
  .data-table tr:last-child{border-bottom:0}
  .data-table td{height:auto;padding:4px 0;border:0}
  .data-table td[data-label]::before{content:attr(data-label);display:block;margin-bottom:2px;color:var(--cp-muted);font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
  .row-actions{justify-content:flex-start;margin-top:6px}
  .stepper{gap:3px}
  .step{font-size:11px}
  .secret-value{align-items:stretch;flex-direction:column}
  .dialog-close{width:44px;height:44px}
  .button,body .role-select,body .project-tabs a,.tab{min-height:44px}
  body .project-tabs a{display:inline-flex;align-items:center}
  .dialog-body{padding:17px}
}
@media(max-width:520px){
  .cp-org-switcher{min-width:0;padding:0 8px}
  .cp-org-name,.cp-org-caret{display:none}
  .cp-page-actions>.button{flex:1}
  .form-actions{align-items:stretch;flex-direction:column-reverse}
  .form-actions .button{width:100%}
  .dialog-footer{flex-direction:column-reverse}
  .dialog-footer .button{width:100%}
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
  .progress-dot{animation:none}
  .cp-content,.button:active,.cp-top-action:active,.cp-icon-button:active,.cp-avatar:active,.organization-card:hover,.step-dot,.toast,.cp-account-menu{transform:none!important}
}
`;

const controlPlaneRuntime = String.raw`
(function(){
  "use strict";
  var root=document.documentElement;
  var media=matchMedia("(prefers-color-scheme: dark)");
  var themeButton=document.getElementById("cp-theme");
  var themeTrack=themeButton&&themeButton.querySelector(".cp-theme-track");
  var themeOrder=["system","dark","light"];
  var themeIndex={system:0,dark:1,light:2};
  var themeResetTimer,activeThemeTransition,themeTransitionId=0;
  function storedTheme(){var value=localStorage.getItem("commentor-theme");return value==="light"||value==="dark"||value==="system"?value:"system";}
  function resolvedTheme(mode){return mode==="system"?(media.matches?"dark":"light"):mode;}
  function setThemeIcon(position,animate){if(!themeTrack)return;if(themeResetTimer)clearTimeout(themeResetTimer);if(!animate||matchMedia("(prefers-reduced-motion: reduce)").matches){themeTrack.style.transition="none";themeTrack.style.transform="translateY(-"+(position*20)+"px)";void themeTrack.offsetHeight;themeTrack.style.transition="";return;}themeTrack.style.transform="translateY(-"+(position*20)+"px)";}
  function renderThemeButton(mode,animate){if(!themeButton||!themeTrack)return;var current=themeButton.dataset.themeMode||mode,next=themeOrder[(themeOrder.indexOf(mode)+1)%themeOrder.length],reduce=matchMedia("(prefers-reduced-motion: reduce)").matches,position=animate&&!reduce&&current==="light"&&mode==="system"?3:themeIndex[mode];themeButton.dataset.themeMode=mode;themeButton.title="Theme: "+mode;themeButton.setAttribute("aria-label","Switch to "+next+" theme");setThemeIcon(position,animate);if(position===3&&animate&&!reduce)themeResetTimer=setTimeout(function(){themeTrack.style.transition="none";themeTrack.style.transform="translateY(0)";void themeTrack.offsetHeight;themeTrack.style.transition="";},320);}
  function applyTheme(mode,persist,animate){var resolved=resolvedTheme(mode);root.dataset.theme=mode;root.dataset.resolvedTheme=resolved;root.classList.toggle("dark",resolved==="dark");if(persist)localStorage.setItem("commentor-theme",mode);renderThemeButton(mode,animate);}
  function transitionTheme(mode){if(!themeButton||matchMedia("(prefers-reduced-motion: reduce)").matches||!document.startViewTransition){applyTheme(mode,true,true);return;}var id=++themeTransitionId;if(activeThemeTransition)activeThemeTransition.skipTransition();var rect=themeButton.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2,radius=Math.hypot(Math.max(x,innerWidth-x),Math.max(y,innerHeight-y));root.style.setProperty("--theme-ripple-x",x+"px");root.style.setProperty("--theme-ripple-y",y+"px");root.classList.add("theme-rippling");var transition=document.startViewTransition(function(){applyTheme(mode,true,true);});activeThemeTransition=transition;transition.ready.then(function(){if(id!==themeTransitionId)return;root.animate({clipPath:["circle(0px at "+x+"px "+y+"px)","circle("+radius+"px at "+x+"px "+y+"px)"]},{duration:520,easing:"cubic-bezier(.4,0,.2,1)",fill:"both",pseudoElement:"::view-transition-new(root)"});}).catch(function(){});transition.finished.finally(function(){if(id!==themeTransitionId)return;activeThemeTransition=undefined;root.classList.remove("theme-rippling");});}
  applyTheme(storedTheme(),false,false);media.addEventListener("change",function(){if(storedTheme()==="system")applyTheme("system",false,false);});
  if(themeButton)themeButton.addEventListener("click",function(){var current=storedTheme(),next=themeOrder[(themeOrder.indexOf(current)+1)%themeOrder.length];transitionTheme(next);});
  var nav=document.querySelector(".cp-sidebar"),menuButton=document.getElementById("cp-menu");
  function syncNavAccess(open){if(!nav)return;var mobile=matchMedia("(max-width:760px)").matches;nav.inert=mobile&&!open;if(mobile)nav.setAttribute("aria-hidden",String(!open));else nav.removeAttribute("aria-hidden");}
  function setNav(open,restoreFocus){document.body.classList.toggle("nav-open",open);if(menuButton)menuButton.setAttribute("aria-expanded",String(open));syncNavAccess(open);if(!open&&restoreFocus&&menuButton)menuButton.focus();}
  if(menuButton)menuButton.addEventListener("click",function(){setNav(!document.body.classList.contains("nav-open"),false);});
  var backdrop=document.getElementById("cp-backdrop");if(backdrop)backdrop.addEventListener("click",function(){setNav(false,true);});
  var account=document.getElementById("cp-account"),avatar=document.getElementById("cp-avatar"),accountMenu=account&&account.querySelector(".cp-account-menu");
  function setAccount(open,restoreFocus){if(!account)return;account.classList.toggle("open",open);if(avatar)avatar.setAttribute("aria-expanded",String(open));if(accountMenu){accountMenu.inert=!open;accountMenu.setAttribute("aria-hidden",String(!open));}if(!open&&restoreFocus&&avatar)avatar.focus();}
  if(avatar)avatar.addEventListener("click",function(){setAccount(!account.classList.contains("open"),false);});
  document.addEventListener("click",function(event){if(account&&!account.contains(event.target))setAccount(false,false);});
  document.addEventListener("keydown",function(event){if(event.key==="Escape"){var navWasOpen=document.body.classList.contains("nav-open"),accountWasOpen=Boolean(account&&account.classList.contains("open"));setNav(false,navWasOpen);setAccount(false,!navWasOpen&&accountWasOpen);}});
  syncNavAccess(document.body.classList.contains("nav-open"));setAccount(false,false);addEventListener("resize",function(){syncNavAccess(document.body.classList.contains("nav-open"));});
  document.querySelectorAll(".cp-nav-link").forEach(function(link){link.addEventListener("click",function(){setNav(false);});});
  function busy(button,on){if(!button)return;button.disabled=on;button.setAttribute("aria-busy",String(on));}
  async function request(path,options){var response=await fetch(path,Object.assign({headers:{Accept:"application/json","Content-Type":"application/json"}},options||{}));var data=null;try{data=await response.json();}catch(_error){}if(!response.ok){var message=data&&(data.message||data.error);throw new Error(typeof message==="string"?message:"Request failed. Please try again.");}return data;}
  function toast(message,type){var region=document.getElementById("cp-toasts");if(!region)return;var node=document.createElement("div");node.className="toast"+(type?" "+type:"");node.setAttribute("role",type==="error"?"alert":"status");node.textContent=message;region.appendChild(node);requestAnimationFrame(function(){node.classList.add("visible");});setTimeout(function(){node.classList.remove("visible");setTimeout(function(){node.remove();},220);},4200);}
  function openDialog(id){var dialog=document.getElementById(id);if(dialog&&typeof dialog.showModal==="function")dialog.showModal();}
  function dialogBusy(dialog){return Boolean(dialog.querySelector("[aria-busy=true]"));}
  function requestDialogClose(dialog){if(dialogBusy(dialog))return;var event=new Event("cancel",{cancelable:true});if(dialog.dispatchEvent(event))dialog.close();}
  document.querySelectorAll("[data-dialog-open]").forEach(function(button){button.addEventListener("click",function(){openDialog(button.getAttribute("data-dialog-open"));});});
  document.querySelectorAll("[data-dialog-close]").forEach(function(button){button.addEventListener("click",function(){var dialog=button.closest("dialog");if(dialog)requestDialogClose(dialog);});});
  document.querySelectorAll("dialog").forEach(function(dialog){dialog.addEventListener("cancel",function(event){if(dialogBusy(dialog))event.preventDefault();});dialog.addEventListener("click",function(event){if(event.target===dialog)requestDialogClose(dialog);});});
  function normalizeEmptyMarks(scope){var icons={"!":"error",P:"folder",S:"link",K:"key",T:"groups",R:"domain"};(scope||document).querySelectorAll(".empty-mark:not([data-icon-ready])").forEach(function(mark){var icon=icons[mark.textContent.trim()]||"inbox";mark.textContent=icon;mark.classList.add("material-symbols-outlined");mark.setAttribute("aria-hidden","true");mark.dataset.iconReady="true";});}
  normalizeEmptyMarks(document);new MutationObserver(function(records){records.forEach(function(record){record.addedNodes.forEach(function(node){if(node.nodeType===1)normalizeEmptyMarks(node);});});}).observe(document.body,{childList:true,subtree:true});
  window.RendroUI={busy:busy,request:request,toast:toast,openDialog:openDialog,applyTheme:applyTheme};
  requestAnimationFrame(function(){root.classList.add("motion-ready");});
})();
`;

export function renderControlPlanePage(options: ControlPlanePageOptions): string {
  const organizationId = options.organizationId;
  const hasSidebar = Boolean(organizationId) && !options.focused;
  const orgLabel = organizationId ? "Organization" : "Organizations";
  const userLabel = options.user.name || options.user.email;
  const initial = userLabel.trim().charAt(0).toUpperCase() || "R";
  const state = jsonState(options.state ?? {});
  const pageClass = options.pageClass ? ` ${escapeHtml(options.pageClass)}` : "";
  const openDocs = organizationId
    ? `<a class="cp-top-action" href="/organizations/${encodeURIComponent(organizationId)}/projects${options.projectId ? `/${encodeURIComponent(options.projectId)}/docs` : ""}"><span class="material-symbols-outlined" aria-hidden="true">description</span><span>Open docs</span></a>`
    : "";
  const organizationSwitcher = organizationId
    ? `<a class="cp-org-switcher" href="/organizations?choose=1" aria-label="Switch organization"><span class="cp-org-mark" data-org-mark>R</span><span class="cp-org-name" data-org-name>${orgLabel}</span><span class="material-symbols-outlined cp-org-caret" aria-hidden="true">unfold_more</span></a>`
    : `<a class="cp-org-switcher" href="/organizations"><span class="cp-org-mark">R</span><span class="cp-org-name">Organizations</span></a>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)} — Rendro</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..24,400,0,0&display=swap" rel="stylesheet"><script>try{var m=localStorage.getItem("commentor-theme"),r=m==="dark"||m==="light"?m:(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");document.documentElement.dataset.theme=m==="dark"||m==="light"||m==="system"?m:"system";document.documentElement.dataset.resolvedTheme=r;document.documentElement.classList.toggle("dark",r==="dark");}catch(_error){}</script><style>${controlPlaneStyles}</style></head>
<body class="${hasSidebar ? "has-sidebar" : "focused-layout"}">
<header class="cp-topbar"><div class="cp-topbar-inner">
  ${hasSidebar ? '<button class="cp-icon-button cp-mobile-menu" id="cp-menu" type="button" aria-label="Open navigation" aria-expanded="false"><span class="material-symbols-outlined" aria-hidden="true">menu</span></button>' : ""}
  <a class="cp-brand" href="/">Rendro<i>.</i></a>
  ${organizationSwitcher}
  <span class="cp-top-spacer"></span>${openDocs}
  <button class="cp-icon-button" id="cp-theme" type="button" aria-label="Switch to dark theme" title="Theme: system"><span class="cp-theme-window" aria-hidden="true"><span class="cp-theme-track"><span class="material-symbols-outlined cp-theme-icon">contrast</span><span class="material-symbols-outlined cp-theme-icon">dark_mode</span><span class="material-symbols-outlined cp-theme-icon">light_mode</span><span class="material-symbols-outlined cp-theme-icon">contrast</span></span></span></button>
  <div class="cp-account" id="cp-account"><button class="cp-avatar" id="cp-avatar" type="button" aria-label="Open account menu" aria-expanded="false">${escapeHtml(initial)}</button><div class="cp-account-menu"><span class="cp-account-email">${escapeHtml(options.user.email)}</span><a href="/account/security"><span class="material-symbols-outlined" aria-hidden="true">shield</span><span>Account security</span></a><a href="/api/auth/sign-out"><span class="material-symbols-outlined" aria-hidden="true">logout</span><span>Sign out</span></a></div></div>
</div></header>
${hasSidebar ? `<aside class="cp-sidebar">${controlNavigation(organizationId ?? "", options.active)}</aside><button class="cp-backdrop" id="cp-backdrop" type="button" aria-label="Close navigation"></button>` : ""}
<main class="cp-main${hasSidebar ? "" : " focused"}"><div class="cp-content${pageClass}">
  <header class="cp-page-head"><div class="cp-page-copy"><p class="eyebrow">${escapeHtml(options.eyebrow)}</p><h1 class="cp-page-heading">${escapeHtml(options.heading)}</h1><p class="cp-page-description">${escapeHtml(options.description)}</p></div>${options.actions ? `<div class="cp-page-actions">${options.actions}</div>` : ""}</header>
  ${options.content}
</div></main>
<div class="toast-region" id="cp-toasts" aria-live="polite"></div>
<script>window.__RENDRO_PAGE_STATE__=${state};</script><script>${controlPlaneRuntime}</script><script>${options.script}</script>
</body></html>`;
}
