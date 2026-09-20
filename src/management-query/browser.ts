import { createManagementQueryCache } from "./cache";
import { installOrganizationListCache } from "./organizations";

declare global {
  interface Window { RendroQueryCore?: { create: typeof createManagementQueryCache; installOrganizationList: typeof installOrganizationListCache } }
}
window.RendroQueryCore = { create: createManagementQueryCache, installOrganizationList: installOrganizationListCache };
