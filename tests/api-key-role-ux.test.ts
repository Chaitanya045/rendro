import vm from "node:vm";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { describe, expect, it, vi } from "vitest";
import apiKeyPages from "@/routes/api-key-pages";

async function runtime(role: string, requestError = false, activePage = true) {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "qa", name: "QA", email: "qa@example.test" } as User);
    await next();
  });
  app.route("/", apiKeyPages);
  const html = await (await app.request("/organizations/org/api-keys")).text();
  const state = JSON.parse(html.match(/window\.__RENDRO_PAGE_STATE__=(.*?);<\/script>/)![1]);
  const script = html.slice(html.indexOf("  function active(){"), html.indexOf("  function statusFor("));
  const create = { disabled: false, hidden: false };
  const recovery = { href: "" };
  const errorCopy = { textContent: "" };
  const retry = { addEventListener: vi.fn() };
  const keyList = { innerHTML: "", querySelector: (selector: string) => selector === "p" ? errorCopy : retry };
  const request = vi.fn((path: string) => {
    if (requestError) return Promise.reject(new Error("Network unavailable"));
    if (path.includes("management/access")) return Promise.resolve({ name: "QA", member: { userId: "qa", role } });
    if (path.includes("credentials")) return Promise.resolve({ credentials: [] });
    return Promise.resolve({ projects: [] });
  });
  const renderKeys = vi.fn();
  const context = vm.createContext({
    state, ui: { request, isActive: () => activePage }, keyList, loadVersion: 0, loading: "loading", projects: new Map(),
    projectSelect: { innerHTML: "", value: "" }, renderKeys,
    document: {
      getElementById: (id: string) => id === "api-key-create" ? create : recovery,
      querySelectorAll: () => [],
    },
  });
  vm.runInContext(script, context);
  await vm.runInContext("load()", context);
  return { create, recovery, keyList, request, renderKeys, retry, errorCopy, state };
}

describe("API key role-aware UI", () => {
  it.each([false, true])("does not paint a disposed page after request failure=%s", async (requestError) => {
    const ui = await runtime("owner", requestError, false);
    expect(ui.keyList.innerHTML).toBe("loading");
    expect(ui.renderKeys).not.toHaveBeenCalled();
    expect(ui.errorCopy.textContent).toBe("");
    expect(ui.request).toHaveBeenCalledTimes(1);
  });
  it("uses the server identity and shows members a clear restriction without forbidden requests", async () => {
    const ui = await runtime("member");
    expect(ui.state.userId).toBe("qa");
    expect(ui.create).toEqual({ disabled: true, hidden: true });
    expect(ui.keyList.innerHTML).toContain("API key access is restricted");
    expect(ui.keyList.innerHTML).not.toContain("Try again");
    expect(ui.recovery.href).toBe("/organizations/org/projects");
    expect(ui.request).toHaveBeenCalledTimes(1);
    expect(ui.renderKeys).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "member, admin"])("allows %s to load keys and create credentials", async (role) => {
    const ui = await runtime(role);
    expect(ui.create).toEqual({ disabled: false, hidden: false });
    expect(ui.request).toHaveBeenCalledTimes(3);
    expect(ui.renderKeys).toHaveBeenCalledWith([]);
  });

  it("keeps creation disabled and provides retry for a genuine network error", async () => {
    const ui = await runtime("owner", true);
    expect(ui.create.disabled).toBe(true);
    expect(ui.keyList.innerHTML).toContain("Try again");
    expect(ui.errorCopy.textContent).toBe("Network unavailable");
    expect(ui.retry.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
    expect(ui.renderKeys).not.toHaveBeenCalled();
  });
});
