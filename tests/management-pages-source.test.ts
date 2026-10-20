import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApiKeyPages from "../src/routes/api-key-pages";
import { managementPagesSource } from "../scripts/management-pages-source";
import { MANAGEMENT_SHELL_VERSION } from "../src/routes/management-navigation";

const state = vi.hoisted(() => ({ incomplete: false }));
vi.mock("../src/routes/api-key-pages", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiKeyPages>();
  return { ...actual, renderApiKeyPage: (...args: Parameters<typeof actual.renderApiKeyPage>) =>
    state.incomplete ? "<html><head><title>API keys</title></head><main>No controller</main></html>" : actual.renderApiKeyPage(...args) };
});

beforeEach(() => { state.incomplete = false; });

describe("management pages bundle source", () => {
  it("registers every section's title, state, dialogs and mount function under the shell version", () => {
    const source = managementPagesSource();
    expect(source.startsWith(`window.RendroManagementPages={version:${JSON.stringify(MANAGEMENT_SHELL_VERSION)},pages:{`)).toBe(true);
    for (const section of ["overview", "projects", "people", "teams", "settings", "api-keys", "project"]) {
      expect(source).toContain(`${JSON.stringify(section)}:{title:`);
    }
    expect(source.match(/,mount:function\(\)\{/g)).toHaveLength(7);
    // Built from placeholders only: no session, user or backend data can reach the bundle.
    expect(source).toContain("__RD_ORG__");
    expect(source).not.toContain("build@example.invalid\"");
    const sandbox = { window: {} as { RendroManagementPages?: { version: string; pages: Record<string, { mount: unknown }> } } };
    runInNewContext(source, sandbox);
    expect(sandbox.window.RendroManagementPages?.version).toBe(MANAGEMENT_SHELL_VERSION);
    expect(Object.keys(sandbox.window.RendroManagementPages!.pages)).toHaveLength(7);
    expect(typeof sandbox.window.RendroManagementPages!.pages["api-keys"].mount).toBe("function");
  });

  it("refuses to build when a template lacks its controller script, state or content", () => {
    state.incomplete = true;
    expect(() => managementPagesSource()).toThrow("Incomplete management template: api-keys");
  });
});
