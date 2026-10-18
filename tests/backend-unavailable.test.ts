import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import * as minio from "@/minio";
import * as deletion from "@/soft-delete";
import { deploymentMetadataCache } from "@/immutable-cache";
import { logger } from "@/logger";
import { createShareToken } from "@/share-links";
import { createViewerTicket } from "@/viewer-ticket";
import { renderSessionUnavailablePage } from "@/routes/session-unavailable";
import { docsBase, mockSecurityBackend } from "./fixtures/security-headers";

/**
 * UI-006-E04: every delivery surface tells "definitely not there" (404) from "could not check" (503 with
 * Retry-After, never cached). The real Worker routes and templates run; only the Convex and storage
 * boundaries are scripted.
 */
const cookie = "better-auth.session_token=backend-unavailable";
const manifestKey = "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json";
const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8";
const request = (path: string, headers: Record<string, string> = {}) =>
  worker.request(`https://rendro.test${path}`, { headers });

const ticket = () => createViewerTicket({ organizationId: "org-a", projectId: "project-a", manifestKey, cookie });
type Surface = { name: string; url: (path: string) => Promise<string>; headers: Record<string, string> };
const surfaces: Surface[] = [
  { name: "private (session)", url: path => Promise.resolve(`${docsBase}/files/${path}`), headers: { Cookie: cookie } },
  { name: "private (viewer ticket)", url: async path => `${docsBase}/view/${await ticket()}/files/${path}`, headers: {} },
  { name: "share", url: path => Promise.resolve(`/s/share-token/files/${path}`), headers: {} },
  { name: "public publication", url: path => Promise.resolve(`/p/product/files/${path}`), headers: {} },
];

const unavailableHeaders = (response: Response) => [
  response.headers.get("Retry-After"), response.headers.get("Cache-Control"),
  response.headers.has("ETag"), response.headers.has("Content-Range"), response.headers.has("Accept-Ranges"),
  response.headers.has("Set-Cookie"), response.headers.has("Location"),
];
const retryable = ["1", "private, no-store", false, false, false, false, false];

/** Wraps the scripted backend so selected Convex URLs fail or deny. */
function backend(override: (url: URL) => Response | Promise<Response> | undefined) {
  const previous = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return override(url) ?? previous(input, init);
  }));
}

beforeEach(() => {
  mockSecurityBackend();
  deploymentMetadataCache.clear();
  vi.spyOn(deletion, "isDeleted").mockResolvedValue(false);
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "debug").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); deploymentMetadataCache.clear(); });

describe.each(surfaces)("$name", surface => {
  const storageFailures = [
    ["a storage 5xx", () => Object.assign(new Error("secret-storage-detail"), { $metadata: { httpStatusCode: 503 } })],
    ["a storage timeout", () => new DOMException("secret-storage-detail", "TimeoutError")],
    ["a transport failure", () => new TypeError("fetch failed: secret-storage-detail")],
  ] as const;

  describe.each([
    ["document", "index.html", HTML],
    ["stylesheet", "assets/site.css", "text/css,*/*;q=0.1"],
  ])("%s", (kind, path, accept) => {
    it.each(storageFailures)("answers %s with a retryable 503 once access is established", async (_label, failure) => {
      vi.mocked(minio.getObjectStream).mockRejectedValue(failure());
      const response = await request(await surface.url(path), { ...surface.headers, Accept: accept });
      expect(response.status).toBe(503);
      expect(unavailableHeaders(response)).toEqual(retryable);
      const body = await response.text();
      expect(body).not.toContain("secret-storage-detail");
      if (kind === "document") {
        expect(response.headers.get("Content-Type")).toContain("text/html");
        expect(body).toContain('<a class="retry" href="">Try again</a>');
        expect(body).toContain("We couldn't load this document");
        expect(body).not.toContain("check your session");
        // A cookie-authenticated document cannot retry from inside the sandboxed frame, so its shell does it.
        expect(body.includes('type:"doc-retry"'), surface.name).toBe(surface.name === "private (session)");
      } else {
        // Plain asset error: nothing for a stylesheet loader or ORB to misread.
        expect(response.headers.get("Content-Type")).toBeNull();
        expect(body).toBe("");
      }
    });

    it("keeps an object that storage reports absent a plain 404", async () => {
      vi.mocked(minio.getObjectStream).mockResolvedValue(null);
      const response = await request(await surface.url(path), { ...surface.headers, Accept: accept });
      expect([response.status, response.headers.has("Retry-After"), response.headers.get("Cache-Control")]).toEqual([404, false, "private, no-store"]);
    });
  });

  it("keeps a path the manifest does not list a plain 404, without touching storage", async () => {
    const response = await request(await surface.url("missing/page.html"), { ...surface.headers, Accept: HTML });
    expect([response.status, response.headers.has("Retry-After")]).toEqual([404, false]);
    expect(minio.getObjectStream).not.toHaveBeenCalled();
  });

  describe("an unreadable manifest of an authorized deployment", () => {
    it.each([
      ["a storage failure", () => { vi.mocked(minio.getObjectText).mockRejectedValue(Object.assign(new Error("secret-storage-detail"), { $metadata: { httpStatusCode: 503 } })); }],
      ["a manifest storage lacks", () => { vi.mocked(minio.getObjectText).mockResolvedValue(null); }],
      ["a corrupt manifest", () => { vi.mocked(minio.getObjectText).mockResolvedValue("{ not json"); }],
    ])("is a retryable 503 for %s", async (_label, damage) => {
      damage();
      const response = await request(await surface.url("index.html"), { ...surface.headers, Accept: HTML });
      expect(response.status).toBe(503);
      expect(unavailableHeaders(response)).toEqual(retryable);
      expect(await response.text()).not.toContain("secret-storage-detail");
      expect(minio.getObjectStream).not.toHaveBeenCalled();
    });
  });

  it("answers a denied request with a plain 404 and no existence signal, even while storage is failing", async () => {
    vi.mocked(minio.getObjectText).mockRejectedValue(new Error("storage down"));
    vi.mocked(minio.getObjectStream).mockRejectedValue(new Error("storage down"));
    const denied = surface.name.startsWith("share") || surface.name.startsWith("public")
      ? (() => { backend(url => /\/(?:shares|publications)\/public$/.test(url.pathname) ? new Response(null, { status: 404 }) : undefined); return surface.headers; })()
      : surface.name.includes("ticket") ? {} : { Cookie: "" };
    // A tampered ticket and a missing session are denials, not outages.
    const url = surface.name.includes("ticket") ? `${docsBase}/view/not-a-ticket/files/index.html` : await surface.url("index.html");
    const response = await request(url, { ...denied, Accept: HTML });
    expect(response.status).toBe(404);
    expect([response.headers.has("Retry-After"), response.headers.has("ETag"), response.headers.has("Accept-Ranges")]).toEqual([false, false, false]);
    expect(minio.getObjectText).not.toHaveBeenCalled();
    expect(minio.getObjectStream).not.toHaveBeenCalled();
  });
});

