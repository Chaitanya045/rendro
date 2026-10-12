import { managementPageAccess } from "./management-page-access";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { renderControlPlanePage } from "./control-plane";
import { organizationContextScript } from "./organization-context";
import { deploymentHistoryLoading, projectLoading, renderDeploymentHistoryPanel, renderProjectLoadingPage, renderProjectNavigation } from "./management-loading";

const app = new Hono<{ Variables: { user?: User } }>();


const projectPageScript = String.raw`
(function(){
  "use strict";
  var RUI=window.RendroUI,ui=RUI.createPageScope?RUI.createPageScope():RUI,state=window.__RENDRO_PAGE_STATE__,mount=document.getElementById("project-content"),base="/organizations/"+encodeURIComponent(state.organizationId)+"/projects",canManage=false,loadVersion=0,loading=${JSON.stringify(projectLoading(""))},detailLoading=state.section==="deployments"?state.projectNavigation+${JSON.stringify(projectLoading("project","deployments"))}:${JSON.stringify(projectLoading("project"))};
  function active(){return !ui.isActive||ui.isActive();}
  function h(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function setChrome(organization){if(!active())return;var name=organization.name||"Organization",mark=(organization.name||"R").charAt(0).toUpperCase();document.querySelectorAll("[data-org-name]").forEach(function(node){if(node.textContent!==name)node.textContent=name;});document.querySelectorAll("[data-org-mark]").forEach(function(node){if(node.textContent!==mark)node.textContent=mark;});}
  function setAccess(organization){var member=organization.member,roles=member?String(member.role||"").split(",").map(function(role){return role.trim();}):[];canManage=roles.some(function(role){return role==="owner"||role==="admin";});var trigger=document.getElementById("project-create"),dialog=document.getElementById("project-dialog");if(trigger){trigger.hidden=!canManage;trigger.disabled=!canManage;}form.querySelectorAll('[name="name"],[name="slug"],button[type="submit"]').forEach(function(control){control.disabled=!canManage;});if(!canManage&&dialog.open)dialog.close();}
  function applyOrganization(organization){setChrome(organization);setAccess(organization);}
  function slugify(value){return value.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,48);}
  function tabs(){return state.projectNavigation;}
  function releaseBadge(project){var deployed=Boolean(project.activeDeploymentId);return h("span","badge"+(deployed?" success":""),RUI.label("release",deployed?"deployed":"undeployed"));}
  async function renderList(version){var query="?organizationId="+encodeURIComponent(state.organizationId),organizationRequest=window.RendroUI.organizationContext.access(ui,state.organizationId);organizationRequest.then(function(organization){if(active())setChrome(organization);}).catch(function(){});var results=await Promise.all([ui.request("/api/rendro/projects"+query),organizationRequest]);if(!active()||version!==loadVersion)return;var data=results[0];applyOrganization(results[1]);mount.innerHTML='<section class="panel"><div class="panel-head panel-pad list-head"><div><h2>Organization projects</h2><p>Each project owns an immutable deployment history, publications, and private shares.</p></div></div><div class="project-list" id="project-list"></div></section>';var list=document.getElementById("project-list");if(!data.projects.length){list.innerHTML='<div class="empty compact"><span class="empty-mark material-symbols-outlined" aria-hidden="true">folder</span><h2>No projects yet</h2><p>'+(canManage?'Create the first documentation product for this organization.':'An owner or admin can create the first documentation product.')+'</p>'+(canManage?'<button class="button primary" type="button">Create project</button>':'')+'</div>';var create=list.querySelector("button");if(create)create.addEventListener("click",function(){ui.openDialog("project-dialog");});return;}data.projects.forEach(function(project){var link=h("a","project-row");link.href=base+"/"+encodeURIComponent(project._id);var mark=h("span","project-mark",project.name.slice(0,2).toUpperCase()),copy=h("span","cell-primary");copy.append(h("strong","",project.name),h("span","cell-secondary",project.slug));link.append(mark,copy,releaseBadge(project),h("span","project-arrow","Open"));list.append(link);});}
  function publishPanel(command){var panel=h("aside","panel panel-pad deployments-panel");panel.setAttribute("aria-labelledby","publish-cli-title");panel.innerHTML='<div class="panel-head"><div><h2 id="publish-cli-title">Publish from the CLI</h2><p>Pushes stage files, verify the manifest, then atomically switch the active deployment.</p></div></div><div class="command"><code></code><button class="button small" type="button">Copy</button></div>';panel.querySelector("code").textContent=command;panel.querySelector("button").addEventListener("click",function(){ui.copyText(this,command,"Copy").catch(function(){if(active())ui.toast("Unable to copy. Select the command and copy it manually.","error");});});return panel;}
  async function renderDetail(version){
    var query="?organizationId="+encodeURIComponent(state.organizationId)+"&projectId="+encodeURIComponent(state.projectId),deploymentsPage=state.section==="deployments",organizationRequest=window.RendroUI.organizationContext.access(ui,state.organizationId);
    organizationRequest.then(function(organization){if(active())setChrome(organization);}).catch(function(){});
    var historyRequest=deploymentsPage?ui.request("/api/rendro/deployments"+query).then(function(data){return {data:data};},function(error){return {error:error};}):null;
    var results=await Promise.all([ui.request("/api/rendro/projects/get"+query),organizationRequest]);
    if(!active()||version!==loadVersion)return;
    var project=results[0].project,command=RUI.cliPushCommand({organizationId:state.organizationId,projectId:state.projectId,endpoint:location.origin}),docsHref=base+"/"+encodeURIComponent(state.projectId)+"/docs";
    applyOrganization(results[1]);
    ui.setDocsLink(project.activeDeploymentId?docsHref:"",state.projectId);
    document.querySelector(".cp-page-heading").textContent=deploymentsPage?"Deployments":project.name;
    document.querySelector(".cp-page-description").textContent=deploymentsPage?"Release history for "+project.name+" ("+project.slug+"), newest first.":"Immutable deployments and publication controls for "+project.slug+".";
    mount.innerHTML=tabs()+(canManage?'':'<p class="access-note" role="status">You have read-only project access. Owners and admins manage publications and revoke private shares.</p>');
    if(deploymentsPage){
      mount.insertAdjacentHTML("beforeend",${JSON.stringify(renderDeploymentHistoryPanel())});
      mount.append(publishPanel(command));
      loadDeploymentHistory(version,query,historyRequest);
      return;
    }
    mount.insertAdjacentHTML("beforeend",'<div class="project-overview"><section class="panel panel-pad"><div class="panel-head"><div><h2>Project overview</h2><p>Stable identifiers and current release state.</p></div></div><dl class="detail-list"><div><dt>Project ID</dt><dd id="project-id"></dd></div><div><dt>Slug</dt><dd id="project-slug"></dd></div><div><dt>Active deployment</dt><dd id="active-deployment"></dd></div><div><dt>Created</dt><dd id="project-created"></dd></div></dl></section></div>');
    mount.querySelector(".project-overview .panel-head").append(releaseBadge(project));
    document.getElementById("project-id").append(RUI.idValue(project._id,{copy:true,label:"project ID"}));
    document.getElementById("project-slug").textContent=project.slug;
    if(project.activeDeploymentId)document.getElementById("active-deployment").append(RUI.idValue(project.activeDeploymentId,{copy:true,label:"deployment ID"}));else document.getElementById("active-deployment").textContent="None yet";
    document.getElementById("project-created").textContent=new Date(project.createdAt).toLocaleDateString();
    var panel=publishPanel(command);panel.classList.remove("deployments-panel");
    var projectBase=base+"/"+encodeURIComponent(state.projectId);
    panel.insertAdjacentHTML("beforeend",(project.activeDeploymentId?'':'<p class="project-docs-note" role="status"><span class="material-symbols-outlined" aria-hidden="true">schedule</span><span><strong>Waiting for first deployment</strong>Documentation opens after Rendro receives the first CLI push.</span></p>')+'<div class="project-actions">'+(project.activeDeploymentId?'<a class="button primary" href="'+docsHref+'">Open documentation</a>':'<a class="button" href="'+projectBase+'/deployments">View deployments</a>')+'<a class="button" href="'+projectBase+'/publications">'+(canManage?'Manage publications':'View publications')+'</a></div>');
    mount.querySelector(".project-overview").append(panel);
  }
  var deploymentVersion=0;
  async function loadDeploymentHistory(version,query,pending){
    var current=++deploymentVersion,list=document.getElementById("deployment-list"),wrapper=list.closest(".deployment-table-wrap");
    wrapper.classList.add("loading-view");wrapper.setAttribute("aria-busy","true");
    if(!list.querySelector(".skeleton-table-row"))list.innerHTML=${JSON.stringify(deploymentHistoryLoading())};
    var result=await (pending||ui.request("/api/rendro/deployments"+query).then(function(data){return {data:data};},function(error){return {error:error};}));
    if(!active()||version!==loadVersion||current!==deploymentVersion)return;
    wrapper.classList.remove("loading-view");wrapper.setAttribute("aria-busy","false");wrapper.removeAttribute("aria-label");
    if(result.error){list.innerHTML='<tr><td colspan="4"><div class="mini-empty" role="status"><p>Deployment history could not be loaded.</p><button class="button" type="button">Try again</button></div></td></tr>';list.querySelector("button").onclick=function(){loadDeploymentHistory(version,query);};return;}
    var deployments=result.data.deployments||[];
    document.getElementById("deployment-count").textContent=deployments.length+" shown";
    list.innerHTML="";
    if(!deployments.length){list.innerHTML='<tr><td colspan="4"><div class="mini-empty" role="status">No deployments yet. Run the CLI command below to create the first immutable release.</div></td></tr>';return;}
    deployments.forEach(function(deployment){
      var source=deployment.provenance&&deployment.provenance.source||{},row=h("tr","deployment-row");
      var identity=h("span","cell-primary");
      identity.append(h("strong","",new Date(deployment.createdAt).toLocaleString()),RUI.idValue(deployment._id,{className:"cell-secondary"}));
      var provenance=h("span","cell-primary");
      provenance.append(h("strong","",source.commit?source.commit.slice(0,12):source.localPathLabel||"Local source"),h("span","cell-secondary",source.dirty?"Uncommitted source changes":"Source provenance"));
      var size=h("span","cell-primary");
      size.append(h("strong","",String(deployment.fileCount)+" files"),h("span","cell-secondary",Math.round(deployment.byteCount/1024)+" KB"));
      if(deployment.failureReason)provenance.append(h("span","deployment-failure",deployment.failureReason));
      [identity,provenance,size,h("span","badge"+(deployment.status==="active"?" success":deployment.status==="failed"?" danger":""),RUI.label("status",deployment.status))].forEach(function(content,index){var cell=h("td");cell.setAttribute("data-label",["Deployment","Source","Files","Status"][index]);cell.append(content);row.append(cell);});
      list.append(row);
    });
  }

  var form=document.getElementById("project-form"),name=form.elements.namedItem("name"),slug=form.elements.namedItem("slug"),touched=false;slug.addEventListener("input",function(){touched=true;});name.addEventListener("input",function(){if(!touched)slug.value=slugify(name.value);});form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),error=document.getElementById("project-error");if(button.getAttribute("aria-busy")==="true")return;error.textContent="";if(!canManage){error.textContent="Only organization owners and admins can create projects.";return;}ui.busy(button,true);try{var result=await ui.request("/api/rendro/projects",{method:"POST",body:JSON.stringify({organizationId:state.organizationId,name:name.value.trim(),slug:slug.value.trim()})});if(!active())return;ui.busy(button,false);document.getElementById("project-dialog").close();var destination=base+"/"+encodeURIComponent(result.project._id);if(window.RendroUI.navigate)await window.RendroUI.navigate(destination);else location.assign(destination);}catch(reason){if(!active())return;error.textContent=reason.message;ui.busy(button,false);}});
  async function load(){var endBatch=ui.beginReadBatch?ui.beginReadBatch():function(){};var version=++loadVersion;if(version>1||!mount.querySelector(".loading-view"))mount.innerHTML=state.projectId?detailLoading:loading;try{await (state.projectId?renderDetail(version):renderList(version));}catch(error){if(!active()||version!==loadVersion)return;mount.innerHTML='<section class="panel empty"><span class="empty-mark material-symbols-outlined" aria-hidden="true">error</span><h2>Unable to load projects</h2><p></p><button class="button" type="button">Try again</button></section>';mount.querySelector("p").textContent=error.message;mount.querySelector("button").addEventListener("click",load);}finally{endBatch();}}
  var knownDisplay=window.RendroUI.organizationContext.display(state.organizationId);if(knownDisplay)setChrome(knownDisplay);
  load();
})();
`;

