import vm from "node:vm";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { describe, expect, it } from "vitest";

import apiKeyPages from "@/routes/api-key-pages";
import {
  type ManagementLoadingPage,
  MANAGEMENT_PROJECT_PLACEHOLDER,
  managementLoadingPages,
} from "@/routes/management-loading-pages";
import {
  organizationPageStyles,
  projectPageStyles,
} from "@/routes/management-loading";
import { renderManagementNavigationRuntime } from "@/routes/management-navigation";
import organizationPages from "@/routes/organization-pages";
import projectPages from "@/routes/project-pages";
import publicationPages from "@/routes/publication-pages";
import sharePages from "@/routes/share-pages";

const organizationId = "org-a";
const projectId = "project-a";

type RouteKind = keyof ReturnType<typeof managementLoadingPages>;

interface RouteCase {
  kind: RouteKind;
  path: string;
  projectId?: string;
  snippets: string[];
  tableHeaders?: string[];
  projectTabs?: boolean;
}

const routes: RouteCase[] = [
  {
    kind: "overview",
    path: `/organizations/${organizationId}`,
    snippets: ['id="organization-content"', 'aria-label="Loading workspace overview"', 'class="grid-3 overview-metrics"', 'class="overview-grid"', "recent-panel"],
  },
  {
    kind: "people",
    path: `/organizations/${organizationId}/people`,
    snippets: ['id="organization-content"', 'aria-label="Loading people and invitations"', 'class="skeleton-list"'],
  },
  {
    kind: "teams",
    path: `/organizations/${organizationId}/teams`,
    snippets: ['id="organization-content"', 'aria-label="Loading teams"', 'class="grid-2"', 'class="panel skeleton-card"'],
  },
  {
    kind: "settings",
    path: `/organizations/${organizationId}/settings`,
    snippets: ['id="organization-content"', 'aria-label="Loading organization settings"', 'class="panel panel-pad settings-panel skeleton-copy"'],
  },
  {
    kind: "projects",
    path: `/organizations/${organizationId}/projects`,
    snippets: ['id="project-content"', 'aria-label="Loading projects"', 'class="project-list"', 'class="project-row"'],
  },
  {
    kind: "project",
    path: `/organizations/${organizationId}/projects/${projectId}`,
    projectId,
    snippets: ['id="project-content"', 'aria-label="Loading project overview"', 'class="skeleton-tabs"', 'class="project-overview"', "deployments-panel"],
  },
  {
    kind: "api-keys",
    path: `/organizations/${organizationId}/api-keys`,
    snippets: ['id="key-list"', '>Loading API keys</span>', 'class="data-table key-table"'],
    tableHeaders: ["Name", "Project scope", "Permissions", "Last used", "Expires", "Status", "Action"],
  },
  {
    kind: "publications",
    path: `/organizations/${organizationId}/projects/${projectId}/publications`,
    projectId,
    snippets: ['id="publication-list"', '>Loading publications</span>', 'class="data-table publication-table"'],
    tableHeaders: ["Publication", "Path", "Release mode", "Status", "Actions"],
    projectTabs: true,
  },
  {
    kind: "shares",
    path: `/organizations/${organizationId}/projects/${projectId}/shares`,
    projectId,
    snippets: ['id="share-list"', '>Loading private shares</span>', 'class="data-table share-table"'],
    tableHeaders: ["Document", "Deployment", "Expires", "Status", "Action"],
    projectTabs: true,
  },
];

function authenticatedPages(): Hono<{ Variables: { user?: User } }> {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "user-a", name: "QA", email: "qa@example.test" } as User);
    await next();
  });
  app.route("/", organizationPages);
  app.route("/", projectPages);
  app.route("/", apiKeyPages);
  app.route("/", publicationPages);
  app.route("/", sharePages);
  return app;
}

function materialize(page: ManagementLoadingPage, routeProjectId = ""): ManagementLoadingPage {
  const replacement = encodeURIComponent(routeProjectId);
  const replace = (value = "") => value.split(MANAGEMENT_PROJECT_PLACEHOLDER).join(replacement);
  return {
    eyebrow: replace(page.eyebrow),
    heading: replace(page.heading),
    description: replace(page.description),
    actions: replace(page.actions),
    content: replace(page.content),
  };
}

function occurrenceCount(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}

function tableHeaders(markup: string): string[] {
  return Array.from(markup.matchAll(/<th>([^<]+)<\/th>/g), (match) => match[1]);
}

