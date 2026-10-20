import { COMMENTOR_PARENT_VERSION, COMMENTOR_VERSION, LAZY_TREE_VERSION, PRIVATE_VIEWER_VERSION, RUM_VERSION } from "../viewer/asset-versions";

// Leaf module (relative imports only): scripts/verify-asset-versions.ts runs it outside the app's path aliases.
/** Versioned browser bundles: public path -> the version recorded in scripts/asset-versions.json. */
export const versionedBundles: Readonly<Record<string, string>> = {
  "/lazy-tree.js": LAZY_TREE_VERSION,
  "/private-viewer.js": PRIVATE_VIEWER_VERSION,
  "/commentor-parent.js": COMMENTOR_PARENT_VERSION,
  "/commentor.js": COMMENTOR_VERSION,
  "/rum.js": RUM_VERSION,
};

