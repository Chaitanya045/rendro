export interface NotFoundPageOptions {
  path?: string;
  homeHref?: string;
  homeLabel?: string;
  heading?: string;
  message?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderNotFoundPage(options: NotFoundPageOptions = {}): string {
  const path = options.path || "/";
  const homeHref = options.homeHref || "/";
  const homeLabel = options.homeLabel || "Go to docs home";
  const heading = options.heading || "404 Not found";
  const message = options.message || "The URL points to a document or route that Rendro cannot find. It may have moved, been deleted, or never existed.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 — Rendro</title>
<script>
  (function(){
    var root=document.documentElement;
    var media=matchMedia("(prefers-color-scheme:dark)");
    function applyTheme(mode){
      mode=mode==="dark"||mode==="light"||mode==="system"?mode:"system";
      var resolved=mode==="system"?(media.matches?"dark":"light"):mode;
      root.dataset.theme=mode;
      root.dataset.resolvedTheme=resolved;
      root.classList.toggle("dark",resolved==="dark");
    }
    var initialTheme="system";
    try{initialTheme=localStorage.getItem("commentor-theme")||"system";}catch(_){}
    applyTheme(initialTheme);
    media.addEventListener("change",function(){if((root.dataset.theme||"system")==="system")applyTheme("system");});
    addEventListener("message",function(event){
      var data=event.data||{};
      if(data.type==="rendro-theme")applyTheme(data.theme);
    });
  })();
</script>
<style>
  *{box-sizing:border-box}
  :root{color-scheme:light;--page:#fafafa;--surface:#fff;--container:#f4f4f5;--text:#18181b;--strong:#09090b;--muted:#71717a;--border:#e4e4e7;--border-strong:#d4d4d8;--accent:#c2410c;--accent-hover:#9a3412;--accent-soft:#ffedd5;--on-accent:#fff;--focus:rgba(194,65,12,.2)}
  html.dark{color-scheme:dark;--page:#09090b;--surface:#18181b;--container:#27272a;--text:#e4e4e7;--strong:#fafafa;--muted:#a1a1aa;--border:#27272a;--border-strong:#3f3f46;--accent:#fb923c;--accent-hover:#fdba74;--accent-soft:rgba(251,146,60,.16);--on-accent:#09090b;--focus:rgba(251,146,60,.23)}
  html,body{margin:0;min-height:100%;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--page);color:var(--text)}
  body{min-height:100vh;display:grid;place-items:center;padding:24px}
  .page{width:min(640px,100%)}
  .panel{width:100%;padding:32px;border:1px solid var(--border);border-radius:10px;background:var(--surface);box-shadow:0 18px 48px rgba(24,24,27,.08)}
  .eyebrow{margin:0 0 8px;color:var(--accent);font-size:11px;font-weight:750;letter-spacing:.09em;text-transform:uppercase}
  h1{margin:0;color:var(--strong);font-size:clamp(30px,5vw,42px);line-height:1.08;letter-spacing:-.04em}
  p{margin:12px 0 0;max-width:56ch;color:var(--muted);font-size:15px;line-height:1.6}
  .path{margin:24px 0;padding:12px 13px;border:1px solid var(--border);border-radius:6px;background:var(--container);color:var(--text);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;overflow-wrap:anywhere}
  .actions{display:flex;flex-wrap:wrap;gap:8px}.btn{min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:8px 14px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--strong);font-size:14px;font-weight:650;text-decoration:none;cursor:pointer;transition:background 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1),transform 150ms cubic-bezier(.4,0,.2,1)}.btn:hover{border-color:var(--muted);background:var(--container)}.btn:active{transform:scale(.98)}.btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--focus);border-color:var(--accent)}.btn.primary{border-color:var(--accent);background:var(--accent);color:var(--on-accent)}.btn.primary:hover{border-color:var(--accent-hover);background:var(--accent-hover)}.hint{margin-top:20px;font-size:12px}
  @media (prefers-reduced-motion:reduce){.btn{transition:none}.btn:active{transform:none}}
  @media (max-width:520px){body{padding:14px}.panel{padding:24px 20px}.actions{align-items:stretch;flex-direction:column}.btn{width:100%}}
</style>
</head>
<body>
  <main class="page" aria-labelledby="not-found-title">
    <section class="panel">
      <div class="eyebrow">404 · Not found</div>
      <h1 id="not-found-title">${escapeHtml(heading)}</h1>
      <p>${escapeHtml(message)}</p>
      <div class="path" aria-label="Requested path">${escapeHtml(path)}</div>
      <div class="actions">
        <a class="btn primary" href="${escapeHtml(homeHref)}" target="_top">${escapeHtml(homeLabel)}</a>
        <button class="btn secondary" type="button" onclick="if(window.top&&window.top!==window){window.top.history.back()}else{history.back()}">Go back</button>
      </div>
      <p class="hint">Check the URL, open the docs tree, or return to a known branch.</p>
    </section>
  </main>
</body>
</html>`;
}
