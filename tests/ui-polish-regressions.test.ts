import { readFileSync } from "node:fs";
import type { User } from "better-auth/types";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import authPages from "@/routes/auth-pages";
import { renderLandingPage } from "@/routes/landing";
import { renderNotFoundPage } from "@/routes/not-found";
import { repoShell } from "./helpers/repo-shell";
import { sharedThemeStyles } from "@/routes/theme";

const user = { id: "u1", name: "Priya Sharma", email: "priya@example.test" } as User;

describe("auth, landing, 404 and viewer polish", () => {
  it("renders a stacked, friendly account-security load failure with a full-size retry", async () => {
    const authenticated = new Hono<{ Variables: { user?: User } }>();
    authenticated.use("*", async (c, next) => { c.set("user", user); await next(); });
    authenticated.route("/", authPages);
    const html = await (await authenticated.request("/account/security")).text();
    expect(html).toContain("<strong>Couldn&#39;t load your sign-in methods</strong><span>Check your connection, then try again.</span>");
    expect(html).not.toContain("list.querySelector(\".error\").textContent=error.message");
    expect(html).toContain(".method-action{flex:none;min-width:88px;");
    expect(html).toContain("white-space:nowrap");
    expect(html).toContain('<a href="/home">Back to home</a>');
  });

  it("uses the shared dark palette, wordmark, and heading order on auth pages", async () => {
    const html = await (await authPages.request("/sign-in")).text();
    expect(html).toContain("html.dark{color-scheme:dark;--page:#09090b;--surface:#09090b;--surface-2:#18181b;");
    expect(html).toContain("--border:#27272a;");
    expect(html).not.toContain("--border:#3f3f46");
    expect(html).toContain('<a class="brand" href="/">Rendro<i>.</i></a>');
    expect(html).toContain(".brand{color:var(--text);font-size:24px;font-weight:700;line-height:32px;letter-spacing:-.04em");
    expect(html.indexOf("<h1>")).toBeLessThan(html.indexOf('<aside class="auth-context">'));
    expect(html).toContain(".auth-context{order:-1;");
  });

  it("keeps the 404 page context-neutral, on Inter, and on shell tokens", () => {
    const html = renderNotFoundPage({ path: "/missing" });
    expect(html).toContain("font-family:Inter;");
    expect(html).toContain('rel="preload" href="/fonts/inter-latin.');
    expect(html).not.toContain("font-display:block");
    expect(html).toContain('<div class="eyebrow">Error 404</div>');
    expect(html).toContain('<h1 id="not-found-title">Page not found</h1>');
    expect(html).toContain('target="_top">Go to Rendro</a>');
    expect(html).not.toContain("docs tree");
    expect(html).toContain("html.dark{color-scheme:dark;--page:#09090b;--surface:#09090b;--container:#18181b;");
    expect(html).toContain('<a class="brand" href="/" target="_top">Rendro<i>.</i></a>');
    expect(html).toContain("html.framed .brand{display:none}");
    const contextual = renderNotFoundPage({ path: "/docs/acme/x", homeHref: "/docs/acme", homeLabel: "Open docs tree" });
    expect(contextual).toContain('href="/docs/acme" target="_top">Open docs tree</a>');
  });

  it("keeps landing sign-in reachable on mobile and every call to action a sign-up link", () => {
    const html = renderLandingPage();
    expect(html).not.toMatch(/\.header-signin[^{]*\{\s*display:\s*none/);
    expect(html).not.toContain(".nav-links, .header-signin { display: none; }");
    expect(html).toContain('<a class="brand" href="/" aria-label="Rendro home">Rendro<i aria-hidden="true">.</i></a>');
    expect(html.match(/<a class="button button-(?:primary|secondary)" href="\/sign-up" data-action-id="(?:hero|security|final)-start">Get started<\/a>/g)).toHaveLength(3);
    // No sign-in submits from the landing page, so it has no inline error region to explain one.
    expect(html).not.toContain('class="auth-error"');
  });

  it("gives the viewer an h1 naming the repository", () => {
    const html = repoShell({ title: "acme/platform-api" });
    expect(html).toContain('<h1 class="topbar-logo">acme/platform-api</h1>');
  });

  it("styles the viewer mobile-menu theme row like its sibling rows", () => {
    expect(sharedThemeStyles).toContain(".mobile-more-menu .rendro-theme-control,html.dark .mobile-more-menu .rendro-theme-control{--theme-button-surface:transparent;--theme-button-border:transparent;--theme-button-border-hover:transparent;--theme-button-text:#52525b}");
    expect(sharedThemeStyles).toContain("html.dark .mobile-more-menu .rendro-theme-control{--theme-button-text:#d4d4d8}");
    expect(sharedThemeStyles).toContain("padding:0 12px;border-width:0;");
  });

  it("does not reference undefined commentor font variables", () => {
    const source = ["commentor.ts", "styles.ts"].map(file => readFileSync(new URL(`../src/commentor/${file}`, import.meta.url), "utf8")).join("\n");
    expect(source).not.toContain("var(--font-ui)");
  });
});
