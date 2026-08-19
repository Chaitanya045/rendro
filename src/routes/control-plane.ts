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

function navLink(href: string, label: string, section: ControlPlaneSection, active?: ControlPlaneSection): string {
  const current = active === section;
  return `<a class="cp-nav-link${current ? " active" : ""}" href="${href}"${current ? ' aria-current="page"' : ""}><span>${label}</span></a>`;
}

function controlNavigation(organizationId: string, active?: ControlPlaneSection): string {
  const org = encodeURIComponent(organizationId);
  return `<nav class="cp-nav" aria-label="Organization navigation">
    <div class="cp-nav-group">
      ${navLink(`/organizations/${org}`, "Overview", "overview", active)}
      ${navLink(`/organizations/${org}/projects`, "Projects", "projects", active)}
    </div>
    <div class="cp-nav-group">
      <p class="cp-nav-label">Organization</p>
      ${navLink(`/organizations/${org}/people`, "People", "people", active)}
      ${navLink(`/organizations/${org}/teams`, "Teams", "teams", active)}
      ${navLink(`/organizations/${org}/settings`, "Settings", "settings", active)}
    </div>
    <div class="cp-nav-group">
      <p class="cp-nav-label">Developer</p>
      ${navLink(`/organizations/${org}/api-keys`, "API keys", "api-keys", active)}
    </div>
  </nav>`;
}

