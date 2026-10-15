import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { main as migrationMain } from "../scripts/migrate-legacy-tenancy";
import { createHash } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const disk = vi.hoisted(() => ({
  readFile: vi.fn<(path: string, encoding: string) => Promise<string>>(),
  writeFile: vi.fn<(path: string, contents: string, options?: { flag?: string; mode?: number }) => Promise<void>>(),
}));
const storage = vi.hoisted(() => ({ getObjectText: vi.fn(), putObject: vi.fn(), listAllKeys: vi.fn(), headObject: vi.fn(), copyObject: vi.fn(), getObjectStream: vi.fn() }));
vi.mock("node:fs/promises", () => disk);
vi.mock("../src/minio", () => storage);
import deploymentRoutes from "../src/routes/deployments";
import migrationRoutes from "../src/routes/migration";
import publicationRoutes from "../src/routes/publication-api";
import legacyPublicRoutes from "../src/routes/public";
import publicRoutes from "../src/routes/public-v2";

const confirmedApply = ["--apply", "--confirm-endpoint", "https://worker.test"];
const target = { legacyOrgSlug: "old-org", organizationId: "org", apiKey: "scoped-key", legacySessionCookie: "better-auth.session_token=legacy-session" };
const initialFixtures = [
  ["old-org/docs/a-last.html", "<h1>Last</h1>"],
  ["old-org/docs/Z file.html", "<h1>First</h1>"],
] as const;
let fixtures: Map<string, string>;
const root = "tenants/org/projects/project/deployments/deployment";
const app = new Hono().route("/", deploymentRoutes).route("/", migrationRoutes).route("/", publicationRoutes);
let deleted: Set<string>;
let legacyPublications: Array<{ orgSlug: string; slug: string; sourcePrefix: string; entryFile: string; title: string; createdAt: string; updatedAt: string }>;
let visibilityFailure: "unavailable" | "malformed" | undefined;
let main: typeof migrationMain;
let active: boolean;
let starts: number;
let commits: number;
let failReason: string | undefined;
let failure: "upload" | "commit" | "publication" | "start" | "source-change" | "destination-change" | "visibility-change" | "publication-removal" | undefined;
let sourceChanged: boolean;
let publications: Array<Record<string, unknown>>;
let objects: Map<string, string | Uint8Array>;
let send: ReturnType<typeof vi.spyOn>;

