import { nonceAttribute } from "@/middleware/html-nonce";
import { renderFaviconLinks } from "./favicon";
import { renderFontHead } from "./fonts";
import { renderThemeAssets, renderThemeButton } from "./theme";

export function renderLandingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>${renderFaviconLinks()}
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Rendro finds the docs in your GitHub repository and renders its Markdown and HTML as a navigable workspace with inline comments, for everyone who can read the repository.">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Rendro — Docs straight from your GitHub repository">
  <meta property="og:description" content="Pick a repository: Rendro detects its docs, renders them from the repository and lets everyone with read access comment in place.">
  <meta property="og:url" content="https://rendro.app/">
  <meta property="og:image" content="https://rendro.app/landing-product.webp">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="https://rendro.app/">
  ${renderFontHead({ icons: true })}
  <title>Rendro — Docs straight from your GitHub repository</title>
  ${renderThemeAssets()}
  <style${nonceAttribute()}>
    :root {
      color-scheme: light;
      --surface: #ffffff;
      --surface-elevated: #f4f4f5;
      --surface-hover: #e4e4e7;
      --surface-glass: rgba(255,255,255,.86);
      --text: #09090b;
      --text-muted: #52525b;
      --border: #e4e4e7;
      --primary: #c2410c;
      --primary-hover: #9a3412;
      --primary-muted: #ffedd5;
      --primary-shadow: rgba(194,65,12,.16);
      --danger: #b42318;
      --shadow-strong: rgba(0,0,0,.12);
      --shadow-soft: rgba(0,0,0,.08);
      --page-width: 1200px;
      --ease-standard: cubic-bezier(.4,0,.2,1);
    }
    html.dark {
      color-scheme: dark;
      --surface: #09090b;
      --surface-elevated: #18181b;
      --surface-hover: #27272a;
      --surface-glass: rgba(9,9,11,.86);
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --border: #27272a;
      --primary: #fb923c;
      --primary-hover: #fdba74;
      --primary-muted: rgba(251,146,60,.16);
      --primary-shadow: rgba(251,146,60,.2);
      --danger: #fca5a5;
      --shadow-strong: rgba(0,0,0,.42);
      --shadow-soft: rgba(0,0,0,.26);
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
    .site-header { position: sticky; top: 0; z-index: 30; min-height: 68px; border-bottom: 1px solid var(--border); background: var(--surface-glass); backdrop-filter: blur(18px); }
    .header-inner { min-height: 68px; display: flex; align-items: center; gap: 32px; }
    .brand, .footer-brand { color: var(--text); font-size: 24px; line-height: 32px; font-weight: 700; letter-spacing: -.04em; }
    .brand i, .footer-brand i { color: var(--primary); font-style: normal; }
    .nav-links { display: flex; align-items: center; gap: 28px; margin-left: auto; color: var(--text-muted); font-size: 14px; }
    .nav-links a, .footer-links a { transition: color 150ms var(--ease-standard); }
    .nav-links a { position: relative; padding-block: 6px; }
    .nav-links a::after { content: ""; position: absolute; right: 0; bottom: 0; left: 0; height: 1px; background: var(--primary); transform: scaleX(0); transform-origin: left; transition: transform 150ms var(--ease-standard); }
    .nav-links a:hover, .nav-links a:focus-visible, .nav-links a[aria-current="true"], .footer-links a:hover { color: var(--text); }
    .nav-links a:hover::after, .nav-links a:focus-visible::after, .nav-links a[aria-current="true"]::after { transform: scaleX(1); }
    .header-actions { display: flex; align-items: center; gap: 10px; }
    .button { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 18px; border: 1px solid transparent; border-radius: 7px; font-size: 14px; line-height: 20px; font-weight: 600; cursor: pointer; transition: transform 150ms var(--ease-standard), background-color 150ms var(--ease-standard), border-color 150ms var(--ease-standard), color 150ms var(--ease-standard), box-shadow 150ms var(--ease-standard); }
    .button:hover:not(:disabled):not([aria-disabled="true"]) { transform: translateY(-1px); }
    .button:active:not(:disabled):not([aria-disabled="true"]) { transform: scale(.98); }
    .button-primary { background: var(--primary); color: var(--surface); box-shadow: 0 10px 30px var(--primary-shadow); }
    .button-primary:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--primary-hover); }
    .button-secondary { border-color: var(--border); background: var(--surface-elevated); color: var(--text); }
    .button-secondary:hover:not(:disabled):not([aria-disabled="true"]) { border-color: var(--text-muted); background: var(--surface-hover); }
    .button-quiet { border-color: transparent; background: transparent; color: var(--text-muted); box-shadow: none; }
    .button-quiet:hover:not(:disabled):not([aria-disabled="true"]) { color: var(--text); background: var(--surface-elevated); }
    .button[disabled], .button[aria-disabled="true"] { cursor: wait; opacity: .72; transform: none; }
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
    .button:hover:not(:disabled):not([aria-disabled="true"]) .arrow { transform: translateX(2px); }
    .hero-facts { display: flex; flex-wrap: wrap; gap: 10px 22px; margin: 0; padding: 0; color: var(--text-muted); font-size: 13px; list-style: none; }
    .hero-facts li { position: relative; padding-left: 14px; }
    .hero-facts li::before { content: ""; position: absolute; left: 0; top: .75em; width: 4px; height: 4px; border-radius: 50%; background: var(--primary); }
    .product-shot { position: relative; margin: 0; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface-elevated); box-shadow: 0 28px 80px var(--shadow-strong); animation: shotReveal 300ms 80ms var(--ease-standard) both; transition: transform 300ms var(--ease-standard), border-color 200ms var(--ease-standard); }
    .product-shot:hover { transform: translateY(-3px); border-color: var(--text-muted); }
    .shot-bar { height: 38px; display: flex; align-items: center; gap: 7px; padding: 0 13px; border-bottom: 1px solid var(--border); background: var(--surface-elevated); }
    .shot-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); opacity: .42; }
    .shot-title { min-width: 0; margin-left: 7px; overflow: hidden; color: var(--text-muted); font-size: 11px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
    .product-shot img { width: 100%; height: auto; aspect-ratio: 1280/577; object-fit: cover; }
    .shot-caption { position: absolute; right: 12px; bottom: 12px; padding: 6px 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-glass); color: var(--text-muted); font-size: 10px; line-height: 14px; }
    .proof-band { border-block: 1px solid var(--border); background: var(--surface-elevated); }
    .proof-grid { display: grid; grid-template-columns: repeat(3,1fr); }
    .proof { min-height: 156px; padding: 32px; border-right: 1px solid var(--border); transition: background-color 200ms var(--ease-standard); }
    .proof:last-child { border-right: 0; }
    .proof:hover { background: var(--surface-hover); }
    .proof-value { margin: 0 0 4px; color: var(--primary); font-size: 34px; line-height: 42px; font-weight: 700; letter-spacing: -.04em; transition: transform 150ms var(--ease-standard); }
    .proof-label { margin: 0; color: var(--text-muted); font-size: 14px; }
    .proof:hover .proof-value { transform: translateY(-2px); }
    .section { padding: 112px 0; border-bottom: 1px solid var(--border); }
    .section-header { max-width: 720px; margin-bottom: 52px; }
    .section-kicker { margin-bottom: 14px; color: var(--primary); font-size: 12px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
    h2 { margin-bottom: 18px; font-size: clamp(34px,4vw,52px); line-height: 1.08; letter-spacing: -.045em; }
    .section-intro { max-width: 650px; margin-bottom: 0; color: var(--text-muted); font-size: 17px; line-height: 27px; }
    .workflow-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .workflow-steps { display: grid; gap: 12px; }
    .workflow-step { display: grid; grid-template-columns: 52px 1fr; gap: 18px; padding: 22px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-elevated); transition: border-color 200ms var(--ease-standard), transform 200ms var(--ease-standard); }
    .workflow-step:hover { border-color: var(--text-muted); transform: translateX(3px); }
    .step-number { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 6px; background: var(--primary-muted); color: var(--primary); font-size: 13px; font-weight: 700; transition: transform 150ms var(--ease-standard), background-color 150ms var(--ease-standard); }
    .workflow-step:hover .step-number { transform: translateY(-1px) scale(1.03); background: var(--primary); color: var(--surface); }
    .workflow-step h3 { margin: 0 0 5px; font-size: 16px; line-height: 24px; }
    .workflow-step p { margin: 0; color: var(--text-muted); font-size: 14px; line-height: 22px; }
    .signals { align-self: stretch; min-height: 100%; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-elevated); box-shadow: 0 20px 48px var(--shadow-soft); }
    .signals-bar { min-height: 44px; display: flex; align-items: center; gap: 7px; padding: 0 16px; border-bottom: 1px solid var(--border); color: var(--text-muted); font: 500 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .signals-title { margin: 0; font: inherit; }
    .signals-body { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 18px; padding: 26px 30px; }
    .signal-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
    .signal { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 13px; line-height: 20px; }
    .signal:last-child { border-bottom: 0; }
    .signal code { color: var(--primary); font: 500 13px/20px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .signal span { color: var(--text-muted); }
    .signals-note { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 21px; }
    .features { display: grid; grid-template-columns: repeat(2,1fr); gap: 16px; }
    .feature { min-height: 230px; padding: 30px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-elevated); transition: transform 200ms var(--ease-standard), border-color 200ms var(--ease-standard), background-color 200ms var(--ease-standard); }
    .feature:hover { transform: translateY(-3px); border-color: var(--text-muted); background: var(--surface-hover); }
    .feature-number { display: block; width: max-content; margin-bottom: 38px; color: var(--primary); font: 700 12px/16px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .feature-number::after { content: ""; display: block; width: 24px; height: 1px; margin-top: 8px; background: var(--primary); transform: scaleX(0); transform-origin: left; transition: transform 150ms var(--ease-standard); }
    .feature:hover .feature-number::after { transform: scaleX(1); }
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
    .footer-brand { font-size: 16px; line-height: 24px; }
    .footer-links { display: flex; flex-wrap: wrap; gap: 20px; margin-left: auto; }
    @media (prefers-reduced-motion: no-preference) {
      [data-reveal], [data-reveal-item] { transition: opacity 300ms var(--ease-standard), transform 300ms var(--ease-standard), background-color 200ms var(--ease-standard), border-color 200ms var(--ease-standard); transition-delay: var(--reveal-delay,0ms), var(--reveal-delay,0ms), 0ms, 0ms; }
      .motion-ready [data-reveal]:not(.is-visible), .motion-ready [data-reveal-item]:not(.is-visible) { opacity: 0; transform: translateY(var(--reveal-y,16px)); }
    }
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
      .nav-links { display: none; }
      .header-inner { gap: 12px; }
      .brand { font-size: 20px; line-height: 28px; }
      .header-actions { margin-left: auto; gap: 6px; }
      .header-signin { padding-inline: 10px; }
      .header-signin, .header-get-started { white-space: nowrap; }
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
      .signals-body { padding: 22px; }
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
      .header-signin { padding-inline: 8px; }
      .hero-facts { align-items: flex-start; flex-direction: column; gap: 8px; }
      .product-shot { border-radius: 8px; }
      .shot-title { display: none; }
      .workflow-step { grid-template-columns: 42px 1fr; padding: 18px; gap: 13px; }
      .step-number { width: 36px; height: 36px; }
    }
    @media (max-width: 360px) {
      .header-inner { gap: 8px; }
      .brand { font-size: 18px; }
      .header-actions { gap: 4px; }
      .header-signin { padding-inline: 6px; }
      .header-get-started { padding-inline: 10px; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
      .button:hover, .button:active, .product-shot:hover, .workflow-step:hover, .workflow-step:hover .step-number, .feature:hover, .proof:hover .proof-value { transform: none; }
      .button:hover:not(:disabled):not([aria-disabled="true"]), .button:active:not(:disabled):not([aria-disabled="true"]) { transform: none !important; }
    }
    @media print {
      [data-reveal], [data-reveal-item] { opacity: 1 !important; transform: none !important; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="Rendro home">Rendro<i aria-hidden="true">.</i></a>
      <nav class="nav-links" aria-label="Primary navigation">
        <a href="#product" data-section-link data-scroll-section="product">Product</a>
        <a href="#workflow" data-section-link data-scroll-section="workflow">Workflow</a>
        <a href="#security" data-section-link data-scroll-section="security">Security</a>
      </nav>
      <div class="header-actions">
        ${renderThemeButton()}
        <a class="button button-quiet header-signin" href="/sign-in">Sign in</a>
        <a class="button button-primary header-get-started" href="/sign-up">Get started</a>
      </div>
    </div>
  </header>
  <main id="main-content">
    <section class="hero" aria-labelledby="hero-title">
      <div class="container hero-grid">
        <div class="hero-copy">
          <p class="eyebrow">Docs for GitHub repositories</p>
          <h1 id="hero-title">Docs straight from your GitHub repository.</h1>
          <p class="hero-lede">Pick a repository and Rendro finds its docs, renders its Markdown and HTML from the repository, and serves them as a navigable workspace with inline comments, for everyone who can read the repository.</p>
          <div class="hero-actions">
            <a class="button button-primary" href="/sign-up" data-action-id="hero-start">Get started</a>
            <a class="button button-secondary" href="#product" data-scroll-section="product" data-action-id="explore-product">Explore the workspace <span class="arrow" aria-hidden="true">→</span></a>
          </div>
          <ul class="hero-facts" aria-label="Product principles">
            <li>Markdown and HTML</li>
            <li>Nothing to upload</li>
            <li>Access follows GitHub</li>
          </ul>
        </div>
        <figure class="product-shot">
          <div class="shot-bar" aria-hidden="true">
            <span class="shot-dot"></span><span class="shot-dot"></span><span class="shot-dot"></span>
            <span class="shot-title">e2e-org / visual-docs / docs / guide / deep / nested / topic.md</span>
          </div>
          <img src="/landing-product.webp" width="1280" height="577" alt="Rendro repository workspace with a searchable document tree beside a rendered Markdown page with highlighted code and a table" fetchpriority="high">
          <figcaption class="shot-caption">Actual Rendro workspace</figcaption>
        </figure>
      </div>
    </section>

    <section class="proof-band" aria-label="Product proof">
      <div class="container proof-grid" data-reveal-group data-reveal-stagger="45">
        <article class="proof" data-reveal-item style="--reveal-y:12px"><p class="proof-value">No uploads</p><p class="proof-label">Docs are read from the repository, so there is no publishing step to maintain</p></article>
        <article class="proof" data-reveal-item style="--reveal-y:12px"><p class="proof-value">Same as GitHub</p><p class="proof-label">Exactly the people who can read a repository can read its docs and comments</p></article>
        <article class="proof" data-reveal-item style="--reveal-y:12px"><p class="proof-value">AES-256-GCM</p><p class="proof-label">Private repository content is sealed with a key per repository</p></article>
      </div>
    </section>

    <section class="section" id="workflow" aria-labelledby="workflow-title">
      <div class="container">
        <header class="section-header" data-reveal>
          <p class="section-kicker">Workflow</p>
          <h2 id="workflow-title">From repository to readable docs.</h2>
          <p class="section-intro">Rendro reads the repository your team already writes, reviews and merges in, so the docs are the ones on the branch.</p>
        </header>
        <div class="workflow-grid">
          <div class="workflow-steps" data-reveal-group data-reveal-stagger="55">
            <article class="workflow-step" data-reveal-item style="--reveal-y:12px"><span class="step-number">01</span><div><h3>Sign in with GitHub</h3><p>Choose which repositories the Rendro GitHub App may read. GitHub sign-in is coming soon; until then, create an account with your email.</p></div></article>
            <article class="workflow-step" data-reveal-item style="--reveal-y:12px"><span class="step-number">02</span><div><h3>Pick a repository</h3><p>Rendro detects where its docs live and renders the Markdown and HTML pages from the repository.</p></div></article>
            <article class="workflow-step" data-reveal-item style="--reveal-y:12px"><span class="step-number">03</span><div><h3>Read and comment</h3><p>Your team reads with a file tree and search, and comments on any page. Push to the branch and Rendro renders the new commit.</p></div></article>
          </div>
          <div class="signals" data-reveal data-reveal-delay="80">
            <div class="signals-bar"><span class="shot-dot" aria-hidden="true"></span><span class="shot-dot" aria-hidden="true"></span><span class="shot-dot" aria-hidden="true"></span><h3 class="signals-title">Where Rendro looks for docs</h3></div>
            <div class="signals-body">
              <ul class="signal-list">
                <li class="signal"><code>mkdocs.yml</code><span>its docs_dir</span></li>
                <li class="signal"><code>docusaurus.config.*</code><span>the docs folder beside it</span></li>
                <li class="signal"><code>.vitepress/config.*</code><span>its source directory</span></li>
                <li class="signal"><code>book.toml</code><span>the mdBook source</span></li>
                <li class="signal"><code>docs/</code><span>a Markdown folder</span></li>
                <li class="signal"><code>index.html</code><span>prebuilt HTML pages</span></li>
                <li class="signal"><code>README.md</code><span>the fallback</span></li>
              </ul>
              <p class="signals-note">GitBook, Mintlify and Docsify layouts are detected too. The strongest signal wins.</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="product" aria-labelledby="product-title">
      <div class="container">
        <header class="section-header" data-reveal>
          <p class="section-kicker">Product</p>
          <h2 id="product-title">A docs workspace for every repository.</h2>
          <p class="section-intro">Rendro owns the workspace around the page: navigation, search and comments. Each page is rendered from the repository and shown in its own sandboxed frame.</p>
        </header>
        <div class="features" data-reveal-group data-reveal-stagger="60">
          <article class="feature" data-reveal-item style="--reveal-y:12px"><span class="feature-number">01 / NAVIGATE</span><h3>File-tree navigation and search</h3><p>Folders load on demand, search finds any section of the docs, and links between pages keep the tree on the page you are reading.</p></article>
          <article class="feature" data-reveal-item style="--reveal-y:12px"><span class="feature-number">02 / RENDER</span><h3>Markdown and HTML from the repository</h3><p>GitHub-flavoured Markdown with tables, task lists, footnotes, alerts and highlighted code, and HTML pages, sanitized and set in one GitHub-style reading theme.</p></article>
          <article class="feature" data-reveal-item style="--reveal-y:12px"><span class="feature-number">03 / REVIEW</span><h3>Comments on any page</h3><p>Select text to open a thread. Replies arrive live, authors can edit their own comments, and a thread stays on its text when a new commit changes the page around it.</p></article>
          <article class="feature" data-reveal-item style="--reveal-y:12px"><span class="feature-number">04 / DELIVER</span><h3>Served from the edge</h3><p>Pages are rendered once, when a commit is ingested, and served from Cloudflare's edge. Navigation stays inside the shell, and a likely next page is prefetched before you open it.</p></article>
        </div>
      </div>
    </section>

    <section class="section" id="security" aria-labelledby="security-title">
      <div class="container security-grid">
        <div class="security-copy" data-reveal>
          <p class="section-kicker">Security</p>
          <h2 id="security-title">Private stays private. Access follows GitHub.</h2>
          <p class="section-intro">Rendro keeps no permission model of its own. The people who can read a repository on GitHub can read its docs and comments, and nobody else.</p>
          <a class="button button-secondary" href="/sign-up" data-action-id="security-start">Get started</a>
        </div>
        <dl class="security-list" data-reveal-group data-reveal-stagger="45">
          <div class="security-row" data-reveal-item style="--reveal-y:12px"><dt>Access</dt><dd>Every view is checked against the repository's GitHub permissions, which Rendro mirrors. When GitHub removes someone's access, their access to the docs and comments ends too.</dd></div>
          <div class="security-row" data-reveal-item style="--reveal-y:12px"><dt>Public repositories</dt><dd>Anyone can read the docs of a public repository. Commenting needs a signed-in account.</dd></div>
          <div class="security-row" data-reveal-item style="--reveal-y:12px"><dt>Private content</dt><dd>Sealed per repository with AES-256-GCM in storage and in the edge cache, and opened only after the reader is authorized.</dd></div>
          <div class="security-row" data-reveal-item style="--reveal-y:12px"><dt>Rendering</dt><dd>Repository HTML is sanitized against an allowlist, with no scripts, styles or event handlers, and shown in a sandboxed frame.</dd></div>
        </dl>
      </div>
    </section>

    <section class="final-cta" aria-labelledby="cta-title">
      <div class="container">
        <div class="cta-panel" data-reveal style="--reveal-y:12px">
          <div><h2 id="cta-title">Your docs are already in the repository.</h2><p>Let Rendro render them, keep them current with every push, and bring the discussion onto the page.</p></div>
          <a class="button button-primary" href="/sign-up" data-action-id="final-start">Get started</a>
        </div>
      </div>
    </section>
  </main>
  <footer class="site-footer">
    <div class="container footer-inner">
      <a class="footer-brand" href="/">Rendro<i aria-hidden="true">.</i></a>
      <span>Docs straight from the repository.</span>
      <nav class="footer-links" aria-label="Footer navigation">
        <a href="#product" data-scroll-section="product">Product</a><a href="#workflow" data-scroll-section="workflow">Workflow</a><a href="#security" data-scroll-section="security">Security</a><a href="https://github.com/Chaitanya045/rendro" target="_blank" rel="noreferrer">GitHub</a>
      </nav>
    </div>
  </footer>
  <script${nonceAttribute()}>
    (function () {
      window.RendroTheme.mount(document.getElementById("theme-toggle"));
      var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      var canObserve = "IntersectionObserver" in window;
      var revealTargets = Array.from(document.querySelectorAll("[data-reveal], [data-reveal-item]"));

      function revealElement(element) {
        if (element.classList.contains("is-visible")) return;
        element.classList.add("is-visible");
        var clearDelay = function (event) {
          if (event.target !== element) return;
          element.style.removeProperty("--reveal-delay");
          element.removeEventListener("transitionend", clearDelay);
        };
        element.addEventListener("transitionend", clearDelay);
      }

      if (!reduceMotion && canObserve && revealTargets.length > 0) {
        Array.from(document.querySelectorAll("[data-reveal-group]")).forEach(function (group) {
          var stagger = Number.parseInt(group.getAttribute("data-reveal-stagger") || "0", 10);
          Array.from(group.children).forEach(function (child, index) {
            if (child.hasAttribute("data-reveal-item"))
              child.style.setProperty("--reveal-delay", Math.min(index * stagger, 180) + "ms");
          });
        });
        revealTargets.forEach(function (element) {
          var delay = Number.parseInt(element.getAttribute("data-reveal-delay") || "0", 10);
          if (delay > 0) element.style.setProperty("--reveal-delay", Math.min(delay, 180) + "ms");
        });

        var revealObserver = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            revealElement(entry.target);
            revealObserver.unobserve(entry.target);
          });
        }, { threshold: .12, rootMargin: "0px 0px -10% 0px" });

        revealTargets.forEach(function (element) { revealObserver.observe(element); });
        document.documentElement.classList.add("motion-ready");

        document.addEventListener("focusin", function (event) {
          if (!(event.target instanceof Element)) return;
          var target = event.target.closest("[data-reveal], [data-reveal-item]");
          if (target) revealElement(target);
        });
      }
      var scrollLinks = Array.from(document.querySelectorAll("[data-scroll-section]"));
      var scrollSectionIds = scrollLinks.map(function (link) {
        return link.getAttribute("data-scroll-section");
      });
      var initialSectionHash = "";
      try { initialSectionHash = decodeURIComponent(window.location.hash.slice(1)); } catch {}
      var hasLegacySectionHash = scrollSectionIds.includes(initialSectionHash);
      var navigationEntry = performance.getEntriesByType("navigation")[0];
      var isReload = navigationEntry && navigationEntry.type === "reload";
      if (hasLegacySectionHash)
        history.replaceState(null, "", window.location.pathname + window.location.search);
      if (hasLegacySectionHash || isReload) {
        var resetSectionPosition = function () {
          window.scrollTo({ top: 0, behavior: "auto" });
        };
        resetSectionPosition();
        window.addEventListener("pageshow", resetSectionPosition, { once: true });
      }
      scrollLinks.forEach(function (link) {
        link.addEventListener("click", function (event) {
          var id = link.getAttribute("data-scroll-section");
          var section = id && document.getElementById(id);
          if (!section) return;
          event.preventDefault();
          var sectionTop = window.scrollY + section.getBoundingClientRect().top;
          window.scrollTo({ top: sectionTop, behavior: reduceMotion ? "auto" : "smooth" });
        });
      });


      if (canObserve) {
        var sectionLinks = Array.from(document.querySelectorAll("[data-section-link]"));
        var sectionMap = new Map(sectionLinks.map(function (link) {
          return [link.getAttribute("data-scroll-section"), link];
        }));
        var setActiveSection = function (id) {
          sectionLinks.forEach(function (link) {
            if (link === sectionMap.get(id)) link.setAttribute("aria-current", "true");
            else link.removeAttribute("aria-current");
          });
        };
        var sectionObserver = new IntersectionObserver(function (entries) {
          var visible = entries.filter(function (entry) { return entry.isIntersecting; });
          if (visible.length === 0) return;
          visible.sort(function (a, b) {
            return Math.abs(a.boundingClientRect.top - 68) - Math.abs(b.boundingClientRect.top - 68);
          });
          setActiveSection(visible[0].target.id);
        }, { threshold: 0, rootMargin: "-25% 0px -65% 0px" });
        sectionMap.forEach(function (_, id) {
          var section = document.getElementById(id);
          if (section) sectionObserver.observe(section);
        });
      }
    })();
  </script>
</body>
</html>`;
}