const controlPlaneStyles = String.raw`
:root{color-scheme:light;--cp-page:#fafafa;--cp-surface:#fff;--cp-surface-2:#f4f4f5;--cp-surface-3:#e4e4e7;--cp-text:#18181b;--cp-strong:#09090b;--cp-muted:#71717a;--cp-border:#e4e4e7;--cp-border-strong:#d4d4d8;--cp-accent:#c2410c;--cp-accent-hover:#9a3412;--cp-accent-soft:#ffedd5;--cp-danger:#b42318;--cp-danger-soft:#fef3f2;--cp-success:#15803d;--cp-success-soft:#f0fdf4;--cp-warning:#a16207;--cp-warning-soft:#fefce8;--cp-focus:rgba(194,65,12,.2);--cp-shadow:0 18px 48px rgba(24,24,27,.08);--cp-ease:cubic-bezier(.4,0,.2,1);--cp-instant:150ms;--cp-fast:200ms;--cp-base:300ms}
html.dark{color-scheme:dark;--cp-page:#09090b;--cp-surface:#18181b;--cp-surface-2:#27272a;--cp-surface-3:#3f3f46;--cp-text:#e4e4e7;--cp-strong:#fafafa;--cp-muted:#a1a1aa;--cp-border:#27272a;--cp-border-strong:#3f3f46;--cp-accent:#fb923c;--cp-accent-hover:#fdba74;--cp-accent-soft:rgba(251,146,60,.16);--cp-danger:#fca5a5;--cp-danger-soft:rgba(180,35,24,.16);--cp-success:#86efac;--cp-success-soft:rgba(21,128,61,.16);--cp-warning:#fde68a;--cp-warning-soft:rgba(161,98,7,.18);--cp-focus:rgba(251,146,60,.23);--cp-shadow:0 22px 58px rgba(0,0,0,.38)}
*{box-sizing:border-box}html{background:var(--cp-page)}body{margin:0;min-height:100vh;background:var(--cp-page);color:var(--cp-text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}button,input,select,textarea{font:inherit}button,a,input,select,textarea{outline:none}a{color:inherit}.cp-topbar{position:fixed;inset:0 0 auto;z-index:60;height:56px;display:flex;align-items:center;border-bottom:1px solid var(--cp-border);background:color-mix(in srgb,var(--cp-surface) 92%,transparent);backdrop-filter:blur(14px)}.cp-topbar-inner{width:100%;display:flex;align-items:center;gap:14px;padding:0 18px}.cp-brand{width:196px;flex:none;color:var(--cp-strong);font-size:20px;font-weight:800;letter-spacing:-.045em;text-decoration:none}.cp-brand i{color:var(--cp-accent);font-style:normal}.cp-mobile-menu{display:none}.cp-org-switcher{height:36px;min-width:0;display:flex;align-items:center;gap:9px;padding:0 10px;border:1px solid var(--cp-border);border-radius:9px;background:var(--cp-surface);color:var(--cp-strong);font-weight:600;text-decoration:none;transition:border-color var(--cp-instant) var(--cp-ease),background var(--cp-instant) var(--cp-ease)}.cp-org-switcher:hover{border-color:var(--cp-border-strong);background:var(--cp-surface-2)}.cp-org-mark{width:22px;height:22px;display:grid;place-items:center;border-radius:6px;background:var(--cp-accent-soft);color:var(--cp-accent);font-size:11px;font-weight:800}.cp-org-name{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cp-org-caret{color:var(--cp-muted);font-size:11px}.cp-top-spacer{flex:1}.cp-top-action,.cp-icon-button,.cp-avatar{height:36px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--cp-border);border-radius:9px;background:var(--cp-surface);color:var(--cp-text);text-decoration:none;cursor:pointer;transition:background var(--cp-instant) var(--cp-ease),border-color var(--cp-instant) var(--cp-ease),transform var(--cp-instant) var(--cp-ease)}.cp-top-action{padding:0 12px;font-weight:600}.cp-icon-button{width:36px}.cp-avatar{width:36px;border-radius:50%;background:var(--cp-accent-soft);border-color:transparent;color:var(--cp-accent);font-weight:800}.cp-top-action:hover,.cp-icon-button:hover,.cp-avatar:hover{background:var(--cp-surface-2);border-color:var(--cp-border-strong)}.cp-top-action:active,.cp-icon-button:active,.cp-avatar:active,.button:active{transform:translateY(1px)}.cp-account{position:relative}.cp-account-menu{position:absolute;right:0;top:44px;width:230px;padding:7px;border:1px solid var(--cp-border);border-radius:12px;background:var(--cp-surface);box-shadow:var(--cp-shadow);opacity:0;transform:translateY(-4px);pointer-events:none;transition:opacity var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease)}.cp-account.open .cp-account-menu{opacity:1;transform:none;pointer-events:auto}.cp-account-email{display:block;padding:9px 10px 10px;color:var(--cp-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid var(--cp-border);white-space:nowrap}.cp-account-menu a{display:block;padding:9px 10px;border-radius:7px;text-decoration:none}.cp-account-menu a:hover{background:var(--cp-surface-2)}.cp-sidebar{position:fixed;z-index:50;left:0;top:56px;bottom:0;width:232px;padding:20px 12px;border-right:1px solid var(--cp-border);background:var(--cp-surface)}.cp-nav{display:grid;gap:22px}.cp-nav-group{display:grid;gap:3px}.cp-nav-label{margin:0 10px 7px;color:var(--cp-muted);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.cp-nav-link{position:relative;display:flex;align-items:center;min-height:38px;padding:8px 10px;border-radius:8px;color:var(--cp-muted);font-weight:550;text-decoration:none;transition:color var(--cp-instant) var(--cp-ease),background var(--cp-instant) var(--cp-ease)}.cp-nav-link:before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:3px;background:var(--cp-accent);opacity:0;transform:scaleY(.4);transition:opacity var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease)}.cp-nav-link:hover{color:var(--cp-strong);background:var(--cp-surface-2)}.cp-nav-link.active{padding-left:15px;background:var(--cp-accent-soft);color:var(--cp-accent)}.cp-nav-link.active:before{opacity:1;transform:none}.cp-main{min-height:100vh;padding:96px 36px 54px 268px}.cp-main.focused{padding-left:36px}.cp-content{width:min(1120px,100%);margin:0 auto;opacity:1}.motion-ready .cp-content{animation:cpPageIn var(--cp-fast) var(--cp-ease) both}@keyframes cpPageIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.cp-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:28px}.cp-page-copy{max-width:680px}.eyebrow{margin:0 0 6px;color:var(--cp-accent);font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.cp-page-head h1{margin:0;color:var(--cp-strong);font-size:30px;line-height:1.15;letter-spacing:-.035em}.cp-page-description{margin:10px 0 0;color:var(--cp-muted);font-size:15px}.cp-page-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.button{min-height:38px;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:8px 13px;border:1px solid var(--cp-border-strong);border-radius:8px;background:var(--cp-surface);color:var(--cp-strong);font-weight:650;text-decoration:none;cursor:pointer;transition:background var(--cp-instant) var(--cp-ease),border-color var(--cp-instant) var(--cp-ease),color var(--cp-instant) var(--cp-ease),transform var(--cp-instant) var(--cp-ease),opacity var(--cp-instant) var(--cp-ease)}.button:hover{background:var(--cp-surface-2);border-color:var(--cp-muted)}.button.primary{border-color:var(--cp-accent);background:var(--cp-accent);color:#fff}.dark .button.primary{color:#18181b}.button.primary:hover{background:var(--cp-accent-hover);border-color:var(--cp-accent-hover)}.button.danger{border-color:color-mix(in srgb,var(--cp-danger) 35%,var(--cp-border));color:var(--cp-danger)}.button.danger:hover{background:var(--cp-danger-soft)}.button.ghost{border-color:transparent;background:transparent}.button.small{min-height:32px;padding:5px 10px;font-size:12px}.button:disabled,.button[aria-disabled=true]{cursor:not-allowed;opacity:.5;transform:none}.button[aria-busy=true] .button-label{opacity:.65}.button[aria-busy=true]:after{content:"";width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:cpSpin .7s linear infinite}@keyframes cpSpin{to{transform:rotate(360deg)}}.panel{border:1px solid var(--cp-border);border-radius:12px;background:var(--cp-surface)}.panel-pad{padding:22px}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.panel-head h2,.section-title{margin:0;color:var(--cp-strong);font-size:18px;line-height:1.3;letter-spacing:-.018em}.panel-head p{margin:5px 0 0;color:var(--cp-muted)}.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.metric{padding:18px}.metric strong{display:block;color:var(--cp-strong);font-size:24px;letter-spacing:-.03em}.metric span{color:var(--cp-muted)}.field{display:grid;gap:7px}.field>span,.field>label{color:var(--cp-strong);font-size:13px;font-weight:650}.field small{color:var(--cp-muted)}.input,.select,.textarea{width:100%;min-height:42px;padding:9px 11px;border:1px solid var(--cp-border-strong);border-radius:8px;background:var(--cp-surface);color:var(--cp-strong);transition:border-color var(--cp-instant) var(--cp-ease),box-shadow var(--cp-instant) var(--cp-ease),background var(--cp-instant) var(--cp-ease)}.textarea{min-height:92px;resize:vertical}.input:hover,.select:hover,.textarea:hover{border-color:var(--cp-muted)}.input:focus,.select:focus,.textarea:focus{border-color:var(--cp-accent);box-shadow:0 0 0 3px var(--cp-focus)}.input[aria-invalid=true]{border-color:var(--cp-danger);box-shadow:0 0 0 3px var(--cp-danger-soft)}.form-grid{display:grid;gap:16px}.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.check{display:flex;align-items:flex-start;gap:9px;color:var(--cp-text);cursor:pointer}.check input{width:16px;height:16px;margin-top:2px;accent-color:var(--cp-accent)}.message{min-height:20px;margin:10px 0 0;color:var(--cp-muted);font-size:13px}.message.error{color:var(--cp-danger)}.message.success{color:var(--cp-success)}.table-wrap{overflow:auto}.data-table{width:100%;border-collapse:collapse}.data-table th{padding:10px 14px;border-bottom:1px solid var(--cp-border);color:var(--cp-muted);font-size:11px;font-weight:750;letter-spacing:.06em;text-align:left;text-transform:uppercase;white-space:nowrap}.data-table td{height:54px;padding:10px 14px;border-bottom:1px solid var(--cp-border);vertical-align:middle}.data-table tbody tr:last-child td{border-bottom:0}.data-table tbody tr{transition:background var(--cp-instant) var(--cp-ease)}.data-table tbody tr:hover{background:var(--cp-surface-2)}.cell-primary{display:grid;gap:2px;color:var(--cp-strong);font-weight:650}.cell-secondary{color:var(--cp-muted);font-size:12px;font-weight:450}.badge{display:inline-flex;align-items:center;gap:5px;min-height:24px;padding:3px 8px;border-radius:999px;background:var(--cp-surface-2);color:var(--cp-muted);font-size:11px;font-weight:750;white-space:nowrap}.badge.success{background:var(--cp-success-soft);color:var(--cp-success)}.badge.warning{background:var(--cp-warning-soft);color:var(--cp-warning)}.badge.danger{background:var(--cp-danger-soft);color:var(--cp-danger)}.badge.accent{background:var(--cp-accent-soft);color:var(--cp-accent)}.empty{display:grid;place-items:center;min-height:220px;padding:36px;text-align:center}.empty-mark{width:44px;height:44px;display:grid;place-items:center;margin-bottom:14px;border-radius:12px;background:var(--cp-surface-2);color:var(--cp-accent);font-weight:800}.empty h2,.empty h3{margin:0;color:var(--cp-strong)}.empty p{max-width:440px;margin:7px 0 18px;color:var(--cp-muted)}.skeleton{position:relative;overflow:hidden;background:var(--cp-surface-2)}.skeleton:after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--cp-surface) 70%,transparent),transparent);animation:cpSkeleton 1.1s infinite}@keyframes cpSkeleton{to{transform:translateX(100%)}}.loading-panel{height:180px;border-radius:12px}.stack{display:grid;gap:16px}.row-actions{display:flex;justify-content:flex-end;gap:7px}.tabs{display:flex;gap:4px;margin-bottom:20px;padding:4px;border:1px solid var(--cp-border);border-radius:10px;background:var(--cp-surface);overflow:auto}.tab{min-height:34px;padding:7px 12px;border-radius:7px;color:var(--cp-muted);font-weight:650;text-decoration:none;white-space:nowrap;transition:color var(--cp-instant) var(--cp-ease),background var(--cp-instant) var(--cp-ease)}.tab:hover{color:var(--cp-strong)}.tab.active{background:var(--cp-accent-soft);color:var(--cp-accent)}dialog.cp-dialog{width:min(540px,calc(100vw - 28px));max-height:calc(100vh - 40px);padding:0;border:1px solid var(--cp-border);border-radius:14px;background:var(--cp-surface);color:var(--cp-text);box-shadow:var(--cp-shadow);opacity:0;transform:translateY(8px) scale(.985);transition:opacity var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease),overlay var(--cp-fast) allow-discrete,display var(--cp-fast) allow-discrete}dialog.cp-dialog[open]{opacity:1;transform:none}@starting-style{dialog.cp-dialog[open]{opacity:0;transform:translateY(8px) scale(.985)}}dialog.cp-dialog::backdrop{background:rgba(9,9,11,.48);opacity:0;transition:opacity var(--cp-fast) var(--cp-ease),overlay var(--cp-fast) allow-discrete,display var(--cp-fast) allow-discrete}dialog.cp-dialog[open]::backdrop{opacity:1}@starting-style{dialog.cp-dialog[open]::backdrop{opacity:0}}.dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:21px 22px 15px;border-bottom:1px solid var(--cp-border)}.dialog-head h2{margin:0;color:var(--cp-strong);font-size:20px}.dialog-head p{margin:5px 0 0;color:var(--cp-muted)}.dialog-close{width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--cp-muted);cursor:pointer}.dialog-close:hover{background:var(--cp-surface-2);color:var(--cp-strong)}.dialog-body{padding:22px}.dialog-footer{display:flex;justify-content:flex-end;gap:8px;padding:15px 22px;border-top:1px solid var(--cp-border);background:var(--cp-page)}.toast-region{position:fixed;z-index:100;right:18px;bottom:18px;display:grid;gap:8px;width:min(380px,calc(100vw - 36px))}.toast{padding:12px 14px;border:1px solid var(--cp-border);border-radius:10px;background:var(--cp-surface);box-shadow:var(--cp-shadow);color:var(--cp-strong);opacity:0;transform:translateY(8px);transition:opacity var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease)}.toast.visible{opacity:1;transform:none}.toast.error{border-color:color-mix(in srgb,var(--cp-danger) 40%,var(--cp-border));color:var(--cp-danger)}.cp-backdrop{display:none}.onboarding{width:min(760px,100%);margin:20px auto}.stepper{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:24px}.step{position:relative;display:grid;justify-items:center;gap:7px;color:var(--cp-muted);font-size:12px;font-weight:650;text-align:center}.step:not(:last-child):after{content:"";position:absolute;z-index:-1;top:15px;left:calc(50% + 18px);right:calc(-50% + 18px);height:2px;background:var(--cp-border)}.step.complete:not(:last-child):after{background:var(--cp-accent)}.step-dot{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--cp-border-strong);border-radius:50%;background:var(--cp-surface);color:var(--cp-muted);transition:background var(--cp-fast) var(--cp-ease),color var(--cp-fast) var(--cp-ease),border-color var(--cp-fast) var(--cp-ease),transform var(--cp-fast) var(--cp-ease)}.step.active .step-dot,.step.complete .step-dot{border-color:var(--cp-accent);background:var(--cp-accent);color:#fff}.step.complete .step-dot{transform:scale(1.03)}.command{display:grid;gap:10px;padding:16px;border:1px solid var(--cp-border);border-radius:10px;background:#09090b;color:#f4f4f5}.command code{overflow:auto;white-space:pre-wrap;font-family:"SFMono-Regular",Consolas,monospace;font-size:12px}.secret-box{display:grid;gap:12px;padding:16px;border:1px solid color-mix(in srgb,var(--cp-accent) 45%,var(--cp-border));border-radius:10px;background:var(--cp-accent-soft)}.secret-value{display:flex;align-items:center;gap:9px}.secret-value code{min-width:0;flex:1;overflow:auto;padding:10px;border-radius:7px;background:var(--cp-surface);color:var(--cp-strong);font-family:"SFMono-Regular",Consolas,monospace;white-space:nowrap}.progress-state{display:flex;align-items:flex-start;gap:12px;padding:15px;border:1px solid var(--cp-border);border-radius:10px;background:var(--cp-surface-2)}.progress-dot{width:10px;height:10px;flex:none;margin-top:5px;border-radius:50%;background:var(--cp-accent);box-shadow:0 0 0 5px var(--cp-accent-soft);animation:cpPulse 1.1s var(--cp-ease) infinite}@keyframes cpPulse{50%{transform:scale(.75);opacity:.65}}
:focus-visible{box-shadow:0 0 0 3px var(--cp-focus)!important;border-color:var(--cp-accent)!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:900px){.cp-main{padding-right:22px;padding-left:254px}.grid-3{grid-template-columns:1fr 1fr}.cp-org-name{max-width:150px}}
@media(max-width:760px){.cp-topbar-inner{padding:0 12px}.cp-brand{width:auto}.cp-mobile-menu{display:inline-flex}.cp-org-switcher{max-width:180px}.cp-org-name{max-width:110px}.cp-top-action{display:none}.cp-sidebar{top:0;z-index:80;width:min(282px,86vw);padding-top:76px;transform:translateX(-102%);box-shadow:var(--cp-shadow);transition:transform var(--cp-base) var(--cp-ease)}body.nav-open .cp-sidebar{transform:none}.cp-backdrop{position:fixed;z-index:70;inset:0;display:block;background:rgba(9,9,11,.4);opacity:0;pointer-events:none;transition:opacity var(--cp-base) var(--cp-ease)}body.nav-open .cp-backdrop{opacity:1;pointer-events:auto}.cp-main,.cp-main.focused{padding:84px 14px 38px}.cp-page-head{align-items:stretch;flex-direction:column;margin-bottom:20px}.cp-page-head h1{font-size:27px}.cp-page-actions{justify-content:flex-start}.grid-2,.grid-3{grid-template-columns:1fr}.panel-pad{padding:18px}.data-table thead{display:none}.data-table,.data-table tbody,.data-table tr,.data-table td{display:block;width:100%}.data-table tr{padding:12px 14px;border-bottom:1px solid var(--cp-border)}.data-table tr:last-child{border-bottom:0}.data-table td{height:auto;padding:4px 0;border:0}.data-table td[data-label]:before{content:attr(data-label);display:block;margin-bottom:2px;color:var(--cp-muted);font-size:10px;font-weight:750;letter-spacing:.05em;text-transform:uppercase}.row-actions{justify-content:flex-start;margin-top:6px}.stepper{gap:3px}.step{font-size:11px}.secret-value{align-items:stretch;flex-direction:column}.dialog-body{padding:18px}}
@media(max-width:460px){.cp-org-switcher{min-width:0;padding:0 7px}.cp-org-name,.cp-org-caret{display:none}.cp-page-actions>.button{flex:1}.form-actions{align-items:stretch;flex-direction:column-reverse}.form-actions .button{width:100%}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}.progress-dot{animation:none}}
`;

