import vm from "node:vm";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { describe, expect, it, vi } from "vitest";
import projectPages from "@/routes/project-pages";

async function renderedPage() {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "qa", name: "QA", email: "qa@example.test" } as User);
    await next();
  });
  app.route("/", projectPages);
  return (await app.request("/organizations/org/projects/project")).text();
}

async function navigationRuntime() {
  const html = await renderedPage();
  const script = html.slice(html.indexOf('var sectionTarget=null'), html.indexOf('var createProjectNavigation='));
  expect(script).not.toBe("");
  const base = "https://rendro.test/organizations/org/projects/project";
  const location = { href: `${base}#deployments`, pathname: new URL(base).pathname, hash: "#deployments" };
  const links = [base, `${base}#deployments`].map((href) => ({
    href, classList: { toggle: vi.fn() }, setAttribute: vi.fn(), removeAttribute: vi.fn(),
  }));
  const select = { options: links.map((link) => ({ value: link.href })), value: base };
  const target = { scrollIntoView: vi.fn() };
  let mounted = false;
  const document = {
    querySelectorAll: (selector: string) => selector === ".project-section-picker select" ? [select] : [{ querySelectorAll: () => links }],
    getElementById: (id: string) => mounted && id === "deployments" ? target : null,
  };
  const context = vm.createContext({ document, location, URL });
  vm.runInContext(script, context);
  return { select, links, target, location, mount: () => { mounted = true; }, sync: () => { vm.runInContext("syncProjectSectionPickers()", context); } };
}

describe("project section navigation", () => {
  it("aligns the mobile picker and desktop active tab with a deep link", async () => {
    const ui = await navigationRuntime();
    ui.sync();
    expect(ui.select.value).toContain("#deployments");
    expect(ui.links[0].removeAttribute).toHaveBeenCalledWith("aria-current");
    expect(ui.links[1].setAttribute).toHaveBeenCalledWith("aria-current", "page");
  });

  it("scrolls to an asynchronously mounted section once, without later mutation scroll jumps", async () => {
    const ui = await navigationRuntime();
    ui.sync();
    expect(ui.target.scrollIntoView).not.toHaveBeenCalled();
    ui.mount();
    ui.sync();
    ui.sync();
    expect(ui.target.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(ui.target.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
    ui.location.hash = "";
    ui.sync();
    ui.location.hash = "#deployments";
    ui.sync();
    expect(ui.target.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed and unknown fragments without throwing or scrolling", async () => {
    const ui = await navigationRuntime();
    ui.mount();
    ui.location.hash = "#%E0%A4%A";
    expect(ui.sync).not.toThrow();
    ui.location.hash = "#unknown";
    ui.sync();
    expect(ui.target.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("mobile navigation access", () => {
  it("contains background focus while open, restores the trigger on close, and releases desktop content", async () => {
    const html = await renderedPage();
    const script = html.slice(html.indexOf("function syncNavAccess("), html.indexOf('if(menuButton)menuButton.addEventListener'));
    const attributes = new Map<string, string>();
    const close = { focus: vi.fn() };
    const nav = {
      inert: false, querySelector: () => close,
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      removeAttribute: (key: string) => attributes.delete(key),
    };
    const regions = [{ inert: false }, { inert: false }];
    const menuButton = { setAttribute: vi.fn(), focus: vi.fn() };
    let mobile = true;
    const context = vm.createContext({ nav, menuButton, document: {
      querySelectorAll: () => regions, body: { classList: { toggle: vi.fn() } },
    }, matchMedia: () => ({ matches: mobile }) });
    vm.runInContext(script, context);
    vm.runInContext("setNav(true,false)", context);
    expect(regions.every((region) => region.inert)).toBe(true);
    expect(attributes.get("aria-modal")).toBe("true");
    expect(nav.inert).toBe(false);
    expect(close.focus).toHaveBeenCalledOnce();
    vm.runInContext("setNav(false,true)", context);
    expect(regions.some((region) => region.inert)).toBe(false);
    expect(nav.inert).toBe(true);
    expect(menuButton.focus).toHaveBeenCalledOnce();
    mobile = false;
    vm.runInContext("syncNavAccess(true)", context);
    expect(regions.some((region) => region.inert)).toBe(false);
    expect(nav.inert).toBe(false);
    expect(attributes.has("aria-modal")).toBe(false);
    expect(attributes.has("aria-hidden")).toBe(false);
    expect(html).toContain('id="cp-nav-close"');
    expect(html).toContain('aria-controls="cp-navigation"');
  });
});
