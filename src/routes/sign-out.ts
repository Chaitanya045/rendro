import { nonceAttribute } from "@/middleware/html-nonce";
import { renderCommentRecoveryLifecycle } from "@/commentor/recovery-session";

/** Fixed copy only: upstream diagnostics and request data never enter this page. */
export function renderSignOutPage(state: "confirm" | "failed" | "complete"): string {
  const complete = state === "complete";
  const title = complete ? "You're signed out" : state === "failed" ? "Sign-out wasn't completed" : "Sign out of Rendro?";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Rendro</title>
<style${nonceAttribute()}>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui;background:#fafafa;color:#18181b}main{padding:32px;max-width:480px}button,a{font:inherit}button{padding:10px 18px;cursor:pointer}a{color:#9a3412}</style></head><body><main>
<h1>${title}</h1>${complete ? '<p>You can sign in again when you’re ready.</p><a href="/sign-in">Sign in</a>' : `<p>${state === "failed" ? "We couldn't confirm that your session ended. Please try again." : "This will end your session in all open Rendro tabs."}</p><form method="post" action="/api/auth/sign-out"><button type="submit">${state === "failed" ? "Try again" : "Sign out"}</button></form>`}
</main>${renderCommentRecoveryLifecycle(null, nonceAttribute(), complete)}</body></html>`;
}