const controlPlaneRuntime = String.raw`
(function(){
  "use strict";
  var root=document.documentElement;
  var media=matchMedia("(prefers-color-scheme: dark)");
  function storedTheme(){var value=localStorage.getItem("commentor-theme");return value==="light"||value==="dark"?value:"system";}
  function resolvedTheme(){var value=storedTheme();return value==="system"?(media.matches?"dark":"light"):value;}
  function applyTheme(){var mode=storedTheme();root.classList.toggle("dark",resolvedTheme()==="dark");var button=document.getElementById("cp-theme");if(button){button.textContent=mode==="system"?"◐":mode==="dark"?"☾":"☀";button.title="Theme: "+mode;}}
  applyTheme();media.addEventListener("change",function(){if(storedTheme()==="system")applyTheme();});
  var themeButton=document.getElementById("cp-theme");if(themeButton)themeButton.addEventListener("click",function(){var current=storedTheme();var next=current==="system"?"dark":current==="dark"?"light":"system";if(next==="system")localStorage.removeItem("commentor-theme");else localStorage.setItem("commentor-theme",next);applyTheme();});
  function setNav(open){document.body.classList.toggle("nav-open",open);var button=document.getElementById("cp-menu");if(button)button.setAttribute("aria-expanded",String(open));}
  var menuButton=document.getElementById("cp-menu");if(menuButton)menuButton.addEventListener("click",function(){setNav(!document.body.classList.contains("nav-open"));});
  var backdrop=document.getElementById("cp-backdrop");if(backdrop)backdrop.addEventListener("click",function(){setNav(false);});
  var account=document.getElementById("cp-account");var avatar=document.getElementById("cp-avatar");
  if(avatar)avatar.addEventListener("click",function(){var open=!account.classList.contains("open");account.classList.toggle("open",open);avatar.setAttribute("aria-expanded",String(open));});
  document.addEventListener("click",function(event){if(account&&!account.contains(event.target)){account.classList.remove("open");if(avatar)avatar.setAttribute("aria-expanded","false");}});
  document.addEventListener("keydown",function(event){if(event.key==="Escape"){setNav(false);if(account)account.classList.remove("open");document.querySelectorAll("dialog[open]").forEach(function(dialog){dialog.close();});}});
  function busy(button,on){if(!button)return;button.disabled=on;button.setAttribute("aria-busy",String(on));}
  async function request(path,options){var response=await fetch(path,Object.assign({headers:{Accept:"application/json","Content-Type":"application/json"}},options||{}));var data=null;try{data=await response.json();}catch(_error){}if(!response.ok){var message=data&&(data.message||data.error);throw new Error(typeof message==="string"?message:"Request failed. Please try again.");}return data;}
  function toast(message,type){var region=document.getElementById("cp-toasts");if(!region)return;var node=document.createElement("div");node.className="toast"+(type?" "+type:"");node.setAttribute("role",type==="error"?"alert":"status");node.textContent=message;region.appendChild(node);requestAnimationFrame(function(){node.classList.add("visible");});setTimeout(function(){node.classList.remove("visible");setTimeout(function(){node.remove();},220);},4200);}
  function openDialog(id){var dialog=document.getElementById(id);if(dialog&&typeof dialog.showModal==="function")dialog.showModal();}
  document.querySelectorAll("[data-dialog-open]").forEach(function(button){button.addEventListener("click",function(){openDialog(button.getAttribute("data-dialog-open"));});});
  document.querySelectorAll("[data-dialog-close]").forEach(function(button){button.addEventListener("click",function(){var dialog=button.closest("dialog");if(dialog)dialog.close();});});
  document.querySelectorAll("dialog").forEach(function(dialog){dialog.addEventListener("click",function(event){if(event.target===dialog)dialog.close();});});
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
    ? `<a class="cp-top-action" href="/organizations/${encodeURIComponent(organizationId)}/projects">Open docs</a>`
    : "";
  const organizationSwitcher = organizationId
    ? `<a class="cp-org-switcher" href="/organizations?choose=1" aria-label="Switch organization"><span class="cp-org-mark" data-org-mark>R</span><span class="cp-org-name" data-org-name>${orgLabel}</span><span class="cp-org-caret">⌄</span></a>`
    : `<a class="cp-org-switcher" href="/organizations"><span class="cp-org-mark">R</span><span class="cp-org-name">Organizations</span></a>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(options.title)} — Rendro</title><style>${controlPlaneStyles}</style></head>
