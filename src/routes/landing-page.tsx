import { FaviconLinks, FontHead, ThemeAssets, ThemeButton } from "./head";
import { landingScript, landingStyles } from "./landing";
import { InlineScript, InlineStyle, renderHtml } from "./trusted-html";

export function LandingPage() {
  return (
    <html lang="en">
      <head>
        <FaviconLinks />
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="Rendro finds the docs in your GitHub repository and renders its Markdown and HTML as a navigable workspace with inline comments, for everyone who can read the repository." />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Rendro — Docs straight from your GitHub repository" />
        <meta property="og:description" content="Pick a repository: Rendro detects its docs, renders them from the repository and lets everyone with read access comment in place." />
        <meta property="og:url" content="https://rendro.app/" />
        <meta property="og:image" content="https://rendro.app/landing-product.webp" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="canonical" href="https://rendro.app/" />
        <FontHead icons />
        <title>Rendro — Docs straight from your GitHub repository</title>
        <ThemeAssets />
        <InlineStyle code={landingStyles} />
      </head>
      <body>
        <a class="skip-link" href="#main-content">Skip to content</a>
        <header class="site-header">
          <div class="container header-inner">
            <a class="brand" href="/" aria-label="Rendro home">Rendro<i aria-hidden="true">.</i></a>
            <nav class="nav-links" aria-label="Primary navigation">
              <a href="#product" data-section-link="" data-scroll-section="product">Product</a>
              <a href="#workflow" data-section-link="" data-scroll-section="workflow">Workflow</a>
              <a href="#security" data-section-link="" data-scroll-section="security">Security</a>
            </nav>
            <div class="header-actions">
              <ThemeButton />
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
                <img src="/landing-product.webp" width="1280" height="577" alt="Rendro repository workspace with a searchable document tree beside a rendered Markdown page with highlighted code and a table" fetchpriority="high" />
                <figcaption class="shot-caption">Actual Rendro workspace</figcaption>
              </figure>
            </div>
          </section>

          <section class="proof-band" aria-label="Product proof">
            <div class="container proof-grid" data-reveal-group="" data-reveal-stagger="45">
              <article class="proof" data-reveal-item="" style="--reveal-y:12px"><p class="proof-value">No uploads</p><p class="proof-label">Docs are read from the repository, so there is no publishing step to maintain</p></article>
              <article class="proof" data-reveal-item="" style="--reveal-y:12px"><p class="proof-value">Same as GitHub</p><p class="proof-label">Exactly the people who can read a repository can read its docs and comments</p></article>
              <article class="proof" data-reveal-item="" style="--reveal-y:12px"><p class="proof-value">AES-256-GCM</p><p class="proof-label">Private repository content is sealed with a key per repository</p></article>
            </div>
          </section>

          <section class="section" id="workflow" aria-labelledby="workflow-title">
            <div class="container">
              <header class="section-header" data-reveal="">
                <p class="section-kicker">Workflow</p>
                <h2 id="workflow-title">From repository to readable docs.</h2>
                <p class="section-intro">Rendro reads the repository your team already writes, reviews and merges in, so the docs are the ones on the branch.</p>
              </header>
              <div class="workflow-grid">
                <div class="workflow-steps" data-reveal-group="" data-reveal-stagger="55">
                  <article class="workflow-step" data-reveal-item="" style="--reveal-y:12px"><span class="step-number">01</span><div><h3>Sign in with GitHub</h3><p>Choose which repositories the Rendro GitHub App may read. GitHub sign-in is coming soon; until then, create an account with your email.</p></div></article>
                  <article class="workflow-step" data-reveal-item="" style="--reveal-y:12px"><span class="step-number">02</span><div><h3>Pick a repository</h3><p>Rendro detects where its docs live and renders the Markdown and HTML pages from the repository.</p></div></article>
                  <article class="workflow-step" data-reveal-item="" style="--reveal-y:12px"><span class="step-number">03</span><div><h3>Read and comment</h3><p>Your team reads with a file tree and search, and comments on any page. Push to the branch and Rendro renders the new commit.</p></div></article>
                </div>
                <div class="signals" data-reveal="" data-reveal-delay="80">
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
              <header class="section-header" data-reveal="">
                <p class="section-kicker">Product</p>
                <h2 id="product-title">A docs workspace for every repository.</h2>
                <p class="section-intro">Rendro owns the workspace around the page: navigation, search and comments. Each page is rendered from the repository and shown in its own sandboxed frame.</p>
              </header>
              <div class="features" data-reveal-group="" data-reveal-stagger="60">
                <article class="feature" data-reveal-item="" style="--reveal-y:12px"><span class="feature-number">01 / NAVIGATE</span><h3>File-tree navigation and search</h3><p>Folders load on demand, search finds any section of the docs, and links between pages keep the tree on the page you are reading.</p></article>
                <article class="feature" data-reveal-item="" style="--reveal-y:12px"><span class="feature-number">02 / RENDER</span><h3>Markdown and HTML from the repository</h3><p>GitHub-flavoured Markdown with tables, task lists, footnotes, alerts and highlighted code, and HTML pages, sanitized and set in one GitHub-style reading theme.</p></article>
                <article class="feature" data-reveal-item="" style="--reveal-y:12px"><span class="feature-number">03 / REVIEW</span><h3>Comments on any page</h3><p>Select text to open a thread. Replies arrive live, authors can edit their own comments, and a thread stays on its text when a new commit changes the page around it.</p></article>
                <article class="feature" data-reveal-item="" style="--reveal-y:12px"><span class="feature-number">04 / DELIVER</span><h3>Served from the edge</h3><p>Pages are rendered once, when a commit is ingested, and served from Cloudflare's edge. Navigation stays inside the shell, and a likely next page is prefetched before you open it.</p></article>
              </div>
            </div>
          </section>

          <section class="section" id="security" aria-labelledby="security-title">
            <div class="container security-grid">
              <div class="security-copy" data-reveal="">
                <p class="section-kicker">Security</p>
                <h2 id="security-title">Private stays private. Access follows GitHub.</h2>
                <p class="section-intro">Rendro keeps no permission model of its own. The people who can read a repository on GitHub can read its docs and comments, and nobody else.</p>
                <a class="button button-secondary" href="/sign-up" data-action-id="security-start">Get started</a>
              </div>
              <dl class="security-list" data-reveal-group="" data-reveal-stagger="45">
                <div class="security-row" data-reveal-item="" style="--reveal-y:12px"><dt>Access</dt><dd>Every view is checked against the repository's GitHub permissions, which Rendro mirrors. When GitHub removes someone's access, their access to the docs and comments ends too.</dd></div>
                <div class="security-row" data-reveal-item="" style="--reveal-y:12px"><dt>Public repositories</dt><dd>Anyone can read the docs of a public repository. Commenting needs a signed-in account.</dd></div>
                <div class="security-row" data-reveal-item="" style="--reveal-y:12px"><dt>Private content</dt><dd>Sealed per repository with AES-256-GCM in storage and in the edge cache, and opened only after the reader is authorized.</dd></div>
                <div class="security-row" data-reveal-item="" style="--reveal-y:12px"><dt>Rendering</dt><dd>Repository HTML is sanitized against an allowlist, with no scripts, styles or event handlers, and shown in a sandboxed frame.</dd></div>
              </dl>
            </div>
          </section>

          <section class="final-cta" aria-labelledby="cta-title">
            <div class="container">
              <div class="cta-panel" data-reveal="" style="--reveal-y:12px">
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
        <InlineScript code={landingScript} />
      </body>
    </html>
  );
}

export function renderLandingPage(): string {
  return renderHtml(<LandingPage />, "<!DOCTYPE html>\n");
}
