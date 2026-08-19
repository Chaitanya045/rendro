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