<body class="${hasSidebar ? "has-sidebar" : "focused-layout"}">
<header class="cp-topbar"><div class="cp-topbar-inner">
  ${hasSidebar ? '<button class="cp-icon-button cp-mobile-menu" id="cp-menu" type="button" aria-label="Open navigation" aria-expanded="false">Menu</button>' : ""}
  <a class="cp-brand" href="/">Rendro<i>.</i></a>
  ${organizationSwitcher}
  <span class="cp-top-spacer"></span>${openDocs}
  <button class="cp-icon-button" id="cp-theme" type="button" aria-label="Change color theme">◐</button>
  <div class="cp-account" id="cp-account"><button class="cp-avatar" id="cp-avatar" type="button" aria-label="Open account menu" aria-expanded="false">${escapeHtml(initial)}</button><div class="cp-account-menu"><span class="cp-account-email">${escapeHtml(options.user.email)}</span><a href="/account/security">Account security</a><a href="/api/auth/sign-out">Sign out</a></div></div>
</div></header>
${hasSidebar ? `<aside class="cp-sidebar">${controlNavigation(organizationId ?? "", options.active)}</aside><button class="cp-backdrop" id="cp-backdrop" type="button" aria-label="Close navigation"></button>` : ""}
<main class="cp-main${hasSidebar ? "" : " focused"}"><div class="cp-content${pageClass}">
  <header class="cp-page-head"><div class="cp-page-copy"><p class="eyebrow">${escapeHtml(options.eyebrow)}</p><h1>${escapeHtml(options.heading)}</h1><p class="cp-page-description">${escapeHtml(options.description)}</p></div>${options.actions ? `<div class="cp-page-actions">${options.actions}</div>` : ""}</header>
  ${options.content}
</div></main>
<div class="toast-region" id="cp-toasts" aria-live="polite"></div>
<script>window.__RENDRO_PAGE_STATE__=${state};</script><script>${controlPlaneRuntime}</script><script>${options.script}</script>
</body></html>`;
}
