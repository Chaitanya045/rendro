import { installViewerFrame, installViewerParent } from "./client";
const script = document.currentScript as HTMLScriptElement | null;
if (script?.dataset.config) {
  const config = JSON.parse(script.dataset.config) as { base: string; prefix: string; manifestKey: string };
  if (script.dataset.viewer === "parent") installViewerParent(config);
  if (script.dataset.viewer === "frame") installViewerFrame(config);
}
