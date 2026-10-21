import type { User } from "better-auth/types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "@/worker";
import authPages from "@/routes/auth-pages";
import { renderAuthPage } from "@/routes/auth-page";
import { nonceContext } from "@/middleware/html-nonce";
import { renderCommentRecoveryLifecycle } from "@/commentor/recovery-session";
import { renderPreparingPage } from "@/repo-read/preparing";
import { renderFaviconLinks } from "@/routes/favicon";
import { renderFontHead } from "@/routes/fonts";
import { renderLandingPage } from "@/routes/landing";
import { renderNotFoundPage } from "@/routes/not-found";
import { renderSessionUnavailablePage } from "@/routes/session-unavailable";
import { renderSignOutPage } from "@/routes/sign-out";
import { renderStylesheet } from "@/routes/styles";
import { renderThemeAssets, renderThemeButton } from "@/routes/theme";
import { repoShell } from "./helpers/repo-shell";
import { repoReadFixture, sessionCookies, stubSessions } from "./helpers/repo-read-fixture";

/**
 * Characterization of every server-rendered page and state (#288): the exact HTML, with the request's
 * CSP nonce replaced by a placeholder. A change here is a change to what readers receive; review the
 * snapshot diff as the change itself.
 */
const NONCE = "NONCE-PLACEHOLDER";
const nonced = (render: () => string) => nonceContext.run(NONCE, render);
const snapshot = (name: string, html: string) => expect(html).toMatchFileSnapshot(`__snapshots__/pages/${name}.html`);

const user = { id: "user-ada", name: "Ada Lovelace", email: "ada@example.test" } as User;
function signedIn() {
  const pages = new Hono<{ Variables: { user?: User } }>();
  pages.use("*", async (c, next) => { c.set("user", user); await next(); });
  return pages.route("/", authPages);
}
const page = async (response: Response | Promise<Response>) => {
  const resolved = await response;
  expect(resolved.status).toBeLessThan(600);
  return resolved.text();
};

