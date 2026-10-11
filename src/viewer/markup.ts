import { nonceAttribute } from "@/middleware/html-nonce";
import { escapeHtml } from "@/routes/html";

export function viewerScript(mode: "parent" | "frame" | "navigation" | "share", config: Record<string, unknown>, documentUrl?: string): string {
  // Publisher bases can be cross-origin: integration code must stay app-owned.
  const src = documentUrl ? new URL("/private-viewer.js?v=7", documentUrl).href : "/private-viewer.js?v=7";
  // Request nonces belong only to trusted shells, never publisher documents.
  const nonce = mode === "parent" || mode === "share" ? nonceAttribute() : "";
  return `<script${nonce} src="${escapeHtml(src)}" data-viewer="${mode}" data-config="${escapeHtml(JSON.stringify(config))}"></script>`;
}

/** Trusted shell UI; publisher documents never receive this nonce or notice. */
export function viewerUpdateNotice(): string {
  return `<style${nonceAttribute()}>
#viewer-update-notice{position:fixed;z-index:100;top:12px;right:12px;max-width:calc(100vw - 24px);padding:12px 16px;border:1px solid #71717a;border-radius:8px;background:#fff;color:#18181b;box-shadow:0 4px 16px #0002;font:14px/1.5 system-ui}
#viewer-update-notice button{margin-left:12px;padding:4px 10px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer}
#viewer-update-notice button:focus-visible{outline:2px solid #c2410c;outline-offset:3px}
html.dark #viewer-update-notice{background:#18181b;color:#fafafa}
</style><aside id="viewer-update-notice" aria-label="Document update" hidden><span role="status" aria-live="polite"></span><button type="button">Reload</button></aside>`;
}
