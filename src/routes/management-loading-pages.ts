import {
  type ManagementLoadingPage,
  renderOrganizationLoadingPage,
  renderProjectLoadingPage,
  renderProjectNavigation,
  renderTableLoading,
} from "./management-loading";

export type { ManagementLoadingPage } from "./management-loading";

export const MANAGEMENT_PROJECT_PLACEHOLDER = "__RENDRO_PROJECT_ID__";

export function apiKeyLoadingPage(): ManagementLoadingPage {
  return {
    eyebrow: "Developer access",
    heading: "API keys",
    description: "Project-scoped credentials for local pushes and CI jobs. Secrets are shown once; revocation is immediate.",
    actions: '<button class="button primary" id="api-key-create" type="button" data-dialog-open="key-dialog" hidden disabled>Create API key</button>',
    content: `<section class="panel"><div class="table-wrap"><table class="data-table key-table"><thead><tr><th>Name</th><th>Project scope</th><th>Permissions</th><th>Last used</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody id="key-list">${renderTableLoading("Loading API keys", 7)}</tbody></table></div></section>
<style>.key-table{min-width:920px}.scope-list{display:flex;flex-wrap:wrap;gap:4px;max-width:260px}.field-label{margin:0 0 8px;color:var(--cp-strong);font-weight:650}.secret-dialog{width:min(620px,calc(100vw - 28px))}.secret-dialog .wide-button{width:100%;margin-top:10px}.secret-confirm{margin-top:18px}.empty.compact{padding:44px 20px}</style>`,
  };
}

export function publicationLoadingPage(organizationId: string, projectId: string): ManagementLoadingPage {
  const base = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`;
  return {
    eyebrow: "Public access",
    heading: "Publications",
    description: "Expose an explicit project path through a stable anonymous URL.",
    actions: `<a class="button" href="${base}">Project overview</a><button class="button primary" id="publication-create" type="button" data-dialog-open="publication-dialog" disabled hidden>Create publication</button>`,
    content: `${renderProjectNavigation(organizationId, projectId, "publications")}<p class="access-note" id="publication-access-note" role="status" hidden>You have read-only publication access. Owners and admins create and remove publications.</p><section class="panel"><div class="table-wrap"><table class="data-table publication-table"><thead><tr><th>Publication</th><th>Path</th><th>Release mode</th><th>Status</th><th>Actions</th></tr></thead><tbody id="publication-list">${renderTableLoading("Loading publications", 5)}</tbody></table></div></section><style>.publication-table{min-width:760px}.row-actions{display:flex;gap:6px}@media(max-width:620px){.row-actions .button{min-height:44px}}</style>`,
  };
}

export function shareLoadingPage(organizationId: string, projectId: string): ManagementLoadingPage {
  const base = `/organizations/${encodeURIComponent(organizationId)}/projects/${encodeURIComponent(projectId)}`;
  return {
    eyebrow: "Private access",
    heading: "Private shares",
    description: "Revocable links pinned to immutable deployments, with explicit expiry.",
    actions: `<a class="button" href="${base}">Project overview</a><a class="button primary" href="${base}/docs">Browse documentation</a>`,
    content: `${renderProjectNavigation(organizationId, projectId, "shares")}<p class="access-note" id="share-access-note" role="status" hidden>You can view private-share history and create links from documentation. Only owners and admins can revoke links.</p><section class="panel"><div class="table-wrap"><table class="data-table share-table"><thead><tr><th>Document</th><th>Deployment</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody id="share-list">${renderTableLoading("Loading private shares", 5)}</tbody></table></div></section><style>.share-table{min-width:720px}@media(max-width:620px){.share-table .button{min-height:44px}}</style>`,
  };
}

/** Public presentation only: no records, roles, tokens, or private response cache. */
export function managementLoadingPages(organizationId: string): Record<string, ManagementLoadingPage> {
  const projectId = MANAGEMENT_PROJECT_PLACEHOLDER;
  return {
    overview: renderOrganizationLoadingPage(organizationId, "overview"),
    people: renderOrganizationLoadingPage(organizationId, "people"),
    teams: renderOrganizationLoadingPage(organizationId, "teams"),
    settings: renderOrganizationLoadingPage(organizationId, "settings"),
    projects: renderProjectLoadingPage(organizationId),
    project: renderProjectLoadingPage(organizationId, projectId),
    "api-keys": apiKeyLoadingPage(),
    publications: publicationLoadingPage(organizationId, projectId),
    shares: shareLoadingPage(organizationId, projectId),
  };
}