export function renderProjectPage(user: User, organizationId: string, projectId = "", section: "overview" | "deployments" = "overview"): string {
  const loadingPage = renderProjectLoadingPage(organizationId, projectId, section);
  return renderControlPlanePage({
    user,
    title: section === "deployments" ? "Deployments" : projectId ? "Project" : "Projects",
    eyebrow: loadingPage.eyebrow,
    heading: loadingPage.heading,
    description: loadingPage.description,
    organizationId,
    projectId: projectId || undefined,
    active: "projects",
    actions: loadingPage.actions,
    state: { organizationId, projectId, section, userId: user.id, projectNavigation: projectId ? renderProjectNavigation(organizationId, projectId, section) : "" },
    content: loadingPage.content + '<dialog class="cp-dialog" id="project-dialog"><div class="dialog-head"><div><h2>Create project</h2><p>Use one project per independently deployed documentation product.</p></div><button class="dialog-close" type="button" data-dialog-close aria-label="Close project dialog">Close</button></div><form id="project-form"><div class="dialog-body"><div class="form-grid"><label class="field"><span>Project name</span><input class="input" name="name" required maxlength="80" placeholder="Product documentation" disabled></label><label class="field"><span>Project slug</span><input class="input" name="slug" required maxlength="48" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="product-docs" disabled><small>Generated from the name until you edit it.</small></label><p class="message error" id="project-error" role="alert"></p></div></div><div class="dialog-footer"><button class="button" type="button" data-dialog-close>Cancel</button><button class="button primary" type="submit" disabled><span class="button-label">Create project</span></button></div></form></dialog>',
    script: organizationContextScript + projectPageScript,
  });
}

app.get("/organizations/:organizationId/projects", managementPageAccess, (c) => {
  const organizationId = c.req.param("organizationId");
  const user = c.get("user");
  const returnTo = `/organizations/${encodeURIComponent(organizationId)}/projects`;
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  return c.html(renderProjectPage(user, organizationId));
});

app.get("/organizations/:organizationId/projects/:projectId", managementPageAccess, (c) => {
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const user = c.get("user");
  const returnTo = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`;
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  return c.html(renderProjectPage(user, organizationId, projectId));
});

app.get("/organizations/:organizationId/projects/:projectId/deployments", managementPageAccess, (c) => {
  const organizationId = c.req.param("organizationId");
  const projectId = c.req.param("projectId");
  const user = c.get("user");
  const returnTo = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}/deployments`;
  if (!user) return c.redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  return c.html(renderProjectPage(user, organizationId, projectId, "deployments"));
});

export default app;
