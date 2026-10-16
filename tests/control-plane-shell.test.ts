import type { User } from "better-auth/types";
import { describe, expect, it } from "vitest";
import { renderControlPlanePage } from "@/routes/control-plane";

function page(user: Partial<User>, options: Partial<Parameters<typeof renderControlPlanePage>[0]> = {}) {
  return renderControlPlanePage({
    user: { id: "user-a", name: "A User", email: "user@example.test", ...user } as User,
    title: "People", eyebrow: "Access", heading: "People", description: "Manage access.",
    content: "<p>content</p>", script: "", ...options,
  });
}
const avatar = (html: string) => html.match(/<button class="cp-avatar"[^>]*>([^<]*)<\/button>/)?.[1];

describe("control-plane shell", () => {
  it("derives a sanitized avatar initial from the name, then the email, then a fallback", () => {
    expect(avatar(page({ name: "ada" }))).toBe("A");
    expect(avatar(page({ name: "", email: "zed@example.test" }))).toBe("Z");
    expect(avatar(page({ name: "   ", email: "zed@example.test" }))).toBe("R");
    expect(avatar(page({ name: "<b>", email: "zed@example.test" }))).toBe("&lt;");
  });

  it("escapes the optional page class", () => {
    const html = page({}, { pageClass: 'wide" onclick="x' });
    expect(html).toContain('wide&quot; onclick=&quot;x');
    expect(html).not.toContain('wide" onclick');
    expect(html).toContain('<div class="cp-content wide&quot; onclick=&quot;x"');
    expect(page({})).toContain('<div class="cp-content"');
  });

  it.each([
    ["an organization page", { organizationId: "org a", active: "people" as const }, true],
    ["a focused organization page", { organizationId: "org a", focused: true }, false],
    ["a page without an organization", {}, false],
  ])("renders the sidebar and shell script only for %s", (_name, options, sidebar) => {
    const html = page({}, options);
    expect(html.includes('id="cp-navigation"')).toBe(sidebar);
    expect(html.includes('/management-pages.js?v=')).toBe(sidebar);
    expect(html.includes('aria-label="Organization navigation"')).toBe(sidebar);
    expect(html).toContain(sidebar ? '<body class="has-sidebar">' : '<body class="focused-layout">');
    if (sidebar) {
      expect(html).toContain('href="/organizations/org%20a/people" aria-current="page"');
      expect(html).toContain('href="/organizations/org%20a/api-keys"');
    }
    expect(html.includes('data-cp-open-docs href="/organizations/org%20a/projects"')).toBe("organizationId" in options);
  });

  it("links documentation to the project when one is known", () => {
    expect(page({}, { organizationId: "org-a", projectId: "p/1" })).toContain('data-cp-open-docs href="/organizations/org-a/projects/p%2F1/docs"');
  });
});
