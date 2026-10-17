import { escapeHtml } from "./html";

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

export type OrganizationLoadingSection = "overview" | "people" | "teams" | "settings";

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

export function organizationSectionLoading(section: OrganizationLoadingSection): string {
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

export function deploymentHistoryLoading(): string {
  return renderTableLoading("Loading deployment history", 4);
}

export function renderDeploymentHistoryPanel(): string {
  return `<section class="panel panel-pad deployments-panel" id="deployments"><div class="panel-head"><div><h2>Deployment history</h2><p>The latest 100 immutable releases, newest first.</p></div><span class="count-note" id="deployment-count" role="status"></span></div><div class="table-wrap loading-view deployment-table-wrap" aria-busy="true" aria-label="Loading deployment history"><table class="data-table deployment-table" aria-label="Project deployments"><colgroup><col><col><col class="deployment-files-column"><col class="deployment-status-column"></colgroup><thead><tr><th scope="col">Deployment</th><th scope="col">Source</th><th scope="col">Files</th><th scope="col">Status</th></tr></thead><tbody id="deployment-list">${deploymentHistoryLoading()}</tbody></table></div></section>`;
}

export function projectLoading(projectId: string, section: "overview" | "deployments" = "overview"): string {
  const row = `<div class="project-row">
    <span class="skeleton skeleton-icon"></span>
    <span class="skeleton-copy"><span class="skeleton skeleton-line strong medium"></span><span class="skeleton skeleton-line long"></span></span>
    <span class="skeleton skeleton-pill"></span>
    <span class="skeleton skeleton-line short"></span>
  </div>`;
  if (!projectId) {
    return renderLoadingState("Loading projects", `<section class="panel">
      <div class="panel-pad skeleton-copy"><span class="skeleton skeleton-line strong short"></span><span class="skeleton skeleton-line medium"></span></div>
      <div class="project-list">${row}${row}${row}</div>
    </section>`);
  }
  if (section === "deployments") {
    return renderLoadingState("Loading project deployments", `${renderDeploymentHistoryPanel()}
      <div class="panel skeleton-card deployments-panel"><span class="skeleton skeleton-line strong medium"></span><span class="skeleton skeleton-line long"></span><span class="skeleton skeleton-field"></span></div>`);
  }
  return renderLoadingState("Loading project overview", `<div class="skeleton-tabs"><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line"></span></div>
    <div class="project-overview">
      <section class="panel skeleton-card"><span class="skeleton skeleton-line strong medium"></span><span class="skeleton skeleton-line long"></span>${row}${row}</section>
      <section class="panel skeleton-card"><span class="skeleton skeleton-line strong medium"></span><span class="skeleton skeleton-line long"></span><span class="skeleton skeleton-field"></span><span class="skeleton skeleton-button"></span></section>
    </div>`);
}

export type OrganizationPageSection = "overview" | "people" | "teams" | "settings";
export type ProjectNavigationSection = "overview" | "deployments" | "publications" | "shares";

export interface ManagementLoadingPage {
  eyebrow: string;
  heading: string;
  description: string;
  actions: string;
  content: string;
}

export function renderProjectNavigation(
  organizationId: string,
  projectId: string,
  active: ProjectNavigationSection,
): string {
  const base = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`;
  const link = (href: string, label: string, section: ProjectNavigationSection) => {
    const current = section === active;
    return `<a${current ? ' class="active" aria-current="page"' : ""} href="${href}">${label}</a>`;
  };
  return `<nav class="project-tabs" aria-label="Project sections">${link(base, "Overview", "overview")}${link(`${base}/deployments`, "Deployments", "deployments")}${link(`${base}/publications`, "Publications", "publications")}${link(`${base}/shares`, "Private shares", "shares")}</nav>`;
}

export const organizationPageStyles = `.overview-metrics{margin-bottom:16px}.overview-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,.65fr);gap:16px}.overview-list,.checklist{display:grid}.overview-row{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:54px;padding:10px 0;border-bottom:1px solid var(--cp-border);text-decoration:none}.overview-row:last-child{border-bottom:0}.overview-row>.cell-primary{min-width:0;flex:1}.overview-row .cell-secondary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.overview-row strong{overflow-wrap:anywhere}.overview-row>.badge{flex:none}.overview-row[href]:hover strong{color:var(--cp-accent)}.checklist-row{display:grid;grid-template-columns:22px 1fr;align-items:center;gap:9px;min-height:38px;color:var(--cp-muted)}.checklist-row.complete{color:var(--cp-text)}.checklist-mark{position:relative;width:18px;height:18px;display:grid;place-items:center;border:1px solid var(--cp-border-strong);border-radius:50%;font-size:0}.checklist-row.complete .checklist-mark{border-color:var(--cp-success);background:var(--cp-success-soft)}.checklist-row.complete .checklist-mark:after{content:"check";position:absolute;inset:0;display:grid;place-items:center;color:var(--cp-success);font:400 14px/1 "Material Symbols Outlined";font-feature-settings:"liga";font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 20}.recent-panel,.pending-panel{margin-top:16px}.mini-empty{padding:18px 0;color:var(--cp-muted)}.people-head{margin:0;padding-bottom:10px}.person-name{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.role-select{min-height:34px;width:120px;padding:5px 8px}.invite-entry{display:grid;grid-template-columns:minmax(0,1fr) 140px auto;align-items:end;gap:10px}.team-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.team-card{transition:opacity var(--cp-fast) var(--cp-ease)}.team-grid>.empty{grid-column:1/-1}.team-roster-toggle{margin-top:12px}.team-roster{margin-top:8px}.team-assign{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.team-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px 14px;margin-top:18px;padding-top:14px;border-top:1px solid var(--cp-border)}.team-hint{margin:0;flex:1 1 220px;color:var(--cp-muted);font-size:12px;line-height:18px}.settings-panel{max-width:720px}.metric .skeleton-line.strong{height:23px}@media(max-width:880px){.overview-grid,.team-grid{grid-template-columns:1fr}}@media(max-width:620px){.invite-entry{grid-template-columns:1fr}.team-assign{grid-template-columns:1fr}.team-footer .button{min-height:44px}}`;

export const projectPageStyles = `.list-head{margin:0}.project-list{display:grid}.project-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:12px;min-height:68px;padding:10px 18px;border-top:1px solid var(--cp-border);text-decoration:none;transition:background var(--cp-instant) var(--cp-ease)}.project-row:hover{background:var(--cp-surface-2)}.project-mark{width:36px;height:36px;display:grid;place-items:center;border-radius:8px;background:var(--cp-accent-soft);color:var(--cp-accent);font-size:11px;font-weight:800}.project-arrow{color:var(--cp-accent);font-size:12px;font-weight:750}.project-overview{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(300px,.9fr);gap:16px}.detail-list{display:grid;grid-template-columns:1fr 1fr;margin:0}.detail-list div{min-width:0;padding:13px 0;border-top:1px solid var(--cp-border)}.detail-list div:nth-child(odd){padding-right:14px}.detail-list dt{color:var(--cp-muted);font-size:12px}.detail-list dd{min-width:0;margin:3px 0 0;color:var(--cp-strong);font-weight:650;overflow-wrap:anywhere}.detail-list .cp-id-value{display:flex}.project-docs-note{display:flex;align-items:flex-start;gap:10px;margin:14px 0 0;padding:12px 14px;border:1px solid var(--cp-border);border-radius:7px;background:var(--cp-container);color:var(--cp-muted-strong)}.project-docs-note strong{display:block;color:var(--cp-strong)}.project-docs-note .material-symbols-outlined{color:var(--cp-accent)}.project-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.deployments-panel{margin-top:16px}.deployment-table{table-layout:fixed}.deployment-table .deployment-files-column{width:100px}.deployment-table .deployment-status-column{width:120px}.deployment-table td{vertical-align:top;overflow-wrap:anywhere}.deployment-table .cell-primary{min-width:0}.deployment-table .cp-id-value{display:flex}.deployment-failure{color:var(--cp-danger);font-size:12px;font-weight:400;overflow-wrap:anywhere}.mini-empty{padding:18px 0;color:var(--cp-muted)}@media(max-width:900px){.project-overview{grid-template-columns:1fr}}@media(max-width:760px){.deployment-table colgroup{display:none}.deployment-table .skeleton-table-row td{padding:7px 0}.deployment-table-wrap .loading-announcement{padding:0;border:0}}@media(max-width:620px){.project-row{grid-template-columns:auto 1fr}.project-row>.badge,.project-arrow{display:none}.detail-list{grid-template-columns:1fr}.detail-list div:nth-child(odd){padding-right:0}}`;

export function organizationSectionHeading(section: OrganizationPageSection, organizationId: string) {
  const base = `/organizations/${encodeURIComponent(organizationId)}`;
  if (section === "people") return {
    active: "people" as const,
    eyebrow: "Organization access",
    heading: "People",
    description: "Manage members, roles, and invitations without weakening the organization boundary.",
    actions: '<button class="button primary" id="organization-page-action" type="button" data-dialog-open="invite-dialog" hidden disabled>Invite people</button>',
  };
  if (section === "teams") return {
    active: "teams" as const,
    eyebrow: "Organization structure",
    heading: "Teams",
    description: "Group existing members for ownership and collaboration without creating another permission model.",
    actions: '<button class="button primary" id="organization-page-action" type="button" data-dialog-open="team-dialog" hidden disabled>Create team</button>',
  };
  if (section === "settings") return {
    active: "settings" as const,
    eyebrow: "Organization",
    heading: "Settings",
    description: "Manage the stable name and slug used throughout this workspace.",
    actions: "",
  };
  return {
    active: "overview" as const,
    eyebrow: "Organization overview",
    heading: "Workspace",
    description: "Projects, deployments, people, and publishing status in one operational view.",
    actions: `<a class="button" href="${base}/projects">View projects</a><a class="button primary" id="organization-page-action" href="${base}/onboarding" hidden>Create project</a>`,
  };
}

export function renderOrganizationLoadingPage(organizationId: string, section: OrganizationPageSection): ManagementLoadingPage {
  const { eyebrow, heading, description, actions } = organizationSectionHeading(section, organizationId);
  return {
    eyebrow,
    heading,
    description,
    actions,
    content: `<div id="organization-content">${organizationSectionLoading(section)}</div><style>${organizationPageStyles}</style>`,
  };
}

export function renderProjectLoadingPage(organizationId: string, projectId = "", section: "overview" | "deployments" = "overview"): ManagementLoadingPage {
  const base = `/organizations/${encodeURIComponent(organizationId)}/projects`;
  const deployments = Boolean(projectId) && section === "deployments";
  return {
    eyebrow: projectId ? "Project" : "Documentation delivery",
    heading: deployments ? "Deployments" : projectId ? "Project" : "Projects",
    description: deployments ? "Immutable release history for this project, newest first." : projectId
      ? "Immutable deployments, publications, and access for this documentation product."
      : "View independently deployed documentation products and their release state.",
    actions: projectId
      ? `<a class="button" href="${base}">All projects</a>`
      : '<button class="button primary" id="project-create" type="button" data-dialog-open="project-dialog" disabled hidden>Create project</button>',
    content: `<div id="project-content">${deployments ? renderProjectNavigation(organizationId, projectId, "deployments") : ""}${projectLoading(projectId, section)}</div><style>${projectPageStyles}</style>`,
  };
}