describe("server-rendered page snapshots", () => {
  it("landing", async () => {
    await snapshot("landing", nonced(renderLandingPage));
    await snapshot("landing-github", nonced(() => renderLandingPage({ github: true })));
  });

  it("repository shell, with and without comments", async () => {
    await snapshot("shell", nonced(() => repoShell()));
    await snapshot("shell-comments", nonced(() => repoShell({
      namespace: "handbook", title: "acme/handbook", basePath: "/r/acme/handbook/~feature", frameBase: "/r/acme/handbook/@0123456789abcdef0123456789abcdef01234567",
      selectedPath: "docs/guide/start.md",
      repoCommentConfig: { repoId: 42, accessUrl: "/r/acme/handbook/comment-access", convexUrl: "https://convex.example.test", documentPath: "docs/guide/start.md" },
    })));
  });

  describe("repository shell as the read path serves it", () => {
    let fixture: Awaited<ReturnType<typeof repoReadFixture>>;
    beforeEach(async () => {
      fixture = await repoReadFixture();
      stubSessions();
    });
    const served = async (path: string, headers: Record<string, string> = {}) =>
      (await page(app.request(`https://rendro.test${path}`, { headers }, fixture.env, fixture.ctx))).replace(/ nonce="[^"]+"/g, ` nonce="${NONCE}"`);

    it("public and private", async () => {
      await snapshot("shell-route-public", await served("/r/Octo/public-docs"));
      await snapshot("shell-route-private", await served("/r/octo/secret-docs", { Cookie: sessionCookies.reader }));
    });
  });

  it("preparing and failed", async () => {
    await snapshot("preparing", nonced(() => renderPreparingPage("preparing", 3)));
    await snapshot("preparing-failed", nonced(() => renderPreparingPage("failed", 3)));
  });

  it("not found", async () => {
    await snapshot("not-found", nonced(() => renderNotFoundPage({ path: "/r/acme/docs/files/missing.md" })));
    await snapshot("not-found-default", nonced(() => renderNotFoundPage()));
    await snapshot("not-found-gone", nonced(() => renderNotFoundPage({
      status: 410, path: "/old", homeHref: "/home", homeLabel: "Go home", heading: "Page removed", message: "This page was removed.",
    })));
  });

  it("temporarily unavailable", async () => {
    await snapshot("unavailable-session", nonced(() => renderSessionUnavailablePage()));
    await snapshot("unavailable-page", nonced(() => renderSessionUnavailablePage(500)));
    await snapshot("unavailable-document", nonced(() => renderSessionUnavailablePage(503, "document")));
    await snapshot("unavailable-document-framed", nonced(() => renderSessionUnavailablePage(503, "document", true)));
    await snapshot("unavailable-document-error", nonced(() => renderSessionUnavailablePage(500, "document")));
  });

  it("sign-out", async () => {
    for (const state of ["confirm", "failed", "complete"] as const) await snapshot(`sign-out-${state}`, nonced(() => renderSignOutPage(state)));
  });

  it.each([
    ["sign-in", "/sign-in"],
    ["sign-in-error", "/sign-in?error=access_denied&returnTo=%2Fr%2Facme%2Fdocs"],
    ["sign-up", "/sign-up?returnTo=%2Fhome"],
    ["verify-email", "/verify-email"],
    ["verify-email-verified", "/verify-email?verified=1"],
    ["verify-email-invalid", "/verify-email?error=INVALID_TOKEN"],
    ["forgot-password", "/forgot-password"],
    ["reset-password", "/reset-password?token=reset-token-123"],
    ["reset-password-missing", "/reset-password"],
  ])("auth page %s", async (name, path) => {
    await snapshot(`auth-${name}`, await nonceContext.run(NONCE, () => page(authPages.request(path))));
  });

  describe("with GitHub sign-in configured (#338)", () => {
    afterEach(() => vi.unstubAllEnvs());
    it.each([
      ["sign-in-github", "/sign-in", "on"],
      ["sign-in-github-error", "/sign-in?error=state_mismatch&returnTo=%2Fhome", "on"],
      ["sign-in-github-only", "/sign-in?error=access_denied", "off"],
      ["sign-up-github", "/sign-up?returnTo=%2Fhome", "on"],
    ])("auth page %s", async (name, path, email) => {
      vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.fixture");
      vi.stubEnv("AUTH_EMAIL_SIGN_IN", email);
      await snapshot(`auth-${name}`, await nonceContext.run(NONCE, () => page(authPages.request(path))));
    });
  });

  describe("the home's repository list (#338)", () => {
    const installUrl = "https://github.com/apps/rendro-docs/installations/new";
    const listed = [
      { owner: "octo", name: "handbook", private: true, pushedAt: Date.parse("2026-10-01T09:30:00Z") },
      { owner: "octo", name: "notes", private: false, pushedAt: null },
    ];
    it.each([
      ["home-repositories", { repositories: { kind: "list", repositories: listed, truncated: false }, installUrl, notice: null }],
      ["home-repositories-installed", { repositories: { kind: "list", repositories: listed, truncated: true }, installUrl, notice: "installed" }],
      ["home-empty", { repositories: { kind: "list", repositories: [], truncated: false }, installUrl, notice: "requested" }],
      ["home-unlinked", { repositories: { kind: "unlinked" }, installUrl: null, notice: null }],
      ["home-unavailable", { repositories: { kind: "unavailable" }, installUrl, notice: null }],
    ] as const)("%s", async (name, home) => {
      await snapshot(`auth-${name}`, nonced(() => renderAuthPage("home", { user, home: structuredClone(home) as never })));
    });
  });

  it.each([
    ["home", "/home"],
    ["security", "/account/security"],
  ])("signed-in page %s", async (name, path) => {
    await snapshot(`auth-${name}`, await nonceContext.run(NONCE, () => page(signedIn().request(path))));
  });

  it("shared head and bootstrap parts", async () => {
    await snapshot("part-favicon", renderFaviconLinks());
    await snapshot("part-fonts", nonced(() => renderFontHead()));
    await snapshot("part-fonts-icons", nonced(() => renderFontHead({ icons: true, weights: [400, 600, 700] })));
    await snapshot("part-stylesheet", renderStylesheet("viewer-base"));
    await snapshot("part-theme-assets", nonced(renderThemeAssets));
    await snapshot("part-theme-button", renderThemeButton());
    await snapshot("part-recovery", renderCommentRecoveryLifecycle("user-ada", ` nonce="${NONCE}"`));
    await snapshot("part-recovery-signed-out", renderCommentRecoveryLifecycle(null, ` nonce="${NONCE}"`, true));
  });
});
