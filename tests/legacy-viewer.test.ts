import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import * as minio from "@/minio";
import * as deletion from "@/soft-delete";
import { createLegacyViewerTicket, createViewerTicket, readLegacyViewerTicket, readViewerTicket } from "@/viewer-ticket";
import { mockSecurityBackend } from "./fixtures/security-headers";
const cookie = "better-auth.session_token=test-session";
const base = "/legacy-view/example";
const request = (path: string, signedIn = false) => worker.fetch(new Request(`https://rendro.test${path}`, { headers: signedIn ? { cookie } : {} }), {});
beforeEach(() => { mockSecurityBackend(); vi.spyOn(deletion, "isDeleted").mockResolvedValue(false); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("legacy viewer routes", () => {
  it("keeps old bookmarks and docs URLs, with a sandboxed shell and parent comments", async () => {
    const response = await request("/files/example/guide/hello%20world.html?mode=print", true);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/docs/example/guide/hello%20world.html?docQuery=%3Fmode%3Dprint");
    const shell = await request(response.headers.get("Location")!, true);
    const html = await shell.text();
    expect(shell.status).toBe(200);
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-downloads"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("RENDRO_LEGACY_COMMENT_CONFIG");
    expect(html).toContain("/commentor-parent.js");
    expect(html).toContain("/api/share/create?key=");
  });
  it("isolates documents even when opened directly and grants only ticket asset reads", async () => {
    const response = await request(`${base}/files/index.html`, true);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts allow-forms allow-popups allow-downloads");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const html = await response.text();
    expect(html).toContain('"transport":"parent"');
    expect(html).not.toContain('"convexUrl"');
    const prefix = html.match(/<base data-rendro-viewer href="([^"]+)index.html"/)![1];
    expect(html.indexOf("<base")).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
    const asset = await request(`${prefix}assets/site.css`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toBe("text/css");
    expect(asset.headers.get("Access-Control-Allow-Origin")).toBe("null");
    expect(asset.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(asset.headers.get("Cache-Control")).toBe("private, no-store");
    expect(asset.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect((await request(`${base}/files/assets/site.css`)).status).toBe(404);
    expect((await request(`${base}/viewer-ticket?manifestKey=example`)).status).toBe(401);
    const renewed = await request(`${base}/viewer-ticket?manifestKey=example`, true);
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toEqual({ prefix: expect.stringMatching(/^\/legacy-view\/example\/view\/[^/]+\/files\/$/) });
  });
  it("revalidates ticket sessions and deletion state before storage reads", async () => {
    const token = await createLegacyViewerTicket("example", cookie);
    const url = `${base}/view/${token}/files/index.html`;
    vi.mocked(minio.getObjectStream).mockClear();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => (input instanceof Request ? input.url : input.toString()).includes("management/access")
      ? Promise.resolve(new Response(null, { status: 403 })) : original(input, init));
    expect((await request(url)).status).toBe(404);
    expect(minio.getObjectStream).not.toHaveBeenCalled();
    vi.mocked(fetch).mockImplementation(original);
    vi.mocked(deletion.isDeleted).mockResolvedValue(true);
    expect((await request(url)).status).toBe(404);
    expect(minio.getObjectStream).not.toHaveBeenCalled();
  });
  it.each(["image.png", "font.woff2", "style.css", "script.js"])("uses empty uncached errors for legacy %s requests", async path => {
    const token = await createLegacyViewerTicket("example", cookie);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ status: "success", value: null }))));
    for (const prefix of [`${base}/files/`, `${base}/view/${token}/files/`]) {
      const response = await request(prefix + path);
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBeNull();
      expect(await response.text()).toBe("");
    }
  });
  it("rejects expired, tampered, cross-org and cross-model tickets", async () => {
    const token = await createLegacyViewerTicket("example", cookie);
    expect(await readLegacyViewerTicket(token, "other")).toBeNull();
    expect(await readLegacyViewerTicket(token.slice(0, -8) + "AAAAAAAA", "example")).toBeNull();
    const scope = { organizationId: "example", projectId: "example", manifestKey: "tenants/example/projects/example/deployments/deploy-a/manifest.json" };
    expect(await readViewerTicket(token, scope)).toBeNull();
    expect(await readLegacyViewerTicket(await createViewerTicket({ ...scope, cookie }), "example")).toBeNull();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(await readLegacyViewerTicket(token, "example")).toBeNull();
  });
  it.each(["/files/other/index.html", "/files/example/%2Fother.html", "/files/example/%ZZ", `${base}/files/%5Cother`, `${base}/files/%2e%2e%2Fother`])("rejects invalid/out-of-scope paths: %s", async path => {
    expect((await request(path, true)).status).toBeGreaterThanOrEqual(400);
  });
  it("preserves publisher-relative bases through the ticket", async () => {
    vi.mocked(minio.getObjectStream).mockResolvedValue(new Response('<html><head><base href="../assets/"><script src="app.js"></script></head></html>').body);
    const html = await (await request(`${base}/files/guide/index.html`, true)).text();
    expect(html).toMatch(/<base data-rendro-viewer href="\/legacy-view\/example\/view\/[^/]+\/files\/assets\/">/);
  });
});
