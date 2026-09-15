import { Hono } from "hono";
import type { User } from "better-auth/types";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderProjectNavigation } from "@/routes/control-plane";
import projectPageRoutes from "@/routes/project-pages";
import publicationPageRoutes from "@/routes/publication-pages";
import sharePageRoutes from "@/routes/share-pages";

const user: User = {
  id: "member-user",
  email: "member@acme.test",
  name: "Acme Member",
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
  app.route("/", projectPageRoutes);
  app.route("/", publicationPageRoutes);
  app.route("/", sharePageRoutes);
  return app;
}

type Role = "owner" | "admin" | "member" | "missing";
type Page = "projects" | "publications" | "shares";
type Listener = (event: Record<string, unknown>) => unknown;

class ElementMock {
  id = "";
  name = "";
  type = "";
  value = "";
  textContent = "";
  className = "";
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  children: ElementMock[] = [];
  parentNode: ElementMock | null = null;
  private html = "";

  constructor(public tagName: string, public ownerDocument: DocumentMock) {}

  get innerHTML(): string { return this.html; }
  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
    parseHTML(this, value);
  }
  get open(): boolean { return this.attributes.has("open"); }
  get elements() {
    return { namedItem: (name: string) => this.querySelector(`[name=${name}]`) };
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
    if (name === "name") this.name = value;
    if (name === "type") this.type = value;
    if (name === "class") this.className = value;
    if (name === "value") this.value = value;
    if (name === "disabled") this.disabled = true;
    if (name === "hidden") this.hidden = true;
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
    }
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  append(...nodes: ElementMock[]) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  insertBefore(node: ElementMock, reference: ElementMock | undefined) {
    node.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }
  querySelector(selector: string): ElementMock | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): ElementMock[] {
    const selectors = selector.split(",").map((part) => part.trim()).filter(Boolean);
    const result: ElementMock[] = [];
    const walk = (node: ElementMock) => {
      for (const child of node.children) {
        if (selectors.some((candidate) => matches(child, candidate))) result.push(child);
        walk(child);
      }
    };
    walk(this);
    return result;
  }
  close() { this.attributes.delete("open"); }
}

class DocumentMock extends ElementMock {
  body: ElementMock;

  constructor() {
    super("document", null as unknown as DocumentMock);
    this.ownerDocument = this;
    this.body = new ElementMock("body", this);
    this.append(this.body);
  }
  createElement(tagName: string): ElementMock { return new ElementMock(tagName.toLowerCase(), this); }
  getElementById(id: string): ElementMock | null { return this.querySelector(`#${id}`); }
}

