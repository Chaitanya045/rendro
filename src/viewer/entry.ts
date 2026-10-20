import { installDocumentNavigation, type DocumentNavigationConfig } from "./navigation";
import { installViewerFrame, installViewerParent } from "./client";
const script = document.currentScript as HTMLScriptElement | null;
if (script?.dataset.config) {
  const config = JSON.parse(script.dataset.config) as { base: string; prefix: string; manifestKey: string; ticket?: { issuedAt: number; renewAfter: number } } & DocumentNavigationConfig;
  if (script.dataset.viewer === "parent") installViewerParent(config);
  if (script.dataset.viewer === "navigation") installDocumentNavigation(config);
  if (script.dataset.viewer === "frame") installViewerFrame(config);
}
