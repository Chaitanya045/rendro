import { CommentRecovery } from "./head";
import { signOutStyles } from "./sign-out";
import { InlineStyle, renderHtml } from "./trusted-html";

/** Fixed copy only: upstream diagnostics and request data never enter this page. */
export function SignOutPage({ state }: { state: "confirm" | "failed" | "complete" }) {
  const complete = state === "complete";
  const title = complete ? "You're signed out" : state === "failed" ? "Sign-out wasn't completed" : "Sign out of Rendro?";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title} — Rendro</title>
        <InlineStyle code={signOutStyles} />
      </head>
      <body>
        <main>
          <h1>{title}</h1>
          {complete ? (
            <>
              <p>You can sign in again when you’re ready.</p>
              <a href="/sign-in">Sign in</a>
            </>
          ) : (
            <>
              <p>{state === "failed" ? "We couldn't confirm that your session ended. Please try again." : "This will end your session in all open Rendro tabs."}</p>
              <form method="post" action="/api/auth/sign-out"><button type="submit">{state === "failed" ? "Try again" : "Sign out"}</button></form>
            </>
          )}
        </main>
        <CommentRecovery userId={null} completedSignOut={complete} />
      </body>
    </html>
  );
}

export function renderSignOutPage(state: "confirm" | "failed" | "complete"): string {
  return renderHtml(<SignOutPage state={state} />, "<!doctype html>");
}
