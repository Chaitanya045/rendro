import {
  type ManagementLoadingPage,
  renderOrganizationLoadingPage,
  renderProjectLoadingPage,
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
    content: `<section class="panel key-panel"><div class="table-wrap"><table class="data-table key-table"><thead><tr><th>Name</th><th>Project scope</th><th>Permissions</th><th>Last used</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody id="key-list">${renderTableLoading("Loading API keys", 7)}</tbody></table></div></section>
<style>.key-table{min-width:920px}.scope-list{display:flex;flex-wrap:wrap;gap:4px;max-width:260px}.field-label{margin:0 0 8px;color:var(--cp-strong);font-weight:650}.secret-dialog{width:min(620px,calc(100vw - 28px))}.secret-dialog .wide-button{width:100%;margin-top:10px}.secret-confirm{margin-top:18px}.empty.compact{padding:44px 20px}</style>`,
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
  };
}
