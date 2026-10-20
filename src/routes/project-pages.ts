import { managementPageAccess } from "./management-page-access";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { renderControlPlanePage } from "./control-plane";
import { organizationContextScript } from "./organization-context";
import { projectLoading, renderProjectLoadingPage } from "./management-loading";
import { renderSessionUnavailablePage } from "./session-unavailable";

const app = new Hono<{ Variables: { user?: User } }>();


const projectPageScript = String.raw`
(function(){
  "use strict";
  var RUI=window.RendroUI,ui=RUI.createPageScope?RUI.createPageScope():RUI,state=window.__RENDRO_PAGE_STATE__,mount=document.getElementById("project-content"),base="/organizations/"+encodeURIComponent(state.organizationId)+"/projects",canManage=false,loadVersion=0,loading=${JSON.stringify(projectLoading(""))},detailLoading=${JSON.stringify(projectLoading("project"))};
  function active(){return !ui.isActive||ui.isActive();}
  function h(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function setChrome(organization){if(!active())return;var name=organization.name||"Organization",mark=(organization.name||"R").charAt(0).toUpperCase();window.RendroUI.setOrganizationChrome(name,mark);}
  function setAccess(organization){var member=organization.member,roles=member?String(member.role||"").split(",").map(function(role){return role.trim();}):[];canManage=roles.some(function(role){return role==="owner"||role==="admin";});var trigger=document.getElementById("project-create"),dialog=document.getElementById("project-dialog");if(trigger){trigger.hidden=!canManage;trigger.disabled=!canManage;}form.querySelectorAll('[name="name"],[name="slug"],button[type="submit"]').forEach(function(control){control.disabled=!canManage;});if(!canManage&&dialog.open)dialog.close();}
  function applyOrganization(organization){setChrome(organization);setAccess(organization);}
  function slugify(value){return value.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,48);}
  async function renderList(version){var query="?organizationId="+encodeURIComponent(state.organizationId),organizationRequest=window.RendroUI.organizationContext.access(ui,state.organizationId);organizationRequest.then(function(organization){if(active())setChrome(organization);}).catch(function(){});var results=await Promise.all([ui.request("/api/rendro/projects"+query),organizationRequest]);if(!active()||version!==loadVersion)return;var data=results[0];applyOrganization(results[1]);mount.innerHTML='<section class="panel"><div class="panel-head panel-pad list-head"><div><h2>Organization projects</h2><p>Each project is one documentation product of this organization.</p></div></div><div class="project-list" id="project-list"></div></section>';var list=document.getElementById("project-list");if(!data.projects.length){list.innerHTML='<div class="empty compact"><span class="empty-mark material-symbols-outlined" aria-hidden="true">folder</span><h2>No projects yet</h2><p>'+(canManage?'Create the first documentation product for this organization.':'An owner or admin can create the first documentation product.')+'</p>'+(canManage?'<button class="button primary" type="button">Create project</button>':'')+'</div>';var create=list.querySelector("button");if(create)create.addEventListener("click",function(){ui.openDialog("project-dialog");});return;}data.projects.forEach(function(project){var link=h("a","project-row");link.href=base+"/"+encodeURIComponent(project._id);var mark=h("span","project-mark",project.name.slice(0,2).toUpperCase()),copy=h("span","cell-primary");copy.append(h("strong","",project.name),h("span","cell-secondary",project.slug));link.append(mark,copy,h("span","project-arrow","Open"));list.append(link);});}
  async function renderDetail(version){
    var query="?organizationId="+encodeURIComponent(state.organizationId)+"&projectId="+encodeURIComponent(state.projectId),organizationRequest=window.RendroUI.organizationContext.access(ui,state.organizationId);
    organizationRequest.then(function(organization){if(active())setChrome(organization);}).catch(function(){});
    var results=await Promise.all([ui.request("/api/rendro/projects/get"+query),organizationRequest]);
    if(!active()||version!==loadVersion)return;
    var project=results[0].project;
    applyOrganization(results[1]);
    document.querySelector(".cp-page-heading").textContent=project.name;
    document.querySelector(".cp-page-description").textContent="Stable identifiers for "+project.slug+".";
    mount.innerHTML='<div class="project-overview"><section class="panel panel-pad"><div class="panel-head"><div><h2>Project overview</h2><p>Stable identifiers of this documentation product.</p></div></div><dl class="detail-list"><div><dt>Project ID</dt><dd id="project-id"></dd></div><div><dt>Slug</dt><dd id="project-slug"></dd></div><div><dt>Created</dt><dd id="project-created"></dd></div></dl></section></div>';
    document.getElementById("project-id").append(RUI.idValue(project._id,{copy:true,label:"project ID"}));
    document.getElementById("project-slug").textContent=project.slug;
    document.getElementById("project-created").textContent=new Date(project.createdAt).toLocaleDateString();
  }

  var form=document.getElementById("project-form"),name=form.elements.namedItem("name"),slug=form.elements.namedItem("slug"),touched=false;slug.addEventListener("input",function(){touched=true;});name.addEventListener("input",function(){if(!touched)slug.value=slugify(name.value);});form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),error=document.getElementById("project-error");if(button.getAttribute("aria-busy")==="true")return;error.textContent="";if(!canManage){error.textContent="Only organization owners and admins can create projects.";return;}ui.busy(button,true);try{var result=await ui.request("/api/rendro/projects",{method:"POST",body:JSON.stringify({organizationId:state.organizationId,name:name.value.trim(),slug:slug.value.trim()})});if(!active())return;ui.busy(button,false);document.getElementById("project-dialog").close();var destination=base+"/"+encodeURIComponent(result.project._id);if(window.RendroUI.navigate)await window.RendroUI.navigate(destination);else location.assign(destination);}catch(reason){if(!active())return;error.textContent=reason.message;ui.busy(button,false);}});
  async function load(){var endBatch=ui.beginReadBatch?ui.beginReadBatch():function(){};var version=++loadVersion;if(version>1||!mount.querySelector(".loading-view"))mount.innerHTML=state.projectId?detailLoading:loading;try{await (state.projectId?renderDetail(version):renderList(version));}catch(error){if(!active()||version!==loadVersion)return;mount.innerHTML='<section class="panel empty"><span class="empty-mark material-symbols-outlined" aria-hidden="true">error</span><h2>Unable to load projects</h2><p></p><button class="button" type="button">Try again</button></section>';mount.querySelector("p").textContent=error.message;mount.querySelector("button").addEventListener("click",load);}finally{endBatch();}}
  var knownDisplay=window.RendroUI.organizationContext.display(state.organizationId);if(knownDisplay)setChrome(knownDisplay);
  load();
})();
`;

