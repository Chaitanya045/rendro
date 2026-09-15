import { describe, expect, it } from "vitest";
import vm from "node:vm";
import type { User } from "better-auth/types";
import { Hono } from "hono";
import organizationPageRoutes from "@/routes/organization-pages";

type EventData = Record<string, unknown>;
type Listener = (event: EventData) => unknown;
type FetchOptions = { body?: string; method?: string; headers?: Record<string, string> };
type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

class ElementMock {
  [key: string]: unknown;
  id = "";
  name = "";
  type = "";
  private _value = "";
  textContent = "";
  className = "";
  disabled = false;
  hidden = false;
  required = false;
  checked = false;
  tabIndex = 0;
  nodeType = 1;
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, Listener[]>();
  children: ElementMock[] = [];
  parentNode: ElementMock | null = null;
  private _innerHTML = "";

  constructor(public tagName: string, public ownerDocument: DocumentMock) {}

  get firstChild() { return this.children[0] ?? null; }
  get options() { return this.children.filter((child) => child.tagName === "option"); }
  get value() {
    if (this.tagName === "select") return this.valueOfSelectedOption;
    return this._value;
  }
  set value(next: string) {
    this._value = next;
    if (this.tagName === "select") {
      for (const option of this.options) option.selected = option.value === next;
    }
  }
  get classList() {
    return {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name: string, force?: boolean) => {
        const shouldHave = force ?? !this.className.split(/\s+/).includes(name);
        if (shouldHave) this.classList.add(name); else this.classList.remove(name);
        return shouldHave;
      },
    };
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value: string) {
    this._innerHTML = value;
    this.children = [];
    parseHTML(this, value);
    bindFormFields(this);
  }

  get valueOfSelectedOption() {
    return this.options.find((option) => option.selected)?.value ?? this.options[0]?.value ?? "";
  }

  get selected() { return this.attributes.has("selected"); }
  set selected(value: boolean) {
    if (value) this.attributes.set("selected", "");
    else this.attributes.delete("selected");
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  async dispatch(type: string, event: EventData = {}) {
    for (const listener of this.listeners.get(type) ?? []) await listener({ target: this, ...event });
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
    if (name === "class") this.className = value;
    if (name === "name") this.name = value;
    if (name === "type") this.type = value;
    if (name === "value") this.value = value;
    if (name === "disabled") this.disabled = true;
    if (name === "hidden") this.hidden = true;
    if (name === "required") this.required = true;
    if (name === "checked") this.checked = true;
    if (name === "data-org-name") this.dataset.orgName = value;
    if (name === "data-org-mark") this.dataset.orgMark = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase())] = value;
  }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "disabled") this.disabled = false;
    if (name === "hidden") this.hidden = false;
  }
  append(...nodes: ElementMock[]) {
    for (const node of nodes) {
      if (!node) continue;
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(node: ElementMock) { this.append(node); return node; }
  remove() { this.parentNode?.removeChild(this); }
  removeChild(node: ElementMock) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
  }
  contains(node: ElementMock | null): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  closest(selector: string): ElementMock | null {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let current: ElementMock | null = this;
    while (current) {
      if (matches(current, selector)) return current;
      current = current.parentNode;
    }
    return null;
  }
  querySelector(selector: string): ElementMock | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): ElementMock[] {
    const selectors = selector.split(",").map((part) => part.trim()).filter(Boolean);
    const result: ElementMock[] = [];
    const walk = (node: ElementMock) => {
      for (const child of node.children) {
        if (selectors.some((candidate) => matchesSelectorPath(child, candidate))) result.push(child);
        walk(child);
      }
    };
    walk(this);
    return result;
  }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.attributes.set("open", ""); }
  close() { this.attributes.delete("open"); }
  get open() { return this.attributes.has("open"); }
  get elements() {
    return {
      namedItem: (field: string) => this.querySelector(`[name=${field}]`),
    };
  }
}

class DocumentMock extends ElementMock {
  activeElement: ElementMock | null = null;
  documentElement: ElementMock;
  body: ElementMock;

