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
  const heading = options.heading || "This doc lost its branch.";
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
  .page{width:min(1040px,100%);display:grid;grid-template-columns:minmax(280px,.92fr) minmax(320px,1fr);gap:28px;align-items:center}
  .graph,.panel{border:1px solid #e4e4e7;background:rgba(255,255,255,.82);box-shadow:0 24px 80px rgba(9,9,11,.10);backdrop-filter:blur(16px)}
  .graph{min-height:430px;border-radius:32px;position:relative;overflow:hidden;padding:28px}
  .graph:before{content:"";position:absolute;inset:0;background-image:linear-gradient(#e4e4e7 1px,transparent 1px),linear-gradient(90deg,#e4e4e7 1px,transparent 1px);background-size:32px 32px;mask-image:radial-gradient(circle at center,#000 0%,transparent 78%);opacity:.55}
  .edge{position:absolute;height:2px;background:linear-gradient(90deg,rgba(113,113,122,.0),rgba(113,113,122,.55),rgba(113,113,122,.0));transform-origin:left center}
  .edge.a{left:104px;top:138px;width:190px;transform:rotate(20deg)}
  .edge.b{left:124px;top:267px;width:180px;transform:rotate(-18deg)}
  .edge.c{right:128px;top:205px;width:132px;transform:rotate(90deg);background:linear-gradient(90deg,rgba(251,146,60,0),rgba(251,146,60,.72),rgba(251,146,60,0));filter:drop-shadow(0 0 8px rgba(251,146,60,.45))}
  .node{position:absolute;display:flex;align-items:center;gap:10px;min-width:150px;padding:12px 14px;border-radius:18px;border:1px solid #e4e4e7;background:#fff;color:#18181b;box-shadow:0 10px 28px rgba(9,9,11,.10)}
  .node:before{content:"";width:10px;height:10px;border-radius:50%;background:#a1a1aa;box-shadow:0 0 0 4px rgba(161,161,170,.16)}
  .node strong{display:block;font-size:13px;line-height:1.1}.node span{display:block;margin-top:3px;color:#71717a;font-size:11px}
  .node.root{left:42px;top:64px}.node.guides{left:236px;top:126px}.node.api{left:72px;bottom:70px}.node.ref{right:54px;bottom:108px}
  .node.missing{right:52px;top:60px;min-width:176px;border-color:#fed7aa;background:linear-gradient(135deg,#fff7ed,#fff);transform:rotate(2deg);animation:floatMissing 3.8s cubic-bezier(.4,0,.2,1) infinite;box-shadow:0 18px 44px rgba(194,65,12,.18)}
  .node.missing:before{background:#f97316;box-shadow:0 0 0 5px rgba(249,115,22,.18),0 0 28px rgba(249,115,22,.55)}
  .break{position:absolute;right:224px;top:132px;color:#f97316;font-weight:900;font-size:28px;text-shadow:0 6px 22px rgba(249,115,22,.38)}
  .badge{position:absolute;left:28px;bottom:26px;display:inline-flex;align-items:center;gap:8px;border:1px solid #fed7aa;background:#fff7ed;color:#9a3412;border-radius:999px;padding:8px 12px;font-size:13px;font-weight:600}
  .panel{border-radius:28px;padding:34px;position:relative;overflow:hidden}.panel:before{content:"404";position:absolute;right:-18px;top:-38px;font-size:150px;font-weight:800;letter-spacing:-.08em;color:rgba(249,115,22,.08);line-height:1}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;margin:0 0 18px;padding:7px 10px;border-radius:999px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
  h1{position:relative;margin:0 0 12px;font-size:clamp(34px,5vw,58px);line-height:.95;letter-spacing:-.055em;color:#09090b}
  p{position:relative;margin:0;color:#52525b;font-size:16px;line-height:1.65;max-width:58ch}.path{position:relative;margin:22px 0 24px;padding:13px 14px;border:1px solid #e4e4e7;border-radius:16px;background:#f4f4f5;color:#18181b;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;overflow-wrap:anywhere}
  .actions{position:relative;display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 16px;border-radius:999px;border:1px solid #d4d4d8;font-size:14px;font-weight:700;text-decoration:none;cursor:pointer;transition:transform .18s cubic-bezier(.4,0,.2,1),background .18s ease,border-color .18s ease,color .18s ease}.btn:hover{transform:translateY(-1px)}.btn.primary{background:#241c0c;border-color:#241c0c;color:#fff}.btn.primary:hover{background:#3f2f12}.btn.secondary{background:transparent;color:#18181b}.btn.secondary:hover{background:#f4f4f5;border-color:#a1a1aa}.hint{margin-top:20px;color:#71717a;font-size:13px}
  @keyframes floatMissing{0%,100%{transform:translateY(0) rotate(2deg)}50%{transform:translateY(-8px) rotate(-1deg)}}
  @media (prefers-reduced-motion:reduce){.node.missing{animation:none}.btn{transition:none}}
  @media (max-width:820px){body{padding:20px}.page{grid-template-columns:1fr}.graph{min-height:310px}.node.ref{display:none}.panel{padding:28px}.panel:before{font-size:110px}}
  html.dark body,body.dark{background:linear-gradient(180deg,#09090b 0%,#111113 50%,#18181b 100%);color:#fafafa}
  html.dark .graph,html.dark .panel,body.dark .graph,body.dark .panel{background:rgba(24,24,27,.78);border-color:#27272a;box-shadow:0 28px 90px rgba(0,0,0,.45)}
  html.dark .graph:before,body.dark .graph:before{background-image:linear-gradient(#27272a 1px,transparent 1px),linear-gradient(90deg,#27272a 1px,transparent 1px);opacity:.65}
  html.dark .node,body.dark .node{background:#18181b;border-color:#3f3f46;color:#fafafa}.dark .node span,html.dark .node span{color:#a1a1aa}
  html.dark .node.missing,body.dark .node.missing{background:linear-gradient(135deg,rgba(67,20,7,.85),#18181b);border-color:#9a3412}
  html.dark h1,body.dark h1{color:#fafafa}html.dark p,body.dark p{color:#a1a1aa}html.dark .path,body.dark .path{background:#09090b;border-color:#27272a;color:#fafafa}
  html.dark .btn.primary,body.dark .btn.primary{background:#fafafa;border-color:#fafafa;color:#09090b}html.dark .btn.primary:hover,body.dark .btn.primary:hover{background:#e4e4e7}
  html.dark .btn.secondary,body.dark .btn.secondary{color:#fafafa;border-color:#3f3f46}html.dark .btn.secondary:hover,body.dark .btn.secondary:hover{background:#27272a;border-color:#52525b}
  @media (prefers-color-scheme:dark){body{background:linear-gradient(180deg,#09090b 0%,#111113 50%,#18181b 100%);color:#fafafa}.graph,.panel{background:rgba(24,24,27,.78);border-color:#27272a;box-shadow:0 28px 90px rgba(0,0,0,.45)}.graph:before{background-image:linear-gradient(#27272a 1px,transparent 1px),linear-gradient(90deg,#27272a 1px,transparent 1px);opacity:.65}.node{background:#18181b;border-color:#3f3f46;color:#fafafa}.node span{color:#a1a1aa}.node.missing{background:linear-gradient(135deg,rgba(67,20,7,.85),#18181b);border-color:#9a3412}h1{color:#fafafa}p{color:#a1a1aa}.path{background:#09090b;border-color:#27272a;color:#fafafa}.btn.primary{background:#fafafa;border-color:#fafafa;color:#09090b}.btn.primary:hover{background:#e4e4e7}.btn.secondary{color:#fafafa;border-color:#3f3f46}.btn.secondary:hover{background:#27272a;border-color:#52525b}}
</style>
</head>
<body>
  <main class="page" aria-labelledby="not-found-title">
    <section class="graph" aria-label="Broken document graph illustration">
      <div class="edge a"></div><div class="edge b"></div><div class="edge c"></div><div class="break">×</div>
      <div class="node root"><div><strong>Docs root</strong><span>connected</span></div></div>
      <div class="node guides"><div><strong>Guides</strong><span>branch found</span></div></div>
      <div class="node api"><div><strong>Reference</strong><span>branch found</span></div></div>
      <div class="node ref"><div><strong>Current tree</strong><span>stable</span></div></div>
      <div class="node missing"><div><strong>Missing doc</strong><span>404 branch</span></div></div>
      <div class="badge">Broken document graph</div>
    </section>
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
