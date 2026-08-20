import { Hono } from "hono";
import type { User } from "better-auth/types";
import { describe, expect, it } from "vitest";
import apiKeyPageRoutes from "@/routes/api-key-pages";
import authPageRoutes from "@/routes/auth-pages";
import organizationPageRoutes from "@/routes/organization-pages";
import projectPageRoutes from "@/routes/project-pages";
import publicationPageRoutes from "@/routes/publication-pages";
import sharePageRoutes from "@/routes/share-pages";

const user: User = {
  id: "user-a",
  email: "owner@acme.test",
  name: "Acme Owner",
  emailVerified: true,
  image: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function authenticatedPages(): Hono<{ Variables: { user?: User } }> {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", authPageRoutes);
  app.route("/", organizationPageRoutes);
  app.route("/", projectPageRoutes);
  app.route("/", apiKeyPageRoutes);
  app.route("/", publicationPageRoutes);
  app.route("/", sharePageRoutes);
  return app;
}

describe("control-plane UI", () => {
  it("renders one responsive organization shell across administration pages", async () => {
    const app = authenticatedPages();
    const routes = [
      "/organizations/org-a",
      "/organizations/org-a/people",
      "/organizations/org-a/teams",
      "/organizations/org-a/settings",
      "/organizations/org-a/projects",
      "/organizations/org-a/api-keys",
    ];

    for (const route of routes) {
      const response = await app.request(route);
      const html = await response.text();
      expect(response.status, route).toBe(200);
      expect(html, route).toContain('class="cp-topbar"');
      expect(html, route).toContain('class="cp-sidebar"');
      expect(html, route).toContain('id="cp-menu"');
      expect(html, route).toContain("prefers-reduced-motion:reduce");
      expect(html, route).toContain("/organizations/org-a/people");
      expect(html, route).toContain("/organizations/org-a/api-keys");
    }
  });
  it("renders destination-shaped loading states without generic placeholders", async () => {
    const app = authenticatedPages();
    const cases = [
      ["/organizations?choose=1", 'id="organization-state"', "Loading organizations", "organization-grid"],
      ["/organizations/org-a", 'id="organization-content"', "Loading workspace overview", "overview-metrics"],
      ["/organizations/org-a/people", 'id="organization-content"', "Loading people and invitations", "skeleton-table-head"],
      ["/organizations/org-a/teams", 'id="organization-content"', "Loading teams", "skeleton-card"],
      ["/organizations/org-a/settings", 'id="organization-content"', "Loading organization settings", "skeleton-field"],
      ["/organizations/org-a/projects", 'id="project-content"', "Loading projects", "project-list"],
      ["/organizations/org-a/projects/project-a", 'id="project-content"', "Loading project overview", "deployments-panel"],
      ["/organizations/org-a/projects/project-a/publications", 'id="publication-list"', "Loading publications", "skeleton-table-row"],
      ["/organizations/org-a/projects/project-a/shares", 'id="share-list"', "Loading private shares", "skeleton-table-row"],
      ["/organizations/org-a/api-keys", 'id="key-list"', "Loading API keys", "skeleton-table-row"],
      ["/accept-invitation/invitation-a", 'id="invitation-state"', "Loading invitation", "invitation-mark"],
      ["/account/security", 'id="method-list"', "Loading sign-in methods", "method-skeleton"],
    ] as const;

    for (const [route, marker, label, shape] of cases) {
      const response = await app.request(route);
      const html = await response.text();
      const mountStart = html.indexOf(marker);
      const stateScript = html.indexOf("<script>window.__", mountStart);
      const initialMount = html.slice(mountStart, stateScript);
      expect(response.status, route).toBe(200);
      expect(mountStart, route).toBeGreaterThan(0);
      expect(stateScript, route).toBeGreaterThan(mountStart);
      expect(initialMount, route).toContain(label);
      expect(initialMount, route).toContain(shape);
      expect(initialMount, route).not.toContain('<div class="skeleton loading-panel"></div>');
    }
  });

  it("keeps invitation context through sign-in and account creation", async () => {
    const returnTo = "/accept-invitation/invitation-a";
    for (const route of ["/sign-in", "/sign-up"]) {
      const response = await authPageRoutes.request(`${route}?returnTo=${encodeURIComponent(returnTo)}`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("You have been invited to collaborate.");
      expect(html).toContain("Sign in with the exact invited email");
      expect(html).toContain(JSON.stringify(returnTo));
    }
  });

  it("renders the activation path and deployment-backed project tabs", async () => {
    const app = authenticatedPages();
    const onboarding = await (await app.request("/organizations/org-a/onboarding")).text();
    expect(onboarding).toContain("Organization</span>");
    expect(onboarding).toContain("Project</span>");
    expect(onboarding).toContain("First deployment</span>");
    expect(onboarding).toContain("Waiting for your first deployment");

    const project = await (await app.request("/organizations/org-a/projects/project-a")).text();
    expect(project).toContain('<h1 class="cp-page-heading">Project</h1>');
    expect(project).toContain("Project overview");
    expect(project).toContain("Deployment history");
    expect(project).toContain("Publications");
    expect(project).toContain("Private shares");
  });

  it("protects one-time API key reveal and exposes scoped key metadata", async () => {
    const app = authenticatedPages();
    const html = await (await app.request("/organizations/org-a/api-keys")).text();
    expect(html).toContain('id="secret-dialog"');
    expect(html).toContain("This secret is shown once");
    expect(html).toContain('id="secret-confirmed"');
    expect(html).toContain('id="secret-done" type="button" disabled');
    expect(html).toContain("Project scope");
    expect(html).toContain("Last used");
    expect(html).toContain("revocation is immediate");
  });

  it("keeps publication and private-share controls inside project navigation", async () => {
    const app = authenticatedPages();
    const base = "/organizations/org-a/projects/project-a";
    const publication = await (await app.request(`${base}/publications`)).text();
    const share = await (await app.request(`${base}/shares`)).text();

    expect(publication).toContain('class="project-tabs"');
    expect(publication).toContain("Create publication");
    expect(publication).toContain("Track active deployment");
    expect(share).toContain('class="project-tabs"');
    expect(share).toContain("Revocable links pinned to immutable deployments");
    expect(share).toContain("Browse documentation");
  });
});
