/**
 * Speculation Rules for the repository read path (#245). Chromium prefetches the
 * document frames the sidebar links to before the reader clicks, cutting the
 * in-shell switch to the document the reader already saw. Other engines ignore
 * the header and the JSON.
 *
 * The rules are served as same-origin JSON — referenced by a `Speculation-Rules`
 * response header on the shell — rather than an inline `<script type="speculationrules">`,
 * so the strict nonce CSP never has to allow an inline rules script
 * (`'strict-dynamic'` would not authorize it). See docs/TECHNICAL.md,
 * "In-shell navigation and prefetch".
 */
export const REPO_SPECULATION_RULES_PATH = "/speculation-rules/repo.json";

/**
 * Prefetch commit-pinned document frames a sidebar link points at, with
 * `moderate` eagerness (on hover/pointerdown). Ticket URLs are never prefetched:
 * they embed a per-reader capability and are not the plain frame documents.
 */
export function repoSpeculationRules(): string {
  return JSON.stringify({
    prefetch: [
      {
        source: "document",
        where: {
          and: [
            { href_matches: "/r/*/@*/files/*" },
            { not: { href_matches: "/r/*/@*/view/*" } },
          ],
        },
        eagerness: "moderate",
      },
    ],
  });
}
