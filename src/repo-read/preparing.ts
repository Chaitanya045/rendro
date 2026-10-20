/**
 * What a reader sees while the docs for a repository are still being built
 * (#242): a "Preparing…" page that polls this URL with backoff, and the retry
 * page an outcome of "failed" leaves behind. The server stays stateless: the
 * poll pattern only consults its own responses, so any reader of the URL can
 * re-check what any other is already preparing.
 */
import { renderPreparingPage } from "./preparing-page";

/** Header that labels the response state for the poll script (readable same-origin). */
export const READINESS_HEADER = "X-Rendro-Readiness";

export type PreparingState = "preparing" | "failed";

export interface ReadinessAccessibility {
  busy: boolean;
  message: string;
  assertive: boolean;
}

/** What the reader page announces about the current state. */
export function readinessAccessibility(state: PreparingState): ReadinessAccessibility {
  if (state === "preparing") return { busy: true, message: "Preparing the docs for this repository…", assertive: false };
  return { busy: false, message: "We couldn't prepare the docs for this repository. Use Retry to try again.", assertive: true };
}

/**
 * Delay before the poll's next attempt (attempt 0 = the first one, served on
 * the page itself), in milliseconds: each wait grows the server's Retry-After,
 * capped so a stalled build never spins hot. Polling pauses while the page is
 * hidden, so a forgotten tab costs at most one check per interval.
 */
export function pollDelayMs(retryAfterSeconds: number, attempt: number): number {
  const base = Math.min(Math.max(Math.round(retryAfterSeconds), 1), 60);
  return Math.min(base * 2 ** Math.max(attempt, 0) * 1000, 60_000);
}

/** The preparing page's poll: it re-checks this URL with backoff while the page is visible. */
export function pollScript(retryAfterSeconds: number): string {
  return `
  var base=${Math.round(pollDelayMs(retryAfterSeconds, 0))},live=document.querySelector("[data-readiness] p");
  async function poll(){
    if(document.hidden){setTimeout(poll,base);return;}
    try{
      var res=await fetch(location.pathname+location.search,{cache:"no-store"});
      if(res.status===404){live.textContent="These docs are no longer available.";document.querySelector("main").setAttribute("aria-busy","false");return;}
      var state=res.headers.get("${READINESS_HEADER.toLowerCase()}");
      if(state==="failed"){location.replace(location.href);return;}
      if(state!=="preparing"){location.reload();return;}
    }catch(e){}
    base=Math.min(base*2,60000);
    setTimeout(poll,base);
  }
  poll();
`;
}

export const preparingStyles = `
  *{box-sizing:border-box}
  :root{color-scheme:light;--page:#fafafa;--surface:#fff;--text:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#c2410c;--accent-hover:#9a3412;--on-accent:#fff}
  html.dark{color-scheme:dark;--page:#09090b;--surface:#18181b;--text:#fafafa;--muted:#a1a1aa;--border:#27272a;--accent:#fb923c;--accent-hover:#fdba74;--on-accent:#09090b}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--page);color:var(--text);font-family:Inter,system-ui,sans-serif}
  main{width:min(560px,100%);padding:32px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
  .brand{font-size:24px;font-weight:700;letter-spacing:-.04em}.brand span{color:var(--accent)}
  main[aria-busy="true"] h1{animation:rendro-pulse 2.4s ease-in-out infinite}
  @keyframes rendro-pulse{50%{opacity:.55}}
  .eyebrow{margin:24px 0 8px;color:var(--accent);font-size:12px;font-weight:700}
  h1{margin:0;font-size:clamp(28px,5vw,36px);line-height:1.15;letter-spacing:-.03em}
  p{color:var(--muted);font-size:15px;line-height:1.6}
  .retry{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin-top:8px;padding:10px 18px;border-radius:6px;background:var(--accent);color:var(--on-accent);font-size:14px;font-weight:650;text-decoration:none}
  .retry:hover{background:var(--accent-hover)}.retry:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
`;

// The markup is PreparingPage (preparing-page.tsx).
export { renderPreparingPage };
