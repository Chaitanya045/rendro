export function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#09090b">
  <meta name="description" content="Rendro turns plain HTML in your repository into a navigable documentation workspace with contextual comments and controlled publishing.">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Rendro — Documentation that ships with your code">
  <meta property="og:description" content="Keep documentation beside the code. Publish from CI into a fast, navigable workspace without maintaining a CMS.">
  <meta property="og:url" content="https://rendro.app/">
  <meta property="og:image" content="https://rendro.app/landing-product.webp">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="https://rendro.app/">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <title>Rendro — Documentation that ships with your code</title>
  <style>
    :root {
      color-scheme: dark;
      --surface: #09090b;
      --surface-elevated: #18181b;
      --surface-hover: #27272a;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --border: #27272a;
      --primary: #fb923c;
      --primary-hover: #fdba74;
      --primary-muted: rgba(251,146,60,.16);
      --primary-shadow: rgba(251,146,60,.2);
      --page-width: 1200px;
      --ease-standard: cubic-bezier(.4,0,.2,1);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; scroll-padding-top: 88px; background: var(--surface); }
    body { margin: 0; min-width: 320px; overflow-x: hidden; background: var(--surface); color: var(--text); font-family: Inter, system-ui, -apple-system, sans-serif; font-size: 16px; line-height: 1.6; }
    button, a { font: inherit; }
    button { color: inherit; }
    a { color: inherit; text-decoration: none; }
    img { display: block; max-width: 100%; }
    .skip-link { position: fixed; top: 12px; left: 12px; z-index: 100; padding: 10px 14px; border-radius: 6px; background: var(--primary); color: var(--surface); font-weight: 700; transform: translateY(-160%); transition: transform 150ms var(--ease-standard); }
    .skip-link:focus { transform: translateY(0); }
    :focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
    .container { width: min(calc(100% - 48px), var(--page-width)); margin-inline: auto; }
    .site-header { position: sticky; top: 0; z-index: 30; min-height: 68px; border-bottom: 1px solid var(--border); background: rgba(9,9,11,.86); backdrop-filter: blur(18px); }
    .header-inner { min-height: 68px; display: flex; align-items: center; gap: 32px; }
    .brand { color: var(--primary); font-size: 24px; line-height: 32px; font-weight: 700; letter-spacing: -.03em; }
    .nav-links { display: flex; align-items: center; gap: 28px; margin-left: auto; color: var(--text-muted); font-size: 14px; }
    .nav-links a, .footer-links a { transition: color 150ms var(--ease-standard); }
    .nav-links a:hover, .footer-links a:hover { color: var(--text); }
    .header-actions { display: flex; align-items: center; gap: 10px; }
    .button { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 18px; border: 1px solid transparent; border-radius: 7px; font-size: 14px; line-height: 20px; font-weight: 600; cursor: pointer; transition: transform 150ms var(--ease-standard), background-color 150ms var(--ease-standard), border-color 150ms var(--ease-standard), color 150ms var(--ease-standard), box-shadow 150ms var(--ease-standard); }
    .button:hover { transform: translateY(-1px); }
    .button:active { transform: scale(.98); }
    .button-primary { background: var(--primary); color: var(--surface); box-shadow: 0 10px 30px var(--primary-shadow); }
    .button-primary:hover { background: var(--primary-hover); }
    .button-secondary { border-color: var(--border); background: var(--surface-elevated); color: var(--text); }
    .button-secondary:hover { border-color: var(--text-muted); background: var(--surface-hover); }
    .button-quiet { border-color: transparent; background: transparent; color: var(--text-muted); box-shadow: none; }
    .button-quiet:hover { color: var(--text); background: var(--surface-elevated); }
    .button[disabled] { cursor: wait; opacity: .72; transform: none; }
    .button-spinner { display: none; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 700ms linear infinite; }
    .button[aria-busy="true"] .button-spinner { display: block; }
    .hero { position: relative; overflow: clip; padding: 104px 0 88px; }
    .hero::before { content: ""; position: absolute; width: 520px; height: 520px; top: -180px; right: -180px; border-radius: 50%; background: radial-gradient(circle, var(--primary-muted), transparent 68%); pointer-events: none; }
    .hero-grid { position: relative; display: grid; grid-template-columns: minmax(0,.86fr) minmax(520px,1.14fr); align-items: center; gap: 64px; }
    .hero-copy { animation: heroReveal 300ms var(--ease-standard) both; }
    .eyebrow { display: flex; align-items: center; gap: 10px; margin: 0 0 20px; color: var(--primary); font-size: 12px; line-height: 16px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
    .eyebrow::before { content: ""; width: 28px; height: 1px; background: var(--primary); }
    h1, h2, h3, p { margin-top: 0; }
    h1 { max-width: 680px; margin-bottom: 24px; font-size: clamp(46px,5.3vw,72px); line-height: 1.02; letter-spacing: -.055em; }
    .hero-lede { max-width: 620px; margin-bottom: 32px; color: var(--text-muted); font-size: 18px; line-height: 29px; }
    .hero-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 28px; }
    .arrow { display: inline-block; transition: transform 150ms var(--ease-standard); }
    .button:hover .arrow { transform: translateX(2px); }
    .hero-facts { display: flex; flex-wrap: wrap; gap: 10px 22px; margin: 0; padding: 0; color: var(--text-muted); font-size: 13px; list-style: none; }
    .hero-facts li { position: relative; padding-left: 14px; }
    .hero-facts li::before { content: ""; position: absolute; left: 0; top: .75em; width: 4px; height: 4px; border-radius: 50%; background: var(--primary); }
    .product-shot { position: relative; margin: 0; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface-elevated); box-shadow: 0 28px 80px rgba(0,0,0,.42); animation: shotReveal 300ms 80ms var(--ease-standard) both; transition: transform 300ms var(--ease-standard), border-color 200ms var(--ease-standard); }
    .product-shot:hover { transform: translateY(-3px); border-color: var(--text-muted); }
    .shot-bar { height: 38px; display: flex; align-items: center; gap: 7px; padding: 0 13px; border-bottom: 1px solid var(--border); background: var(--surface-elevated); }
    .shot-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); opacity: .42; }
    .shot-title { min-width: 0; margin-left: 7px; overflow: hidden; color: var(--text-muted); font-size: 11px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
    .product-shot img { width: 100%; height: auto; aspect-ratio: 1280/577; object-fit: cover; }
    .shot-caption { position: absolute; right: 12px; bottom: 12px; padding: 6px 9px; border: 1px solid var(--border); border-radius: 5px; background: rgba(9,9,11,.88); color: var(--text-muted); font-size: 10px; line-height: 14px; }
    .proof-band { border-block: 1px solid var(--border); background: var(--surface-elevated); }
    .proof-grid { display: grid; grid-template-columns: repeat(3,1fr); }
    .proof { min-height: 156px; padding: 32px; border-right: 1px solid var(--border); transition: background-color 200ms var(--ease-standard); }
    .proof:last-child { border-right: 0; }
    .proof:hover { background: var(--surface-hover); }
    .proof-value { margin: 0 0 4px; color: var(--primary); font-size: 34px; line-height: 42px; font-weight: 700; letter-spacing: -.04em; }
    .proof-label { margin: 0; color: var(--text-muted); font-size: 14px; }
    .section { padding: 112px 0; border-bottom: 1px solid var(--border); }
    .section-header { max-width: 720px; margin-bottom: 52px; }
    .section-kicker { margin-bottom: 14px; color: var(--primary); font-size: 12px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
    h2 { margin-bottom: 18px; font-size: clamp(34px,4vw,52px); line-height: 1.08; letter-spacing: -.045em; }
    .section-intro { max-width: 650px; margin-bottom: 0; color: var(--text-muted); font-size: 17px; line-height: 27px; }
    .workflow-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .workflow-steps { display: grid; gap: 12px; }
    .workflow-step { display: grid; grid-template-columns: 52px 1fr; gap: 18px; padding: 22px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-elevated); transition: border-color 200ms var(--ease-standard), transform 200ms var(--ease-standard); }
    .workflow-step:hover { border-color: var(--text-muted); transform: translateX(3px); }
    .step-number { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 6px; background: var(--primary-muted); color: var(--primary); font-size: 13px; font-weight: 700; }
    .workflow-step h3 { margin: 0 0 5px; font-size: 16px; line-height: 24px; }
    .workflow-step p { margin: 0; color: var(--text-muted); font-size: 14px; line-height: 22px; }
    .terminal { align-self: stretch; min-height: 100%; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-elevated); box-shadow: 0 20px 48px rgba(0,0,0,.26); }
    .terminal-bar { min-height: 44px; display: flex; align-items: center; gap: 7px; padding: 0 16px; border-bottom: 1px solid var(--border); color: var(--text-muted); font: 500 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .terminal-body { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 12px; padding: 30px; color: var(--text); font: 13px/22px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .terminal-prompt { color: var(--primary); }
    .terminal-muted { color: var(--text-muted); }
    .terminal-success { color: var(--primary-hover); }
    .features { display: grid; grid-template-columns: repeat(2,1fr); gap: 16px; }
    .feature { min-height: 230px; padding: 30px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-elevated); transition: transform 200ms var(--ease-standard), border-color 200ms var(--ease-standard), background-color 200ms var(--ease-standard); }
    .feature:hover { transform: translateY(-3px); border-color: var(--text-muted); background: var(--surface-hover); }
    .feature-number { display: block; margin-bottom: 38px; color: var(--primary); font: 700 12px/16px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .feature h3 { margin-bottom: 9px; font-size: 20px; line-height: 28px; letter-spacing: -.02em; }
    .feature p { max-width: 480px; margin: 0; color: var(--text-muted); font-size: 14px; line-height: 23px; }
    .security-grid { display: grid; grid-template-columns: .8fr 1.2fr; align-items: start; gap: 80px; }
    .security-copy { position: sticky; top: 108px; }
    .security-copy .section-intro { margin-bottom: 28px; }
    .security-list { margin: 0; border-top: 1px solid var(--border); }
    .security-row { display: grid; grid-template-columns: 150px 1fr; gap: 28px; padding: 24px 0; border-bottom: 1px solid var(--border); }
    .security-row dt { color: var(--text); font-size: 14px; font-weight: 600; }
    .security-row dd { margin: 0; color: var(--text-muted); font-size: 14px; line-height: 23px; }
    .final-cta { padding: 112px 0; }
    .cta-panel { position: relative; overflow: hidden; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 40px; padding: 52px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-elevated); }
    .cta-panel::after { content: ""; position: absolute; width: 280px; height: 280px; right: -130px; bottom: -180px; border-radius: 50%; background: var(--primary-muted); pointer-events: none; }
    .cta-panel h2 { max-width: 760px; margin-bottom: 10px; }
    .cta-panel p { margin: 0; color: var(--text-muted); }
    .cta-panel .button { position: relative; z-index: 1; }
    .site-footer { padding: 32px 0; border-top: 1px solid var(--border); }
    .footer-inner { display: flex; align-items: center; gap: 28px; color: var(--text-muted); font-size: 13px; }
    .footer-brand { color: var(--primary); font-size: 16px; font-weight: 700; }
    .footer-links { display: flex; flex-wrap: wrap; gap: 20px; margin-left: auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes heroReveal { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes shotReveal { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @media (max-width: 980px) {
      .hero { padding-top: 80px; }
      .hero-grid { grid-template-columns: 1fr; gap: 48px; }
      .product-shot { width: 100%; }
      .security-grid { grid-template-columns: 1fr; gap: 44px; }
      .security-copy { position: static; }
    }
    @media (max-width: 760px) {
      .container { width: min(calc(100% - 32px), var(--page-width)); }
      .nav-links, .header-signin { display: none; }
      .header-actions { margin-left: auto; }
      .hero { padding: 68px 0 64px; }
      h1 { font-size: clamp(40px,13vw,56px); }
      .hero-lede { font-size: 16px; line-height: 26px; }
      .hero-actions { align-items: stretch; flex-direction: column; }
      .hero-actions .button { width: 100%; }
      .shot-caption { display: none; }
      .proof-grid, .workflow-grid, .features { grid-template-columns: 1fr; }
      .proof { min-height: auto; border-right: 0; border-bottom: 1px solid var(--border); }
      .proof:last-child { border-bottom: 0; }
      .section { padding: 80px 0; }
      .section-header { margin-bottom: 36px; }
      .terminal-body { min-height: 250px; padding: 22px; overflow-wrap: anywhere; }
      .feature { min-height: 210px; }
      .security-row { grid-template-columns: 1fr; gap: 6px; }
      .final-cta { padding: 80px 0; }
      .cta-panel { grid-template-columns: 1fr; padding: 32px 24px; }
      .cta-panel .button { width: 100%; }
      .footer-inner { align-items: flex-start; flex-direction: column; }
      .footer-links { margin-left: 0; }
    }
    @media (max-width: 420px) {
      .header-get-started { padding-inline: 13px; }
      .hero-facts { align-items: flex-start; flex-direction: column; gap: 8px; }
      .product-shot { border-radius: 8px; }
      .shot-title { display: none; }
      .workflow-step { grid-template-columns: 42px 1fr; padding: 18px; gap: 13px; }
      .step-number { width: 36px; height: 36px; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
      .button:hover, .button:active, .product-shot:hover, .workflow-step:hover, .feature:hover { transform: none; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <form id="sign-in-form" method="post" action="/api/auth/sign-in/social" hidden>
    <input type="hidden" name="provider" value="google">
    <input type="hidden" name="callbackURL" id="sign-in-callback">
  </form>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="Rendro home">Rendro</a>
      <nav class="nav-links" aria-label="Primary navigation">
        <a href="#product">Product</a>
        <a href="#workflow">Workflow</a>
        <a href="#security">Security</a>
      </nav>
      <div class="header-actions">
        <button class="button button-quiet header-signin" type="submit" form="sign-in-form" data-auth>
          <span data-auth-label>Sign in</span><span class="button-spinner" aria-hidden="true"></span>
        </button>
        <button class="button button-primary header-get-started" type="submit" form="sign-in-form" data-auth>
          <span data-auth-label>Get started</span><span class="button-spinner" aria-hidden="true"></span>
        </button>
      </div>
    </div>
  </header>
  <main id="main-content">
    <section class="hero" aria-labelledby="hero-title">
      <div class="container hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">Documentation for teams that ship</p>
          <h1 id="hero-title">Your docs should ship with your code.</h1>
          <p class="hero-lede">Keep documentation as plain HTML in the repo. Rendro publishes it from CI into a fast, navigable workspace—with contextual comments and no CMS to maintain.</p>
          <div class="hero-actions">
            <button class="button button-primary" type="submit" form="sign-in-form" data-auth>
              <span data-auth-label>Start with Google</span><span class="button-spinner" aria-hidden="true"></span>
            </button>
            <a class="button button-secondary" href="https://dev.rendro.app/public/rendro-feature-test/reference" target="_blank" rel="noreferrer">View live docs <span class="arrow" aria-hidden="true">→</span></a>
          </div>
          <ul class="hero-facts" aria-label="Product principles">
            <li>Plain HTML</li>
            <li>Zero-dependency CLI</li>
            <li>Private by default</li>
          </ul>
        </div>
        <figure class="product-shot">
          <div class="shot-bar" aria-hidden="true">
            <span class="shot-dot"></span><span class="shot-dot"></span><span class="shot-dot"></span>
            <span class="shot-title">rendro-feature-test / reference / contributing.html</span>
          </div>
          <img src="/landing-product.webp" width="1280" height="577" alt="Rendro workspace with an organization file tree, a rendered documentation page, sharing controls, and contextual comment tools" fetchpriority="high">
          <figcaption class="shot-caption">Actual Rendro workspace</figcaption>
        </figure>
      </div>
    </section>

    <section class="proof-band" aria-label="Product proof">
      <div class="container proof-grid">
        <article class="proof"><p class="proof-value">&lt;40s</p><p class="proof-label">Target from CI push to live documentation</p></article>
        <article class="proof"><p class="proof-value">0</p><p class="proof-label">Runtime dependencies in the publishing CLI</p></article>
        <article class="proof"><p class="proof-value">3 layers</p><p class="proof-label">Organization isolation across auth, routing, and storage</p></article>
      </div>
    </section>

    <section class="section" id="workflow" aria-labelledby="workflow-title">
      <div class="container">
        <header class="section-header">
          <p class="section-kicker">Workflow</p>
          <h2 id="workflow-title">From commit to readable in one push.</h2>
          <p class="section-intro">Rendro fits the workflow your engineering team already reviews, tests, and deploys.</p>
        </header>
        <div class="workflow-grid">
          <div class="workflow-steps">
            <article class="workflow-step"><span class="step-number">01</span><div><h3>Author plain HTML</h3><p>Keep documentation beside the code, with your own structure and styling.</p></div></article>
            <article class="workflow-step"><span class="step-number">02</span><div><h3>Push through CI</h3><p>The Rendro CLI hashes files and uploads only what changed.</p></div></article>
            <article class="workflow-step"><span class="step-number">03</span><div><h3>Read and review</h3><p>Your team gets navigation, sharing, and comments without adopting another editor.</p></div></article>
          </div>
          <div class="terminal" aria-label="Rendro command example">
            <div class="terminal-bar"><span class="shot-dot"></span><span class="shot-dot"></span><span class="shot-dot"></span><span>CI / publish-docs</span></div>
            <div class="terminal-body">
              <div><span class="terminal-prompt">$</span> rendro push --source ./docs --org my-org</div>
              <div class="terminal-muted">→ Syncing ./docs to https://rendro.app my-org</div>
              <div class="terminal-success">✓ API key valid</div>
              <div class="terminal-muted">Only changed HTML is uploaded.</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="product" aria-labelledby="product-title">
      <div class="container">
        <header class="section-header">
          <p class="section-kicker">Product</p>
          <h2 id="product-title">The docs shell your HTML does not have to build.</h2>
          <p class="section-intro">Rendro owns the workspace around the document. Your uploaded HTML remains isolated and renders exactly as authored.</p>
        </header>
        <div class="features">
          <article class="feature"><span class="feature-number">01 / NAVIGATE</span><h3>File-tree navigation</h3><p>Folders load on demand, large directories paginate, and cross-document links keep the active tree location synchronized.</p></article>
          <article class="feature"><span class="feature-number">02 / RENDER</span><h3>Publisher-owned HTML</h3><p>Your document stays inside a sandboxed iframe. Rendro does not impose its typography or rewrite your presentation.</p></article>
          <article class="feature"><span class="feature-number">03 / REVIEW</span><h3>Comments in context</h3><p>Select text, open a thread, and receive replies in real time without moving the discussion to chat or email.</p></article>
          <article class="feature"><span class="feature-number">04 / PUBLISH</span><h3>Controlled public access</h3><p>Uploads remain private until trusted CI registers an approved folder at a stable, anonymous read-only URL.</p></article>
        </div>
      </div>
    </section>

    <section class="section" id="security" aria-labelledby="security-title">
      <div class="container security-grid">
        <div class="security-copy">
          <p class="section-kicker">Security</p>
          <h2 id="security-title">Private by default. Scoped by organization.</h2>
          <p class="section-intro">The organization boundary is part of every request, not an optional permission setting.</p>
          <button class="button button-secondary" type="submit" form="sign-in-form" data-auth><span data-auth-label>Start with Google</span><span class="button-spinner" aria-hidden="true"></span></button>
        </div>
        <dl class="security-list">
          <div class="security-row"><dt>Identity</dt><dd>Google OAuth connects each session to a verified work email.</dd></div>
          <div class="security-row"><dt>Organization</dt><dd>The work-email domain determines the organization namespace.</dd></div>
          <div class="security-row"><dt>Storage</dt><dd>Document objects are stored under organization-specific prefixes.</dd></div>
          <div class="security-row"><dt>Public access</dt><dd>Only folders explicitly registered by trusted CI receive anonymous routes.</dd></div>
        </dl>
      </div>
    </section>

    <section class="final-cta" aria-labelledby="cta-title">
      <div class="container">
        <div class="cta-panel">
          <div><h2 id="cta-title">Keep writing docs where the code changes.</h2><p>Let Rendro handle delivery, navigation, and feedback.</p></div>
          <button class="button button-primary" type="submit" form="sign-in-form" data-auth><span data-auth-label>Start with Google</span><span class="button-spinner" aria-hidden="true"></span></button>
        </div>
      </div>
    </section>
  </main>
  <footer class="site-footer">
    <div class="container footer-inner">
      <a class="footer-brand" href="/">Rendro</a>
      <span>Documentation that stays close to the code.</span>
      <nav class="footer-links" aria-label="Footer navigation">
        <a href="#product">Product</a><a href="#workflow">Workflow</a><a href="#security">Security</a><a href="https://github.com/Chaitanya045/rendro" target="_blank" rel="noreferrer">GitHub</a>
      </nav>
    </div>
  </footer>
  <script>
    (function () {
      var form = document.getElementById("sign-in-form");
      var callback = document.getElementById("sign-in-callback");
      if (!(form instanceof HTMLFormElement) || !(callback instanceof HTMLInputElement)) return;
      callback.value = window.location.href;
      form.addEventListener("submit", function (event) {
        if (form.dataset.submitting === "true") { event.preventDefault(); return; }
        event.preventDefault();
        form.dataset.submitting = "true";
        var submitter = event.submitter;
        var buttons = Array.from(document.querySelectorAll("[data-auth]"));
        buttons.forEach(function (button) { button.disabled = true; });
        if (submitter instanceof HTMLButtonElement) {
          submitter.setAttribute("aria-busy", "true");
          var label = submitter.querySelector("[data-auth-label]");
          if (label) label.textContent = "Redirecting…";
        }
        fetch("/api/auth/sign-in/social", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "google", callbackURL: callback.value })
        }).then(function (response) {
          if (!response.ok) throw new Error("Sign-in request failed");
          return response.json();
        }).then(function (data) {
          if (!data || typeof data.url !== "string") throw new Error("Sign-in URL missing");
          window.location.href = data.url;
        }).catch(function () {
          form.submit();
        });
      });
    })();
  </script>
</body>
</html>`;
}
