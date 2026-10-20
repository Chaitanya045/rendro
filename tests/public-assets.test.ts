import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import { fontResponseHeaders } from "@/routes/fonts";
import { styleResponseHeaders } from "@/routes/styles";
import { faviconAssets, faviconCacheControl } from "@/routes/favicon";
import { bundleCacheControl, publicAssetHeaders, publicAssetPaths } from "@/routes/public-assets";
import { versionedBundles } from "@/routes/versioned-bundles";
import { docsBase, mockSecurityBackend, testUser } from "./fixtures/security-headers";
import { sessionCache } from "@/session-cache";
import { privateRepo, repoReadFixture } from "./helpers/repo-read-fixture";

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
import { app as local } from "@/index";

// The unit-test site (tests/setup.ts): local HTTP, so the unprefixed cookie names.
const localSite = "http://localhost:3000";
const ledger = JSON.parse(readFileSync("scripts/asset-versions.json", "utf8")) as Record<string, Record<string, string>>;
const cookie = "better-auth.session_token=test-session";
const immutable = "public, max-age=31536000, immutable";
const bundles = Object.entries(versionedBundles);
const sessionCalls = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).endsWith("/get-session")).length;
const assetsFor = (init: ResponseInit = {}) => ({
  fetch: vi.fn(() => Promise.resolve(new Response("bytes", { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=0, must-revalidate", ETag: '"e"' }, ...init }))),
});
const nodeContext = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

beforeEach(() => { mockSecurityBackend(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("public asset inventory", () => {
  it("lists every versioned bundle in the asset-version ledger at its current version", () => {
    expect(bundles.length).toBeGreaterThan(0);
    for (const [path, version] of bundles) expect(ledger[`public${path}`]?.[version], path).toMatch(/^[0-9a-f]{64}$/);
    // The ledger tracks exactly the bundles that can be served as immutable, plus the recorded history
    // of retired bundles (#286), which is immutable but never served.
    const retired = ["public/management-pages.js", "public/management-query.js", "public/select.js"];
    expect(Object.keys(ledger).filter(path => !retired.includes(path)).sort()).toEqual(bundles.map(([path]) => `public${path}`).sort());
    for (const path of retired) expect(publicAssetPaths, path).not.toContain(path.slice("public".length));
  });

  it("classifies every file in public/: allowlisted, a hashed font, license or stylesheet, or absent", () => {
    const served = new Set(publicAssetPaths);
    const files = readdirSync("public", { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => `/${(entry.parentPath.replace(/^public\/?/, "") + "/" + entry.name).replace(/^\//, "")}`);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      expect(served.has(file) || (file.startsWith("/fonts/") && fontResponseHeaders(file) !== undefined)
        || (file.startsWith("/styles/") && styleResponseHeaders(file) !== undefined), `public${file} is not served or is not allowlisted`).toBe(true);
    }
  });

  it("allowlists exact paths only, with no prefixes that could swallow application routes", () => {
    for (const path of publicAssetPaths) expect(path, path).toMatch(/^\/[a-z0-9-]+\.(?:js|svg|ico|webp)$/);
    expect(new Set(publicAssetPaths).size).toBe(publicAssetPaths.length);
  });
});

describe("public asset headers", () => {
  it.each(bundles)("%s is immutable only for its exact version (v%s)", (path, version) => {
    expect(publicAssetHeaders(path, `?v=${version}`)).toEqual({ "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": immutable });
    expect(bundleCacheControl).toBe(immutable);
    const next = String(Number(version) + 1);
    for (const search of ["", "?", `?v=${next}`, `?v=${Number(version) - 1}`, "?v=", `?v=${version}0`, `?v=0${version}`, `?v=${version}&v=${version}`, `?v=${version}&x=1`, `?x=1&v=${version}`, `?V=${version}`, `?v=%${version}`, `?v[]=${version}`, "?v=latest", `?${version}`, `#?v=${version}`]) {
      expect(publicAssetHeaders(path, search), `${path}${search}`).toEqual({ "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    }
  });

  it.each(Object.entries(faviconAssets))("%s refreshes daily regardless of its query", (path, type) => {
    for (const search of ["", "?v=1"]) expect(publicAssetHeaders(path, search)).toEqual({ "Content-Type": type, "Cache-Control": faviconCacheControl });
  });

  it("serves the landing image with a daily refresh", () => {
    expect(publicAssetHeaders("/landing-product.webp", "")).toEqual({ "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400" });
  });

  it.each(["/", "/missing.js", "/lazy-tree.js/", "/LAZY-TREE.JS", "/lazy-tree.js.map", "/assets/lazy-tree.js", "/constructor", "/__proto__", "/toString", "/hasOwnProperty", "/fonts/x.woff2", "/organizations", "/api/auth/me"])(
    "does not treat %s as an asset", path => expect(publicAssetHeaders(path, "?v=1")).toBeUndefined(),
  );
});

describe("Worker and Node serve public assets without a session lookup", () => {
  // Every public asset class, requested signed in and anonymous, in both runtimes.
  const targets = [
    ...bundles.map(([path, version]) => [path, `?v=${version}`, immutable] as const),
    ...bundles.map(([path]) => [path, "?v=0", "no-store"] as const),
    ...bundles.map(([path]) => [path, "", "no-store"] as const),
    ...Object.keys(faviconAssets).map(path => [path, "", faviconCacheControl] as const),
    ["/landing-product.webp", "", "public, max-age=86400"] as const,
  ];

  it.each(targets)("%s%s: %s", async (path, search, cacheControl) => {
    const expectedType = publicAssetHeaders(path, search.replace("?v=0", "?v=nope"))!["Content-Type"];
    for (const headers of [{ cookie }, {} as Record<string, string>]) {
      const assets = assetsFor();
      vi.mocked(fetch).mockClear();
      const response = await worker.request(`https://rendro.test${path}${search}`, { headers }, { ASSETS: assets });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(expectedType);
      expect(response.headers.get("cache-control")).toBe(cacheControl);
      expect(response.headers.get("etag")).toBe('"e"');
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("strict-transport-security")).toBe("max-age=15552000");
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("server-timing")).toBeNull();
      expect(await response.text()).toBe("bytes");
      expect(assets.fetch).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("never evicts or refreshes a warm identity cache", async () => {
    // The repository read path's cached identity (the only one the Worker reuses).
    sessionCache.clear();
    await sessionCache.lookup(localSite, cookie, () => Promise.resolve({ kind: "authenticated", user: testUser, expiresAt: Date.now() + 60_000 } as never));
    const warm = sessionCalls();
    expect(warm).toBe(0);
    for (const [path, version] of bundles) await worker.request(`https://rendro.test${path}?v=${version}`, { headers: { cookie } }, { ASSETS: assetsFor() });
    for (const path of [...Object.keys(faviconAssets), "/landing-product.webp", `/fonts/${readdirSync("public/fonts").find(file => file.endsWith(".woff2"))}`]) {
      await worker.request(`https://rendro.test${path}`, { headers: { cookie } }, { ASSETS: assetsFor() });
    }
    expect(sessionCalls()).toBe(warm);
    const fresh = vi.fn();
    await sessionCache.lookup(localSite, cookie, fresh);
    expect(fresh).not.toHaveBeenCalled();
    sessionCache.clear();
    // An asset response never carries per-user state or the session's private policy.
    const response = await worker.request(`https://rendro.test/rum.js?v=${versionedBundles["/rum.js"]}`, { headers: { cookie } }, { ASSETS: assetsFor() });
    expect(response.headers.get("cache-control")).toBe(immutable);
  });

  it("answers HEAD and keeps the policy on a 304 revalidation", async () => {
    const path = `/lazy-tree.js?v=${versionedBundles["/lazy-tree.js"]}`;
    const head = await worker.request(`https://rendro.test${path}`, { method: "HEAD", headers: { cookie } }, { ASSETS: assetsFor() });
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe(immutable);
    expect(await head.text()).toBe("");
    const revalidated = await worker.request(`https://rendro.test${path}`, { headers: { cookie, "if-none-match": '"e"' } }, { ASSETS: { fetch: () => new Response(null, { status: 304, headers: { "Cache-Control": "public, max-age=0, must-revalidate" } }) } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("cache-control")).toBe(immutable);
    expect(sessionCalls()).toBe(0);
  });

  it("serves the current bytes uncached for a stale open tab's old version", async () => {
    const current = versionedBundles["/commentor.js"];
    for (const version of ["19", String(Number(current) - 1), String(Number(current) + 1)]) {
      const response = await worker.request(`https://rendro.test/commentor.js?v=${version}`, { headers: { cookie } }, { ASSETS: assetsFor() });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("bytes");
    }
  });

  it("does not label or cache a missing or failing asset as immutable", async () => {
    for (const status of [404, 500]) {
      const response = await worker.request(`https://rendro.test/rum.js?v=${versionedBundles["/rum.js"]}`, {}, { ASSETS: assetsFor({ status }) });
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).not.toContain("immutable");
      expect(response.headers.get("content-type")).not.toBe("text/javascript; charset=utf-8");
    }
    const unbound = await worker.request(`https://rendro.test/rum.js?v=${versionedBundles["/rum.js"]}`);
    expect(unbound.status).toBe(404);
    expect(unbound.headers.get("cache-control")).toBe("private, no-store");
  });

  it("only serves assets for GET and HEAD, and never reaches ASSETS for application paths", async () => {
    const assets = assetsFor();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await worker.request(`https://rendro.test/rum.js?v=${versionedBundles["/rum.js"]}`, { method, headers: { cookie, origin: "https://rendro.test" } }, { ASSETS: assets });
      expect(response.headers.get("cache-control"), method).not.toContain("immutable");
      expect(response.status, method).not.toBe(200);
    }
    for (const path of ["/home", "/api/auth/me", docsBase, "/sign-in", "/unlisted.js", "/robots.txt", "/fonts"]) {
      await worker.request(`https://rendro.test${path}`, { headers: { cookie } }, { ASSETS: assets });
    }
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  describe("Node server", () => {
    // Built bundles are gitignored: a built one is served with the Worker's headers, and one never built is a
    // plain 404 that never enters the session stack and never looks cached.
    it.each(bundles)("serves %s from public/ with the same headers and no session lookup", async (path, version) => {
      const built = existsSync(`public${path}`);
      for (const [search, cacheControl] of [[`?v=${version}`, immutable], ["?v=0", "no-store"], ["", "no-store"]] as const) {
        for (const headers of [{ cookie }, {} as Record<string, string>]) {
          vi.mocked(fetch).mockClear();
          const response = await local.request(`https://rendro.test${path}${search}`, { headers }, nodeContext);
          expect(fetch).not.toHaveBeenCalled();
          expect(response.headers.get("x-content-type-options")).toBe("nosniff");
          if (!built) {
            expect(response.status).toBe(404);
            expect(await response.text()).toBe("");
            expect(response.headers.get("cache-control")).toBe("private, no-store");
            continue;
          }
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
          expect(response.headers.get("cache-control")).toBe(cacheControl);
          expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(`public${path}`));
        }
      }
    });

    it.each(["/favicon.ico", "/favicon.svg", "/landing-product.webp"])("serves %s with its daily policy", async path => {
      const response = await local.request(`https://rendro.test${path}`, { headers: { cookie } }, nodeContext);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(path === "/landing-product.webp" ? "public, max-age=86400" : faviconCacheControl);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(`public${path}`));
      expect(fetch).not.toHaveBeenCalled();
    });

    it("answers HEAD and ignores non-GET methods", async () => {
      const head = await local.request("https://rendro.test/favicon.svg", { method: "HEAD" }, nodeContext);
      expect(head.status).toBe(200);
      expect(head.headers.get("cache-control")).toBe(faviconCacheControl);
      expect(await head.text()).toBe("");
      const [path, version] = bundles[0];
      const post = await local.request(`https://rendro.test${path}?v=${version}`, { method: "POST", headers: { cookie } }, nodeContext);
      expect(post.headers.get("cache-control")).not.toContain("immutable");
      expect(post.status).not.toBe(200);
    });

    it("returns 404 for unlisted paths without serving files from public/", async () => {
      for (const path of ["/robots.txt", "/fonts", "/fonts/", "/public/select.js", "/%2e%2e/package.json"]) {
        const response = await local.request(`https://rendro.test${path}`, {}, nodeContext);
        expect(response.status, path).toBe(404);
        expect(response.headers.get("cache-control"), path).not.toContain("immutable");
      }
    });
  });
});

describe("rendered pages reference only served bundle versions", () => {
  // Repository frames name same-origin bundles by absolute URL (their base may differ).
  const references = (html: string) => [...html.matchAll(/(?:src|href)="(?:https?:\/\/[^/"]+)?(\/[a-z-]+\.js)\?v=([^"]+)"/g)].map(([, path, version]) => [path, version] as const);

  it("keeps every versioned URL in Rendro-authored HTML on an immutable URL", async () => {
    const seen = new Set<string>();
    // A private repository (#234) the signed-in user reads: its shell and its document frame.
    const fixture = await repoReadFixture();
    fixture.access.grant(testUser.id, privateRepo.id);
    const env = { ...fixture.env, ASSETS: assetsFor() };
    const shell = `/r/${privateRepo.owner}/${privateRepo.name}`;
    const frameBase = /data-frame-base="([^"]+)"/.exec(await (await worker.request(`https://rendro.test${shell}`, { headers: { cookie } }, env, fixture.ctx)).text())![1];
    const pages = [
      "/", "/home", "/account/security",
      shell, `${frameBase}/files/docs/index.md`,
    ];
    for (const page of pages) {
      const response = await worker.request(`https://rendro.test${page}`, { headers: { cookie } }, env, fixture.ctx);
      for (const [path, version] of references(await response.text())) {
        seen.add(path);
        expect(publicAssetHeaders(path, `?v=${version}`)?.["Cache-Control"], `${page} references ${path}?v=${version}`).toBe(immutable);
      }
    }
    // The shell and frame pages together reference each bundle family.
    expect([...seen].sort()).toEqual(expect.arrayContaining(["/commentor-parent.js", "/commentor.js", "/lazy-tree.js", "/private-viewer.js"]));
  });
});
