import { escapeHtml } from "@/routes/html";

export function viewerScript(mode: "parent" | "frame", config: Record<string, unknown>): string {
  return `<script src="/private-viewer.js?v=2" data-viewer="${mode}" data-config="${escapeHtml(JSON.stringify(config))}"></script>`;
}
