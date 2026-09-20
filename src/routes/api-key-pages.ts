import { Hono } from "hono";
import type { User } from "better-auth/types";
import { renderControlPlanePage, renderTableLoading } from "./control-plane";
import { apiKeyLoadingPage } from "./management-loading-pages";

const app = new Hono<{ Variables: { user?: User } }>();

const apiKeyScript = String.raw`
(function(){
  "use strict";
  var ui=window.RendroUI.createPageScope?window.RendroUI.createPageScope():window.RendroUI,state=window.__RENDRO_PAGE_STATE__,keyList=document.getElementById("key-list"),form=document.getElementById("key-form"),projectSelect=form.elements.namedItem("projectId"),projects=new Map(),loading=${JSON.stringify(renderTableLoading("Loading API keys", 7))},loadVersion=0;
  function active(){return !ui.isActive||ui.isActive();}
  function h(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  async function load(showLoading){
    var version=++loadVersion,create=document.getElementById("api-key-create");
    create.disabled=true;if(showLoading!==false)keyList.innerHTML=loading;
    try{
      var query="?organizationId="+encodeURIComponent(state.organizationId);
      var organization=await ui.request("/api/rendro/management/access"+query);
      if(version!==loadVersion||!active())return;
      if(!organization)throw new Error("Organization not found.");
      document.querySelectorAll("[data-org-name]").forEach(function(node){if(node.textContent!==organization.name)node.textContent=organization.name;});
      document.querySelectorAll("[data-org-mark]").forEach(function(node){var initial=organization.name.charAt(0).toUpperCase();if(node.textContent!==initial)node.textContent=initial;});
      var member=organization.member;
      var canManage=Boolean(member&&member.role.split(",").some(function(role){return role.trim()==="owner"||role.trim()==="admin";}));
      create.hidden=!canManage;
      if(!canManage){
        keyList.innerHTML='<tr><td colspan="7"><div class="empty compact" role="status"><span class="empty-mark material-symbols-outlined" aria-hidden="true">lock</span><h2>API key access is restricted</h2><p>Only organization owners and admins can view or manage API keys. Ask an admin if you need a project credential.</p><a class="button" id="keys-return-projects">View projects</a></div></td></tr>';
        document.getElementById("keys-return-projects").href="/organizations/"+encodeURIComponent(state.organizationId)+"/projects";
        return;
      }
      var results=await Promise.all([ui.request("/api/rendro/credentials"+query),ui.request("/api/rendro/projects"+query)]);
      if(version!==loadVersion||!active())return;
      projects.clear();projectSelect.innerHTML='<option value="">All projects</option>';
      results[1].projects.forEach(function(project){projects.set(project._id,project);var option=h("option","",project.name);option.value=project._id;projectSelect.append(option);});
      if(results[1].projects.length)projectSelect.value=results[1].projects[0]._id;
      create.disabled=false;renderKeys(results[0].credentials);
    }catch(error){
      if(version!==loadVersion||!active())return;
      keyList.innerHTML='<tr><td colspan="7"><div class="empty compact"><span class="empty-mark">!</span><h2>Unable to load API keys</h2><p></p><button class="button" type="button">Try again</button></div></td></tr>';
      keyList.querySelector("p").textContent=error.message;keyList.querySelector("button").addEventListener("click",load);
    }
  }
  function statusFor(key){if(key.revokedAt)return {label:"Revoked",className:"danger"};if(key.expiresAt&&key.expiresAt<=Date.now())return {label:"Expired",className:"danger"};if(key.expiresAt&&key.expiresAt-Date.now()<7*86400000)return {label:"Expiring",className:"warning"};return {label:"Active",className:"success"};}
  function renderKeys(keys){keyList.innerHTML="";if(!keys.length){keyList.innerHTML='<tr><td colspan="7"><div class="empty compact"><span class="empty-mark material-symbols-outlined" aria-hidden="true">key</span><h2>No API keys yet</h2><p>Create a project-scoped key for a person, machine, or CI workflow.</p><button class="button primary" type="button" data-dialog-open="key-dialog">Create API key</button></div></td></tr>';keyList.querySelector("button").addEventListener("click",function(){ui.openDialog("key-dialog");});return;}keys.forEach(function(key){var status=statusFor(key),tr=h("tr");var name=h("td");name.dataset.label="Name";var primary=h("span","cell-primary");primary.append(h("strong","",key.name),h("code","cell-secondary",key.keyPrefix+"********"));name.append(primary);var scope=h("td","",key.projectId&&projects.get(key.projectId)?projects.get(key.projectId).name:"All projects");scope.dataset.label="Scope";var permissions=h("td");permissions.dataset.label="Permissions";var scopeWrap=h("span","scope-list");key.scopes.forEach(function(permission){scopeWrap.append(h("span","badge",permission));});permissions.append(scopeWrap);var lastUsed=h("td","",key.lastUsedAt?new Date(key.lastUsedAt).toLocaleDateString():"Never");lastUsed.dataset.label="Last used";var expires=h("td","",key.expiresAt?new Date(key.expiresAt).toLocaleDateString():"Never");expires.dataset.label="Expires";var statusCell=h("td");statusCell.dataset.label="Status";statusCell.append(h("span","badge "+status.className,status.label));var actions=h("td");actions.dataset.label="Action";var revoke=h("button","button danger small",key.revokedAt?"Revoked":"Revoke");revoke.disabled=Boolean(key.revokedAt);revoke.addEventListener("click",async function(){if(!confirm("Revoke "+key.name+"? Any job using it will stop immediately."))return;ui.busy(revoke,true);try{await ui.request("/api/rendro/credentials/revoke",{method:"POST",body:JSON.stringify({organizationId:state.organizationId,keyId:key.keyId})});if(!active())return;ui.toast("API key revoked.");await load();}catch(error){if(!active())return;ui.busy(revoke,false);ui.toast(error.message,"error");}});actions.append(revoke);tr.append(name,scope,permissions,lastUsed,expires,statusCell,actions);keyList.append(tr);});}
  function showSecret(rawKey){var dialog=document.getElementById("secret-dialog"),done=document.getElementById("secret-done"),confirmed=document.getElementById("secret-confirmed");document.getElementById("raw-key").textContent=rawKey;confirmed.checked=false;done.disabled=true;confirmed.onchange=function(){done.disabled=!confirmed.checked;};dialog.oncancel=function(event){if(!confirmed.checked){event.preventDefault();ui.toast("Confirm that the key is stored before closing.","error");}};function clearSecret(){rawKey="";var key=dialog.querySelector("#raw-key");if(key)key.textContent="";var copyKey=dialog.querySelector("#copy-key"),copyEnv=dialog.querySelector("#copy-env");if(copyKey)copyKey.onclick=null;if(copyEnv)copyEnv.onclick=null;done.onclick=null;confirmed.onchange=null;dialog.oncancel=null;dialog.onclose=null;}done.onclick=function(){if(!confirmed.checked)return;dialog.close();clearSecret();};dialog.onclose=clearSecret;if(ui.onCleanup)ui.onCleanup(clearSecret);function copy(button,value,label){ui.copyText(button,value,label).catch(function(){ui.toast("Unable to copy. Select and copy the key manually.","error");});}document.getElementById("copy-key").onclick=function(){copy(this,rawKey,"Copy key");};document.getElementById("copy-env").onclick=function(){copy(this,'RENDRO_API_KEY="'+rawKey+'"',"Copy environment variable");};dialog.showModal();}
  form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),error=document.getElementById("key-error"),scopes=Array.from(form.querySelectorAll('[name="scope"]:checked')).map(function(input){return input.value;});error.textContent="";if(!scopes.length){error.textContent="Choose at least one permission.";return;}ui.busy(button,true);var expiry=form.elements.namedItem("expiry").value;try{var result=await ui.request("/api/rendro/credentials",{method:"POST",body:JSON.stringify({organizationId:state.organizationId,projectId:projectSelect.value||undefined,name:form.elements.namedItem("name").value.trim(),scopes:scopes,expiresAt:expiry?Date.now()+Number(expiry)*86400000:undefined})});if(!active())return;document.getElementById("key-dialog").close();form.reset();form.elements.namedItem("expiry").value="90";ui.busy(button,false);showSecret(result.rawKey);await load();}catch(reason){if(!active())return;error.textContent=reason.message;ui.busy(button,false);}});
  load(false);
})();
`;

