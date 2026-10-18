import { sessionCache } from "@/middleware/session";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptJWT } from "jose";
import worker from "@/worker";
import { decodeStoragePath, isCanonicalStorageKey, isLegacyStorageKey, isLegacyStoragePrefix, legacyStoragePrefix, modernStorageKey, modernStoragePrefix } from "@/storage-boundary";
import { AUTH_SECRET } from "@/config";
import * as blobs from "@/storage";
import * as deletion from "@/soft-delete";
import { createLegacyViewerTicket, createViewerTicket, readLegacyViewerTicket } from "@/viewer-ticket";
import { mockSecurityBackend, docsBase, testUser } from "./fixtures/security-headers";

const cookie = "better-auth.session_token=test-session";
const manifestKey = "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json";
const modernKey = manifestKey.replace("manifest.json", "files/index.html");
const scope = { organizationId: "org-a", projectId: "project-a", manifestKey, cookie };
const request = (path: string, signedIn = false) => worker.fetch(new Request(`https://rendro.test${path}`, { headers: signedIn ? { cookie } : {} }), {});

// Mint a cryptographically authentic pre-fix capability to exercise the reader,
// independently of the new issuer's rejection of invalid storage scopes.
async function oldTicket(kind: "legacy" | "private", payload: Record<string, unknown>) {
  const audience = `rendro:${kind}-document-viewer:v1`;
  const key = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${audience}:${AUTH_SECRET}`)));
  return new EncryptJWT({ ...payload, cookie }).setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setAudience(audience).setIssuedAt().setExpirationTime("15m").encrypt(key);
}

beforeEach(() => {
  mockSecurityBackend();
  vi.spyOn(deletion, "isDeleted").mockResolvedValue(false);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function noStorageReads() {
  expect(blobs.getObjectStream).not.toHaveBeenCalled();
  expect(blobs.getObjectText).not.toHaveBeenCalled();
  expect(blobs.headObject).not.toHaveBeenCalled();
}

function backend(email: string, activeKey: string | null) {
  sessionCache.clear();
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/get-session")) return Promise.resolve(Response.json({ user: { ...testUser, email }, session: { expiresAt: Date.now() + 60_000 } }));
    return Promise.resolve(activeKey ? Response.json({ project: { name: "Docs" }, deployment: { manifestKey: activeKey } }) : new Response(null, { status: 403 }));
  }));
}

describe("disjoint storage authorization", () => {
  it("scopes issued legacy capabilities to their canonical namespace", async () => {
    const ticket = await createLegacyViewerTicket("example", cookie);
    expect(await readLegacyViewerTicket(ticket, "example")).toEqual({ cookie, storagePrefix: "example/" });
    for (const slug of ["tenants", "__rendro", "example/other", "example%2fother"]) {
      await expect(createLegacyViewerTicket(slug, cookie)).rejects.toThrow("Invalid legacy storage scope");
    }
  });

  it("rejects a colliding legacy identity and an existing capability before modern object reads", async () => {
    backend("viewer@tenants.com", null); // Legacy session allowed; modern membership denied.
    const token = await oldTicket("legacy", { orgSlug: "tenants", storagePrefix: "tenants/" });
    for (const url of [
      `/legacy-view/tenants/view/${token}/files/${modernKey.slice("tenants/".length)}`,
      `/legacy-view/tenants/files/${modernKey.slice("tenants/".length)}`,
      `/files/${modernKey}`, `/docs/${modernKey}`, "/docs/tenants",
      "/legacy-view/tenants/viewer-ticket?manifestKey=tenants",
      "/api/tree/tenants", `/api/share/create?key=${encodeURIComponent(modernKey)}`,
      "/public/tenants/product/files/index.html", `${docsBase}/files/index.html`,
    ]) expect((await request(url, true)).status, url.replace(token, "[ticket]")).toBeGreaterThanOrEqual(400);
    noStorageReads();
  });

  it("rejects existing legacy shares that resolve into the modern namespace", async () => {
    const payload = Buffer.from(JSON.stringify({ k: modernKey, e: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    const signature = createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
    expect((await request(`/share/${payload}.${signature}`)).status).toBe(404);
    noStorageReads();
  });

  it("does not let a valid legacy ticket read modern objects through either route", async () => {
    const ticket = await createLegacyViewerTicket("example", cookie);
    // Storage contains only an actual modern object, not a legacy copy of it.
    vi.mocked(blobs.headObject).mockImplementation(key => Promise.resolve(key === modernKey ? { contentType: "text/html" } : null));
    expect((await request(`/legacy-view/example/view/${ticket}/files/${modernKey}`)).status).toBe(404);
    expect((await request(`${docsBase}/view/${ticket}/files/index.html`)).status).toBe(404);
    expect(blobs.headObject).not.toHaveBeenCalledWith(modernKey);
    expect(blobs.getObjectStream).not.toHaveBeenCalled();
  });

  it("does not let a modern ticket read legacy objects or cross into a legacy route", async () => {
    const ticket = await createViewerTicket(scope);
    vi.mocked(blobs.getObjectText).mockResolvedValue(JSON.stringify({ version: 1, files: [{ path: "example/index.html", contentType: "text/html" }] }));
    vi.mocked(blobs.getObjectStream).mockImplementation(key => Promise.resolve(key === "example/index.html" ? new Response("private legacy").body : null));
    expect((await request(`${docsBase}/view/${ticket}/files/example/index.html`)).status).toBe(404);
    expect(blobs.getObjectStream).toHaveBeenCalledWith(manifestKey.replace("manifest.json", "files/example/index.html"));
    expect(blobs.getObjectStream).not.toHaveBeenCalledWith("example/index.html");
    expect((await request(`/legacy-view/example/view/${ticket}/files/index.html`)).status).toBe(404);
  });

  it.each([
    "example/manifest.json", "example/deployments/deploy-a/manifest.json",
    "tenants/org-b/projects/project-a/deployments/deploy-a/manifest.json",
    "tenants/org-a/projects/project-b/deployments/deploy-a/manifest.json",
    "tenants/org-a/projects/project-a/deployments/../manifest.json",
    "tenants/org-a/projects/project-a/deployments//manifest.json",
  ])("rejects modern scopes outside their canonical project namespace: %s", async key => {
    backend(testUser.email, key);
    await expect(createViewerTicket({ ...scope, manifestKey: key })).rejects.toThrow("Invalid viewer storage scope");
    const ticket = await oldTicket("private", { ...scope, manifestKey: key });
    expect((await request(`${docsBase}/view/${ticket}/files/index.html`)).status).toBe(404);
    expect((await request(`${docsBase}/files/index.html`, true)).status).toBe(404);
    expect((await request(`${docsBase}/viewer-ticket?manifestKey=${encodeURIComponent(key)}`, true)).status).toBe(404);
    noStorageReads();
  });

  it.each(["%2e%2e/index.html", "%2e%2e%2findex.html", "guide//index.html", "guide%2findex.html", "%5cindex.html", "%00index.html", "%7findex.html", "%2findex.html"])(
    "rejects ambiguous and encoded traversal in both ticket readers: %s", async path => {
      const legacy = await createLegacyViewerTicket("example", cookie);
      const modern = await createViewerTicket(scope);
      expect((await request(`/legacy-view/example/view/${legacy}/files/${path}`)).status).toBe(404);
      expect((await request(`${docsBase}/view/${modern}/files/${path}`)).status).toBe(404);
      noStorageReads();
    },
  );

  it.each(["100%.html", "literal%25.html", "%2e%2e/index.html", "%5cindex.html", "Case.html", "case.html", "é.html", "e\u0301.html", "folder./index.html"])(
    "preserves existing literal storage keys through legacy access and shares: %s", async path => {
      const key = `example/${path}`;
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const content = `<h1>${path}</h1>`;
      const objects = new Map([[key, content]]);
      vi.mocked(blobs.headObject).mockImplementation(key => Promise.resolve(objects.has(key) ? { contentType: "text/html" } : null));
      vi.mocked(blobs.getObjectStream).mockImplementation(key => Promise.resolve(objects.has(key) ? new Response(objects.get(key)).body : null));
      const bookmark = await request(`/files/example/${encoded}`, true);
      expect(bookmark.status).toBe(302);
      expect(bookmark.headers.get("location")).toBe(`/docs/example/${encoded}`);
      expect((await request(bookmark.headers.get("location")!, true)).status).toBe(200);
      const ticket = await createLegacyViewerTicket("example", cookie);
      // An existing share is signed directly, independently of the current issuer.
      const payload = Buffer.from(JSON.stringify({ k: key, e: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
      const signature = createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
      for (const url of [
        `/legacy-view/example/files/${encoded}`,
        `/legacy-view/example/view/${ticket}/files/${encoded}`,
        `/share/${payload}.${signature}`,
        `/public/example/product/files/${encoded}`,
      ]) {
        const response = await request(url, true);
        expect(response.status, url).toBe(200);
        expect(await response.text()).toContain(content);
      }
      expect(vi.mocked(blobs.getObjectStream).mock.calls.map(([key]) => key)).toEqual(Array(4).fill(key));

    },
  );

  it.each(["%252e%252e/index.html", "%255cindex.html", "%252findex.html"])(
    "contains double encodings as literal keys in both ticket readers: %s", async encoded => {
      const path = decodeURIComponent(encoded);
      const legacy = await createLegacyViewerTicket("example", cookie);
      const modern = await createViewerTicket(scope);
      const key = modernStorageKey(scope, path)!;
      vi.mocked(blobs.getObjectText).mockResolvedValue(JSON.stringify({ version: 1, files: [{ path, contentType: "text/html" }] }));
      for (const url of [
        `/legacy-view/example/view/${legacy}/files/${encoded}`,
        `${docsBase}/view/${modern}/files/${encoded}`,
      ]) expect((await request(url)).status).toBe(200);
      expect(vi.mocked(blobs.getObjectStream).mock.calls.map(([key]) => key)).toEqual([`example/${path}`, key]);
      expect(key).toBe(manifestKey.replace("manifest.json", `files/${path}`));
    },
  );

  it.each(["100%.html", "literal%25.html", "%2e%2e/index.html", "%2findex.html"])(
    "decodes modern file URLs and shell queries only once: %s", async path => {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const key = modernStorageKey(scope, path)!;
      vi.mocked(blobs.getObjectText).mockResolvedValue(JSON.stringify({ version: 1, files: [{ path, contentType: "text/html" }] }));
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const response = await originalFetch(input, init);
        const result = await response.json();
        if (result.grant) result.grant.documentPath = path;
        return Response.json(result);
      }));
      for (const base of [docsBase, "/p/product", "/s/fixture"]) {
        expect((await request(`${base}?doc=${encodeURIComponent(path)}`, true)).status).toBe(200);
        expect((await request(`${base}/files/${encoded}`, true)).status).toBe(200);
      }
      expect(vi.mocked(blobs.getObjectStream).mock.calls.map(([key]) => key)).toEqual(Array(3).fill(key));
    },
  );

  it("treats percent-encoded-looking deployment IDs as literal scoped keys", async () => {
    const key = "tenants/org-a/projects/project-a/deployments/%252e%252e/manifest.json";
    const scoped = { ...scope, manifestKey: key };
    await expect(createViewerTicket(scoped)).resolves.toEqual(expect.any(String));
    expect(modernStorageKey(scoped, "index.html")).toBe(key.replace("manifest.json", "files/index.html"));
  });

  it.each(["../index.html", "/index.html", "guide//index.html", "guide/./index.html", "guide/../index.html", "\\index.html", "\0index.html", "\x1findex.html", "\x7findex.html"])(
    "rejects structurally unsafe canonical keys: %s", path => {
      expect(isCanonicalStorageKey(path)).toBe(false);
      expect(decodeStoragePath(path.split("/").map(encodeURIComponent).join("/"))).toBeNull();
    },
  );

  it("rejects colliding legacy API keys before sync reads or writes", async () => {
    vi.spyOn(blobs, "putObject").mockResolvedValue(undefined);
    const response = await worker.fetch(new Request("https://rendro.test/api/sync/upload", {
      method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
      body: JSON.stringify({ key: modernKey, content: "replacement" }),
    }), {});
    expect(response.status).toBe(410);
    expect(blobs.putObject).not.toHaveBeenCalled();
    noStorageReads();
  });
});

describe("storage boundary derivation", () => {
  const manifest = (id: string) => `tenants/org-a/projects/project-a/deployments/${id}/manifest.json`;
  const scoped = (patch: Partial<{ organizationId: string; projectId: string; manifestKey: string }> = {}) =>
    ({ organizationId: "org-a", projectId: "project-a", manifestKey: manifest("dep-1"), ...patch });

  it("derives the files prefix only from a manifest inside the same organization and project", () => {
    expect(modernStoragePrefix(scoped())).toBe("tenants/org-a/projects/project-a/deployments/dep-1/files/");
    for (const patch of [
      { manifestKey: "tenants/org-a/projects/project-a/deployments/dep-1/other.json" },
      { manifestKey: "tenants/org-a/projects/project-a/deployments/dep-1/nested/manifest.json" },
      { manifestKey: "tenants/org-a/projects/project-a/deployments/manifest.json" },
      { manifestKey: "tenants/org-b/projects/project-a/deployments/dep-1/manifest.json" },
      { manifestKey: "tenants/org-a/projects/project-b/deployments/dep-1/manifest.json" },
      { manifestKey: "tenants/org-a/projects/project-a/deployments/../manifest.json" },
      { manifestKey: "" },
      { organizationId: "org/a" }, { projectId: "project/a" }, { organizationId: "" }, { projectId: ".." },
    ]) expect(modernStoragePrefix(scoped(patch)), JSON.stringify(patch)).toBeNull();
  });

  it("maps canonical paths under the prefix and refuses ambiguous ones", () => {
    const prefix = "tenants/org-a/projects/project-a/deployments/dep-1/files/";
    for (const path of ["index.html", "guide/a b.html", "100%25.html", "a/b/c.css"]) expect(modernStorageKey(scoped(), path)).toBe(prefix + path);
    for (const path of ["", "../manifest.json", "a/../../x", "a//b", "/a", "a/", "a\\b", "a\0b"]) expect(modernStorageKey(scoped(), path), path).toBeNull();
    expect(modernStorageKey(scoped({ manifestKey: "tenants/org-b/projects/project-a/deployments/d/manifest.json" }), "index.html")).toBeNull();
  });

  it("keeps legacy namespaces disjoint from the reserved modern root", () => {
    expect(legacyStoragePrefix("acme-docs")).toBe("acme-docs/");
    for (const org of ["tenants", "", "Acme", "acme_docs", "-acme", "acme-", "acme--docs", "a/b"]) expect(legacyStoragePrefix(org), org).toBeNull();
    expect(isLegacyStorageKey("acme", "acme/index.html")).toBe(true);
    for (const key of ["other/index.html", "acme", "acme/../other/x", "acmeish/x"]) expect(isLegacyStorageKey("acme", key), key).toBe(false);
    expect(isLegacyStorageKey("tenants", "tenants/org-a/projects/p/deployments/d/manifest.json")).toBe(false);
    expect(isLegacyStoragePrefix("acme", "acme/")).toBe(true);
    expect(isLegacyStoragePrefix("acme", "acme/guide/")).toBe(true);
    for (const prefix of ["acme/guide", "other/", "acme//", "acme/../", "", "/"]) expect(isLegacyStoragePrefix("acme", prefix), prefix).toBe(false);
    expect(isLegacyStoragePrefix("tenants", "tenants/")).toBe(false);
  });
});
