import { describe, expect, it } from "vitest";
import authPageRoutes from "@/routes/auth-pages";
import { renderLandingPage } from "@/routes/landing";
import { renderNotFoundPage } from "@/routes/not-found";

describe("auth and error route control consistency", () => {
  it("uses the shared theme control and keeps auth controls state-complete", async () => {
    const response = await authPageRoutes.request("/sign-in");
    const html = await response.text();

    expect(html).toContain('class="rendro-theme-control"');
    expect(html).not.toContain(".theme{");
    expect(html).not.toContain(".theme:hover");
    expect(html).toContain(".button:active:not(:disabled):not([aria-disabled=true])");
    expect(html).toContain(".button:disabled,.button[aria-disabled=true]");
    expect(html).toContain(".field input:hover:not(:disabled):not(:focus):not([aria-invalid=true])");
    expect(html).not.toContain(".field input:hover:not(:disabled){");
    expect(html).toContain(".field input:focus-visible");
    expect(html).toContain(".field input:disabled");
    expect(html).toContain(".reveal:hover:not(:disabled)");
    expect(html).toContain(".reveal:active:not(:disabled)");
    expect(html).toContain("@media(prefers-reduced-motion:reduce){.button,.field input,.method-action");
    expect(html).toContain(".reveal,.account-footer a,.switch a,.form-row>a{transition-duration:.01ms}");
    expect(html).toContain("html.dark{color-scheme:dark");
  });

  it("keeps the standalone 404 actions usable across states and mobile", () => {
    const html = renderNotFoundPage({ path: "/missing" });

    expect(html).toContain(".btn:hover:not(:disabled):not([aria-disabled=true])");
    expect(html).toContain(".btn:active:not(:disabled):not([aria-disabled=true])");
    expect(html).toContain(".btn:focus-visible");
    expect(html).toContain(".btn:disabled,.btn[aria-disabled=true]");
    expect(html).toContain("@media (max-width:520px)");
    expect(html).toContain(".btn{width:100%}");
    expect(html).toContain("html.dark{color-scheme:dark");
  });

  it("keeps landing fixed dark while primary actions remain 44px and motion-safe", () => {
    const html = renderLandingPage();

    expect(html).toContain('<html lang="en" class="dark">');
    expect(html).toContain(".button { min-height: 44px;");
    expect(html).toContain('.button:hover:not(:disabled):not([aria-disabled="true"])');
    expect(html).toContain('.button:active:not(:disabled):not([aria-disabled="true"])');
    expect(html).toContain('.button[disabled], .button[aria-disabled="true"]');
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain(".hero-actions .button { width: 100%; }");
  });
});
