import { Hono } from "hono";
import type { User } from "better-auth/types";
import { renderControlPlanePage, renderTableLoading } from "./control-plane";

const app = new Hono<{ Variables: { user?: User } }>();

const shareScript = String.raw`
(function(){
  "use strict";
  var ui=window.RendroUI,state=window.__RENDRO_PAGE_STATE__,list=document.getElementById("share-list"),query="?organizationId="+encodeURIComponent(state.organizationId)+"&projectId="+encodeURIComponent(state.projectId),loading=${JSON.stringify(renderTableLoading("Loading private shares", 5))},loadVersion=0;
  function h(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  var projectNav=document.querySelector(".project-tabs"),deploymentLink=h("a","", "Deployments");deploymentLink.href="/organizations/"+encodeURIComponent(state.organizationId)+"/projects/"+encodeURIComponent(state.projectId)+"#deployments";projectNav.insertBefore(deploymentLink,projectNav.children[1]);projectNav.querySelector(".active").setAttribute("aria-current","page");
  function statusFor(item){if(item.revokedAt)return {label:"Revoked",className:"danger"};if(item.expiresAt<=Date.now())return {label:"Expired",className:"danger"};if(item.expiresAt-Date.now()<86400000)return {label:"Expiring",className:"warning"};return {label:"Active",className:"success"};}
  function render(items){list.innerHTML="";if(!items.length){list.innerHTML='<tr><td colspan="5"><div class="empty compact"><span class="empty-mark">S</span><h2>No private shares yet</h2><p>Open a document and create a revocable share from the document toolbar.</p><a class="button primary" href="/organizations/'+encodeURIComponent(state.organizationId)+'/projects/'+encodeURIComponent(state.projectId)+'/docs">Browse documentation</a></div></td></tr>';return;}items.forEach(function(item){var tr=h("tr"),status=statusFor(item);var documentCell=h("td");documentCell.dataset.label="Document";var copy=h("span","cell-primary");copy.append(h("strong","",item.documentPath),h("span","cell-secondary","Deployment "+item.deploymentId.slice(0,12)));documentCell.append(copy);var deployment=h("td","",item.deploymentId.slice(0,12));deployment.dataset.label="Deployment";var expiry=h("td","",new Date(item.expiresAt).toLocaleString());expiry.dataset.label="Expires";var statusCell=h("td");statusCell.dataset.label="Status";statusCell.append(h("span","badge "+status.className,status.label));var action=h("td");action.dataset.label="Action";var revoke=h("button","button danger small",item.revokedAt?"Revoked":"Revoke");revoke.disabled=Boolean(item.revokedAt)||item.expiresAt<=Date.now();revoke.onclick=async function(){if(!confirm("Revoke the share for "+item.documentPath+"? The link will stop resolving immediately."))return;ui.busy(revoke,true);try{await ui.request("/api/rendro/shares/revoke",{method:"POST",body:JSON.stringify({organizationId:state.organizationId,grantId:item._id})});ui.toast("Private share revoked.");await load();}catch(error){ui.busy(revoke,false);ui.toast(error.message,"error");}};action.append(revoke);tr.append(documentCell,deployment,expiry,statusCell,action);list.append(tr);});}
  async function load(){var version=++loadVersion;list.innerHTML=loading;try{var results=await Promise.all([ui.request("/api/rendro/shares"+query),ui.request("/api/rendro/projects/get"+query),ui.request("/api/auth/organization/get-full-organization?organizationId="+encodeURIComponent(state.organizationId))]);if(version!==loadVersion)return;var project=results[1].project,organization=results[2];document.querySelectorAll("[data-org-name]").forEach(function(node){node.textContent=organization.name;});document.querySelectorAll("[data-org-mark]").forEach(function(node){node.textContent=organization.name.charAt(0).toUpperCase();});document.querySelector(".cp-page-description").textContent="Revocable, expiring links pinned to immutable deployments in "+project.name+".";render(results[0].shares);}catch(error){if(version!==loadVersion)return;list.innerHTML='<tr><td colspan="5"><div class="empty compact"><span class="empty-mark">!</span><h2>Unable to load private shares</h2><p></p><button class="button" type="button">Try again</button></div></td></tr>';list.querySelector("p").textContent=error.message;list.querySelector("button").addEventListener("click",load);}}
  load();
})();
`;

function page(user: User, organizationId: string, projectId: string): string {
  const base = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`;
  return renderControlPlanePage({
    user,
    title: "Private shares",
    eyebrow: "Private access",
    heading: "Private shares",
    description: "Revocable links pinned to immutable deployments, with explicit expiry.",
    organizationId,
    active: "projects",
    projectId,
    actions: `<a class="button" href="${base}">Project overview</a><a class="button primary" href="${base}/docs">Browse documentation</a>`,
    state: { organizationId, projectId },
    content: `<nav class="project-tabs" aria-label="Project sections"><a href="${base}">Overview</a><a href="${base}/publications">Publications</a><a class="active" href="${base}/shares">Private shares</a></nav><section class="panel"><div class="table-wrap"><table class="data-table share-table"><thead><tr><th>Document</th><th>Deployment</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody id="share-list">${renderTableLoading("Loading private shares", 5)}</tbody></table></div></section><style>.share-table{min-width:720px}.project-tabs{display:flex;gap:4px;margin-bottom:16px;padding-bottom:1px;border-bottom:1px solid var(--cp-border);overflow-x:auto}.project-tabs a{position:relative;padding:9px 12px;color:var(--cp-muted);text-decoration:none}.project-tabs a:hover,.project-tabs a.active{color:var(--cp-strong)}.project-tabs a.active:after{content:"";position:absolute;inset:auto 8px -2px;height:2px;background:var(--cp-accent)}</style>`,
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
