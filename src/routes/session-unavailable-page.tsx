import { FaviconLinks, ThemeAssets } from "./head";
import { parentRetryScript, unavailableStyles, unavailableThemeListener } from "./session-unavailable";
import { InlineScript, InlineStyle, renderHtml } from "./trusted-html";

interface SessionUnavailableProps {
  status: 500 | 503;
  subject: "session" | "document";
  parentRetry: boolean;
}

export function SessionUnavailablePage({ status, subject, parentRetry }: SessionUnavailableProps) {
  const heading = subject === "document" ? "We couldn't load this document"
    : status === 500 ? "We couldn't load this page" : "We couldn't check your session";
  const detail = subject === "document" ? "Please wait a moment and try again. The document hasn't been removed."
    : status === 500 ? "Please wait a moment and try loading this page again."
    : "Please wait a moment and try again. You don't need to sign in again because of this error.";
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Temporarily unavailable — Rendro</title>
        <FaviconLinks />
        <ThemeAssets />
        <InlineScript code={unavailableThemeListener} />
        <InlineStyle code={unavailableStyles} />
      </head>
      <body>
        <main aria-labelledby="session-error-title">
          <div class="brand">Rendro<span>.</span></div>
          <p class="eyebrow">{status} · Temporarily unavailable</p>
          <h1 id="session-error-title">{heading}</h1>
          <p>{detail}</p>
          <a class="retry" href="">Try again</a>
        </main>
        {parentRetry && <InlineScript code={parentRetryScript} />}
      </body>
    </html>
  );
}

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
  return renderHtml(<SessionUnavailablePage status={status} subject={subject} parentRetry={parentRetry} />, "<!DOCTYPE html>\n");
}