describe("Convex lookups", () => {
  it.each([
    ["private shell", `${docsBase}`, { Cookie: cookie }, /\/deployments\/active$/],
    ["share", "/s/share-token/files/index.html", {}, /\/shares\/public$/],
    ["public publication", "/p/product/files/index.html", {}, /\/publications\/public$/],
  ])("%s: a failing lookup is a 503, a denying one a 404", async (_name, path, headers, lookup) => {
    backend(url => lookup.test(url.pathname) ? new Response(null, { status: 502 }) : undefined);
    const outage = await request(path, { ...headers, Accept: HTML });
    expect([outage.status, ...unavailableHeaders(outage)]).toEqual([503, ...retryable]);
    vi.unstubAllGlobals();
    mockSecurityBackend();
    backend(url => lookup.test(url.pathname) ? new Response(null, { status: 404 }) : undefined);
    expect((await request(path, { ...headers, Accept: HTML })).status).toBe(404);
  });
});

describe("tree and shell pages", () => {
  it.each([
    ["private tree", `${docsBase}/tree`, { Cookie: cookie }],
    ["publication tree", "/p/product/tree", {}],
    ["publication directory page", "/p/product/tree?dir=", {}],
    ["private directory page", `${docsBase}/tree?dir=`, { Cookie: cookie }],
  ])("%s answers JSON 503 when the manifest cannot be read", async (_name, path, headers) => {
    vi.mocked(minio.getObjectText).mockRejectedValue(new TypeError("fetch failed"));
    const response = await request(path, headers);
    expect([response.status, ...unavailableHeaders(response)]).toEqual([503, ...retryable]);
    expect(await response.json()).toEqual({ error: "Document temporarily unavailable", retryable: true });
  });

  it.each([
    ["private shell", docsBase, { Cookie: cookie }],
    ["publication shell", "/p/product", {}],
  ])("%s offers a retry page when the manifest cannot be read", async (_name, path, headers) => {
    vi.mocked(minio.getObjectText).mockResolvedValue(null);
    const response = await request(path, { ...headers, Accept: HTML });
    expect([response.status, ...unavailableHeaders(response)]).toEqual([503, ...retryable]);
    expect(await response.text()).toContain('<a class="retry" href="">Try again</a>');
  });

  it("answers a ticket renewal JSON 503 when the lookup fails, and still denies a stranger with 404", async () => {
    const renewal = `${docsBase}/viewer-ticket?manifestKey=${encodeURIComponent(manifestKey)}`;
    backend(url => url.pathname.endsWith("/deployments/active") ? new Response(null, { status: 500 }) : undefined);
    const outage = await request(renewal, { Cookie: cookie });
    expect([outage.status, ...unavailableHeaders(outage)]).toEqual([503, ...retryable]);
  });

  it("logs only the route template and the fault class of an unavailable response", async () => {
    vi.mocked(minio.getObjectText).mockRejectedValue(Object.assign(new Error("secret-storage-detail"), { $metadata: { httpStatusCode: 503 } }));
    await request("/p/product/files/index.html", { Accept: HTML });
    expect(logger.warn).toHaveBeenCalledWith({ category: "DeliveryUnavailable", route: "/p/:slug/files/*", kind: "service", status: 503 }, "Document delivery unavailable");
    vi.mocked(logger.warn).mockClear();
    deploymentMetadataCache.clear();
    vi.mocked(minio.getObjectText).mockResolvedValue(null);
    await request("/p/product/files/index.html", { Accept: HTML });
    expect(logger.warn).toHaveBeenCalledWith({ category: "DeliveryUnavailable", route: "/p/:slug/files/*" }, "Document delivery unavailable");
  });

  describe("a failure that is not a backend outage", () => {
    it.each([
      ["document", "/p/product/files/index.html", HTML],
      ["asset", "/p/product/files/assets/site.css", "text/css,*/*;q=0.1"],
      ["tree", "/p/product/tree", "application/json"],
      ["private shell", docsBase, HTML],
    ])("stays an internal error on the %s, with no retry hint and no leaked detail", async (_name, path, accept) => {
      // A code defect or a rejection such as 403 is not retryable: it must not be dressed up as an outage.
      vi.mocked(minio.getObjectText).mockRejectedValue(Object.assign(new Error("secret-storage-detail"), { $metadata: { httpStatusCode: 403 } }));
      const response = await request(path, { Accept: accept, Cookie: cookie });
      expect([response.status, response.headers.get("Retry-After"), response.headers.get("Cache-Control")]).toEqual([500, null, "private, no-store"]);
      expect(await response.text()).not.toContain("secret-storage-detail");
      expect(logger.error).toHaveBeenCalledWith({ category: "UnhandledError", route: expect.any(String), errorType: "Error" }, "Document delivery failed");
    });
  });
});

