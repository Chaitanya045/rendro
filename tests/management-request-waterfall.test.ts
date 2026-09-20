import vm from "node:vm";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { describe, expect, it } from "vitest";
import { organizationContextScript } from "@/routes/organization-context";
import organizationPages from "@/routes/organization-pages";
import projectPages from "@/routes/project-pages";
import {
  organizationSectionLoading,
  projectLoading,
  renderOrganizationLoadingPage,
  renderProjectLoadingPage,
} from "@/routes/management-loading";

const user = {
  id: "user-a",
  email: "owner@example.test",
  name: "Owner",
  emailVerified: true,
  image: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies User;

function authenticatedPages() {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (context, next) => {
    context.set("user", user);
    await next();
  });
  app.route("/", organizationPages);
  app.route("/", projectPages);
  return app;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function organizationContext() {
  const root: Record<string, unknown> = {};
  vm.runInNewContext(organizationContextScript, {
    window: { RendroUI: root },
    Map,
    Promise,
    encodeURIComponent,
  });
  return root.organizationContext as {
    request: (ui: { request: (path: string) => unknown; isActive: () => boolean }, id: string) => Promise<Record<string, unknown>>;
    display: (id: string) => { name: string; mark: string } | null;
  };
}

describe("management request waterfall", () => {
  it("loads members beyond the full-organization join's first 100 without duplicates", async () => {
    const context = organizationContext(), all = Array.from({ length: 121 }, (_, i) => ({ id: `member-${i}` }));
    const paths: string[] = [];
    const result = await context.request({ isActive: () => true, request: (path) => {
      paths.push(path);
      if (path.includes("get-full-organization")) return { id: "org-a", members: all.slice(0, 100) };
      const cursor = new URL(path, "https://rendro.test").searchParams.get("cursor");
      return { members: cursor ? all.slice(100) : all.slice(0, 100), nextCursor: cursor ? null : "page-two" };
    } }, "org-a");
    expect(result.members).toHaveLength(121);
    expect(paths).toHaveLength(3);
    expect(paths.at(-1)).toContain("cursor=page-two");
  });
  it("fails visibly if roster pagination stops making progress", async () => {
    const context = organizationContext();
    await expect(context.request({ isActive: () => true, request: (path) => path.includes("get-full-organization")
      ? { id: "org-a", members: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) }
      : { members: [], nextCursor: "stuck" } }, "org-a")).rejects.toThrow("changed while loading");
  });
  it("shares only an active in-flight organization check and checks again after it settles", async () => {
    const context = organizationContext();
    const first = deferred<Record<string, unknown>>();
    const second = deferred<Record<string, unknown>>();
    let calls = 0;
    const ui = {
      isActive: () => true,
      request: () => (++calls === 1 ? first.promise : second.promise),
    };

    const firstRequest = context.request(ui, "org-a");
    const sharedRequest = context.request(ui, "org-a");
    expect(calls).toBe(1);
    first.resolve({ id: "org-a", name: "Acme" });
    await expect(Promise.all([firstRequest, sharedRequest])).resolves.toHaveLength(2);
    expect(context.display("org-a")).toEqual({ name: "Acme", mark: "A" });

    const freshRequest = context.request(ui, "org-a");
    expect(calls).toBe(2);
    second.resolve({ id: "org-a", name: "Acme renamed", members: [] });
    await freshRequest;
    expect(context.display("org-a")?.name).toBe("Acme renamed");
  });

  it("does not let an inactive request overwrite display identity or serve a new page", async () => {
    const context = organizationContext();
    const stale = deferred<Record<string, unknown>>();
    const current = deferred<Record<string, unknown>>();
    let oldActive = true;
    let calls = 0;
    const oldUi = { isActive: () => oldActive, request: () => { calls += 1; return stale.promise; } };
    const currentUi = { isActive: () => true, request: () => { calls += 1; return current.promise; } };

    const staleRequest = context.request(oldUi, "org-a");
    oldActive = false;
    const currentRequest = context.request(currentUi, "org-a");
    expect(calls).toBe(2);
    current.resolve({ id: "org-a", name: "Current" });
    await currentRequest;
    stale.resolve({ id: "org-a", name: "Stale" });
    await staleRequest;
    expect(context.display("org-a")?.name).toBe("Current");
  });

  it("renders destination skeletons immediately and removes active-organization setup requests", async () => {
    const app = authenticatedPages();
    for (const [path, skeleton] of [
      ["/organizations/org-a", "Loading workspace overview"],
      ["/organizations/org-a/people", "Loading people and invitations"],
      ["/organizations/org-a/projects", "Loading projects"],
      ["/organizations/org-a/projects/project-a", "Loading project overview"],
    ] as const) {
      const html = await (await app.request(path)).text();
      expect(html, path).toContain(skeleton);
      expect(html, path).not.toContain("/api/auth/organization/set-active");
      expect(html, path).toContain("createPageScope");
      expect(html, path).toContain("if(!active()");
    }
  });

  it("uses the canonical loading page templates for SSR and retry state", async () => {
    const app = authenticatedPages();
    for (const section of ["overview", "people", "teams", "settings"] as const) {
      const suffix = section === "overview" ? "" : `/${section}`;
      const html = await (await app.request(`/organizations/org-a${suffix}`)).text();
      expect(html, section).toContain(renderOrganizationLoadingPage("org-a", section).content);
      expect(html, section).toContain(JSON.stringify(organizationSectionLoading(section)));
    }

    for (const projectId of ["", "project-a"]) {
      const suffix = projectId ? `/${projectId}` : "";
      const html = await (await app.request(`/organizations/org-a/projects${suffix}`)).text();
      expect(html, projectId || "list").toContain(renderProjectLoadingPage("org-a", projectId).content);
      expect(html, projectId || "list").toContain(JSON.stringify(projectLoading(projectId ? "project" : "")));
    }
  });

  it("preserves the initial skeleton DOM so its shimmer does not restart", async () => {
    const app = authenticatedPages();
    const organization = await (await app.request("/organizations/org-a/people")).text();
    const project = await (await app.request("/organizations/org-a/projects/project-a")).text();
    expect(organization).toContain('if(version>1||!mount.querySelector(".loading-view"))mount.innerHTML=loadingStates');
    expect(project).toContain('if(version>1||!mount.querySelector(".loading-view"))mount.innerHTML=state.projectId?detailLoading:loading');
  });

  it("starts independent overview data with the organization request and cleans route resources", async () => {
    const html = await (await authenticatedPages().request("/organizations/org-a")).text();
    expect(html).toContain('projectsRequest=state.section==="overview"?ui.request(projectsPath+query)');
    expect(html).toContain("var initial=await Promise.all([organizationRequest,projectsRequest])");
    expect(html).toContain("organizationRequest.then(function(organization){if(active()&&organization)setOrganizationChrome(organization);");
    expect(html).toContain("if(ui.onCleanup)ui.onCleanup(disconnectObservers)");
    expect(html).toContain("observer.disconnect()");
    expect(html).toContain("version!==loadVersion");
  });

  it("keeps explicit organization scoping on every team mutation", async () => {
    const html = await (await authenticatedPages().request("/organizations/org-a/teams")).text();
    for (const action of ["create-team", "add-team-member", "remove-team"]) {
      const index = html.indexOf(`/api/auth/organization/${action}`);
      expect(index, action).toBeGreaterThan(0);
      expect(html.slice(index, index + 220), action).toContain("organizationId:orgId");
    }
  });
});
