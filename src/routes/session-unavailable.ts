import { nonceAttribute } from "@/middleware/html-nonce";
import { renderFaviconLinks } from "./favicon";
import { renderThemeAssets } from "./theme";

/**
 * No request data is embedded; the relative link retries this URL with a GET, which inside a viewer
 * frame reloads only that frame. `document` is the recovery page for stored documents and assets whose
 * backend (storage or the database) could not be reached: it never claims the session was the problem.
 */
export function renderSessionUnavailablePage(
  status: 500 | 503 = 503,
  subject: "session" | "document" = "session",
  /** Inside a viewer frame, ask the shell to reload the frame: a link click from the sandboxed frame carries no cookies. */
  parentRetry = false,
): string {
  const heading = subject === "document" ? "We couldn't load this document"
    : status === 500 ? "We couldn't load this page" : "We couldn't check your session";
  const detail = subject === "document" ? "Please wait a moment and try again. The document hasn't been removed."
    : status === 500 ? "Please wait a moment and try loading this page again."
    : "Please wait a moment and try again. You don't need to sign in again because of this error.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Temporarily unavailable — Rendro</title>
${renderFaviconLinks()}
${renderThemeAssets()}
<script${nonceAttribute()}>
  addEventListener("message",function(event){if(event.source!==window.parent||window.parent===window)return;var data=event.data||{};if(data.type==="rendro-theme")window.RendroUI.applyTheme(data.theme,false,false);});
  if(window.parent!==window){document.documentElement.classList.add("framed");window.parent.postMessage({type:"commentor-theme-ready"},"*");}
</script>
<style${nonceAttribute()}>
  *{box-sizing:border-box}
  :root{color-scheme:light;--page:#fafafa;--surface:#fff;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#c2410c;--accent-hover:#9a3412;--on-accent:#fff}
  html.dark{color-scheme:dark;--page:#09090b;--surface:#18181b;--text:#fafafa;--muted:#a1a1aa;--border:#27272a;--accent:#fb923c;--accent-hover:#fdba74;--on-accent:#09090b}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--page);color:var(--text);font-family:Inter,system-ui,sans-serif}
  main{width:min(560px,100%);padding:32px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
  .brand{font-size:24px;font-weight:700;letter-spacing:-.04em}.brand span{color:var(--accent)}html.framed .brand{display:none}html.framed .eyebrow{margin-top:0}
  .eyebrow{margin:24px 0 8px;color:var(--accent);font-size:12px;font-weight:700}
  h1{margin:0;font-size:clamp(28px,5vw,36px);line-height:1.15;letter-spacing:-.03em}
  p{color:var(--muted);font-size:15px;line-height:1.6}
  .retry{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:8px;padding:10px 18px;border-radius:6px;background:var(--accent);color:var(--on-accent);font-size:14px;font-weight:650;text-decoration:none}
  .retry:hover{background:var(--accent-hover)}.retry:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  @media(max-width:520px){body{padding:14px}main{padding:24px 20px}}
</style>
</head>
<body>
<main aria-labelledby="session-error-title">
  <div class="brand">Rendro<span>.</span></div>
  <p class="eyebrow">${status} · Temporarily unavailable</p>
  <h1 id="session-error-title">${heading}</h1>
  <p>${detail}</p>
  <a class="retry" href="">Try again</a>
</main>${parentRetry ? `
<script${nonceAttribute()}>
  document.querySelector("a.retry").addEventListener("click",function(event){if(window.parent===window)return;event.preventDefault();window.parent.postMessage({type:"doc-retry"},"*");});
</script>` : ""}
</body>
</html>`;
}
