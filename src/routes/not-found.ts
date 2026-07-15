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
<style>
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fafafa;color:#09090b}
  body{min-height:100vh;display:grid;place-items:center;padding:32px;overflow-x:hidden;background:
    radial-gradient(circle at 20% 15%,rgba(251,146,60,.16),transparent 34%),
    radial-gradient(circle at 82% 18%,rgba(36,28,12,.08),transparent 28%),
    linear-gradient(180deg,#fff 0%,#fafafa 42%,#f4f4f5 100%)}
  .page{width:min(744px,100%);display:grid;place-items:center}
  .panel{width:100%;border:1px solid #e4e4e7;background:rgba(255,255,255,.86);box-shadow:0 28px 96px rgba(9,9,11,.12);backdrop-filter:blur(16px);border-radius:34px;padding:41px;position:relative;overflow:hidden}
  .panel:before{content:"404";position:absolute;right:-22px;top:-46px;font-size:180px;font-weight:800;letter-spacing:-.08em;color:rgba(249,115,22,.08);line-height:1}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;margin:0 0 22px;padding:8px 12px;border-radius:999px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
  h1{position:relative;margin:0 0 14px;font-size:clamp(41px,6vw,70px);line-height:.95;letter-spacing:-.055em;color:#09090b}
  p{position:relative;margin:0;color:#52525b;font-size:19px;line-height:1.65;max-width:58ch}.path{position:relative;margin:26px 0 29px;padding:16px 17px;border:1px solid #e4e4e7;border-radius:19px;background:#f4f4f5;color:#18181b;font:16px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;overflow-wrap:anywhere}
  .actions{position:relative;display:flex;flex-wrap:wrap;gap:12px;margin-top:5px}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:50px;padding:0 19px;border-radius:999px;border:1px solid #d4d4d8;font-size:17px;font-weight:700;text-decoration:none;cursor:pointer;transition:transform .18s cubic-bezier(.4,0,.2,1),background .18s ease,border-color .18s ease,color .18s ease}.btn:hover{transform:translateY(-1px)}.btn.primary{background:#241c0c;border-color:#241c0c;color:#fff}.btn.primary:hover{background:#3f2f12}.btn.secondary{background:transparent;color:#18181b}.btn.secondary:hover{background:#f4f4f5;border-color:#a1a1aa}.hint{margin-top:24px;color:#71717a;font-size:16px}
  @media (prefers-reduced-motion:reduce){.btn{transition:none}}
  @media (max-width:820px){body{padding:20px}.panel{padding:34px}.panel:before{font-size:132px}}
  html.dark body,body.dark{background:linear-gradient(180deg,#09090b 0%,#111113 50%,#18181b 100%);color:#fafafa}
  html.dark .panel,body.dark .panel{background:rgba(24,24,27,.78);border-color:#27272a;box-shadow:0 28px 90px rgba(0,0,0,.45)}
  html.dark h1,body.dark h1{color:#fafafa}html.dark p,body.dark p{color:#a1a1aa}html.dark .path,body.dark .path{background:#09090b;border-color:#27272a;color:#fafafa}
  html.dark .btn.primary,body.dark .btn.primary{background:#fafafa;border-color:#fafafa;color:#09090b}html.dark .btn.primary:hover,body.dark .btn.primary:hover{background:#e4e4e7}
  html.dark .btn.secondary,body.dark .btn.secondary{color:#fafafa;border-color:#3f3f46}html.dark .btn.secondary:hover,body.dark .btn.secondary:hover{background:#27272a;border-color:#52525b}
  @media (prefers-color-scheme:dark){body{background:linear-gradient(180deg,#09090b 0%,#111113 50%,#18181b 100%);color:#fafafa}.panel{background:rgba(24,24,27,.78);border-color:#27272a;box-shadow:0 28px 90px rgba(0,0,0,.45)}h1{color:#fafafa}p{color:#a1a1aa}.path{background:#09090b;border-color:#27272a;color:#fafafa}.btn.primary{background:#fafafa;border-color:#fafafa;color:#09090b}.btn.primary:hover{background:#e4e4e7}.btn.secondary{color:#fafafa;border-color:#3f3f46}.btn.secondary:hover{background:#27272a;border-color:#52525b}}
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
