import { MANAGEMENT_QUERY_VERSION, SELECT_VERSION } from "./management-asset-versions";
import { MANAGEMENT_SHELL_VERSION } from "./management-navigation";
import { COMMENTOR_PARENT_VERSION, COMMENTOR_VERSION, LAZY_TREE_VERSION, PRIVATE_VIEWER_VERSION, RUM_VERSION } from "../viewer/asset-versions";

// Leaf module (relative imports only): scripts/verify-asset-versions.ts runs it outside the app's path aliases.
/** Versioned browser bundles: public path -> the version recorded in scripts/asset-versions.json. */
export const versionedBundles: Readonly<Record<string, string>> = {
  "/management-pages.js": MANAGEMENT_SHELL_VERSION,
  "/management-query.js": MANAGEMENT_QUERY_VERSION,
  "/select.js": SELECT_VERSION,
  "/lazy-tree.js": LAZY_TREE_VERSION,
  "/private-viewer.js": PRIVATE_VIEWER_VERSION,
  "/commentor-parent.js": COMMENTOR_PARENT_VERSION,
  "/commentor.js": COMMENTOR_VERSION,
  "/rum.js": RUM_VERSION,
};

