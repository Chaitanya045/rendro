import { Hono } from "hono";
import vm from "node:vm";
import type { User } from "better-auth/types";
import { describe, expect, it } from "vitest";
import apiKeyPageRoutes from "@/routes/api-key-pages";
import { renderProjectNavigation } from "@/routes/control-plane";
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

function managementPages(): Hono<{ Variables: { user?: User } }> {
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

describe("management control consistency", () => {
  it("ships one complete state contract for shared controls", async () => {
    const app = managementPages();
    for (const route of [
      "/organizations/org-a/people",
      "/organizations/org-a/projects/project-a",
      "/organizations/org-a/api-keys",
      "/organizations/org-a/projects/project-a/publications",
      "/organizations/org-a/projects/project-a/shares",
    ]) {
      const html = await (await app.request(route)).text();
      expect(html, route).toContain(".button:hover:not(:disabled):not([aria-disabled=true])");
      expect(html, route).toContain(".input:disabled,.select:disabled,.textarea:disabled");
      expect(html, route).toContain(".input[aria-invalid=true],.select[aria-invalid=true],.textarea[aria-invalid=true]");
      expect(html, route).toContain(":focus-visible:where(:not(.rendro-theme-control,.input,.select,.textarea,.cp-avatar,.cp-account-menu a))");
      expect(html, route).toContain(".check input:focus-visible{outline:2px solid var(--cp-accent)");
      expect(html, route).toContain(".project-tabs a:active{transform:scale(.98)}");
      expect(html, route).toContain('.project-tabs a.active::after{content:"";position:absolute;inset:auto 8px 0;height:2px');
      expect(html, route).toContain(".project-tabs a:active,.dialog-close:active");
    }
  });

  it("preserves the error ring when an invalid field receives focus", async () => {
    const html = await (await managementPages().request("/organizations/org-a/people")).text();
    const genericFocus = html.indexOf(":focus-visible:where(:not(.rendro-theme-control,.input,.select,.textarea,.cp-avatar,.cp-account-menu a))");
    const fieldFocus = html.indexOf(".input:focus,.select:focus,.textarea:focus");
    const invalid = html.indexOf(".input[aria-invalid=true],.select[aria-invalid=true],.textarea[aria-invalid=true]");
    expect(genericFocus).toBeGreaterThan(0);
    expect(fieldFocus).toBeGreaterThan(genericFocus);
    expect(invalid).toBeGreaterThan(fieldFocus);
  });

  it("keeps account trigger and menu rows aligned with the shared header contract", async () => {
    const html = await (await managementPages().request("/organizations/org-a")).text();
    expect(html).toContain('aria-controls="cp-account-menu"');
    expect(html).toContain('class="cp-account-menu" id="cp-account-menu"');
    expect(html).toContain(".cp-avatar:focus-visible,.cp-account-menu a:focus-visible{outline:2px solid var(--cp-accent);outline-offset:2px");
    expect(html).toContain(".cp-account-menu a:active{background:var(--cp-container);transform:scale(.98)}");
    expect(html).toContain(".cp-account-menu a{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:4px;color:var(--cp-strong)");
    expect(html).toContain("html.dark .cp-avatar{border-color:rgba(251,146,60,.35)}");
    expect(html).toContain(".cp-nav-link,.cp-account-menu a{min-height:44px}");
  });

  it("renders every project section from one canonical navigation helper", () => {
    const base = "/organizations/org-a/projects/project-a";
    const publication = renderProjectNavigation("org-a", "project-a", "publications");
    expect(publication).toContain(`<a href="${base}">Overview</a>`);
    expect(publication).toContain(`<a href="${base}#deployments">Deployments</a>`);
    expect(publication).toContain(`<a class="active" aria-current="page" href="${base}/publications">Publications</a>`);
    expect(publication).toContain(`<a href="${base}/shares">Private shares</a>`);
    expect((publication.match(/aria-current="page"/g) ?? [])).toHaveLength(1);
  });

  it("does not duplicate project-tab and access-note component CSS in subpages", async () => {
    const app = managementPages();
    for (const route of [
      "/organizations/org-a/projects/project-a",
      "/organizations/org-a/projects/project-a/publications",
      "/organizations/org-a/projects/project-a/shares",
    ]) {
      const html = await (await app.request(route)).text();
      expect(html.match(/\.project-tabs\{display:flex/g), route).toHaveLength(1);
      expect(html.match(/\.access-note\{margin:0 0 16px/g), route).toHaveLength(1);
    }
  });

  it("disables invitation and team actions while they cannot do work", async () => {
    const app = managementPages();
    const people = await (await app.request("/organizations/org-a/people")).text();
    expect(people).toContain('entry.querySelector(".remove-invite").disabled=entries.length<=1');
    expect(people).toContain("if(add)add.disabled=entries.length>=10");
    expect(people).toContain("syncInviteRowControls(rows)");

    const teams = await (await app.request("/organizations/org-a/teams")).text();
    expect(teams).toContain('<button class="button" type="button" disabled>Add member</button>');
    expect(teams).toContain('select.addEventListener("change",function(){add.disabled=!select.value;})');
    expect(teams).toContain("add.disabled=!select.value");
  });

  it("uses one pending and confirmation path for management copy buttons", async () => {
    const app = managementPages();
    const project = await (await app.request("/organizations/org-a/projects/project-a")).text();
    const publications = await (await app.request("/organizations/org-a/projects/project-a/publications")).text();
    const keys = await (await app.request("/organizations/org-a/api-keys")).text();
    for (const html of [project, publications, keys]) {
      expect(html).toContain("async function copyText(button,value,idleLabel)");
      expect(html).toContain("busy(button,true)");
      expect(html).toContain('button.textContent="Copied"');
    }
    expect(project).toContain('ui.copyText(this,command,"Copy")');
    expect(publications).toContain('ui.copyText(copyButton,location.origin+url,"Copy URL")');
    expect(keys).toContain("ui.copyText(button,value,label)");
  });

  it("keeps shared copy state coherent across success, repeats, and rejection", async () => {
    const html = await (await managementPages().request("/organizations/org-a/projects/project-a")).text();
    const helper = html.match(/function busy\(button,on\)\{[^\n]+\}\n {2}var copyTimers[^\n]+\n {2}async function copyText[^\n]+/)?.[0];
    expect(helper).toBeTruthy();

    type Deferred = { resolve: () => void; reject: (error: Error) => void };
    const writes: Deferred[] = [];
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const button = {
      disabled: false,
      textContent: "Copy",
      attributes: new Map<string, string>(),
      setAttribute(name: string, value: string) { this.attributes.set(name, value); },
    };
    const context = {
      navigator: {
        clipboard: {
          writeText: () => new Promise<void>((resolve, reject) => writes.push({ resolve, reject })),
        },
      },
      setTimeout: (callback: () => void) => {
        const id = ++timerId;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id: number) => { timers.delete(id); },
      api: undefined as unknown,
    };
    vm.runInNewContext(`${helper};api={copyText};`, context);
    const copyText = (context.api as { copyText: (target: typeof button, value: string, label: string) => Promise<boolean> }).copyText;

    const first = copyText(button, "first", "Copy");
    const duplicate = copyText(button, "duplicate", "Copy");
    expect(writes).toHaveLength(1);
    expect(await duplicate).toBe(false);
    writes[0].resolve();
    await first;
    expect(button.textContent).toBe("Copied");
    expect(timers).toHaveLength(1);

    const repeat = copyText(button, "repeat", "Copy");
    expect(writes).toHaveLength(2);
    expect(timers).toHaveLength(0);
    writes[1].reject(new Error("denied"));
    await expect(repeat).rejects.toThrow("denied");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Copy");
    expect(button.attributes.get("aria-busy")).toBe("false");
    expect(timers).toHaveLength(0);
  });
});
