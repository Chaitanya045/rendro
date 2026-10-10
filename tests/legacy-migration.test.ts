import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const disk = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
const storage = vi.hoisted(() => ({ getObjectText: vi.fn(), putObject: vi.fn(), listAllKeys: vi.fn(), headObject: vi.fn(), copyObject: vi.fn() }));
vi.mock("node:fs/promises", () => disk);
vi.mock("../src/minio", () => storage);
import deploymentRoutes from "../src/routes/deployments";
import migrationRoutes from "../src/routes/migration";
import publicationRoutes from "../src/routes/publication-api";

const target = { legacyOrgSlug: "old-org", organizationId: "org", apiKey: "scoped-key", legacyApiKey: "legacy-key" };
const fixtures = new Map([
  ["old-org/docs/z.html", "<h1>Last</h1>"],
  ["old-org/docs/A file.html", "<h1>First</h1>"],
]);
const root = "tenants/org/projects/project/deployments/deployment";
const app = new Hono().route("/", deploymentRoutes).route("/", migrationRoutes).route("/", publicationRoutes);
let main: typeof import("../scripts/migrate-legacy-tenancy").main;
let active: boolean;
let starts: number;
let commits: number;
let failReason: string | undefined;
let failure: "upload" | "commit" | "publication" | "start" | undefined;
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
  publications = []; objects = new Map();
  disk.readFile.mockResolvedValue(JSON.stringify([target]));
  disk.writeFile.mockResolvedValue(undefined);
  storage.putObject.mockImplementation((key: string, bytes: string | Uint8Array) => {
    objects.set(key, bytes); return Promise.resolve();
  });
  storage.getObjectText.mockImplementation((key: string) => Promise.resolve(objects.get(key) ?? null));
  storage.listAllKeys.mockImplementation((prefix: string) => Promise.resolve([...objects.keys()].filter(key => key.startsWith(prefix))));
  send = vi.spyOn(S3Client.prototype, "send").mockImplementation((command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      expect(command.input.Prefix).toBe("old-org/");
      const index = command.input.ContinuationToken ? 1 : 0;
      const [Key, bytes] = [...fixtures][index];
      return Promise.resolve({ Contents: [{ Key, Size: Buffer.byteLength(bytes) }], NextContinuationToken: index === 0 ? "next" : undefined });
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
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer legacy-key");
        return Response.json({ publications: [
          { slug: "legacy-docs", sourcePrefix: "old-org/docs/", entryFile: "A file.html", title: "Legacy docs" },
          { slug: "foreign", sourcePrefix: "another-org/docs/", entryFile: "index.html", title: "Foreign" },
        ] });
      }
      if (failure === "upload" && init?.method === "PUT") return new Response("Upload unavailable", { status: 503 });
      return app.request(url.href, init);
    }
    expect(url.origin).toBe("http://127.0.0.1:3211");
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
      expect(body.fileCount).toBe(2);
      expect(body.manifest).toBeUndefined(); // Worker strips manifest after validating its checksum.
      return Response.json({ deployment: { deploymentId: "deployment", objectRoot: root, manifestKey: `${root}/manifest.json`, treeIndexKey: `${root}/tree-index.json` } });
    }
    if (path.endsWith("/deployments/staging")) {
      expect(url.searchParams.get("deploymentId")).toBe("deployment");
      expect(url.searchParams.get("organizationId")).toBe("org");
      expect(url.searchParams.get("projectId")).toBe("project");
      return Response.json({ deployment: { manifestKey: `${root}/manifest.json` } });
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
    await main(["--map", "targets.json", "--apply"]);
    expect(starts).toBe(1); expect(commits).toBe(1);
    const manifest = JSON.parse(objects.get(`${root}/manifest.json`) as string);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["docs/A file.html", "docs/z.html"]);
    expect(objects.has(`${root}/tree-index.json`)).toBe(true);
    expect(Buffer.from(objects.get(`${root}/files/docs/A file.html`) as Uint8Array).toString()).toBe(fixtures.get("old-org/docs/A file.html"));
    expect(storage.putObject).toHaveBeenCalledWith(`${root}/files/docs/A file.html`, expect.any(Uint8Array), "text/html", { sha256: manifest.files[0].sha256 });
    expect(publications).toEqual([expect.objectContaining({ slug: "legacy-docs", pathPrefix: "docs", trackingMode: "pinned", pinnedDeploymentId: "deployment" })]);
    expect(records()).toEqual([expect.objectContaining({ deploymentId: "deployment", publicationIds: ["publication"] })]);
  });

  it("reuses an identical completed deployment and publication on a repeated apply", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123456789);
    await main(["--map", "targets.json", "--apply"]);
    const writes = storage.putObject.mock.calls.length;
    await main(["--map", "targets.json", "--apply"]);
    expect(starts).toBe(1); expect(commits).toBe(1);
    expect(storage.putObject).toHaveBeenCalledTimes(writes);
    expect(publications).toHaveLength(1);
    expect(records()[0].publicationIds).toEqual(["publication"]);
    const recordNames = disk.writeFile.mock.calls.filter(call => call[2]?.flag === "wx").map(call => call[0]);
    expect(new Set(recordNames).size).toBe(2);
  });

  it("rejects changed sources on a repeated apply without writing another deployment", async () => {
    await main(["--map", "targets.json", "--apply"]);
    sourceChanged = true;
    await expect(main(["--map", "targets.json", "--apply"])).rejects.toThrow("409");
    expect(starts).toBe(1); expect(commits).toBe(1); expect(publications).toHaveLength(1);
  });

  it.each(["upload", "commit"] as const)("marks staging failed on %s errors and preserves the original error", async (step) => {
    failure = step;
    await expect(main(["--map", "targets.json", "--apply"])).rejects.toThrow(step === "upload" ? "Upload unavailable" : "Active deployment changed");
    expect(failReason).toContain(step === "upload" ? "Upload unavailable" : "Active deployment changed");
    expect(commits).toBe(0); expect(publications).toHaveLength(0);
    expect(records()[0].deploymentId).toBe("deployment");
  });

  it("resumes publication work after a failure without creating another deployment", async () => {
    failure = "publication";
    await expect(main(["--map", "targets.json", "--apply"])).rejects.toThrow("Publication unavailable");
    expect(active).toBe(true); expect(failReason).toBeUndefined();
    failure = undefined;
    await main(["--map", "targets.json", "--apply"]);
    expect(starts).toBe(1); expect(publications).toHaveLength(1);
  });

  it("rejects conflicting publication mappings without changing them", async () => {
    await main(["--map", "targets.json", "--apply"]);
    publications[0].trackingMode = "track_active";
    await expect(main(["--map", "targets.json", "--apply"])).rejects.toThrow("conflicts with the migration");
    expect(publications).toHaveLength(1);
    expect(records()[0].publicationIds).toEqual([]);
  });

  it("stops before uploads when start rejects the credential", async () => {
    failure = "start";
    await expect(main(["--map", "targets.json", "--apply"])).rejects.toThrow("401 Invalid key");
    expect(storage.putObject).not.toHaveBeenCalled(); expect(failReason).toBeUndefined();
  });

  it("does not create projects when source storage cannot be read", async () => {
    send.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(main(["--map", "targets.json", "--apply"])).rejects.toThrow("Storage unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires explicit apply for rollback as well as migration writes", async () => {
    await expect(main(["--map", "targets.json", "--rollback", "record.json"])).rejects.toThrow("requires --apply");
    expect(fetch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it("rolls back recorded publications through the authenticated Worker route", async () => {
    await main(["--map", "targets.json", "--apply"]);
    const saved = records();
    disk.readFile.mockResolvedValueOnce(JSON.stringify([target])).mockResolvedValueOnce(JSON.stringify(saved));
    await main(["--map", "targets.json", "--apply", "--rollback", "record.json"]);
    expect(publications).toHaveLength(0);
    expect(active).toBe(true);
  });

  it("requires the migration secret before any apply storage or HTTP calls", async () => {
    vi.stubEnv("MIGRATION_SECRET", "");
    vi.resetModules();
    const script = await import("../scripts/migrate-legacy-tenancy");
    await expect(script.main(["--map", "targets.json", "--apply"])).rejects.toThrow("MIGRATION_SECRET is required");
    expect(fetch).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(disk.writeFile).not.toHaveBeenCalled();
  });
});
