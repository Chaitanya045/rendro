import { Hono } from "hono";
import type { User } from "better-auth/types";
import { describe, expect, it } from "vitest";
import authPages from "@/routes/auth-pages";
import organizationPages from "@/routes/organization-pages";
import projectPages from "@/routes/project-pages";
import apiKeyPages from "@/routes/api-key-pages";
import publicationPages from "@/routes/publication-pages";
import sharePages from "@/routes/share-pages";
import { renderScopedDocumentShell } from "@/routes/app";
import { renderNotFoundPage } from "@/routes/not-found";
import { sharedThemeRuntime } from "@/routes/theme";
import { mobileViewportStyles } from "@/routes/viewport";
import { renderLandingPage } from "@/routes/landing";

function assertSharedTheme(html: string, buttonId?: string) {
  expect(html).toContain(sharedThemeRuntime);
  expect(html).toContain(mobileViewportStyles);
  expect(html.match(/<script data-rendro-theme>/g)).toHaveLength(1);
  if (buttonId) {
    expect(html).toContain(`RendroTheme.mount(document.getElementById("${buttonId}")`);
    expect(html.match(new RegExp(`id="${buttonId}"`, "g"))).toHaveLength(1);
  }
  expect(html).not.toContain("function transitionTheme(");
  expect(html).not.toContain("function setThemeIconPosition(");
}

describe("shared theme integration", () => {
  it("keeps the landing page fixed dark while sharing only viewport scrollbar styling", () => {
    const html = renderLandingPage();
    expect(html).toContain(mobileViewportStyles);
    expect(html).toContain('<html lang="en" class="dark">');
    expect(html).not.toContain(sharedThemeRuntime);
  });
  it("uses one theme implementation on every public authentication form", async () => {
    for (const path of ["/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/verify-email"]) {
      const response = await authPages.request(path);
      expect(response.status, path).toBe(200);
      assertSharedTheme(await response.text(), "theme-toggle");
    }
  });

  it("uses the same controller on account security and every management route", async () => {
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "qa", name: "QA", email: "qa@example.test" } as User);
      await next();
    });
    for (const routes of [authPages, organizationPages, projectPages, apiKeyPages, publicationPages, sharePages]) app.route("/", routes);
    for (const path of ["/organizations", "/organizations/org", "/organizations/org/people", "/organizations/org/teams", "/organizations/org/settings", "/organizations/org/api-keys", "/organizations/org/onboarding", "/organizations/org/projects", "/organizations/org/projects/project", "/organizations/org/projects/project/publications", "/organizations/org/projects/project/shares", "/account/security"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      assertSharedTheme(await response.text(), path === "/account/security" ? "theme-toggle" : "cp-theme");
    }
  });

  it("keeps private/public viewers on the same controller and preserves iframe theme messaging", () => {
    for (const publicDocument of [false, true]) {
      const html = renderScopedDocumentShell({ user: null, namespace: "qa", title: "QA", basePath: publicDocument ? "/p/qa" : "/organizations/org/projects/project/docs", selectedPath: "index.html", publicDocument });
      assertSharedTheme(html, "theme-toggle");
      expect(html).toContain('RendroTheme.mount(document.getElementById("theme-toggle"),notifyTheme)');
      expect(html).toContain('e.source!==themeFrame.contentWindow');
    }
  });

  it("keeps passive error pages in sync without adding a second theme toggle inside documents", () => {
    const html = renderNotFoundPage();
    assertSharedTheme(html);
    expect(html).not.toContain('id="theme-toggle"');
    expect(html).toContain('event.source!==window.parent');
    expect(html).toContain('window.parent.postMessage({type:"commentor-theme-ready"}');
  });
});
