import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptJWT } from "jose";
import worker from "@/worker";
import { decodeStoragePath, isCanonicalStorageKey, modernStorageKey } from "@/storage-boundary";
import { AUTH_SECRET } from "@/config";
import * as minio from "@/minio";
import * as deletion from "@/soft-delete";
import * as apiKeys from "@/api-keys";
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
  expect(minio.getObjectStream).not.toHaveBeenCalled();
  expect(minio.getObjectText).not.toHaveBeenCalled();
  expect(minio.headObject).not.toHaveBeenCalled();
}

function backend(email: string, activeKey: string | null) {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/get-session")) return Promise.resolve(Response.json({ user: { ...testUser, email } }));
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
    vi.mocked(minio.headObject).mockImplementation(key => Promise.resolve(key === modernKey ? { contentType: "text/html" } : null));
    expect((await request(`/legacy-view/example/view/${ticket}/files/${modernKey}`)).status).toBe(404);
    expect((await request(`${docsBase}/view/${ticket}/files/index.html`)).status).toBe(404);
    expect(minio.headObject).not.toHaveBeenCalledWith(modernKey);
    expect(minio.getObjectStream).not.toHaveBeenCalled();
  });

  it("does not let a modern ticket read legacy objects or cross into a legacy route", async () => {
    const ticket = await createViewerTicket(scope);
    vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ version: 1, files: [{ path: "example/index.html", contentType: "text/html" }] }));
    vi.mocked(minio.getObjectStream).mockImplementation(key => Promise.resolve(key === "example/index.html" ? new Response("private legacy").body : null));
    expect((await request(`${docsBase}/view/${ticket}/files/example/index.html`)).status).toBe(404);
    expect(minio.getObjectStream).toHaveBeenCalledWith(manifestKey.replace("manifest.json", "files/example/index.html"));
    expect(minio.getObjectStream).not.toHaveBeenCalledWith("example/index.html");
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
    "preserves literal storage keys through upload, legacy access and existing shares: %s", async path => {
      const key = `example/${path}`;
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const content = `<h1>${path}</h1>`;
      const objects = new Map<string, string>();
      vi.spyOn(apiKeys, "validateApiKey").mockResolvedValue("example");
      vi.spyOn(deletion, "unmarkDeleted").mockResolvedValue(undefined);
      vi.spyOn(minio, "putObject").mockImplementation((key, body) => { objects.set(key, String(body)); return Promise.resolve(); });
      vi.mocked(minio.headObject).mockImplementation(key => Promise.resolve(objects.has(key) ? { contentType: "text/html" } : null));
      vi.mocked(minio.getObjectStream).mockImplementation(key => Promise.resolve(objects.has(key) ? new Response(objects.get(key)).body : null));
      const uploaded = await worker.fetch(new Request("https://rendro.test/api/sync/upload", {
        method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
        body: JSON.stringify({ key, content }),
      }), {});
      expect(uploaded.status).toBe(200);
      expect([...objects.keys()]).toEqual([key]);
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
      expect(vi.mocked(minio.getObjectStream).mock.calls.map(([key]) => key)).toEqual(Array(4).fill(key));
      const checked = await worker.fetch(new Request(`https://rendro.test/api/sync/check?key=${encodeURIComponent(key)}`, {
        headers: { Authorization: "Bearer fixture" },
      }), {});
      expect(checked.status).toBe(200);
      expect(await checked.json()).toMatchObject({ exists: true });
      expect(minio.headObject).toHaveBeenLastCalledWith(key);
    },
  );

  it.each(["%252e%252e/index.html", "%255cindex.html", "%252findex.html"])(
    "contains double encodings as literal keys in both ticket readers: %s", async encoded => {
      const path = decodeURIComponent(encoded);
      const legacy = await createLegacyViewerTicket("example", cookie);
      const modern = await createViewerTicket(scope);
      const key = modernStorageKey(scope, path)!;
      vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ version: 1, files: [{ path, contentType: "text/html" }] }));
      for (const url of [
        `/legacy-view/example/view/${legacy}/files/${encoded}`,
        `${docsBase}/view/${modern}/files/${encoded}`,
      ]) expect((await request(url)).status).toBe(200);
      expect(vi.mocked(minio.getObjectStream).mock.calls.map(([key]) => key)).toEqual([`example/${path}`, key]);
      expect(key).toBe(manifestKey.replace("manifest.json", `files/${path}`));
    },
  );

  it.each(["100%.html", "literal%25.html", "%2e%2e/index.html", "%2findex.html"])(
    "decodes modern file URLs and shell queries only once: %s", async path => {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const key = modernStorageKey(scope, path)!;
      vi.mocked(minio.getObjectText).mockResolvedValue(JSON.stringify({ version: 1, files: [{ path, contentType: "text/html" }] }));
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
      expect(vi.mocked(minio.getObjectStream).mock.calls.map(([key]) => key)).toEqual(Array(3).fill(key));
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
    vi.spyOn(apiKeys, "validateApiKey").mockResolvedValue("tenants");
    vi.spyOn(minio, "putObject").mockResolvedValue(undefined);
    const response = await worker.fetch(new Request("https://rendro.test/api/sync/upload", {
      method: "POST", headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
      body: JSON.stringify({ key: modernKey, content: "replacement" }),
    }), {});
    expect(response.status).toBe(401);
    expect(minio.putObject).not.toHaveBeenCalled();
    noStorageReads();
  });
});
