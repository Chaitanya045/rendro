import { FaviconLinks, FontHead, ThemeAssets } from "./head";
import { frameThemeListener, goBackScript, notFoundStyles, type NotFoundPageOptions } from "./not-found";
import { InlineScript, InlineStyle, renderHtml } from "./trusted-html";

export function NotFoundPage(options: NotFoundPageOptions) {
  const status = options.status ?? 404;
  const path = options.path || "/";
  const homeHref = options.homeHref || "/";
  const homeLabel = options.homeLabel || "Go to Rendro";
  const heading = options.heading || "Page not found";
  const message = options.message || "The URL points to a document or route that Rendro cannot find. It may have moved, been deleted, or never existed.";
  return (
    <html lang="en">
      <head>
        <FaviconLinks />
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{status} · {heading} — Rendro</title>
        <FontHead />
        <ThemeAssets />
        <InlineScript code={frameThemeListener} />
        <InlineStyle code={notFoundStyles} />
      </head>
      <body>
        <main class="page" aria-labelledby="not-found-title">
          <a class="brand" href="/" target="_top">Rendro<i>.</i></a>
          <section class="panel">
            <div class="eyebrow">Error {status}</div>
            <h1 id="not-found-title">{heading}</h1>
            <p>{message}</p>
            <p class="path-label" id="requested-path-label">Requested path</p>
            <code class="path" aria-labelledby="requested-path-label">{path}</code>
            <div class="actions">
              <a class="btn primary" href={homeHref} target="_top">{homeLabel}</a>
              <button class="btn secondary" id="go-back" type="button" data-home-href={homeHref}>Go back</button>
            </div>
            <p class="hint">Check the URL for typos, or go back to the previous page.</p>
          </section>
        </main>
      </body>
      <InlineScript code={goBackScript} />
    </html>
  );
}

export function renderNotFoundPage(options: NotFoundPageOptions = {}): string {
  return renderHtml(<NotFoundPage {...options} />, "<!DOCTYPE html>\n");
}
