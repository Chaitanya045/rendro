import { afterEach, expect, it, vi } from "vitest";

const installed = vi.hoisted(() => ({ parent: vi.fn(), frame: vi.fn(), navigation: vi.fn() }));
vi.mock("@/viewer/client", () => ({ installViewerParent: installed.parent, installViewerFrame: installed.frame }));
vi.mock("@/viewer/navigation", () => ({ installDocumentNavigation: installed.navigation }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

/** The private viewer bundle (#234): each script tag says which part to run, with its JSON config. */
async function load(script: { dataset: Record<string, string> } | null) {
  vi.stubGlobal("document", { currentScript: script });
  await import("@/viewer/entry");
}

it("installs the part its script names, with its config", async () => {
  for (const viewer of ["parent", "navigation", "frame"] as const) {
    await load({ dataset: { viewer, config: JSON.stringify({ base: "/r/a/b", prefix: "/r/a/b/files/" }) } });
    vi.resetModules();
  }
  expect(installed.parent).toHaveBeenCalledWith({ base: "/r/a/b", prefix: "/r/a/b/files/" });
  expect(installed.navigation).toHaveBeenCalledOnce();
  expect(installed.frame).toHaveBeenCalledOnce();
});

it("does nothing for a script without a config, or when there is no current script", async () => {
  await load({ dataset: { viewer: "frame" } });
  vi.resetModules();
  await load(null);
  expect(installed.parent).not.toHaveBeenCalled();
  expect(installed.navigation).not.toHaveBeenCalled();
  expect(installed.frame).not.toHaveBeenCalled();
});
