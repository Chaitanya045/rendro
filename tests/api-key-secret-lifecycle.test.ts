import vm from "node:vm";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { describe, expect, it, vi } from "vitest";
import apiKeyPages from "@/routes/api-key-pages";

async function secretRuntime() {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "qa", name: "QA", email: "qa@example.test" } as User);
    await next();
  });
  app.route("/", apiKeyPages);
  const html = await (await app.request("/organizations/org/api-keys")).text();
  const source = html.slice(html.indexOf("  function showSecret("), html.indexOf("  form.addEventListener(\"submit\""));
  const nodes: Record<string, {
    textContent: string; checked: boolean; disabled: boolean;
    onclick: (() => void) | null; onchange: (() => void) | null;
  }> = {};
  for (const id of ["secret-done", "secret-confirmed", "raw-key", "copy-key", "copy-env"]) {
    nodes[id] = { textContent: "", checked: false, disabled: false, onclick: null, onchange: null };
  }
  const cleanups: (() => void)[] = [];
  const dialog = {
    open: false,
    oncancel: null as ((event: { preventDefault: () => void }) => void) | null,
    onclose: null as (() => void) | null,
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector: (selector: string) => nodes[selector.slice(1)],
  };
  const context = vm.createContext({
    ui: { onCleanup: (fn: () => void) => cleanups.push(fn), toast: vi.fn(), copyText: vi.fn(() => Promise.resolve(true)) },
    document: { getElementById: (id: string) => id === "secret-dialog" ? dialog : nodes[id] },
  });
  vm.runInContext(source, context);
  vm.runInContext('showSecret("synthetic-qa-key")', context);
  return { dialog, nodes, cleanups };
}

describe("one-time API-key lifecycle", () => {
  it("keeps an unconfirmed secret available and refuses the Done action", async () => {
    const { dialog, nodes } = await secretRuntime();
    const preventDefault = vi.fn();
    dialog.oncancel!({ preventDefault });
    nodes["secret-done"].onclick!();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(nodes["raw-key"].textContent).toBe("synthetic-qa-key");
  });

  it("clears secret text and copy closures after confirmed completion", async () => {
    const { dialog, nodes } = await secretRuntime();
    nodes["secret-confirmed"].checked = true;
    nodes["secret-confirmed"].onchange!();
    expect(nodes["secret-done"].disabled).toBe(false);
    nodes["secret-done"].onclick!();
    expect(dialog.open).toBe(false);
    expect(nodes["raw-key"].textContent).toBe("");
    expect(nodes["copy-key"].onclick).toBeNull();
    expect(nodes["copy-env"].onclick).toBeNull();
  });

  it("clears one-time data when the owning page is disposed", async () => {
    const { nodes, cleanups } = await secretRuntime();
    expect(cleanups).toHaveLength(1);
    cleanups[0]();
    expect(nodes["raw-key"].textContent).toBe("");
    expect(nodes["copy-key"].onclick).toBeNull();
    expect(nodes["copy-env"].onclick).toBeNull();
  });
});
