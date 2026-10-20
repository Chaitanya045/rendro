import { describe, expect, it } from "vitest";
import { renderSessionUnavailablePage } from "@/routes/session-unavailable";

/**
 * UI-006-E04: "could not check" is a retryable 503 page, never a 404. The repository read path's storage, GitHub and
 * session outages are in tests/repo-read-routes.test.ts ("faults are retryable 503s, never 404s").
 */
describe("recovery page", () => {
  it.each([
    [503, "session", "We couldn't check your session"],
    [500, "session", "We couldn't load this page"],
    [503, "document", "We couldn't load this document"],
  ] as const)("renders %s for the %s subject", (status, subject, heading) => {
    const page = renderSessionUnavailablePage(status, subject);
    expect(page).toContain(`<h1 id="session-error-title">${heading}</h1>`);
    expect(page).toContain(`${status} · Temporarily unavailable`);
    expect(page).toContain('<a class="retry" href="">Try again</a>');
  });

  it("asks the shell to reload the frame only when told its cookie is needed", () => {
    expect(renderSessionUnavailablePage(503, "document", true)).toContain('window.parent.postMessage({type:"doc-retry"},"*")');
    expect(renderSessionUnavailablePage(503, "document")).not.toContain("doc-retry");
  });

  it("is frame-aware: inside a viewer frame the wordmark hides and the parent supplies the theme", () => {
    const page = renderSessionUnavailablePage();
    expect(page).toContain("html.framed .brand{display:none}");
    expect(page).toContain('classList.add("framed")');
    expect(page).toContain('type:"commentor-theme-ready"');
    expect(page).toContain('data.type==="rendro-theme"');
  });
});
