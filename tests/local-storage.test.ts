import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as LocalStorage from "../src/local-storage";
import { bindStorage, getObjectText, putObject } from "../src/storage";

afterEach(() => { bindStorage(undefined); vi.unstubAllEnvs(); });

describe("local development storage", () => {
  it("binds the Miniflare R2 simulation from wrangler.toml, with no endpoint or key", async () => {
    // tests/setup.ts replaces the module for tests that import the Node server; this case wants the real one.
    const { bindLocalStorage } = await vi.importActual<typeof LocalStorage>("../src/local-storage");
    const state = await mkdtemp(join(tmpdir(), "rendro-local-r2-"));
    vi.stubEnv("RENDRO_LOCAL_STATE_DIR", state);
    const dispose = await bindLocalStorage();
    try {
      await putObject("local/k.html", "<p>local</p>");
      expect(await getObjectText("local/k.html")).toBe("<p>local</p>");
    } finally {
      await dispose();
      await rm(state, { recursive: true, force: true });
    }
  }, 60_000);

  it("persists to wrangler's default state directory when no override is set", async () => {
    vi.stubEnv("RENDRO_LOCAL_STATE_DIR", "");
    const { bindLocalStorage } = await vi.importActual<typeof LocalStorage>("../src/local-storage");
    const dispose = await bindLocalStorage();
    try {
      expect(await getObjectText("local/never-written.html")).toBeNull();
    } finally { await dispose(); }
  }, 60_000);
});
