import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetFixture, fixtureCookie } from "./fixtures/viewer-assets";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Some bytes arrive, then storage fails: the reader must see the failure, never a clean end of a shorter file. */
function interrupted(first: string) {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(first)); return; }
      controller.error(new Error("storage stream interrupted"));
    },
  });
}

describe.each(["public", "share", "private ticket", "private cookie"])("%s delivery when storage fails mid-stream", name => {
  it.each([
    ["guide/index.html", "<!doctype html><html><head><title>Partial</title></head><body>"],
    ["guide/assets/site.css", "body { color: red }"],
    ["guide/assets/image.svg", "<svg xmlns='http://www.w3.org/2000/svg'>"],
    ["guide/assets/module.js", "document.body.dataset.module = "],
  ])("never completes %s successfully", async (file, first) => {
    const { app, objects, viewers } = await createAssetFixture();
    const viewer = viewers.find(viewer => viewer.name === name)!;
    // Every viewer prefix already names the guide directory (or the publication root, which is that directory).
    const path = file.replace("guide/", "");
    objects.mockImplementation(() => Promise.resolve(interrupted(first)));
    const response = await app.request(viewer.prefix + path, { headers: viewer.cookie ? { Cookie: fixtureCookie } : {} });
    if (name === "public" && path.endsWith(".html")) {
      // A publication buffers its HTML to place the integration, so the failure is still ahead of the status line.
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.text()).not.toContain("Partial");
      return;
    }
    // Everything else streams: the status is sent, so the body is what must not look complete.
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow("storage stream interrupted");
  });
});