describe("legacy pages", () => {
  const token = createShareToken("example/index.html", Date.now() + 60_000);
  it.each([
    ["public document", "/public/example/product/files/index.html"],
    ["legacy share", `/share/${token}`],
  ])("%s: a browser gets the retry page, a script the JSON envelope", async (_name, path) => {
    vi.mocked(minio.getObjectStream).mockRejectedValue(new Error("storage down"));
    const page = await request(path, { Accept: HTML });
    expect([page.status, ...unavailableHeaders(page)]).toEqual([503, ...retryable]);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    expect(await page.text()).toContain('<a class="retry" href="">Try again</a>');
    const script = await request(path, { Accept: "application/json" });
    expect([script.status, ...unavailableHeaders(script)]).toEqual([503, ...retryable]);
    expect(await script.json()).toEqual({ error: "Legacy backend unavailable", retryable: true });
  });
});

describe("session outage on cookie-authenticated asset reads", () => {
  const failSession = () => backend(url => url.pathname.endsWith("/get-session") ? new Response(null, { status: 503, headers: { "Retry-After": "30" } }) : undefined);

  it.each(["assets/image.png", "assets/site.css"])("answers %s with a plain empty 503, not a JSON body", async path => {
    failSession();
    const response = await request(`${docsBase}/files/${path}`, { Cookie: cookie, Accept: "image/avif,image/webp,*/*;q=0.8" });
    expect([response.status, response.headers.get("Retry-After"), response.headers.get("Content-Type"), await response.text()]).toEqual([503, "30", null, ""]);
  });

  it("names the session on the retry page for a document", async () => {
    failSession();
    const response = await request(`${docsBase}/files/index.html`, { Cookie: cookie, Accept: HTML });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("We couldn't check your session");
  });
});

describe("recovery page", () => {
  it.each([
    [503, "session", "We couldn't check your session"],
    [500, "session", "We couldn't load this page"],
    [503, "document", "We couldn't load this document"],
  ] as const)("renders %s for the %s subject", (status, subject, heading) => {
    const page = renderSessionUnavailablePage(status, subject);
    expect(page).toContain(`<h1 id="session-error-title">${heading}</h1>`);
    expect(page).toContain(`${status} · Temporarily unavailable`);
    expect(page).toContain('<a class="retry" href="">Try again</a>');
  });

  it("asks the shell to reload the frame only when told its cookie is needed", () => {
    expect(renderSessionUnavailablePage(503, "document", true)).toContain('window.parent.postMessage({type:"doc-retry"},"*")');
    expect(renderSessionUnavailablePage(503, "document")).not.toContain("doc-retry");
  });

  it("is frame-aware: inside a viewer frame the wordmark hides and the parent supplies the theme", () => {
    const page = renderSessionUnavailablePage();
    expect(page).toContain("html.framed .brand{display:none}");
    expect(page).toContain('classList.add("framed")');
    expect(page).toContain('type:"commentor-theme-ready"');
    expect(page).toContain('data.type==="rendro-theme"');
  });
});
