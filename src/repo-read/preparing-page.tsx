import { FaviconLinks, ThemeAssets } from "@/routes/head";
import { InlineScript, InlineStyle, renderHtml } from "@/routes/trusted-html";
import { pollScript, preparingStyles, readinessAccessibility, type PreparingState } from "./preparing";

export function PreparingPage({ state, retryAfterSeconds }: { state: PreparingState; retryAfterSeconds: number }) {
  const { busy, message, assertive } = readinessAccessibility(state);
  const preparing = state === "preparing";
  const heading = preparing ? "Preparing these docs…" : "We couldn't load these docs";
  const detail = preparing
    ? "Rendro is assembling the documentation from the repository. This page updates on its own; there is nothing to do."
    : "Rendro couldn't assemble the documentation from the repository. Use Retry to try again.";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{preparing ? "Preparing" : "Unavailable"} — Rendro</title>
        <FaviconLinks />
        <ThemeAssets />
        <InlineStyle code={preparingStyles} />
      </head>
      <body>
        <main data-readiness={state} aria-busy={busy ? "true" : "false"} aria-labelledby="readiness-title">
          <div class="brand">Rendro<span>.</span></div>
          <p class="eyebrow">{preparing ? "One moment" : "503 · Temporarily unavailable"}</p>
          <h1 id="readiness-title">{heading}</h1>
          <p role={assertive ? "alert" : "status"} aria-live={assertive ? undefined : "polite"}>{message}</p>
          <p>{detail}</p>
          {!preparing && <a class="retry" href="">Retry</a>}
        </main>
        {preparing && <InlineScript code={pollScript(retryAfterSeconds)} />}
      </body>
    </html>
  );
}

export function renderPreparingPage(state: PreparingState, retryAfterSeconds: number): string {
  return renderHtml(<PreparingPage state={state} retryAfterSeconds={retryAfterSeconds} />, "<!doctype html>");
}