describe("canonical management loading parity", () => {
  it.each(routes)("matches the real SSR head and loading body for $kind", async (route) => {
    const response = await authenticatedPages().request(route.path);
    expect(response.status).toBe(200);
    const html = await response.text();
    const descriptor = materialize(managementLoadingPages(organizationId)[route.kind], route.projectId);
    const expectedHead = `<header class="cp-page-head"><div class="cp-page-copy"><p class="eyebrow">${descriptor.eyebrow}</p><h1 class="cp-page-heading">${descriptor.heading}</h1><p class="cp-page-description">${descriptor.description}</p></div>${descriptor.actions ? `<div class="cp-page-actions">${descriptor.actions}</div>` : ""}</header>`;

    expect(html).toContain(expectedHead);
    expect(html).toContain(descriptor.content);
    expect(occurrenceCount(html, descriptor.content)).toBe(1);
    for (const snippet of route.snippets) {
      expect(descriptor.content).toContain(snippet);
      expect(html).toContain(snippet);
    }
    if (route.tableHeaders) {
      expect(tableHeaders(descriptor.content)).toEqual(route.tableHeaders);
      expect(tableHeaders(html)).toEqual(route.tableHeaders);
    }
    if (route.projectTabs) {
      for (const label of ["Overview", "Deployments", "Publications", "Private shares"]) {
        expect(descriptor.content).toContain(`>${label}</a>`);
      }
      expect(descriptor.content).toContain(`/projects/${encodeURIComponent(projectId)}`);
    }
  });

  it("uses the same canonical style sources as organization and project SSR", async () => {
    const app = authenticatedPages();
    const organizationHtml = await (await app.request(`/organizations/${organizationId}/people`)).text();
    const projectHtml = await (await app.request(`/organizations/${organizationId}/projects/${projectId}`)).text();

    expect(organizationHtml).toContain(`<style>${organizationPageStyles}</style>`);
    expect(projectHtml).toContain(`<style>${projectPageStyles}</style>`);
    expect(occurrenceCount(organizationHtml, `<style>${organizationPageStyles}</style>`)).toBe(1);
    expect(occurrenceCount(projectHtml, `<style>${projectPageStyles}</style>`)).toBe(1);
  });

  it("executes the router's project sentinel replacement with URL-safe route identity", () => {
    const runtime = renderManagementNavigationRuntime(organizationId);
    const start = runtime.indexOf("function materialize(");
    const end = runtime.indexOf("function hasLoadingContent", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const routeProjectId = "project / 100%";
    const context = vm.createContext({
      PROJECT_PLACEHOLDER: MANAGEMENT_PROJECT_PLACEHOLDER,
      route: { projectId: routeProjectId },
      value: `/organizations/${organizationId}/projects/${MANAGEMENT_PROJECT_PLACEHOLDER}/publications`,
    });
    vm.runInContext(`${runtime.slice(start, end)}result=materialize(value,route);`, context);

    expect(context.result).toBe(`/organizations/${organizationId}/projects/${encodeURIComponent(routeProjectId)}/publications`);
    expect(String(context.result)).not.toContain(MANAGEMENT_PROJECT_PLACEHOLDER);
  });

  it("suppresses the second whole-page loading animation while retaining retry loaders", async () => {
    const app = authenticatedPages();
    const apiKeys = await (await app.request(`/organizations/${organizationId}/api-keys`)).text();
    const publications = await (await app.request(`/organizations/${organizationId}/projects/${projectId}/publications`)).text();
    const shares = await (await app.request(`/organizations/${organizationId}/projects/${projectId}/shares`)).text();
    const organization = await (await app.request(`/organizations/${organizationId}/people`)).text();
    const project = await (await app.request(`/organizations/${organizationId}/projects/${projectId}`)).text();
    const runtime = renderManagementNavigationRuntime(organizationId);

    for (const html of [apiKeys, publications, shares]) {
      expect(html).toContain("load(false);");
      expect(html).toMatch(/if\(showLoading!==false\)[a-zA-Z]+\.innerHTML=loading/);
    }
    for (const html of [organization, project]) {
      expect(html).toContain('if(version>1||!mount.querySelector(".loading-view"))mount.innerHTML=');
    }
    expect(runtime).toContain("pendingExpectedMarkup.get(pendingContent)!==normalizedServerMarkup(incoming)");
    expect(runtime).toContain("incoming=pendingContent");
    expect(runtime).toContain('classList.replace("cp-navigation-pending","cp-navigation-ready")');
  });
});