function renderApiKeyPage(user: User, organizationId: string): string {
  return renderControlPlanePage({
    ...apiKeyLoadingPage(),
    user,
    title: "API keys",
    organizationId,
    active: "api-keys",
    state: { organizationId, userId: user.id },
    content: `${apiKeyLoadingPage().content}<dialog class="cp-dialog" id="key-dialog"><div class="dialog-head"><div><h2>Create API key</h2><p>Use one credential for each person, machine, or workflow.</p></div><button class="dialog-close" type="button" data-dialog-close aria-label="Close API key dialog">Close</button></div><form id="key-form"><div class="dialog-body"><div class="form-grid"><label class="field"><span>Display name</span><input class="input" name="name" required maxlength="80" placeholder="GitHub Actions"></label><label class="field"><span>Project scope</span><select class="select" name="projectId"><option value="">All projects</option></select><small>Project scope is recommended for CI credentials.</small></label><label class="field"><span>Expiration</span><select class="select" name="expiry"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">1 year</option><option value="">Never</option></select></label><div><p class="field-label">Permissions</p><div class="checks"><label class="check"><input type="checkbox" name="scope" value="docs:read" checked> Read deployments</label><label class="check"><input type="checkbox" name="scope" value="docs:write" checked> Push documentation</label><label class="check"><input type="checkbox" name="scope" value="publications:read"> Read publications</label><label class="check"><input type="checkbox" name="scope" value="publications:write"> Manage publications</label></div></div><p class="message error" id="key-error" role="alert"></p></div></div><div class="dialog-footer"><button class="button" type="button" data-dialog-close>Cancel</button><button class="button primary" type="submit"><span class="button-label">Create API key</span></button></div></form></dialog>
<dialog class="cp-dialog secret-dialog" id="secret-dialog"><div class="dialog-head"><div><h2>API key created</h2><p>This secret is shown once. Store it before closing.</p></div></div><div class="dialog-body"><div class="secret-box"><strong>Secret key</strong><span>Use this value as <code>RENDRO_API_KEY</code> in your CI secret manager.</span><div class="secret-value"><code id="raw-key"></code><button class="button" id="copy-key" type="button">Copy key</button></div></div><button class="button wide-button" id="copy-env" type="button">Copy environment variable</button><label class="check secret-confirm"><input id="secret-confirmed" type="checkbox"> I have stored this key securely</label></div><div class="dialog-footer"><button class="button primary" id="secret-done" type="button" disabled>Done</button></div></dialog>
`,
    script: apiKeyScript,
  });
}

app.get("/organizations/:organizationId/api-keys", (c) => {
  const organizationId = c.req.param("organizationId");
  const user = c.get("user");
  const returnTo = `/organizations/${encodeURIComponent(organizationId)}/api-keys`;
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  return c.html(renderApiKeyPage(user, organizationId));
});

export default app;