  constructor() {
    super("document", null!);
    this.ownerDocument = this;
    this.documentElement = new ElementMock("html", this);
    this.body = new ElementMock("body", this);
    this.documentElement.append(this.body);
    this.append(this.documentElement);
  }
  createElement(tagName: string) { return new ElementMock(tagName, this); }
  getElementById(id: string) { return this.querySelector(`#${id}`); }
}

function parseHTML(parent: ElementMock, html: string) {
  const stack: ElementMock[] = [parent];
  const tokens = html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? [];
  for (const token of tokens) {
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
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      node.setAttribute(attribute[1], value);
    }
    stack[stack.length - 1].append(node);
    if (!/^(input|br|hr|img|meta|link|source|area|base|embed|param|track|wbr)$/i.test(tagName) && !/\/\s*>$/.test(token)) stack.push(node);
  }
}

function bindFormFields(scope: ElementMock) {
  for (const form of scope.querySelectorAll("form")) {
    for (const input of form.querySelectorAll("[name]")) form[input.name] = input;
  }
}

function matchesSelectorPath(node: ElementMock, selector: string): boolean {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (!matches(node, parts[parts.length - 1])) return false;
  let current = node.parentNode;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (current && !matches(current, parts[index])) current = current.parentNode;
    if (!current) return false;
    current = current.parentNode;
  }
  return true;
}

function matches(node: ElementMock, selector: string): boolean {
  if (selector === ":invalid") return false;
  const checked = selector.includes(":checked");
  if (checked && !node.checked) return false;
  selector = selector.replace(":checked", "").replace(/:not\([^)]*\)/g, "");
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

function jsonResponse(data: unknown, ok = true): MockResponse {
  return { ok, status: ok ? 200 : 500, json: () => Promise.resolve(data) };
}

