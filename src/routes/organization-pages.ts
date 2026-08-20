import { Hono } from "hono";
import type { User } from "better-auth/types";
import { renderControlPlanePage, renderLoadingState, type ControlPlaneSection } from "./control-plane";

const app = new Hono<{ Variables: { user?: User } }>();

type OrganizationPageSection = "overview" | "people" | "teams" | "settings";

function signInHref(returnTo: string): string {
  return `/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

function organizationRoute(organizationId: string, suffix = ""): string {
  return `/organizations/${encodeURIComponent(organizationId)}${suffix}`;
}
function loadingRows(count: number): string {
  return Array.from({ length: count }, (_, index) => `<div class="skeleton-row">
    <span class="skeleton skeleton-icon"></span>
    <span class="skeleton-copy">
      <span class="skeleton skeleton-line strong ${index % 2 ? "medium" : "long"}"></span>
      <span class="skeleton skeleton-line ${index % 2 ? "long" : "medium"}"></span>
    </span>
    <span class="skeleton skeleton-pill"></span>
  </div>`).join("");
}

function organizationChooserLoading(): string {
  const card = `<article class="panel skeleton-card">
    <div class="skeleton-card-head"><span class="skeleton skeleton-icon"></span><span class="skeleton-copy"><span class="skeleton skeleton-line strong long"></span><span class="skeleton skeleton-line medium"></span></span></div>
  </article>`;
  return renderLoadingState("Loading organizations", `<div class="organization-grid">${card}${card}</div><div class="chooser-footer"><span class="skeleton skeleton-button"></span></div>`);
}

function organizationSectionLoading(section: OrganizationPageSection): string {
  if (section === "people") {
    const table = `<section class="panel"><div class="panel-pad skeleton-copy"><span class="skeleton skeleton-line strong short"></span><span class="skeleton skeleton-line medium"></span></div><div class="skeleton-table-head"></div><div class="skeleton-list">${loadingRows(3)}</div></section>`;
    return renderLoadingState("Loading people and invitations", table + table);
  }
  if (section === "teams") {
    const team = `<article class="panel skeleton-card"><div class="skeleton-card-head"><span class="skeleton skeleton-icon"></span><span class="skeleton-copy"><span class="skeleton skeleton-line strong medium"></span><span class="skeleton skeleton-line long"></span></span></div>${loadingRows(2)}</article>`;
    return renderLoadingState("Loading teams", `<div class="grid-2">${team}${team}</div>`);
  }
  if (section === "settings") {
    return renderLoadingState("Loading organization settings", `<section class="panel panel-pad settings-panel skeleton-copy">
      <span class="skeleton skeleton-line strong short"></span><span class="skeleton skeleton-line medium"></span>
      <span class="skeleton skeleton-line short"></span><span class="skeleton skeleton-field"></span>
      <span class="skeleton skeleton-line short"></span><span class="skeleton skeleton-field"></span>
      <span class="skeleton skeleton-button"></span>
    </section>`);
  }
  const metric = `<article class="panel metric skeleton-copy"><span class="skeleton skeleton-line strong short"></span><span class="skeleton skeleton-line medium"></span></article>`;
  return renderLoadingState("Loading workspace overview", `<div class="grid-3 overview-metrics">${metric}${metric}${metric}</div>
    <div class="overview-grid">
      <section class="panel"><div class="panel-pad skeleton-copy"><span class="skeleton skeleton-line strong medium"></span><span class="skeleton skeleton-line long"></span></div><div class="skeleton-list">${loadingRows(4)}</div></section>
      <section class="panel panel-pad skeleton-copy"><span class="skeleton skeleton-line strong medium"></span><span class="skeleton skeleton-line long"></span>${loadingRows(3)}</section>
    </div>
    <section class="panel panel-pad recent-panel skeleton-copy"><span class="skeleton skeleton-line strong medium"></span><span class="skeleton skeleton-line long"></span>${loadingRows(1)}</section>`);
}
function onboardingLoading(projectReady: boolean): string {
  return renderLoadingState(projectReady ? "Loading deployment setup" : "Loading project setup", `<div class="skeleton-copy">
    <span class="skeleton skeleton-line strong medium"></span>
    <span class="skeleton skeleton-line long"></span>
    <span class="skeleton skeleton-line short"></span>
    <span class="skeleton skeleton-field"></span>
    <span class="skeleton skeleton-line short"></span>
    <span class="skeleton skeleton-field"></span>
    <span class="skeleton skeleton-button"></span>
  </div>`);
}



const organizationChooserScript = String.raw`
(function(){
  "use strict";
  var ui=window.RendroUI,state=window.__RENDRO_PAGE_STATE__,mount=document.getElementById("organization-state"),loading=${JSON.stringify(organizationChooserLoading())},loadVersion=0;
  function slugify(value){return value.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,48);}
  function organizationCard(organization){var link=document.createElement("a");link.className="panel panel-pad organization-card";link.href="/organizations/"+encodeURIComponent(organization.id);link.innerHTML='<span class="cp-org-mark"></span><span class="cell-primary"><strong></strong><span class="cell-secondary"></span></span><span class="organization-arrow">Open</span>';link.querySelector(".cp-org-mark").textContent=(organization.name||"R").charAt(0).toUpperCase();link.querySelector("strong").textContent=organization.name;link.querySelector(".cell-secondary").textContent=organization.slug;return link;}
  function creationForm(onboarding){mount.innerHTML='<section class="panel panel-pad onboarding"><div class="stepper"><div class="step active"><span class="step-dot">1</span><span>Organization</span></div><div class="step"><span class="step-dot">2</span><span>Project</span></div><div class="step"><span class="step-dot">3</span><span>First deployment</span></div></div><div class="panel-head"><div><h2>Create your organization</h2><p>This is the security boundary for people, projects, credentials, and documentation.</p></div></div><form class="form-grid" id="organization-form"><label class="field"><span>Organization name</span><input class="input" name="name" autocomplete="organization" maxlength="80" required placeholder="Acme Documentation"></label><label class="field"><span>Organization slug</span><input class="input" name="slug" maxlength="48" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="acme-docs"><small>Used in human-readable URLs. You can edit the generated value.</small></label><p class="message error" id="organization-error" role="alert"></p><div class="form-actions"><button class="button primary" type="submit"><span class="button-label">Create organization</span></button></div></form></section>';bindCreation(document.getElementById("organization-form"),onboarding);}
  function bindCreation(form,onboarding){var name=form.elements.namedItem("name"),slug=form.elements.namedItem("slug"),touched=false;slug.addEventListener("input",function(){touched=true;});name.addEventListener("input",function(){if(!touched)slug.value=slugify(name.value);});form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),error=document.getElementById("organization-error");error.textContent="";ui.busy(button,true);try{var organization=await ui.request("/api/auth/organization/create",{method:"POST",body:JSON.stringify({name:name.value.trim(),slug:slug.value.trim(),keepCurrentActiveOrganization:false})});location.assign("/organizations/"+encodeURIComponent(organization.id)+(onboarding?"/onboarding":""));}catch(reason){error.textContent=reason instanceof Error?reason.message:"Unable to create organization.";ui.busy(button,false);}});}
  async function load(){var version=++loadVersion;mount.innerHTML=loading;try{var organizations=await ui.request("/api/auth/organization/list"),choose=new URLSearchParams(location.search).get("choose")==="1";if(version!==loadVersion)return;if(!organizations.length){creationForm(true);return;}if(organizations.length===1&&!choose){location.replace("/organizations/"+encodeURIComponent(organizations[0].id));return;}mount.innerHTML='<div class="organization-grid" id="organization-list"></div><div class="chooser-footer"><button class="button" id="show-create" type="button">New organization</button></div>';var list=document.getElementById("organization-list");organizations.forEach(function(organization){list.appendChild(organizationCard(organization));});document.getElementById("show-create").addEventListener("click",function(){creationForm(false);});}catch(error){if(version!==loadVersion)return;mount.innerHTML='<section class="panel empty"><span class="empty-mark">!</span><h2>Unable to load organizations</h2><p></p><button class="button" type="button">Try again</button></section>';mount.querySelector("p").textContent=error.message;mount.querySelector("button").addEventListener("click",load);}}
  load();
})();
`;

function renderOrganizationsPage(user: User): string {
  return renderControlPlanePage({
    user,
    title: "Organizations",
    eyebrow: "Workspace",
    heading: "Your organizations",
    description: "Return to a workspace or create a secure boundary for a new documentation product.",
    focused: true,
    content: `<div id="organization-state">${organizationChooserLoading()}</div><style>.organization-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.organization-card{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;text-decoration:none;transition:border-color var(--cp-instant) var(--cp-ease),transform var(--cp-instant) var(--cp-ease),background var(--cp-instant) var(--cp-ease)}.organization-card:hover{border-color:var(--cp-accent);background:var(--cp-accent-soft);transform:translateY(-1px)}.organization-arrow{color:var(--cp-accent);font-size:12px;font-weight:750}.chooser-footer{display:flex;justify-content:center;margin-top:18px}@media(max-width:720px){.organization-grid{grid-template-columns:1fr}}</style>`,
    script: organizationChooserScript,
  });
}

function sectionHeading(section: OrganizationPageSection, organizationId: string): { active: ControlPlaneSection; eyebrow: string; heading: string; description: string; actions: string } {
  const base = `/organizations/${encodeURIComponent(organizationId)}`;
  if (section === "people") return {
    active: "people",
    eyebrow: "Organization access",
    heading: "People",
    description: "Manage members, roles, and invitations without weakening the organization boundary.",
    actions: '<button class="button primary" id="organization-page-action" type="button" data-dialog-open="invite-dialog" disabled>Invite people</button>',
  };
  if (section === "teams") return {
    active: "teams",
    eyebrow: "Organization structure",
    heading: "Teams",
    description: "Group existing members for ownership and collaboration without creating another permission model.",
    actions: '<button class="button primary" id="organization-page-action" type="button" data-dialog-open="team-dialog" disabled>Create team</button>',
  };
  if (section === "settings") return {
    active: "settings",
    eyebrow: "Organization",
    heading: "Settings",
    description: "Manage the stable name and slug used throughout this workspace.",
    actions: "",
  };
  return {
    active: "overview",
    eyebrow: "Organization overview",
    heading: "Workspace",
    description: "Projects, deployments, people, and publishing status in one operational view.",
    actions: `<a class="button" href="${base}/projects">View projects</a><a class="button primary" href="${base}/onboarding">Create project</a>`,
  };
}

const organizationPageScript = String.raw`
(function(){
  "use strict";
  var ui=window.RendroUI,state=window.__RENDRO_PAGE_STATE__,orgId=state.organizationId,mount=document.getElementById("organization-content"),loadVersion=0;
  var loadingStates={overview:${JSON.stringify(organizationSectionLoading("overview"))},people:${JSON.stringify(organizationSectionLoading("people"))},teams:${JSON.stringify(organizationSectionLoading("teams"))},settings:${JSON.stringify(organizationSectionLoading("settings"))}};
  function h(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function post(path,body){return ui.request(path,{method:"POST",body:JSON.stringify(body)}).then(function(result){if(path.indexOf("/invite-member")>=0){var sent=Array.from(document.querySelectorAll(".invite-entry")).find(function(entry){var input=entry.querySelector("[name=email]");return input&&input.value.trim()===body.email;});if(sent)sent.remove();}return result;});}
  function setOrganizationChrome(organization){document.querySelectorAll("[data-org-name]").forEach(function(node){node.textContent=organization.name;});document.querySelectorAll("[data-org-mark]").forEach(function(node){node.textContent=(organization.name||"R").charAt(0).toUpperCase();});}
  async function baseData(){await post("/api/auth/organization/set-active",{organizationId:orgId});var query="?organizationId="+encodeURIComponent(orgId);var results=await Promise.all([ui.request("/api/auth/organization/get-full-organization"+query),ui.request("/api/auth/organization/list-invitations"+query),ui.request("/api/rendro/projects"+query)]);var organization=results[0],invitations=results[1]||[],projects=results[2].projects||[];if(!organization)throw new Error("Organization not found.");setOrganizationChrome(organization);return {organization:organization,invitations:invitations,projects:projects};}
  function statusEmpty(mark,title,copy,action){return '<section class="panel empty"><span class="empty-mark">'+mark+'</span><h2>'+title+'</h2><p>'+copy+'</p>'+action+'</section>';}
  function watchCollectionEmpties(){if(state.section==="people"){var invitations=document.getElementById("invitation-list");new MutationObserver(function(){if(!invitations.children.length)invitations.innerHTML='<tr><td colspan="4"><div class="mini-empty">No pending invitations.</div></td></tr>';}).observe(invitations,{childList:true});}if(state.section==="teams"){var grid=document.getElementById("team-grid");new MutationObserver(function(){if(!grid.querySelector(".team-card")&&!grid.querySelector(".empty")){grid.innerHTML=statusEmpty("T","No teams yet","Create a team, then assign existing organization members.",'<button class="button primary" type="button">Create first team</button>');grid.querySelector("button").addEventListener("click",function(){ui.openDialog("team-dialog");});}}).observe(grid,{childList:true});}}
  async function renderOverview(data){var org=data.organization,pending=data.invitations.filter(function(invitation){return invitation.status==="pending";});var deploymentResults=await Promise.all(data.projects.slice(0,6).map(function(project){var query="?organizationId="+encodeURIComponent(orgId)+"&projectId="+encodeURIComponent(project._id);return ui.request("/api/rendro/deployments"+query).catch(function(){return {deployments:[]};});}));var deployments=[];deploymentResults.forEach(function(result){deployments=deployments.concat(result.deployments||[]);});deployments.sort(function(left,right){return (right.activatedAt||right.createdAt||0)-(left.activatedAt||left.createdAt||0);});mount.innerHTML='<div class="grid-3 overview-metrics"><article class="panel metric"><strong>'+data.projects.length+'</strong><span>Projects</span></article><article class="panel metric"><strong>'+org.members.length+'</strong><span>Members</span></article><article class="panel metric"><strong>'+org.teams.length+'</strong><span>Teams</span></article></div><div class="overview-grid"><section class="panel panel-pad"><div class="panel-head"><div><h2>Projects</h2><p>Active documentation products in this organization.</p></div><a class="button small" href="/organizations/'+encodeURIComponent(orgId)+'/projects">All projects</a></div><div id="overview-projects" class="overview-list"></div></section><aside class="panel panel-pad"><div class="panel-head"><div><h2>Workspace status</h2><p>Complete the path to a live document.</p></div></div><div class="checklist" id="workspace-checklist"></div></aside></div><section class="panel panel-pad recent-panel"><div class="panel-head"><div><h2>Recent deployment</h2><p>The latest immutable release across your projects.</p></div></div><div id="recent-deployment"></div></section>';var projectList=document.getElementById("overview-projects");if(!data.projects.length){projectList.innerHTML='<div class="mini-empty">No projects yet. Create the first project to connect your documentation.</div>';}data.projects.slice(0,5).forEach(function(project){var link=h("a","overview-row");link.href="/organizations/"+encodeURIComponent(orgId)+"/projects/"+encodeURIComponent(project._id);var copy=h("span","cell-primary");copy.append(h("strong","",project.name),h("span","cell-secondary",project.slug));link.append(copy,h("span","badge "+(project.activeDeploymentId?"success":""),project.activeDeploymentId?"Deployed":"Not deployed"));projectList.append(link);});var checklist=document.getElementById("workspace-checklist"),items=[{done:true,label:"Organization created"},{done:data.projects.length>0,label:"Create a project"},{done:deployments.length>0,label:"Push the first deployment"},{done:org.members.length>1||pending.length>0,label:"Invite a teammate",optional:true}];items.forEach(function(item){var row=h("div","checklist-row"+(item.done?" complete":""));row.append(h("span","checklist-mark",item.done?"Done":""),h("span","",item.label+(item.optional?" (optional)":"")));checklist.append(row);});var recent=document.getElementById("recent-deployment");if(!deployments.length){recent.innerHTML='<div class="mini-empty">No deployment has been committed yet.</div>';return;}var latest=deployments[0],project=data.projects.find(function(candidate){return candidate._id===latest.projectId;});recent.append(h("div","overview-row"));recent.firstChild.append(h("span","cell-primary"));recent.firstChild.firstChild.append(h("strong","",project?project.name:"Project"),h("span","cell-secondary",latest.provenance&&latest.provenance.commit?"Commit "+latest.provenance.commit:"Immutable deployment"));recent.firstChild.append(h("span","badge success","Active"));}
  function inviteRow(){var row=h("div","invite-entry");row.innerHTML='<label class="field"><span>Work email</span><input class="input" type="email" name="email" required autocomplete="off" placeholder="person@company.com"></label><label class="field"><span>Role</span><select class="select" name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label><button class="button ghost remove-invite" type="button" aria-label="Remove invitation row">Remove</button>';row.querySelector(".remove-invite").addEventListener("click",function(){if(document.querySelectorAll(".invite-entry").length>1)row.remove();});return row;}
  async function renderPeople(data){var org=data.organization,pending=data.invitations.filter(function(invitation){return invitation.status==="pending";});mount.innerHTML='<section class="panel"><div class="panel-head panel-pad people-head"><div><h2>Members</h2><p>'+org.members.length+' people currently have organization access.</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>User</th><th>Role</th><th>Joined</th><th>Access</th></tr></thead><tbody id="member-list"></tbody></table></div></section><section class="panel pending-panel"><div class="panel-head panel-pad people-head"><div><h2>Pending invitations</h2><p>Invitations expire after seven days and can be revoked immediately.</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead><tbody id="invitation-list"></tbody></table></div></section>';var members=document.getElementById("member-list");org.members.forEach(function(member){var tr=h("tr");var person=h("td");person.dataset.label="User";var copy=h("span","cell-primary");copy.append(h("strong","",member.user&&member.user.name||"Member"),h("span","cell-secondary",member.user&&member.user.email||member.userId));person.append(copy);var roleCell=h("td");roleCell.dataset.label="Role";var select=h("select","select role-select");["member","admin","owner"].forEach(function(role){var option=h("option","",role.charAt(0).toUpperCase()+role.slice(1));option.value=role;option.selected=member.role.split(",").indexOf(role)>=0;select.append(option);});select.setAttribute("aria-label","Change role for "+(member.user&&member.user.email||"member"));select.addEventListener("change",async function(){select.disabled=true;try{await post("/api/auth/organization/update-member-role",{memberId:member.id,role:select.value,organizationId:orgId});ui.toast("Member role updated.");}catch(error){ui.toast(error.message,"error");location.reload();}select.disabled=false;});roleCell.append(select);var joined=h("td","",member.createdAt?new Date(member.createdAt).toLocaleDateString():"—");joined.dataset.label="Joined";var access=h("td");access.dataset.label="Access";access.append(h("span","badge success","Active"));tr.append(person,roleCell,joined,access);members.append(tr);});var invitations=document.getElementById("invitation-list");if(!pending.length){var empty=h("tr");empty.innerHTML='<td colspan="4"><div class="mini-empty">No pending invitations.</div></td>';invitations.append(empty);}pending.forEach(function(invitation){var tr=h("tr");tr.innerHTML='<td data-label="Email"><span class="cell-primary"><strong></strong><span class="cell-secondary"></span></span></td><td data-label="Role"></td><td data-label="Status"><span class="badge warning">Pending</span></td><td data-label="Action"></td>';tr.querySelector("strong").textContent=invitation.email;tr.querySelector(".cell-secondary").textContent="Invited "+(invitation.createdAt?new Date(invitation.createdAt).toLocaleDateString():"");tr.children[1].textContent=invitation.role||"member";var revoke=h("button","button danger small","Revoke");revoke.addEventListener("click",async function(){if(!confirm("Revoke the invitation for "+invitation.email+"?"))return;ui.busy(revoke,true);try{await post("/api/auth/organization/cancel-invitation",{invitationId:invitation.id});tr.remove();ui.toast("Invitation revoked.");}catch(error){ui.busy(revoke,false);ui.toast(error.message,"error");}});tr.children[3].append(revoke);invitations.append(tr);});var rows=document.getElementById("invite-rows");rows.innerHTML="";rows.append(inviteRow());document.getElementById("add-invite-row").addEventListener("click",function(){if(rows.children.length<10)rows.append(inviteRow());});var form=document.getElementById("invite-form");form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),error=document.getElementById("invite-error"),entries=Array.from(rows.querySelectorAll(".invite-entry"));error.textContent="";ui.busy(button,true);var failures=[];for(var entry of entries){var email=entry.querySelector("[name=email]").value.trim(),role=entry.querySelector("[name=role]").value;try{await post("/api/auth/organization/invite-member",{email:email,role:role,organizationId:orgId});}catch(reason){failures.push(email+": "+reason.message);entry.querySelector("[name=email]").setAttribute("aria-invalid","true");}}if(failures.length){error.textContent=failures.join(" ");ui.busy(button,false);return;}document.getElementById("invite-dialog").close();ui.toast(entries.length===1?"Invitation sent.":entries.length+" invitations sent.");setTimeout(function(){location.reload();},350);});}
  async function renderTeams(data){var org=data.organization;mount.innerHTML='<div class="team-grid" id="team-grid"></div>';var grid=document.getElementById("team-grid");if(!org.teams.length){grid.innerHTML=statusEmpty("T","No teams yet","Create a team, then assign existing organization members.",'<button class="button primary" type="button" data-dialog-open="team-dialog">Create first team</button>');grid.querySelector("button").addEventListener("click",function(){ui.openDialog("team-dialog");});}org.teams.forEach(function(team){var card=h("article","panel panel-pad team-card");card.innerHTML='<div class="panel-head"><div><h2></h2><p>Assign organization members to this team.</p></div><span class="badge">Team</span></div><div class="team-assign"><select class="select" aria-label="Choose member"><option value="">Choose member</option></select><button class="button" type="button">Add member</button></div><div class="team-footer"><button class="button danger small remove-team" type="button">Remove team</button></div>';card.querySelector("h2").textContent=team.name;var select=card.querySelector("select");org.members.forEach(function(member){var option=h("option","",member.user&&member.user.name||member.userId);option.value=member.userId;select.append(option);});var add=card.querySelector(".team-assign .button");add.addEventListener("click",async function(){if(!select.value)return;ui.busy(add,true);try{await post("/api/auth/organization/add-team-member",{teamId:team.id,userId:select.value,organizationId:orgId});ui.toast("Member added to "+team.name+".");select.value="";}catch(error){ui.toast(error.message,"error");}ui.busy(add,false);});var remove=card.querySelector(".remove-team");remove.addEventListener("click",async function(){if(!confirm("Remove team "+team.name+"? Organization members keep their access."))return;ui.busy(remove,true);try{await post("/api/auth/organization/remove-team",{teamId:team.id,organizationId:orgId});card.style.opacity="0";setTimeout(function(){card.remove();},200);ui.toast("Team removed.");}catch(error){ui.busy(remove,false);ui.toast(error.message,"error");}});grid.append(card);});var form=document.getElementById("team-form");form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),error=document.getElementById("team-error");error.textContent="";ui.busy(button,true);try{await post("/api/auth/organization/create-team",{name:form.elements.namedItem("name").value.trim(),organizationId:orgId});document.getElementById("team-dialog").close();ui.toast("Team created.");setTimeout(function(){location.reload();},300);}catch(reason){error.textContent=reason.message;ui.busy(button,false);}});}
  async function renderSettings(data){var org=data.organization;mount.innerHTML='<section class="panel panel-pad settings-panel"><div class="panel-head"><div><h2>Organization profile</h2><p>Changing these values does not change the immutable organization ID used for authorization and storage.</p></div></div><form class="form-grid" id="settings-form"><label class="field"><span>Name</span><input class="input" name="name" maxlength="80" required></label><label class="field"><span>Slug</span><input class="input" name="slug" maxlength="48" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*"></label><p class="message error" id="settings-error" role="alert"></p><div class="form-actions"><button class="button primary" type="submit"><span class="button-label">Save changes</span></button></div></form></section>';var form=document.getElementById("settings-form");form.name.value=org.name;form.slug.value=org.slug;form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),error=document.getElementById("settings-error");error.textContent="";ui.busy(button,true);try{var updated=await post("/api/auth/organization/update",{organizationId:orgId,data:{name:form.name.value.trim(),slug:form.slug.value.trim()}});setOrganizationChrome(updated);ui.toast("Organization settings saved.");}catch(reason){error.textContent=reason.message;}ui.busy(button,false);});}
  async function load(){var version=++loadVersion;mount.innerHTML=loadingStates[state.section]||loadingStates.overview;try{var data=await baseData();if(version!==loadVersion)return;if(state.section==="people")await renderPeople(data);else if(state.section==="teams")await renderTeams(data);else if(state.section==="settings")await renderSettings(data);else await renderOverview(data);watchCollectionEmpties();var action=document.getElementById("organization-page-action");if(action)action.disabled=false;}catch(error){if(version!==loadVersion)return;mount.innerHTML=statusEmpty("!","Unable to load this organization",error.message,'<button class="button" type="button" id="retry">Try again</button>');document.getElementById("retry").addEventListener("click",load);}}
  load();
})();
`;

function organizationDialogs(section: OrganizationPageSection): string {
  if (section === "people") return `<dialog class="cp-dialog" id="invite-dialog"><div class="dialog-head"><div><h2>Invite people</h2><p>Each invitation is bound to its exact email address and expires after seven days.</p></div><button class="dialog-close" type="button" data-dialog-close aria-label="Close invitation dialog">Close</button></div><form id="invite-form"><div class="dialog-body"><div class="form-grid" id="invite-rows"></div><button class="button ghost small" id="add-invite-row" type="button">Add another person</button><p class="message error" id="invite-error" role="alert"></p></div><div class="dialog-footer"><button class="button" type="button" data-dialog-close>Cancel</button><button class="button primary" type="submit"><span class="button-label">Send invitations</span></button></div></form></dialog>`;
  if (section === "teams") return `<dialog class="cp-dialog" id="team-dialog"><div class="dialog-head"><div><h2>Create team</h2><p>Teams organize existing members without changing their organization role.</p></div><button class="dialog-close" type="button" data-dialog-close aria-label="Close team dialog">Close</button></div><form id="team-form"><div class="dialog-body"><label class="field"><span>Team name</span><input class="input" name="name" maxlength="80" required autofocus placeholder="Documentation"></label><p class="message error" id="team-error" role="alert"></p></div><div class="dialog-footer"><button class="button" type="button" data-dialog-close>Cancel</button><button class="button primary" type="submit"><span class="button-label">Create team</span></button></div></form></dialog>`;
  return "";
}

function renderOrganizationSection(user: User, organizationId: string, section: OrganizationPageSection): string {
  const heading = sectionHeading(section, organizationId);
  return renderControlPlanePage({
    user,
    title: heading.heading,
    eyebrow: heading.eyebrow,
    heading: heading.heading,
    description: heading.description,
    organizationId,
    active: heading.active,
    actions: heading.actions,
    state: { organizationId, section },
    content: `<div id="organization-content">${organizationSectionLoading(section)}</div>${organizationDialogs(section)}<style>.overview-metrics{margin-bottom:16px}.overview-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:16px}.overview-list,.checklist{display:grid}.overview-row{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:54px;padding:10px 0;border-bottom:1px solid var(--cp-border);text-decoration:none}.overview-row:last-child{border-bottom:0}.overview-row[href]:hover strong{color:var(--cp-accent)}.checklist-row{display:grid;grid-template-columns:22px 1fr;align-items:center;gap:9px;min-height:38px;color:var(--cp-muted)}.checklist-row.complete{color:var(--cp-text)}.checklist-mark{width:18px;height:18px;display:grid;place-items:center;border:1px solid var(--cp-border-strong);border-radius:50%;font-size:0}.checklist-row.complete .checklist-mark{border-color:var(--cp-success);background:var(--cp-success-soft)}.checklist-row.complete .checklist-mark:after{content:"";width:6px;height:3px;border-left:2px solid var(--cp-success);border-bottom:2px solid var(--cp-success);transform:rotate(-45deg) translateY(-1px)}.recent-panel,.pending-panel{margin-top:16px}.mini-empty{padding:18px 0;color:var(--cp-muted)}.people-head{margin:0;padding-bottom:10px}.role-select{min-height:34px;width:120px;padding:5px 8px}.invite-entry{display:grid;grid-template-columns:minmax(0,1fr) 140px auto;align-items:end;gap:10px}.team-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.team-card{transition:opacity var(--cp-fast) var(--cp-ease)}.team-assign{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.team-footer{display:flex;justify-content:flex-end;margin-top:18px;padding-top:14px;border-top:1px solid var(--cp-border)}.settings-panel{max-width:720px}.metric .skeleton-line.strong{height:23px}@media(max-width:880px){.overview-grid,.team-grid{grid-template-columns:1fr}}@media(max-width:620px){.invite-entry{grid-template-columns:1fr}.team-assign{grid-template-columns:1fr}}</style>`,
    script: organizationPageScript,
  });
}

const onboardingScript = String.raw`
(function(){
  "use strict";
  var ui=window.RendroUI,state=window.__RENDRO_PAGE_STATE__,orgId=state.organizationId,projectId=state.projectId,mount=document.getElementById("onboarding-stage"),pollTimer=null,keyConfirmed=true,loading=projectId?${JSON.stringify(onboardingLoading(true))}:${JSON.stringify(onboardingLoading(false))};
  function slugify(value){return value.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,48);}
  function setOrg(organization){document.querySelectorAll("[data-org-name]").forEach(function(node){node.textContent=organization.name;});document.querySelectorAll("[data-org-mark]").forEach(function(node){node.textContent=organization.name.charAt(0).toUpperCase();});}
  function projectStage(){mount.innerHTML='<div class="panel-head"><div><h2>Create your first project</h2><p>A project owns an immutable deployment history, publications, and private shares.</p></div></div><form class="form-grid" id="project-form"><label class="field"><span>Project name</span><input class="input" name="name" maxlength="80" required autofocus placeholder="Product documentation"></label><label class="field"><span>Project slug</span><input class="input" name="slug" maxlength="48" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="product-docs"></label><p class="message error" id="project-error" role="alert"></p><div class="form-actions"><a class="button" href="/organizations/'+encodeURIComponent(orgId)+'">Finish later</a><button class="button primary" type="submit"><span class="button-label">Create project</span></button></div></form>';var form=document.getElementById("project-form"),name=form.name,slug=form.slug,touched=false;slug.addEventListener("input",function(){touched=true;});name.addEventListener("input",function(){if(!touched)slug.value=slugify(name.value);});form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),error=document.getElementById("project-error");error.textContent="";ui.busy(button,true);try{var result=await ui.request("/api/rendro/projects",{method:"POST",body:JSON.stringify({organizationId:orgId,name:name.value.trim(),slug:slug.value.trim()})});location.assign("/organizations/"+encodeURIComponent(orgId)+"/onboarding?projectId="+encodeURIComponent(result.project._id));}catch(reason){error.textContent=reason.message;ui.busy(button,false);}});}
  function deploymentStage(){mount.innerHTML='<div class="panel-head"><div><h2>Connect the Rendro CLI</h2><p>Create a project-scoped credential, store it once, then push real documentation.</p></div></div><form class="form-grid" id="key-form"><label class="field"><span>Credential name</span><input class="input" name="name" maxlength="80" required value="First deployment"></label><label class="field"><span>Expiration</span><select class="select" name="expiry"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">1 year</option><option value="">Never</option></select></label><div><p class="field-label">Permissions</p><label class="check"><input type="checkbox" name="scope" value="docs:read" checked> Read documentation</label><label class="check"><input type="checkbox" name="scope" value="docs:write" checked> Publish documentation</label></div><p class="message error" id="key-error" role="alert"></p><div class="form-actions"><button class="button primary" type="submit"><span class="button-label">Generate API key</span></button></div></form><div id="deployment-connect" hidden></div>';var form=document.getElementById("key-form");form.addEventListener("submit",async function(event){event.preventDefault();var button=form.querySelector("button[type=submit]"),error=document.getElementById("key-error"),scopes=Array.from(form.querySelectorAll("[name=scope]:checked")).map(function(input){return input.value;}),expiry=form.expiry.value;error.textContent="";ui.busy(button,true);try{var result=await ui.request("/api/rendro/credentials",{method:"POST",body:JSON.stringify({organizationId:orgId,projectId:projectId,name:form.name.value.trim(),scopes:scopes,expiresAt:expiry?Date.now()+Number(expiry)*86400000:undefined})});showCredential(result.rawKey);}catch(reason){error.textContent=reason.message;ui.busy(button,false);}});}
  function showCredential(rawKey){var form=document.getElementById("key-form"),connect=document.getElementById("deployment-connect"),command='export RENDRO_API_KEY="'+rawKey+'"\nrendro push --source ./docs --organization '+orgId+' --project '+projectId;keyConfirmed=false;form.hidden=true;connect.hidden=false;connect.innerHTML='<div class="secret-box"><strong>API key created</strong><span>This secret is shown once. Store it in your CI secret manager before leaving this page.</span><div class="secret-value"><code id="onboarding-key"></code><button class="button" id="copy-key" type="button">Copy key</button></div><label class="check secret-confirm"><input id="onboarding-key-confirmed" type="checkbox"> I have stored this key securely</label></div><div class="command onboarding-command"><code id="onboarding-command"></code><button class="button small" id="copy-command" type="button">Copy command</button></div><div class="progress-state"><span class="progress-dot"></span><span class="cell-primary"><strong>Waiting for your first deployment</strong><span class="cell-secondary">This status changes only after Rendro receives and commits a real CLI push.</span></span></div><div id="deployment-success"></div>';document.getElementById("onboarding-key").textContent=rawKey;document.getElementById("onboarding-command").textContent=command;document.getElementById("onboarding-key-confirmed").addEventListener("change",function(){keyConfirmed=this.checked;});function copy(id,button,label){ui.busy(button,true);navigator.clipboard.writeText(document.getElementById(id).textContent).then(function(){ui.busy(button,false);button.textContent="Copied";setTimeout(function(){button.textContent=label;},1600);}).catch(function(){ui.busy(button,false);ui.toast("Unable to copy. Select the value and copy it manually.","error");});}document.getElementById("copy-key").addEventListener("click",function(){copy("onboarding-key",this,"Copy key");});document.getElementById("copy-command").addEventListener("click",function(){copy("onboarding-command",this,"Copy command");});pollDeployment();}
  async function pollDeployment(){if(document.hidden){pollTimer=setTimeout(pollDeployment,5000);return;}try{var query="?organizationId="+encodeURIComponent(orgId)+"&projectId="+encodeURIComponent(projectId),data=await ui.request("/api/rendro/deployments"+query),deployment=(data.deployments||[]).find(function(candidate){return candidate.status==="active";}),progress=document.querySelector(".progress-state");if(progress){progress.classList.remove("poll-error");progress.querySelector("strong").textContent="Waiting for your first deployment";progress.querySelector(".cell-secondary").textContent="This status changes only after Rendro receives and commits a real CLI push.";}if(deployment){if(progress)progress.remove();var success=document.getElementById("deployment-success");success.className="deployment-success";success.innerHTML='<span class="step-dot">Done</span><span class="cell-primary"><strong>First deployment received</strong><span class="cell-secondary"></span></span><a class="button primary" href="/organizations/'+encodeURIComponent(orgId)+'/projects/'+encodeURIComponent(projectId)+'/docs">Open documentation</a>';success.querySelector(".cell-secondary").textContent=(deployment.fileCount||0)+" documents"+(deployment.provenance&&deployment.provenance.commit?" · commit "+deployment.provenance.commit:"");return;}}catch(error){var progress=document.querySelector(".progress-state");if(progress){progress.classList.add("poll-error");progress.querySelector("strong").textContent="Connection interrupted";progress.querySelector(".cell-secondary").textContent="Unable to check deployment status. Rendro will retry automatically.";}}pollTimer=setTimeout(pollDeployment,5000);}
  async function init(){mount.innerHTML=loading;try{var organization=await ui.request("/api/auth/organization/get-full-organization?organizationId="+encodeURIComponent(orgId));setOrg(organization);if(projectId)deploymentStage();else projectStage();}catch(error){mount.innerHTML='<section class="empty"><span class="empty-mark">!</span><h2>Unable to load setup</h2><p></p><button class="button" type="button">Try again</button></section>';mount.querySelector("p").textContent=error.message;mount.querySelector("button").addEventListener("click",init);}}
  window.addEventListener("beforeunload",function(event){if(!keyConfirmed){event.preventDefault();event.returnValue="";}});init();
})();
`;

function renderOnboardingPage(user: User, organizationId: string, projectId?: string): string {
  const projectReady = Boolean(projectId);
  return renderControlPlanePage({
    user,
    title: "Set up Rendro",
    eyebrow: "Workspace setup",
    heading: projectReady ? "Ship your first documentation" : "Create your first project",
    description: "A focused path from a secure organization to a real, immutable documentation deployment.",
    organizationId,
    focused: true,
    state: { organizationId, projectId: projectId ?? "" },
    content: `<section class="onboarding"><div class="stepper"><div class="step complete"><span class="step-dot">Done</span><span>Organization</span></div><div class="step ${projectReady ? "complete" : "active"}"><span class="step-dot">${projectReady ? "Done" : "2"}</span><span>Project</span></div><div class="step ${projectReady ? "active" : ""}"><span class="step-dot">3</span><span>First deployment</span></div></div><div class="panel panel-pad" id="onboarding-stage">${onboardingLoading(projectReady)}</div></section><style>.field-label{margin:0 0 8px;color:var(--cp-strong);font-weight:650}.onboarding-command{margin-top:14px}.deployment-success{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;margin-top:16px;padding:16px;border:1px solid color-mix(in srgb,var(--cp-success) 40%,var(--cp-border));border-radius:10px;background:var(--cp-success-soft)}.deployment-success .step-dot{border-color:var(--cp-success);background:var(--cp-success);font-size:9px}@media(max-width:620px){.deployment-success{grid-template-columns:auto 1fr}.deployment-success .button{grid-column:1/-1}}</style>`,
    script: onboardingScript,
  });
}

const invitationScript = String.raw`
(function(){
  "use strict";
  var ui=window.RendroUI,state=window.__RENDRO_PAGE_STATE__,mount=document.getElementById("invitation-state");
  async function load(){try{var invitation=await ui.request("/api/auth/organization/get-invitation?id="+encodeURIComponent(state.invitationId));mount.innerHTML='<div class="invitation-mark"></div><p class="eyebrow">Organization invitation</p><h2></h2><p class="invitation-copy"></p><div class="invitation-actions"><button class="button" id="reject" type="button">Decline</button><button class="button primary" id="accept" type="button"><span class="button-label">Accept invitation</span></button></div><p class="message error" id="invitation-error" role="alert"></p>';mount.querySelector(".invitation-mark").textContent=(invitation.organizationName||"R").charAt(0).toUpperCase();mount.querySelector("h2").textContent="Join "+(invitation.organizationName||"this organization");mount.querySelector(".invitation-copy").textContent="Accept the invitation for "+invitation.email+" with the "+(invitation.role||"member")+" role.";document.getElementById("accept").addEventListener("click",function(){respond("accept-invitation",this);});document.getElementById("reject").addEventListener("click",function(){respond("reject-invitation",this);});}catch(error){mount.innerHTML='<span class="empty-mark">!</span><h2>Invitation unavailable</h2><p class="invitation-copy"></p><a class="button" href="/organizations">Return to organizations</a>';mount.querySelector("p").textContent=error.message;}}
  async function respond(action,button){var buttons=mount.querySelectorAll(".invitation-actions button");buttons.forEach(function(candidate){candidate.disabled=true;});button.setAttribute("aria-busy","true");try{var result=await ui.request("/api/auth/organization/"+action,{method:"POST",body:JSON.stringify({invitationId:state.invitationId})});if(action==="accept-invitation"){location.assign("/organizations/"+encodeURIComponent(result.member.organizationId));}else location.assign("/organizations");}catch(error){document.getElementById("invitation-error").textContent=error.message;buttons.forEach(function(candidate){candidate.disabled=false;});button.setAttribute("aria-busy","false");}}
  load();
})();
`;

function renderInvitationPage(user: User, invitationId: string): string {
  return renderControlPlanePage({
    user,
    title: "Organization invitation",
    eyebrow: "Invitation",
    heading: "Continue to your organization",
    description: `Signed in as ${user.email}. Review the organization and role before accepting.`,
    focused: true,
    state: { invitationId },
    content: `<section class="panel panel-pad invitation-card" id="invitation-state">${renderLoadingState("Loading invitation", `<span class="skeleton invitation-mark"></span><span class="skeleton-copy"><span class="skeleton skeleton-line strong medium"></span><span class="skeleton skeleton-line long"></span><span class="skeleton skeleton-line medium"></span></span><span class="skeleton skeleton-button"></span>`)}</section><style>.invitation-card{width:min(520px,100%);margin:20px auto;text-align:center}.invitation-card .loading-view{justify-items:center}.invitation-card .skeleton-copy{width:min(360px,100%);justify-items:center}.invitation-mark{width:52px;height:52px;display:grid;place-items:center;margin:0 auto 18px;border-radius:14px;background:var(--cp-accent-soft);color:var(--cp-accent);font-size:20px;font-weight:800}.invitation-card h2{margin:0;color:var(--cp-strong);font-size:24px}.invitation-copy{margin:9px auto 22px;color:var(--cp-muted)}.invitation-actions{display:flex;justify-content:center;gap:8px}</style>`,
    script: invitationScript,
  });
}

app.get("/organizations", (c) => {
  const user = c.get("user");
  if (!user) return c.redirect(signInHref("/organizations"));
  return c.html(renderOrganizationsPage(user));
});

app.get("/organizations/:organizationId/onboarding", (c) => {
  const user = c.get("user");
  const organizationId = c.req.param("organizationId");
  if (!user) return c.redirect(signInHref(organizationRoute(organizationId, "/onboarding")));
  return c.html(renderOnboardingPage(user, organizationId, c.req.query("projectId")));
});

for (const [path, section] of [
  ["/organizations/:organizationId/people", "people"],
  ["/organizations/:organizationId/teams", "teams"],
  ["/organizations/:organizationId/settings", "settings"],
] as const) {
  app.get(path, (c) => {
    const user = c.get("user");
    const organizationId = c.req.param("organizationId");
    if (!user) return c.redirect(signInHref(organizationRoute(organizationId, `/${section}`)));
    return c.html(renderOrganizationSection(user, organizationId, section));
  });
}

app.get("/organizations/:organizationId", (c) => {
  const user = c.get("user");
  const organizationId = c.req.param("organizationId");
  if (!user) return c.redirect(signInHref(organizationRoute(organizationId)));
  return c.html(renderOrganizationSection(user, organizationId, "overview"));
});

app.get("/accept-invitation/:invitationId", (c) => {
  const invitationId = c.req.param("invitationId");
  const user = c.get("user");
  const returnTo = `/accept-invitation/${encodeURIComponent(invitationId)}`;
  if (!user) return c.redirect(signInHref(returnTo));
  return c.html(renderInvitationPage(user, invitationId));
});

export default app;
