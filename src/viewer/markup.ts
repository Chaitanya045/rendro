import { escapeHtml } from "@/routes/html";

export function viewerScript(mode: "parent" | "frame" | "navigation" | "share", config: Record<string, unknown>, documentUrl?: string): string {
  // Publisher bases can be cross-origin: integration code must stay app-owned.
  const src = documentUrl ? new URL("/private-viewer.js?v=3", documentUrl).href : "/private-viewer.js?v=3";
  return `<script src="${escapeHtml(src)}" data-viewer="${mode}" data-config="${escapeHtml(JSON.stringify(config))}"></script>`;
}