const owner: User = {
  id: "user-owner",
  email: "owner@example.test",
  name: "Owner",
  emailVerified: true,
  image: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const organization = {
  id: "org-a",
  name: "Acme",
  slug: "acme",
  members: [
    { id: "member-owner", userId: owner.id, role: "owner", user: { name: owner.name, email: owner.email }, createdAt: Date.now() },
    { id: "member-editor", userId: "user-editor", role: "member", user: { name: "Editor", email: "editor@example.test" }, createdAt: Date.now() },
  ],
  teams: [{ id: "team-a", name: "Docs", memberIds: [] }],
};

async function runtime(
  section: "people" | "teams" | "settings",
  fetchImpl: (path: string, options?: FetchOptions) => MockResponse | Promise<MockResponse>,
) {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => { c.set("user", owner); await next(); });
  app.route("/", organizationPageRoutes);
  const response = await app.request(`/organizations/org-a/${section}`);
  const html = await response.text();
  const document = new DocumentMock();
  parseHTML(document.body, html);
  bindFormFields(document.body);
  const scripts = [...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const state = JSON.parse(html.match(/window\.__RENDRO_PAGE_STATE__=([^;]+);/)?.[1] ?? "{}");
  const location = { pathname: `/organizations/org-a/${section}`, reload: () => { locationReloads += 1; }, assign() {}, replace() {} };
  let locationReloads = 0;
  const matchMedia = () => ({ matches: false, addEventListener() {} });
  const addEventListener = () => {};
  const browserWindow = {
    __RENDRO_PAGE_STATE__: state,
    RendroTheme: { mount: () => ({ apply() {} }) },
    location,
    matchMedia,
    addEventListener,
  };
  const context = {
    window: browserWindow,
    document,
    fetch: fetchImpl,
    console,
    Error,
    URL,
    URLSearchParams,
    location,
    matchMedia,
    addEventListener,
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout: () => 1,
    clearTimeout() {},
    confirm: () => true,
    Event: class { constructor(public type: string, public init: EventData = {}) {} },
    MutationObserver: class { observe() {} },
  };
  vm.runInNewContext(scripts.find((script) => script.includes("window.RendroUI={busy")) ?? "", context);
  vm.runInNewContext(scripts.at(-1) ?? "", context);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve(); await Promise.resolve();
  return { document, location, get locationReloads() { return locationReloads; } };
}

function apiData(path: string, data: unknown) {
  if (path === "/api/auth/organization/set-active") return jsonResponse({ ok: true });
  if (path.startsWith("/api/auth/organization/get-full-organization")) return jsonResponse(organization);
  return jsonResponse(data);
}

describe("organization management form regressions", () => {
  it("keeps only failed rows after a partially failed batch invitation", async () => {
    const calls: { path: string; body: { email?: string } | undefined }[] = [];
    const ui = await runtime("people", (path, options) => {
      const body = (options?.body ? JSON.parse(options.body) : undefined) as { email?: string } | undefined;
      calls.push({ path, body });
      if (path === "/api/auth/organization/list-invitations?organizationId=org-a") return jsonResponse([]);
      if (path === "/api/auth/organization/invite-member") {
        return body?.email === "failed@example.test"
          ? jsonResponse({ message: "Mailbox rejected" }, false)
          : jsonResponse({ id: "inv-a" });
      }
      return apiData(path, {});
    });
    const add = ui.document.getElementById("add-invite-row")!;
    await add.dispatch("click");
    const rows = ui.document.getElementById("invite-rows")!;
    const entries = rows.querySelectorAll(".invite-entry");
    expect(entries).toHaveLength(2);
    entries[0].querySelector("[name=email]")!.value = "sent@example.test";
    entries[1].querySelector("[name=email]")!.value = "failed@example.test";
    await ui.document.getElementById("invite-form")!.dispatch("submit", { preventDefault() {} });

    expect(calls.filter((call) => call.path === "/api/auth/organization/invite-member").map((call) => call.body?.email))
      .toEqual(["sent@example.test", "failed@example.test"]);
    expect(rows.querySelectorAll(".invite-entry")).toHaveLength(1);
    expect(rows.querySelector("[name=email]")!.value).toBe("failed@example.test");
    expect(rows.querySelector("[name=email]")!.getAttribute("aria-invalid")).toBe("true");
    expect(ui.document.getElementById("invite-error")!.textContent).toContain("Mailbox rejected");
    expect(ui.document.querySelector("#invite-form button[type=submit]")!.disabled).toBe(false);
  });

  it("reverts a member role select when the role mutation fails", async () => {
    const ui = await runtime("people", (path) => {
      if (path === "/api/auth/organization/list-invitations?organizationId=org-a") return jsonResponse([]);
      if (path === "/api/auth/organization/update-member-role") return jsonResponse({ message: "Role update denied" }, false);
      return apiData(path, {});
    });
    const select = ui.document.querySelectorAll("select").find((candidate) =>
      candidate.getAttribute("aria-label") === "Change role for owner@example.test")!;
    expect(select.valueOfSelectedOption).toBe("owner");
    select.value = "admin";
    await select.dispatch("change");
    expect(select.valueOfSelectedOption).toBe("owner");
    expect(select.disabled).toBe(false);
    expect(ui.locationReloads).toBe(0);
  });

  it("preserves edited settings fields and restores save controls after a failed save", async () => {
    const ui = await runtime("settings", (path) => {
      if (path === "/api/auth/organization/update") return jsonResponse({ message: "Slug already taken" }, false);
      return apiData(path, {});
    });
    const form = ui.document.getElementById("settings-form")!;
    const name = form.querySelector('[name="name"]')!;
    const slug = form.querySelector('[name="slug"]')!;
    name.value = "Renamed Acme";
    slug.value = "renamed-acme";
    const save = form.querySelector("button[type=submit]")!;
    await form.dispatch("submit", { preventDefault() {} });
    expect(name.value).toBe("Renamed Acme");
    expect(slug.value).toBe("renamed-acme");
    expect(ui.document.getElementById("settings-error")!.textContent).toBe("Slug already taken");
    expect(save.disabled).toBe(false);
  });

  it("restores team assignment controls after a failed member mutation", async () => {
    const ui = await runtime("teams", (path) => {
      if (path === "/api/auth/organization/add-team-member") return jsonResponse({ message: "Team service unavailable" }, false);
      return apiData(path, {});
    });
    const card = ui.document.querySelector(".team-card")!;
    const select = card.querySelector("select")!;
    const add = card.querySelector(".team-assign .button")!;
    select.value = "user-editor";
    await add.dispatch("click");
    expect(select.valueOfSelectedOption).toBe("user-editor");
    expect(add.disabled).toBe(false);
    expect(add.getAttribute("aria-busy")).toBe("false");
  });
});
