import { Hono } from "hono";
import type { User } from "better-auth/types";
import { describe, expect, it } from "vitest";
import apiKeyPageRoutes from "@/routes/api-key-pages";
import authPageRoutes from "@/routes/auth-pages";
import organizationPageRoutes, { organizationSectionDataPaths } from "@/routes/organization-pages";
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
  it("preserves hidden controls and conditional fields over component display styles", async () => {
    const html = await (await authenticatedPages().request("/organizations/org-a/api-keys")).text();
    expect(html).toContain("[hidden]{display:none!important}");
  });

  it("aligns select chevrons consistently without replacing native select behavior", async () => {
    const html = await (await authenticatedPages().request("/organizations/org-a/people")).text();
    expect(html).toContain("select.select{appearance:none;padding-inline-end:40px");
    expect(html).toContain("background-position:right 12px center;background-size:16px 16px");
    expect(html).toContain("html.dark select.select{background-image:");
    expect(html).toContain("@media(forced-colors:active){select.select,html.dark select.select{appearance:auto");
  });

  it("gives dialog close buttons complete interaction states", async () => {
    const html = await (await authenticatedPages().request("/organizations/org-a/api-keys")).text();
    expect(html).toContain(".dialog-close:hover:not(:disabled){background:var(--cp-container);color:var(--cp-strong)}");
    expect(html).toContain(".dialog-close:active:not(:disabled){transform:scale(.98)}");
    expect(html).toContain(".dialog-close:disabled{cursor:not-allowed;opacity:.5;transform:none}");
    expect(html).toContain("transform var(--cp-instant) var(--cp-ease),opacity var(--cp-instant) var(--cp-ease)");
    expect(html).toContain(".dialog-close:active,.organization-card:hover");
  });

  it("removes desktop table widths and scrollbar chrome from stacked mobile layouts", async () => {
    const app = authenticatedPages();
    for (const route of [
      "/organizations/org-a/api-keys",
      "/organizations/org-a/projects/project-a/publications",
      "/organizations/org-a/projects/project-a/shares",
    ]) {
      const html = await (await app.request(route)).text();
      const mobile = html.slice(html.indexOf("@media(max-width:760px){"));
      expect(mobile, route).toContain("body .data-table{min-width:0}");
      expect(mobile, route).toContain("body .project-tabs{overflow-y:hidden}");
      expect(mobile, route).toContain("body .project-tabs a{flex:0 0 auto;white-space:nowrap}");
      expect(mobile, route).toContain(".project-tabs::-webkit-scrollbar");
      expect(html, route).toContain('caption.textContent="Project section"');
      expect(html, route).toContain('option.value=link.href');
      expect(html, route).toContain('window.location.assign(select.value)');
      expect(html, route).toContain('url.pathname===location.pathname&&url.hash===location.hash');
      expect(html, route).toContain('window.addEventListener("hashchange",syncProjectSectionPickers)');
      expect(mobile, route).toContain('body .project-tabs[data-mobile-nav]{display:none}');
      expect(mobile, route).toContain('.cp-page-actions>.primary{order:-1}');
      expect(mobile, route).toContain('grid-template-columns:minmax(76px,.38fr) minmax(0,1fr)');
      expect(mobile, route).toContain('body .button.small,body .role-select');
      expect(mobile, route).toContain('.cp-nav-link,.cp-account-menu a{min-height:44px}');
      expect(html, route).toContain(".table-wrap{overflow:auto}");
    }
  });
  it("loads only the organization data required by each management section", async () => {
    expect(organizationSectionDataPaths("settings")).toEqual([
      "/api/auth/organization/get-full-organization",
    ]);
    expect(organizationSectionDataPaths("teams")).toHaveLength(1);
    expect(organizationSectionDataPaths("people")).toEqual([
      "/api/auth/organization/get-full-organization",
      "/api/auth/organization/list-invitations",
    ]);
    expect(organizationSectionDataPaths("overview")).toEqual([
      "/api/auth/organization/get-full-organization",
      "/api/auth/organization/list-invitations",
      "/api/rendro/projects",
    ]);

    const app = authenticatedPages();
    const settings = await (await app.request("/organizations/org-a/settings")).text();
    const people = await (await app.request("/organizations/org-a/people")).text();
    expect(settings).not.toContain("/api/auth/organization/list-invitations");
    expect(settings).not.toContain("/api/rendro/projects");
    expect(people).toContain("/api/auth/organization/list-invitations");
    expect(people).not.toContain("/api/rendro/projects");
  });

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
    expect(onboarding).toContain("Organization");
    expect(onboarding).toContain("Project");
    expect(onboarding).toContain("First deployment</span>");
    expect(onboarding).toContain("Waiting for your first deployment");
    expect(onboarding).toContain('class="stepper" aria-label="Setup progress"');
    expect(onboarding).toContain('aria-current="step"');
    expect(onboarding).toContain('class="step-dot material-symbols-outlined" aria-hidden="true">check');
    expect(onboarding).toContain('<span class="sr-only"> completed</span>');
    expect(onboarding).not.toContain('<span class="step-dot">Done</span>');
    expect(onboarding).toContain('if(!scopes.length){error.textContent="Choose at least one permission.";return;}');
    expect(onboarding).toContain('ui.busy(button,false);showCredential(result.rawKey)');
    expect(onboarding).toContain('success.setAttribute("role","status")');

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

  it("keeps management mutations synchronized and retry-safe", async () => {
    const app = authenticatedPages();
    const base = "/organizations/org-a/projects/project-a";
    const publication = await (await app.request(`${base}/publications`)).text();
    const apiKeys = await (await app.request("/organizations/org-a/api-keys")).text();
    const people = await (await app.request("/organizations/org-a/people")).text();

    expect(publication).toContain("publications=publications.filter");
    expect(publication).toContain('render(publications);ui.toast("Publication removed.")');
    expect(publication).not.toContain('ui.toast("Publication removed.");await load()');
    expect(publication).toContain("publications=publications.concat([result.publication])");
    expect(publication).toContain("Unable to copy. Select the URL and copy it manually.");
    expect(publication).toContain("@media(max-width:620px){.row-actions .button{min-height:44px}}");
    expect(apiKeys).toContain("projectSelect.value=results[1].projects[0]._id");
    expect(apiKeys).toContain("dialog.oncancel=function(event)");
    expect(people).toContain("entry.remove();}catch");
    expect(people).toContain("retry the highlighted rows");

    const teams = await (await app.request("/organizations/org-a/teams")).text();
    const shares = await (await app.request(`${base}/shares`)).text();
    expect(teams).toContain("@media(max-width:620px){.invite-entry");
    expect(teams).toContain(".team-footer .button{min-height:44px}");
    expect(shares).toContain("@media(max-width:620px){.share-table .button{min-height:44px}}");
    expect(publication).not.toContain("}(max-width:620px)");
    expect(shares).not.toContain("}(max-width:620px)");
  });

  it("uses accessible Material Symbols for collection empty states", async () => {
    const app = authenticatedPages();
    for (const [route, icon] of [
      ["/organizations/org-a/projects", "folder"],
      ["/organizations/org-a/projects/project-a/publications", "public"],
      ["/organizations/org-a/projects/project-a/shares", "link"],
      ["/organizations/org-a/api-keys", "key"],
    ]) {
      const html = await (await app.request(route)).text();
      expect(html, route).toContain(`class="empty-mark material-symbols-outlined" aria-hidden="true">${icon}</span>`);
      expect(html, route).toContain(".empty-mark.material-symbols-outlined{font-size:22px;font-weight:400}");
    }
    const teams = await (await app.request("/organizations/org-a/teams")).text();
    expect(teams).toContain('statusEmpty("groups","No teams yet"');
    expect(teams).toContain('class="empty-mark material-symbols-outlined" aria-hidden="true"');
  });
});
