
/**
 * Shared management vocabulary and small browser helpers.
 *
 * Every management screen renders statuses, roles and API-key permissions
 * through these maps so the same state never appears under different words or
 * as a raw lowercase value. The browser runtime below exposes the same maps on
 * `window.RendroUI` for client-rendered rows.
 */
export const MANAGEMENT_LABELS = {
  /** Record lifecycle states. */
  status: {
    active: "Active",
    pending: "Pending",
    expiring: "Expiring",
    expired: "Expired",
    revoked: "Revoked",
  },
  role: {
    owner: "Owner",
    admin: "Admin",
    member: "Member",
  },
  /** Scopes accepted by `convex/credentialHttp.ts`. */
  scope: {
    "docs:read": "Read deployments",
    "docs:write": "Push documentation",
    "publications:read": "Read publications",
    "publications:write": "Manage publications",
  },
} as const;

export type ManagementLabelKind = keyof typeof MANAGEMENT_LABELS;
export type ApiKeyScope = keyof typeof MANAGEMENT_LABELS.scope;

export const API_KEY_SCOPES = Object.keys(MANAGEMENT_LABELS.scope) as ApiKeyScope[];
/** The permissions a new key starts with. */
export const RECOMMENDED_API_KEY_SCOPES: ApiKeyScope[] = ["docs:read", "docs:write"];

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function managementLabel(kind: ManagementLabelKind, value: string | null | undefined): string {
  const map = MANAGEMENT_LABELS[kind] as Record<string, string>;
  const key = String(value ?? "");
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : titleCase(key);
}

/** Checkbox set for API-key permissions, grouped for assistive technology. */
export function renderScopeFieldset(scopes: readonly ApiKeyScope[] = API_KEY_SCOPES, checked: readonly ApiKeyScope[] = RECOMMENDED_API_KEY_SCOPES): string {
  const options = scopes.map((scope) => `<label class="check"><input type="checkbox" name="scope" value="${scope}"${checked.includes(scope) ? " checked" : ""}> ${MANAGEMENT_LABELS.scope[scope]}</label>`).join("");
  return `<fieldset class="scope-fieldset"><legend class="field-label">Permissions</legend><div class="checks">${options}</div></fieldset>`;
}

/**
 * Browser helpers mounted on `window.RendroUI` by the control-plane shell:
 * `label`, `idValue` and the promise-based
 * `confirm` dialog used for every destructive action.
 */