function parseHTML(parent: ElementMock, html: string) {
  const stack: ElementMock[] = [parent];
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    if (token.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (!token.startsWith("<")) {
      const text = token.trim();
      if (text) stack[stack.length - 1].textContent += text;
      continue;
    }
    const match = token.match(/^<\s*([a-zA-Z0-9-]+)([\s\S]*?)\/?\s*>$/);
    if (!match) continue;
    const [, tagName, rawAttributes] = match;
    const node = new ElementMock(tagName.toLowerCase(), parent.ownerDocument);
    const attributes = /([:@a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributes.exec(rawAttributes))) {
      node.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    stack[stack.length - 1].append(node);
    if (!/^(input|br|hr|img|meta|link)$/i.test(tagName) && !/\/\s*>$/.test(token)) stack.push(node);
  }
}

function matches(node: ElementMock, selector: string): boolean {
  const id = selector.match(/#([\w-]+)/)?.[1];
  if (id && node.id !== id) return false;
  for (const className of selector.match(/\.([\w-]+)/g) ?? []) {
    if (!node.className.split(/\s+/).includes(className.slice(1))) return false;
  }
  for (const attribute of selector.matchAll(/\[([\w:-]+)(?:=([^\]]+))?\]/g)) {
    const actual = node.getAttribute(attribute[1]);
    if (actual === null) return false;
    if (attribute[2] !== undefined && actual !== attribute[2].replace(/^['"]|['"]$/g, "")) return false;
  }
  const tag = selector.match(/^[a-zA-Z][\w-]*/)?.[0];
  return !tag || node.tagName === tag.toLowerCase();
}

function routeFor(page: Page): string {
  const base = "/organizations/org-a/projects";
  if (page === "projects") return base;
  return `${base}/project-a/${page}`;
}

function managementMember(role: Role) {
  return role === "missing" ? [] : [{ userId: user.id, role }];
}

async function flushRuntime() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function roleRuntime(page: Page, initialRole: Role) {
  const html = await (await authenticatedPages().request(routeFor(page))).text();
  const scripts = [...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.at(-1) ?? "";
  const state = JSON.parse(html.match(/window\.__RENDRO_PAGE_STATE__=([^;]+);/)?.[1] ?? "{}");
  const document = new DocumentMock();
  parseHTML(document.body, html);
  let role = initialRole;
  const organization = () => ({ name: "Acme", members: managementMember(role) });
  const request = (path: string) => {
    if (path.startsWith("/api/auth/organization/get-full-organization")) return organization();
    if (path.startsWith("/api/rendro/projects/get")) return { project: { _id: "project-a", name: "Docs", slug: "docs", createdAt: Date.now() } };
    if (path.startsWith("/api/rendro/projects")) return { projects: [] };
    if (path.startsWith("/api/rendro/deployments")) return { deployments: [] };
    if (path.startsWith("/api/rendro/publications")) return { publications: [{ _id: "publication-a", slug: "docs", title: "Docs", pathPrefix: "", trackingMode: "track_active" }] };
    if (path.startsWith("/api/rendro/shares")) return { shares: [{ _id: "share-a", documentPath: "index.html", deploymentId: "deployment-a", expiresAt: Date.now() + 86_400_000 }] };
    throw new Error(`Unexpected request: ${path}`);
  };
  const context: Record<string, unknown> = {
    window: { __RENDRO_PAGE_STATE__: state, RendroUI: { request, openDialog() {}, busy() {}, toast() {} } },
    document,
    location: { origin: "https://rendro.test", assign() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    URL,
    URLSearchParams,
    setTimeout: () => 1,
    clearTimeout() {},
    confirm: () => true,
  };
  const execute = async () => {
    vm.runInNewContext(script, context);
    await flushRuntime();
  };
  await execute();
  return {
    document,
    transition: async (nextRole: Role) => {
      role = nextRole;
      await execute();
    },
  };
}

function expectProjectAccess(document: DocumentMock, allowed: boolean) {
  const trigger = document.getElementById("project-create")!;
  expect(trigger.hidden).toBe(!allowed);
  expect(trigger.disabled).toBe(!allowed);
  const form = document.getElementById("project-form")!;
  for (const control of [form.querySelector('[name="name"]')!, form.querySelector('[name="slug"]')!, form.querySelector('button[type="submit"]')!]) {
    expect(control.disabled).toBe(!allowed);
  }
  expect(document.getElementById("project-list")!.querySelector("button") !== null).toBe(allowed);
}

function expectPublicationAccess(document: DocumentMock, allowed: boolean) {
  const trigger = document.getElementById("publication-create")!;
  expect(trigger.hidden).toBe(!allowed);
  expect(trigger.disabled).toBe(!allowed);
  expect(document.getElementById("publication-access-note")!.hidden).toBe(allowed);
  for (const control of document.getElementById("publication-form")!.querySelectorAll("input,select,button[type=submit]")) {
    expect(control.disabled).toBe(!allowed);
  }
  const labels = document.getElementById("publication-list")!.querySelectorAll("button").map((button) => button.textContent);
  expect(labels).toEqual(allowed ? ["Copy URL", "Remove"] : ["Copy URL"]);
}

function expectShareAccess(document: DocumentMock, allowed: boolean) {
  expect(document.getElementById("share-access-note")!.hidden).toBe(allowed);
  const action = document.getElementById("share-list")!.querySelectorAll("td").at(-1)!;
  expect(action.querySelector("button") !== null).toBe(allowed);
  expect(action.querySelector("span")?.textContent ?? "").toBe(allowed ? "" : "Owner/admin only");
}

describe("project role-aware UX", () => {
  it.each(["owner", "admin", "member", "missing"] as const)(
    "executes project access resolution for %s membership",
    async (role) => {
      const runtime = await roleRuntime("projects", role);
      expectProjectAccess(runtime.document, role === "owner" || role === "admin");
    },
  );

  it.each(["owner", "admin", "member", "missing"] as const)(
    "executes publication access resolution for %s membership",
    async (role) => {
      const runtime = await roleRuntime("publications", role);
      expectPublicationAccess(runtime.document, role === "owner" || role === "admin");
    },
  );

  it.each(["owner", "admin", "member", "missing"] as const)(
    "executes private-share access resolution for %s membership",
    async (role) => {
      const runtime = await roleRuntime("shares", role);
      expectShareAccess(runtime.document, role === "owner" || role === "admin");
    },
  );

  it("fails all three management surfaces closed after an admin becomes a member", async () => {
    const projects = await roleRuntime("projects", "admin");
    const publications = await roleRuntime("publications", "admin");
    const shares = await roleRuntime("shares", "admin");

    expectProjectAccess(projects.document, true);
    expectPublicationAccess(publications.document, true);
    expectShareAccess(shares.document, true);

    await projects.transition("member");
    await publications.transition("member");
    await shares.transition("member");

    expectProjectAccess(projects.document, false);
    expectPublicationAccess(publications.document, false);
    expectShareAccess(shares.document, false);
  });

  it("keeps project creation fail-closed until organization role data resolves", async () => {
    const html = await (await authenticatedPages().request("/organizations/org-a/projects")).text();

    expect(html).toContain('id="project-create" type="button" data-dialog-open="project-dialog" disabled hidden');
    expect(html).toContain('name="name" required maxlength="80" placeholder="Product documentation" disabled');
    expect(html).toContain('type="submit" disabled><span class="button-label">Create project');
    expect(html).toContain('"userId":"member-user"');
    expect(html).toContain('if(!canManage){error.textContent="Only organization owners and admins can create projects.";return;}');
  });

  it("derives management access from the signed-in member while retaining read routes", async () => {
    const html = await (await authenticatedPages().request("/organizations/org-a/projects/project-a")).text();

    expect(html).toContain('candidate.userId===state.userId');
    expect(html).toContain('String(member.role||"").split(",").map(function(role){return role.trim();})');
    expect(html).toContain('return role==="owner"||role==="admin";');
    expect(html).toContain('trigger.hidden=!canManage;trigger.disabled=!canManage;');
    expect(html).toContain('control.disabled=!canManage;');

    const projectNavigation = renderProjectNavigation("org-a", "project-a", "overview");
    expect(html).toContain(`"projectNavigation":${JSON.stringify(projectNavigation).replace(/</g, "\\u003c")}`);
    expect(html).toContain("function tabs(){return state.projectNavigation;}");
    expect(html).toContain("Deployment history");
    expect(html).toContain("Open documentation");
    expect(html).toContain("You have read-only project access. Owners and admins manage publications and revoke private shares.");
    expect(html).toContain("canManage?'Manage publications':'View publications'");
  });

  it("reuses the organization lookup that supplies canonical chrome for permission resolution", async () => {
    const html = await (await authenticatedPages().request("/organizations/org-a/projects/project-a")).text();
    const lookups = html.match(/\/api\/auth\/organization\/get-full-organization/g) ?? [];

    // The shared context owns the single full-organization lookup. Its settled
    // authorization response is discarded while display identity may be reused.
    expect(lookups).toHaveLength(1);
    expect(html).toContain('applyOrganization(results[2])');
    expect(html).toContain("if(inFlight.get(key)===entry)inFlight.delete(key)");
    expect(html).not.toContain('.then(setChrome)');
  });

  it("gates publication writes while preserving publication links and copy access", async () => {
    const html = await (await authenticatedPages().request(
      "/organizations/org-a/projects/project-a/publications",
    )).text();

    expect(html).toContain('id="publication-create" type="button" data-dialog-open="publication-dialog" disabled hidden');
    expect(html).toContain('"userId":"member-user"');
    expect(html).toContain('candidate.userId===state.userId');
    expect(html).toContain('trigger.hidden=!canManage;trigger.disabled=!canManage;note.hidden=canManage;');
    expect(html).toContain('form.querySelectorAll("input,select,button[type=submit]")');
    expect(html).toContain('if(!canManage){error.textContent="Only organization owners and admins can create publications.";return;}');
    expect(html).toContain("if(canManage){var remove=");
    expect(html).toContain('var link=h("a","cell-secondary",location.origin+url)');
    expect(html).toContain('copyButton=h("button","button small","Copy URL")');
    expect(html).toContain("You have read-only publication access. Owners and admins create and remove publications.");
    expect(html).toContain("canManage?'<button class=\"button primary\" type=\"button\">Create publication</button>':''");
  });

  it("gates private-share revocation while retaining history and member share creation access", async () => {
    const html = await (await authenticatedPages().request(
      "/organizations/org-a/projects/project-a/shares",
    )).text();

    expect(html).toContain('"userId":"member-user"');
    expect(html).toContain('candidate.userId===state.userId');
    expect(html).toContain('document.getElementById("share-access-note").hidden=canManage;');
    expect(html).toContain('if(canManage){var revoke=');
    expect(html).toContain('else action.append(h("span","cell-secondary","Owner/admin only"))');
    expect(html).toContain("item.documentPath");
    expect(html).toContain("item.deploymentId.slice(0,12)");
    expect(html).toContain("statusFor(item)");
    expect(html).toContain("Browse documentation");
    expect(html).toContain("You can view private-share history and create links from documentation. Only owners and admins can revoke links.");
  });
});