function records() {
  return JSON.parse(disk.writeFile.mock.calls.at(-1)![1] as string) as Array<{ deploymentId?: string; publicationIds: string[] }>;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubEnv("RENDRO_ENDPOINT", "https://worker.test");
  vi.stubEnv("MIGRATION_SECRET", "migration-secret");
  vi.spyOn(console, "log").mockImplementation(() => {});
  active = false; starts = 0; commits = 0; failReason = undefined; failure = undefined;
  sourceChanged = false;
  fixtures = new Map(initialFixtures);
  deleted = new Set(); visibilityFailure = undefined;
  legacyPublications = [{ orgSlug: "old-org", slug: "legacy-docs", sourcePrefix: "old-org/docs/", entryFile: "Z file.html", title: "Legacy docs", createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
  publications = []; objects = new Map();
  disk.readFile.mockResolvedValue(JSON.stringify([target]));
  disk.writeFile.mockResolvedValue(undefined);
  storage.getObjectStream.mockImplementation((key: string) => {
    const publication = legacyPublications.find(row => key === `__rendro/publications/${row.orgSlug}/${row.slug}.json`);
    const value = publication ? JSON.stringify(publication) : objects.get(key) ?? fixtures.get(key);
    return Promise.resolve(value === undefined ? null : new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(typeof value === "string" ? Buffer.from(value) : value); controller.close(); },
    }));
  });
  storage.putObject.mockImplementation((key: string, bytes: string | Uint8Array) => {
    objects.set(key, bytes); return Promise.resolve();
  });
  storage.getObjectText.mockImplementation((key: string) => Promise.resolve(objects.get(key) ?? null));
  storage.listAllKeys.mockImplementation((prefix: string) => Promise.resolve([...objects.keys()].filter(key => key.startsWith(prefix))));
  // Select the promise overload; the script never uses the SDK's callback form.
  const source = S3Client.prototype as { send(command: unknown): Promise<unknown> };
  send = vi.spyOn(source, "send").mockImplementation((command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      expect(command.input.Prefix).toBe("old-org/");
      const index = Number(command.input.ContinuationToken ?? 0);
      const [Key, bytes] = [...fixtures][index];
      return Promise.resolve({ Contents: [{ Key, Size: Buffer.byteLength(bytes) }], NextContinuationToken: index + 1 < fixtures.size ? String(index + 1) : undefined });
    }
    if (command instanceof GetObjectCommand) {
      const bytes = fixtures.get(command.input.Key!);
      if (bytes === undefined) throw new Error("Unknown source object");
      return Promise.resolve({ Body: { transformToByteArray: () => Promise.resolve(Buffer.from(sourceChanged ? `${bytes} changed` : bytes)) }, ContentType: "text/html" });
    }
    throw new Error("Migration must only read source storage");
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://worker.test") {
      if (url.pathname === "/api/publications") {
        expect(new Headers(init?.headers).get("Cookie")).toBe("better-auth.session_token=legacy-session");
        return Response.json({ publications: legacyPublications });
      }
      if (failure === "upload" && init?.method === "PUT") return new Response("Upload unavailable", { status: 503 });
      return app.request(url.href, init);
    }
    if (url.origin === "http://127.0.0.1:3210") {
      const body = JSON.parse(init?.body as string) as { path: string; args: Array<{ internalSecret: string; fileKey: string; keys: string[] }> };
      expect(body.args[0].internalSecret).toBe("test-convex-internal-secret-32-chars");
      if (body.path === "legacyAccess:resolve") return Response.json({ status: "success", value: "org" });
      if (body.path === "deletedFiles:isDeleted") return Response.json({ status: "success", value: deleted.has(body.args[0].fileKey) });
      expect(body.path).toBe("deletedFiles:filterFn");
      if (visibilityFailure === "unavailable") return Response.json({ status: "error" }, { status: 503 });
      return Response.json({ status: "success", value: visibilityFailure === "malformed" ? null : body.args[0].keys.filter((key: string) => !deleted.has(key)) });
    }
    expect(url.origin).toBe("http://127.0.0.1:3211");
    if (url.pathname.endsWith("/publications/public")) {
      const publication = publications.find(row => row.slug === url.searchParams.get("slug"));
      return publication ? Response.json({ publication, project: { name: "Legacy", slug: "legacy" }, deployment: { manifestKey: `${root}/manifest.json`, manifestSha256: "manifest" } }) : new Response("Not found", { status: 404 });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    const path = url.pathname;
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      path.endsWith("/migration/project") ? "Bearer migration-secret" : "Bearer scoped-key",
    );
    if (path.endsWith("/migration/project")) {
      expect(body.legacyOrgSlug).toBe(target.legacyOrgSlug);
      if (active) {
        if (sourceChanged) return Response.json({ error: "Existing migration project does not match this migration" }, { status: 409 });
        expect(body.manifestSha256).toBe(createHash("sha256").update(objects.get(`${root}/manifest.json`) as string).digest("hex"));
      }
      return Response.json({ project: { _id: "project", ...(active ? { activeDeploymentId: "deployment" } : {}) } });
    }
    if (path.endsWith("/deployments/start")) {
      if (failure === "start") return new Response("Invalid key", { status: 401 });
      starts++;
      if (failure === "visibility-change") deleted.add("old-org/docs/a-last.html");
      if (failure === "publication-removal") legacyPublications = [];
      if (failure === "source-change") sourceChanged = true;
      expect(body.fileCount).toBeGreaterThan(0);
      expect(body.manifest).toBeUndefined(); // Worker strips manifest after validating its checksum.
      return Response.json({ deployment: { deploymentId: "deployment", objectRoot: root, stagingExpiresAt: Date.now() + 3_600_000, manifestKey: `${root}/manifest.json`, treeIndexKey: `${root}/tree-index.json`, ...(failure === "destination-change" ? { previousDeploymentId: "ordinary-deployment" } : {}) } });
    }
    if (path.endsWith("/deployments/staging")) {
      expect(url.searchParams.get("deploymentId")).toBe("deployment");
      expect(url.searchParams.get("organizationId")).toBe("org");
      expect(url.searchParams.get("projectId")).toBe("project");
      return Response.json({ deployment: { stagingExpiresAt: Date.now() + 3_600_000, manifestKey: `${root}/manifest.json` } });
    }
    if (path.endsWith("/deployments/commit")) {
      expect(body).toEqual({ organizationId: "org", projectId: "project", deploymentId: "deployment" });
      if (failure === "commit") return new Response("Active deployment changed", { status: 409 });
      commits++; active = true;
      return Response.json({ deploymentId: "deployment" });
    }
    if (path.endsWith("/deployments/fail")) {
      failReason = body.reason as string;
      return new Response("Failure callback unavailable", { status: 503 });
    }
    if (path.endsWith("/deployments")) return Response.json({ deployments: [{ _id: "deployment", status: "active", manifestKey: `${root}/manifest.json` }] });
    if (path.endsWith("/publications") && init?.method === "GET") return Response.json({ publications });
    if (path.endsWith("/publications") && init?.method === "POST") {
      if (failure === "publication") return new Response("Publication unavailable", { status: 503 });
      const publication = { _id: "publication", ...body };
      publications.push(publication);
      return Response.json({ publication });
    }
    if (path.endsWith("/publications/remove")) {
      expect(body).toEqual({ organizationId: "org", projectId: "project", publicationId: "publication" });
      publications = publications.filter(publication => publication._id !== body.publicationId);
      return Response.json({ status: true });
    }
    throw new Error(`Unexpected backend request: ${path}`);
  }));
  ({ main } = await import("../scripts/migrate-legacy-tenancy"));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("legacy migration with mocked source storage and backend HTTP", () => {
  it("defaults to a paginated, read-only inventory without HTTP or output files", async () => {
    await main(["--", "--map", "targets.json"]);
    expect(console.log).toHaveBeenCalledWith("old-org: 2 legacy objects");
    expect(console.log).toHaveBeenCalledWith("  old-org/ → organization org, project <new: legacy-old-org>");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Dry run only"));
    expect(send).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(disk.writeFile).not.toHaveBeenCalled();
  });

  it("applies through current Worker start/upload/commit routes and creates pinned publications", async () => {
    await main(["--map", "targets.json", ...confirmedApply]);
    expect(starts).toBe(1); expect(commits).toBe(1);
    const manifest = JSON.parse(objects.get(`${root}/manifest.json`) as string);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["docs/Z file.html", "docs/a-last.html"]);
    expect(objects.has(`${root}/tree-index.json`)).toBe(true);
    expect(Buffer.from(objects.get(`${root}/files/docs/Z file.html`) as Uint8Array).toString()).toBe(fixtures.get("old-org/docs/Z file.html"));
    expect(storage.putObject).toHaveBeenCalledWith(`${root}/files/docs/Z file.html`, expect.any(Uint8Array), "text/html", { sha256: manifest.files[0].sha256 }, expect.any(AbortSignal));
    expect(publications).toEqual([expect.objectContaining({ slug: "legacy-docs", pathPrefix: "docs", trackingMode: "pinned", pinnedDeploymentId: "deployment" })]);
    expect(records()).toEqual([expect.objectContaining({ deploymentId: "deployment", publicationIds: ["publication"] })]);
  });

  it("reuses an identical completed deployment and publication on a repeated apply", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123456789);
    await main(["--map", "targets.json", ...confirmedApply]);
    const writes = storage.putObject.mock.calls.length;
    await main(["--map", "targets.json", ...confirmedApply]);
    expect(starts).toBe(1); expect(commits).toBe(1);
    expect(storage.putObject).toHaveBeenCalledTimes(writes);
    expect(publications).toHaveLength(1);
    expect(records()[0].publicationIds).toEqual(["publication"]);
    const recordNames = disk.writeFile.mock.calls.filter(call => call[2]?.flag === "wx").map(call => call[0]);
    expect(new Set(recordNames).size).toBe(2);
  });

  it("rejects changed sources on a repeated apply without writing another deployment", async () => {
    await main(["--map", "targets.json", ...confirmedApply]);
    sourceChanged = true;
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("409");
    expect(starts).toBe(1); expect(commits).toBe(1); expect(publications).toHaveLength(1);
  });

  it.each(["upload", "commit"] as const)("marks staging failed on %s errors and preserves the original error", async (step) => {
    failure = step;
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow(step === "upload" ? "Upload unavailable" : "Active deployment changed");
    expect(failReason).toContain(step === "upload" ? "Upload unavailable" : "Active deployment changed");
    expect(commits).toBe(0); expect(publications).toHaveLength(0);
    expect(records()[0].deploymentId).toBe("deployment");
  });

  it("does not overwrite a deployment activated between project validation and start", async () => {
    failure = "destination-change";
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("gained an active deployment");
    expect(starts).toBe(1); expect(commits).toBe(0);
    expect(failReason).toContain("gained an active deployment");
    expect([...objects.keys()].some(key => key.includes("/files/"))).toBe(false);
    expect(publications).toHaveLength(0);
    expect(records()[0].deploymentId).toBe("deployment");
  });

  it("rejects source changes between hashing and upload without activating corrupt bytes", async () => {
    failure = "source-change";
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("does not match its manifest entry");
    expect(starts).toBe(1); expect(commits).toBe(0);
    expect(active).toBe(false);
    expect(failReason).toContain("does not match its manifest entry");
    expect([...objects.keys()].some(key => key.includes("/files/"))).toBe(false);
    expect(publications).toHaveLength(0);
    expect(records()[0].deploymentId).toBe("deployment");
  });

  it("resumes publication work after a failure without creating another deployment", async () => {
    failure = "publication";
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow('502 {"error":"Backend unavailable"}');
    expect(active).toBe(true); expect(failReason).toBeUndefined();
    failure = undefined;
    await main(["--map", "targets.json", ...confirmedApply]);
    expect(starts).toBe(1); expect(publications).toHaveLength(1);
  });

  it("rejects conflicting publication mappings without changing them", async () => {
    await main(["--map", "targets.json", ...confirmedApply]);
    publications[0].trackingMode = "track_active";
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("conflicts with the migration");
    expect(publications).toHaveLength(1);
    expect(records()[0].publicationIds).toEqual([]);
  });

  it("stops before uploads when start rejects the credential", async () => {
    failure = "start";
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("401 Invalid key");
    expect(storage.putObject).not.toHaveBeenCalled(); expect(failReason).toBeUndefined();
  });

  it("does not create projects when source storage cannot be read", async () => {
    send.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("Storage unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  function expectNoDestinationWrites() {
    expect(starts).toBe(0);
    expect(commits).toBe(0);
    expect(publications).toEqual([]);
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) =>
      (url instanceof Request ? url.url : String(url)).includes("/api/rendro/") && ["POST", "PUT"].includes(init?.method ?? "GET"))).toBe(false);
    expect(send).not.toHaveBeenCalledWith(expect.any(GetObjectCommand));
  }

  it.each(["docs ", " "])("never exposes a private sibling when prefix %j would shrink in v2", async (folder) => {
    legacyPublications[0].sourcePrefix = `old-org/${folder}/`;
    fixtures.set(`old-org/${folder}/Z file.html`, "public entry");
    const privateFolder = folder.trim() ? `${folder.trim()}/` : "";
    fixtures.set(`old-org/${privateFolder}Z file.html`, "private entry");
    fixtures.set(`old-org/${privateFolder}a-last.html`, "private sibling secret");
    expect((await legacyPublicRoutes.request("/public/old-org/legacy-docs/files/Z%20file.html")).status).toBe(200);
    expect((await legacyPublicRoutes.request("/public/old-org/legacy-docs/files/a-last.html")).status).toBe(404);
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow(JSON.stringify(`old-org/${folder}/`));
    expectNoDestinationWrites();
    expect((await publicRoutes.request("/p/legacy-docs/files/a-last.html")).status).toBe(404);
  });

  it.each([
    ["whitespace", " docs"],
    ["trailing whitespace", "docs "],
    ["leading slash", "/docs"],
    ["repeated slashes", "docs//nested"],
    ["dot", "docs/./nested"],
    ["parent", "docs/../private"],
    ["percent decoding", "%64ocs"],
    ["repeated percent decoding", "%2564ocs"],
    ["encoded slash", "docs%2Fnested"],
    ["encoded dot segment", "docs/%2e%2e/private"],
    ["extra trailing slash", "docs/"],
    ["backslash", "docs\\nested"],
  ])("rejects publication prefix %s before any destination write", async (_kind, folder) => {
    legacyPublications[0].sourcePrefix = `old-org/${folder}/`;
    fixtures.set(`old-org/${folder}/Z file.html`, "entry");
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow(JSON.stringify(`old-org/${folder}/`));
    expectNoDestinationWrites();
  });

  it.each([
    ["whitespace", " docs/a.html"],
    ["trailing whitespace", "docs/a.html "],
    ["leading slash", "/docs/a.html"],
    ["repeated slashes", "docs//a.html"],
    ["dot", "docs/./a.html"],
    ["parent", "docs/../a.html"],
    ["percent decoding", "docs/%61.html"],
    ["repeated percent decoding", "docs/%2561.html"],
    ["encoded slash", "docs%2Fa.html"],
    ["malformed encoding", "docs/a%.html"],
    ["trailing slash", "docs/a.html/"],
    ["backslash", "docs\\a.html"],
  ])("rejects file path %s, even when deleted, before destination writes", async (_kind, path) => {
    const key = `old-org/${path}`;
    fixtures.set(key, "deleted secret");
    deleted.add(key);
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow(JSON.stringify(key));
    expectNoDestinationWrites();
  });

  it.each([" Z file.html", "Z file.html/", "%5A file.html", "./Z file.html"])("rejects entry path %j before destination writes", async (entry) => {
    legacyPublications[0].entryFile = entry;
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow(JSON.stringify(`legacy-docs entry: ${entry}`));
    expectNoDestinationWrites();
  });

  it.each([
    ["old-org/docs/a-last.html", "old-org/docs/%61-last.html"],
    ["old-org/docs/a-last.html", "old-org//docs/a-last.html"],
    ["old-org/docs/a-last.html", "old-org/docs/a-last.html "],
  ])("lists both file paths in a normalization collision: %s and %s", async (original, alias) => {
    fixtures.set(alias, "deleted alias");
    deleted.add(alias);
    const result = main(["--map", "targets.json", ...confirmedApply]);
    await expect(result).rejects.toThrow(`collision at "docs/a-last.html": ${JSON.stringify(original)}, ${JSON.stringify(alias)}`);
    expectNoDestinationWrites();
  });

  it("lists colliding publication prefixes before destination writes", async () => {
    legacyPublications.push({ ...legacyPublications[0], slug: "other-docs", sourcePrefix: "old-org/docs /" });
    fixtures.set("old-org/docs /Z file.html", "public entry");
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow('collision at "docs": "old-org/docs/", "old-org/docs /"');
    expectNoDestinationWrites();
  });

  it.each([
    ["case", "Docs", "docs"],
    ["Unicode code points", "caf\u00e9", "cafe\u0301"],
  ])("preserves distinct %s in prefixes, paths, and exact-key deletion state", async (_kind, first, second) => {
    fixtures = new Map([
      [`old-org/${first}/index.html`, "first entry"],
      [`old-org/${second}/index.html`, "second entry"],
      [`old-org/${first}/a.html`, "deleted secret"],
      [`old-org/${first}/b.html`, "live first"],
      [`old-org/${second}/b.html`, "deleted second"],
    ]);
    deleted.add(`old-org/${first}/a.html`);
    deleted.add(`old-org/${second}/b.html`);
    legacyPublications = [
      { ...legacyPublications[0], sourcePrefix: `old-org/${first}/`, entryFile: "index.html" },
      { ...legacyPublications[0], slug: "second-docs", sourcePrefix: `old-org/${second}/`, entryFile: "index.html" },
    ];
    await main(["--map", "targets.json", ...confirmedApply]);
    const manifest = JSON.parse(objects.get(`${root}/manifest.json`) as string);
    expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual([
      `${first}/index.html`, `${first}/b.html`, `${second}/index.html`,
    ].sort());
    for (const slug of ["legacy-docs", "second-docs"]) {
      expect((await publicRoutes.request(`/p/${slug}/files/a.html`)).status).toBe(404);
      expect((await publicRoutes.request(`/p/${slug}/files/index.html`)).status).toBe(200);
    }
    expect((await publicRoutes.request("/p/legacy-docs/files/b.html")).status).toBe(200);
    expect((await publicRoutes.request("/p/second-docs/files/b.html")).status).toBe(404);
  });

  it("keeps soft-deleted documents 404, including an idempotent rerun", async () => {
    deleted.add("old-org/docs/a-last.html");
    expect((await legacyPublicRoutes.request("/public/old-org/legacy-docs/files/a-last.html")).status).toBe(404);
    for (let run = 0; run < 2; run++) {
      await main(["--map", "targets.json", ...confirmedApply]);
      expect((await publicRoutes.request("/p/legacy-docs/files/a-last.html")).status).toBe(404);
      expect((await publicRoutes.request("/p/legacy-docs/files/Z%20file.html")).status).toBe(200);
      const manifest = JSON.parse(objects.get(`${root}/manifest.json`) as string);
      expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["docs/Z file.html"]);
      expect(objects.has(`${root}/files/docs/a-last.html`)).toBe(false);
    }
    expect(starts).toBe(1); expect(publications).toHaveLength(1);
  });

  it("does not republish a removed publication even though its source objects remain", async () => {
    legacyPublications = [];
    expect((await legacyPublicRoutes.request("/public/old-org/legacy-docs/files/a-last.html")).status).toBe(404);
    await main(["--map", "targets.json", ...confirmedApply]);
    expect(publications).toEqual([]);
    expect((await publicRoutes.request("/p/legacy-docs/files/a-last.html")).status).toBe(404);
  });

  it("keeps private documents and non-HTML files inaccessible anonymously and creates no shares", async () => {
    fixtures.set("old-org/private/secret.html", "private");
    fixtures.set("old-org/docs/secret.json", "private asset");
    expect((await legacyPublicRoutes.request("/public/old-org/legacy-docs/files/secret.json")).status).toBe(404);
    await main(["--map", "targets.json", ...confirmedApply]);
    expect(objects.has(`${root}/files/private/secret.html`)).toBe(true);
    expect(objects.has(`${root}/files/docs/secret.json`)).toBe(false);
    expect((await publicRoutes.request("/p/legacy-docs/files/secret.json")).status).toBe(404);
    expect((await publicRoutes.request("/p/legacy-docs/files/private/secret.html")).status).toBe(404);
    expect((await publicRoutes.request("/p/private/files/secret.html")).status).toBe(404);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => (url instanceof Request ? url.url : String(url)).includes("/shares"))).toBe(false);
  });

  it("migrates privately without a legacy API key, still excluding deleted files", async () => {
    disk.readFile.mockResolvedValue(JSON.stringify([{ ...target, legacySessionCookie: undefined }]));
    deleted.add("old-org/docs/a-last.html");
    await main(["--map", "targets.json", ...confirmedApply]);
    expect(publications).toEqual([]);
    expect(objects.has(`${root}/files/docs/a-last.html`)).toBe(false);
  });

  it.each(["unavailable", "malformed"] as const)("fails closed before remote writes when deletion state is %s", async (mode) => {
    visibilityFailure = mode;
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("Cannot establish legacy visibility");
    expect(starts).toBe(0); expect(storage.putObject).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => (url instanceof Request ? url.url : String(url)).includes("/migration/project"))).toBe(false);
  });

  it("requires authoritative source deletion credentials", async () => {
    vi.stubEnv("CONVEX_INTERNAL_SECRET", "");
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("Cannot establish legacy visibility");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses publications whose entry document was deleted before writing", async () => {
    deleted.add("old-org/docs/Z file.html");
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("no visible entry document");
    expect(starts).toBe(0); expect(publications).toEqual([]);
  });

  it.each(["visibility-change", "publication-removal"] as const)("refuses publication when legacy visibility changes during upload: %s", async (mode) => {
    failure = mode;
    await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("Legacy visibility changed");
    expect(publications).toEqual([]);
  });

  it("requires explicit apply for rollback as well as migration writes", async () => {
    await expect(main(["--map", "targets.json", "--rollback", "record.json"])).rejects.toThrow("requires --apply");
    expect(fetch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it("rolls back recorded publications through the authenticated Worker route", async () => {
    await main(["--map", "targets.json", ...confirmedApply]);
    const saved = records();
    disk.readFile.mockResolvedValueOnce(JSON.stringify([target])).mockResolvedValueOnce(JSON.stringify(saved));
    await main(["--map", "targets.json", ...confirmedApply, "--rollback", "record.json"]);
    expect(publications).toHaveLength(0);
    expect(active).toBe(true);
  });

  it.each([{ confirmation: [] }, { confirmation: ["--confirm-endpoint", "https://wrong.test"] }])("requires matching confirmation before any non-local apply writes: %j", async ({ confirmation }) => {
    await expect(main(["--map", "targets.json", "--apply", ...confirmation])).rejects.toThrow("Non-local writes require --confirm-endpoint https://worker.test");
    expect(console.log).toHaveBeenCalledWith("Destination Worker: https://worker.test");
    expect(fetch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(disk.writeFile).not.toHaveBeenCalled();
  });

  it("requires matching confirmation for non-local rollback", async () => {
    disk.readFile.mockResolvedValueOnce(JSON.stringify([target])).mockResolvedValueOnce(JSON.stringify([
      { ...target, projectId: "project", publicationIds: ["publication"] },
    ]));
    await expect(main(["--map", "targets.json", "--apply", "--rollback", "record.json"])).rejects.toThrow("Non-local writes require");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prints sanitized source and destination details before the first apply and rollback writes", async () => {
    const assertSummaryBeforeWrites = () => {
      const writes = vi.mocked(fetch).mock.calls.flatMap(([url, init], index) =>
        (url instanceof Request ? url.url : String(url)).includes("/api/rendro/") && ["POST", "PUT"].includes(init?.method ?? "GET")
          ? [vi.mocked(fetch).mock.invocationCallOrder[index]] : []);
      expect(writes.length).toBeGreaterThan(0);
      for (const line of [
        "Destination Worker: https://worker.test",
        "Source storage: http://localhost:9000; bucket: docs",
        "Source legacy Convex: http://127.0.0.1:3210",
      ]) {
        const index = vi.mocked(console.log).mock.calls.findIndex(([value]) => value === line);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(vi.mocked(console.log).mock.invocationCallOrder[index]).toBeLessThan(Math.min(...writes));
      }
      const mapping = vi.mocked(console.log).mock.calls.findIndex(([value]) => String(value).includes("old-org/ → organization org, project"));
      expect(mapping).toBeGreaterThanOrEqual(0);
      expect(vi.mocked(console.log).mock.invocationCallOrder[mapping]).toBeLessThan(Math.min(...writes));
    };
    await main(["--map", "targets.json", ...confirmedApply]);
    assertSummaryBeforeWrites();
    const saved = records();
    vi.mocked(console.log).mockClear(); vi.mocked(fetch).mockClear();
    disk.readFile.mockResolvedValueOnce(JSON.stringify([target])).mockResolvedValueOnce(JSON.stringify(saved));
    await main(["--map", "targets.json", ...confirmedApply, "--rollback", "record.json"]);
    assertSummaryBeforeWrites();
    expect(console.log).toHaveBeenCalledWith("  old-org/ → organization org, project project");
  });

  it("never prints URL credentials, paths, query secrets, or fragments in the environment summary", async () => {
    vi.stubEnv("RENDRO_ENDPOINT", "https://operator:worker-password@worker.test/secret-path?token=worker-token#worker-fragment");
    vi.stubEnv("MINIO_ENDPOINT", "https://operator:storage-password@storage.test/secret-path?token=storage-token#storage-fragment");
    vi.stubEnv("CONVEX_URL", "https://operator:convex-password@convex.test/secret-path?token=convex-token#convex-fragment");
    vi.resetModules();
    const script = await import("../scripts/migrate-legacy-tenancy");
    await script.main(["--map", "targets.json"]);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Destination Worker: https://worker.test");
    expect(output).toContain("Source storage: https://storage.test; bucket: docs");
    expect(output).toContain("Source legacy Convex: https://convex.test");
    expect(output).not.toMatch(/operator|password|secret-path|token|fragment/);
  });

  it("keeps local apply available without endpoint confirmation", async () => {
    vi.stubEnv("RENDRO_ENDPOINT", "http://localhost:3000");
    vi.resetModules();
    const script = await import("../scripts/migrate-legacy-tenancy");
    send.mockRejectedValueOnce(new Error("Inventory reached"));
    await expect(script.main(["--map", "targets.json", "--apply"])).rejects.toThrow("Inventory reached");
  });

  it("requires the migration secret before any apply storage or HTTP calls", async () => {
    vi.stubEnv("MIGRATION_SECRET", "");
    vi.resetModules();
    const script = await import("../scripts/migrate-legacy-tenancy");
    await expect(script.main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("MIGRATION_SECRET is required");
    expect(fetch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(disk.writeFile).not.toHaveBeenCalled();
  });
});

it("stops publication migration when the mapped-member session expires", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((input, init) => (input instanceof Request ? input.url : input.toString()).includes("/api/publications?")
    ? Promise.resolve(new Response(null, { status: 404 })) : original(input, init));
  await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("Legacy publication lookup failed (404)");
  expect(starts).toBe(0);
});
it.each([[], ["--map"], ["--map", "--apply"], ["--map", "targets.json", "--rollback"], ["--map", "targets.json", "--rollback", "--apply"]].map(args => [args]))("rejects incomplete operator arguments (%j)", async args => {
  await expect(main(args)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("requires a legacy folder delimiter before migration", async () => {
  legacyPublications[0].sourcePrefix = "old-org/docs";
  await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("missing legacy folder delimiter");
});
it("rejects unsafe paths without a publication mapping", async () => {
  legacyPublications = [];
  fixtures.set("old-org/a//b.html", "bad");
  await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("publications: none");
});
it("handles empty object pages and skips incomplete object listings", async () => {
  send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Contents: [{ Size: 1 }, { Key: "old-org/a.html" }] });
  await main(["--map", "targets.json"]);
  await main(["--map", "targets.json"]);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([1, 3])("stops on a missing source body during read %s", async missingRead => {
  const original = send.getMockImplementation() as (command: unknown) => Promise<unknown>;
  let reads = 0;
  send.mockImplementation((command: unknown) => command instanceof GetObjectCommand && ++reads === missingRead
    ? Promise.resolve({}) : original(command));
  await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow("Unable to read");
});
it("uses a fallback media type and accepts root-folder legacy publications", async () => {
  legacyPublications[0].sourcePrefix = "old-org/";
  legacyPublications[0].entryFile = "docs/Z file.html";
  const original = send.getMockImplementation() as (command: unknown) => Promise<unknown>;
  send.mockImplementation(async (command: unknown) => {
    const result = await original(command) as { ContentType?: string };
    if (command instanceof GetObjectCommand && command.input.Key?.endsWith("a-last.html")) delete result.ContentType;
    return result;
  });
  await main(["--map", "targets.json", ...confirmedApply]);
  expect(commits).toBe(1);
});
it("refuses rollback without matching target credentials", async () => {
  disk.readFile.mockImplementation(path => Promise.resolve(JSON.stringify(path === "targets.json" ? [target] : [{ legacyOrgSlug: "other", organizationId: "org", projectId: "project", publicationIds: [] }])));
  await expect(main(["--map", "targets.json", ...confirmedApply, "--rollback", "record.json"])).rejects.toThrow("Missing target credentials");
});
it("prints sanitized fallback and invalid source origins", async () => {
  vi.stubEnv("MINIO_ENDPOINT", undefined);
  vi.stubEnv("CONVEX_URL", "not a URL");
  vi.stubEnv("RENDRO_ENDPOINT", undefined);
  vi.stubEnv("MINIO_ACCESS_KEY", undefined);
  vi.resetModules();
  await (await import("../scripts/migrate-legacy-tenancy")).main(["--map", "targets.json"]);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("AWS SDK default"));
  expect(console.log).toHaveBeenCalledWith("Source legacy Convex: <invalid endpoint>");
  vi.stubEnv("CONVEX_URL", undefined);
  await main(["--map", "targets.json"]);
  expect(console.log).toHaveBeenCalledWith("Source legacy Convex: <unset>");
});
it.each([new Error("CLI failure"), "CLI failure"])("exits unsuccessfully on a direct CLI failure (%#)", async error => {
  vi.resetModules();
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", new URL("../scripts/migrate-legacy-tenancy.ts", import.meta.url).pathname, "--map", "targets.json"]);
  disk.readFile.mockRejectedValue(error);
  await import("../scripts/migrate-legacy-tenancy");
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(log).toHaveBeenCalledWith("CLI failure");
});

it("rejects duplicate source rows instead of committing an invalid manifest", async () => {
  const original = send.getMockImplementation() as (command: unknown) => Promise<unknown>;
  send.mockImplementation((command: unknown) => command instanceof ListObjectsV2Command
    ? Promise.resolve({ Contents: [{ Key: "old-org/docs/Z file.html", Size: 1 }, { Key: "old-org/docs/Z file.html", Size: 1 }] })
    : original(command));
  await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toThrow();
  expect(commits).toBe(0);
});
it("records non-Error source failures safely in the failure callback", async () => {
  const rejectSource = vi.fn<() => Promise<unknown>>().mockRejectedValue("source unavailable");
  const original = send.getMockImplementation() as (command: unknown) => Promise<unknown>;
  let reads = 0;
  send.mockImplementation((command: unknown) => command instanceof GetObjectCommand && ++reads === 3
    ? rejectSource() : original(command));
  await expect(main(["--map", "targets.json", ...confirmedApply])).rejects.toBe("source unavailable");
  expect(failReason).toContain("source unavailable");
});