export const managementUiRuntime = String.raw`
(function(){
  "use strict";
  var ui=window.RendroUI;if(!ui)return;
  var LABELS=${JSON.stringify(MANAGEMENT_LABELS)};
  function titleCase(value){return String(value).replace(/[_-]+/g," ").replace(/\b\w/g,function(character){return character.toUpperCase();});}
  function label(kind,value){var map=LABELS[kind]||{},key=String(value==null?"":value);return Object.prototype.hasOwnProperty.call(map,key)?map[key]:titleCase(key);}
  var copyTimers=new WeakMap();
  function idValue(value,options){
    options=options||{};var wrap=document.createElement("span"),code=document.createElement("code");
    wrap.className="cp-id-value"+(options.className?" "+options.className:"");code.className="cp-id";code.textContent=value;code.title=value;wrap.append(code);
    if(options.copy){
      var name=options.label||"ID",button=document.createElement("button"),icon=document.createElement("span");
      button.type="button";button.className="cp-id-copy";button.setAttribute("aria-label","Copy "+name);button.title="Copy "+name;
      icon.className="material-symbols-outlined";icon.setAttribute("aria-hidden","true");icon.textContent="content_copy";button.append(icon);
      button.addEventListener("click",function(){var previous=copyTimers.get(button);if(previous)clearTimeout(previous);navigator.clipboard.writeText(value).then(function(){icon.textContent="check";button.setAttribute("aria-label",name+" copied");copyTimers.set(button,setTimeout(function(){icon.textContent="content_copy";button.setAttribute("aria-label","Copy "+name);},1500));},function(){if(ui.toast)ui.toast("Unable to copy. Select the value and copy it manually.","error");});});
      wrap.append(button);
    }
    return wrap;
  }
  // The organization name and mark sit in the switcher the reader may be pressing while this page hydrates. WebKit drops a
  // click whose pressed text node is removed before release, so a changed label is rewritten in place, never replaced.
  function setText(node,value){var kids=node.childNodes;if(kids&&kids.length===1&&kids[0].nodeType===3){if(kids[0].data!==value)kids[0].data=value;}else if(node.textContent!==value)node.textContent=value;}
  function setOrganizationChrome(name,mark){document.querySelectorAll("[data-org-name]").forEach(function(node){setText(node,name);});document.querySelectorAll("[data-org-mark]").forEach(function(node){setText(node,mark);});}
  var dialog=null,resolver=null,returnFocus=null;
  function finish(result){var resolve=resolver;resolver=null;var target=returnFocus;returnFocus=null;if(dialog&&dialog.open)dialog.close();if(!document.documentElement.dataset.rendroSignedOut&&target&&target.isConnected&&typeof target.focus==="function")target.focus({preventScroll:true});if(resolve)resolve(result);}
  addEventListener("commentor-sign-out",function(){finish(false);});
  function confirmDialog(){
    if(dialog&&dialog.isConnected)return dialog;
    dialog=document.createElement("dialog");dialog.className="cp-dialog cp-confirm-dialog";dialog.id="cp-confirm-dialog";dialog.dataset.dialogReady="true";
    dialog.setAttribute("aria-labelledby","cp-confirm-title");dialog.setAttribute("aria-describedby","cp-confirm-message");
    dialog.innerHTML='<div class="dialog-head"><div><h2 id="cp-confirm-title"></h2><p id="cp-confirm-message"></p></div></div><div class="dialog-footer"><button class="button" type="button" data-confirm-cancel>Cancel</button><button class="button" type="button" data-confirm-accept></button></div>';
    dialog.querySelector("[data-confirm-cancel]").addEventListener("click",function(){finish(false);});
    dialog.querySelector("[data-confirm-accept]").addEventListener("click",function(){finish(true);});
    dialog.addEventListener("cancel",function(event){event.preventDefault();finish(false);});
    dialog.addEventListener("click",function(event){if(event.target===dialog)finish(false);});
    dialog.addEventListener("close",function(){if(resolver)finish(false);});
    (document.querySelector(".cp-main")||document.body).append(dialog);
    return dialog;
  }
  function confirmAction(options){
    options=options||{};if(resolver)finish(false);
    var node=confirmDialog(),accept=node.querySelector("[data-confirm-accept]");
    node.querySelector("#cp-confirm-title").textContent=options.title||"Are you sure?";
    node.querySelector("#cp-confirm-message").textContent=options.message||"";
    accept.textContent=options.confirmLabel||"Confirm";accept.className="button "+(options.destructive===false?"primary":"destructive");
    if(typeof node.showModal!=="function")return Promise.resolve(window.confirm((options.title||"")+"\n\n"+(options.message||"")));
    returnFocus=document.activeElement;
    return new Promise(function(resolve){resolver=resolve;node.showModal();node.querySelector("[data-confirm-cancel]").focus();});
  }
  Object.assign(ui,{label:label,idValue:idValue,setOrganizationChrome:setOrganizationChrome,confirm:confirmAction});
})();
`;

export const managementUiStyles = String.raw`
.button.destructive{border-color:var(--cp-danger-strong);background:var(--cp-danger-strong);color:var(--cp-on-danger)}
.button.destructive:hover:not(:disabled):not([aria-disabled=true]){border-color:var(--cp-danger-hover);background:var(--cp-danger-hover)}
.cp-confirm-dialog{width:min(440px,calc(100vw - 28px))}
.cp-confirm-dialog .dialog-head{border-bottom:0;padding-bottom:18px}
.cp-confirm-dialog .dialog-head p{color:var(--cp-muted-strong)}
.cp-id-value{min-width:0;max-width:100%;display:inline-flex;align-items:center;gap:4px;vertical-align:middle}
.cp-id{min-width:0;max-width:100%;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;font-weight:500}
.cp-id-copy{width:28px;height:28px;flex:none;display:inline-grid;place-items:center;padding:0;border:0;border-radius:4px;background:transparent;color:var(--cp-muted-strong);cursor:pointer;transition:background var(--cp-instant) var(--cp-ease),color var(--cp-instant) var(--cp-ease),transform var(--cp-instant) var(--cp-ease)}
.cp-id-copy .material-symbols-outlined{font-size:16px}
.cp-id-copy:hover{background:var(--cp-container);color:var(--cp-strong)}
.cp-id-copy:active{transform:scale(.98)}
.scope-fieldset{min-width:0;margin:0;padding:0;border:0}
.scope-fieldset .field-label{margin:0 0 8px;padding:0;color:var(--cp-strong);font-size:13px;font-weight:600}
.scope-fieldset .checks{display:grid;gap:4px}
@media(max-width:760px){.cp-id-copy{width:44px;height:44px}}
@media(prefers-reduced-motion:reduce){.cp-id-copy:active{transform:none}}
`;
