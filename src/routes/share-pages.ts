import { Hono } from "hono";
import type { User } from "better-auth/types";
import { renderControlPlanePage, renderTableLoading } from "./control-plane";
import { shareLoadingPage } from "./management-loading-pages";

const app = new Hono<{ Variables: { user?: User } }>();

const shareScript = String.raw`
(function(){
  "use strict";
  var RUI=window.RendroUI,ui=RUI.createPageScope?RUI.createPageScope():RUI,state=window.__RENDRO_PAGE_STATE__,list=document.getElementById("share-list"),query="?organizationId="+encodeURIComponent(state.organizationId)+"&projectId="+encodeURIComponent(state.projectId),loading=${JSON.stringify(renderTableLoading("Loading private shares", 5))},loadVersion=0,canManage=false,docsHref="/organizations/"+encodeURIComponent(state.organizationId)+"/projects/"+encodeURIComponent(state.projectId)+"/docs",deployed=false;
  function active(){return !ui.isActive||ui.isActive();}
  function h(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function setAccess(organization){var member=organization.member,roles=member?String(member.role||"").split(",").map(function(role){return role.trim();}):[];canManage=roles.some(function(role){return role==="owner"||role==="admin";});if(!active())return;document.getElementById("share-access-note").hidden=canManage;}
  function statusFor(item){if(item.revokedAt)return {label:"Revoked",className:"danger"};if(item.expiresAt<=Date.now())return {label:"Expired",className:"danger"};if(item.expiresAt-Date.now()<86400000)return {label:"Expiring",className:"warning"};return {label:"Active",className:"success"};}
  function render(items){list.innerHTML="";if(!items.length){list.innerHTML='<tr><td colspan="5"><div class="empty compact"><span class="empty-mark material-symbols-outlined" aria-hidden="true">link</span><h2>No private shares yet</h2><p>'+(deployed?'Open a document and create a revocable share from the document toolbar.':'Private shares are created from documentation after the first deployment.')+'</p>'+(deployed?'<a class="button primary" href="'+docsHref+'">Browse documentation</a>':'<a class="button" href="/organizations/'+encodeURIComponent(state.organizationId)+'/projects/'+encodeURIComponent(state.projectId)+'/deployments">View deployments</a>')+'</div></td></tr>';return;}items.forEach(function(item){var tr=h("tr"),status=statusFor(item);var documentCell=h("td");documentCell.dataset.label="Document";var copy=h("span","cell-primary");copy.append(h("strong","",item.documentPath));documentCell.append(copy);var deployment=h("td");deployment.dataset.label="Deployment";deployment.append(RUI.idValue(item.deploymentId));var expiry=h("td","",new Date(item.expiresAt).toLocaleString());expiry.dataset.label="Expires";var statusCell=h("td");statusCell.dataset.label="Status";statusCell.append(h("span","badge "+status.className,status.label));var action=h("td");action.dataset.label="Action";if(canManage&&!item.revokedAt&&item.expiresAt>Date.now()){var revoke=h("button","button danger small","Revoke");revoke.onclick=async function(){if(!(await ui.confirm({title:"Revoke private share?",message:"The link to "+item.documentPath+" will stop resolving immediately.",confirmLabel:"Revoke share"})))return;ui.busy(revoke,true);try{await ui.request("/api/rendro/shares/revoke",{method:"POST",body:JSON.stringify({organizationId:state.organizationId,grantId:item._id})});if(!active())return;ui.toast("Private share revoked.");await load();}catch(error){if(!active())return;ui.busy(revoke,false);ui.toast(error.message,"error");}};action.append(revoke);}else if(!canManage)action.append(h("span","cell-secondary","Owner/admin only"));tr.append(documentCell,deployment,expiry,statusCell,action);list.append(tr);});}
  async function load(showLoading){var version=++loadVersion;if(showLoading!==false)list.innerHTML=loading;try{var results=await Promise.all([ui.request("/api/rendro/shares"+query),ui.request("/api/rendro/projects/get"+query),ui.request("/api/rendro/management/access?organizationId="+encodeURIComponent(state.organizationId))]);if(version!==loadVersion||!active())return;var project=results[1].project,organization=results[2];document.querySelectorAll("[data-org-name]").forEach(function(node){if(node.textContent!==organization.name)node.textContent=organization.name;});document.querySelectorAll("[data-org-mark]").forEach(function(node){var initial=organization.name.charAt(0).toUpperCase();if(node.textContent!==initial)node.textContent=initial;});setAccess(organization);deployed=Boolean(project.activeDeploymentId);ui.setDocsLink(deployed?docsHref:"",state.projectId);var browse=document.getElementById("share-browse-docs");if(browse)browse.hidden=!deployed;document.querySelector(".cp-page-description").textContent="Revocable, expiring links pinned to immutable deployments in "+project.name+".";render(results[0].shares);}catch(error){if(version!==loadVersion||!active())return;list.innerHTML='<tr><td colspan="5"><div class="empty compact"><span class="empty-mark">!</span><h2>Unable to load private shares</h2><p></p><button class="button" type="button">Try again</button></div></td></tr>';list.querySelector("p").textContent=error.message;list.querySelector("button").addEventListener("click",load);}}
  load(false);
})();
`;

function page(user: User, organizationId: string, projectId: string): string {
  return renderControlPlanePage({
    ...shareLoadingPage(organizationId, projectId),
    user,
    title: "Private shares",
    organizationId,
    active: "projects",
    projectId,
    state: { organizationId, projectId, userId: user.id },
    content: `${shareLoadingPage(organizationId, projectId).content}`,
    script: shareScript,
  });
}

app.get("/organizations/:organizationId/projects/:projectId/shares", (c) => {
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const user = c.get("user");
  const returnTo = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/shares`;
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  return c.html(page(user, organizationId, projectId));
});

export default app;