export function renderProjectPage(user: User, organizationId: string, projectId = ""): string {
  const loadingPage = renderProjectLoadingPage(organizationId, projectId);
  return renderControlPlanePage({
    user,
    title: projectId ? "Project" : "Projects",
    eyebrow: loadingPage.eyebrow,
    heading: loadingPage.heading,
    description: loadingPage.description,
    organizationId,
    projectId: projectId || undefined,
    active: "projects",
    actions: loadingPage.actions,
    state: { organizationId, projectId, userId: user.id },
    content: loadingPage.content + '<dialog class="cp-dialog" id="project-dialog"><div class="dialog-head"><div><h2>Create project</h2><p>Use one project per documentation product.</p></div><button class="dialog-close" type="button" data-dialog-close aria-label="Close project dialog">Close</button></div><form id="project-form"><div class="dialog-body"><div class="form-grid"><label class="field"><span>Project name</span><input class="input" name="name" required maxlength="80" placeholder="Product documentation" disabled></label><label class="field"><span>Project slug</span><input class="input" name="slug" required maxlength="48" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="product-docs" disabled><small>Generated from the name until you edit it.</small></label><p class="message error" id="project-error" role="alert"></p></div></div><div class="dialog-footer"><button class="button" type="button" data-dialog-close>Cancel</button><button class="button primary" type="submit" disabled><span class="button-label">Create project</span></button></div></form></dialog>',
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

// Onboarding continues to a new project's page, so, as for the organization pages, a committed error document
// must offer a GET retry: the completed form in the previous document is no longer available.
app.onError(async (error, c) => {
  const { logger } = await import("@/logger");
  logger.error({ errorType: error.name }, "Project page failed");
  c.header("Cache-Control", "private, no-store");
  return c.html(renderSessionUnavailablePage(500), 500);
});

export default app;
