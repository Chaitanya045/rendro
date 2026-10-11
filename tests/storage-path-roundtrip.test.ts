import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { build } from "esbuild";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanDeploymentPath, cleanPublicationPath } from "../shared/v2-paths";
import { parseStoredManifest } from "../src/stored-manifest";

const storage = vi.hoisted(() => ({
  putObject: vi.fn(), getObjectText: vi.fn(), getObjectStream: vi.fn(),
  headObject: vi.fn(), copyObject: vi.fn<(source: string, destination: string) => Promise<void>>(), listAllKeys: vi.fn(),
}));
vi.mock("../src/minio", () => storage);
import deployments from "../src/routes/deployments";
import publications from "../src/routes/publication-api";
import publicReader from "../src/routes/public-v2";

const root = (id: string) => `tenants/org/projects/project/deployments/${id}`;
const objects = new Map<string, { text: string; metadata?: Record<string, string> }>();
let active: string | null;
let next: number;
let publication: { slug: string; pathPrefix: string; entryFile: string };
const app = new Hono().route("/", deployments).route("/", publications).route("/", publicReader);

beforeEach(() => {
  vi.clearAllMocks();
  objects.clear();
  active = null;
  next = 0;
  publication = { slug: "docs", pathPrefix: "", entryFile: "index.html" };
  storage.putObject.mockImplementation((key: string, value: string | Uint8Array, _type: string, metadata?: Record<string, string>) => {
    objects.set(key, { text: typeof value === "string" ? value : new TextDecoder().decode(value), metadata });
    return Promise.resolve();
  });
  storage.getObjectText.mockImplementation((key: string) => Promise.resolve(objects.get(key)?.text ?? null));
  storage.getObjectStream.mockImplementation((key: string) => Promise.resolve(objects.has(key) ? new Response(objects.get(key)!.text).body : null));
  storage.headObject.mockImplementation((key: string) => {
    const object = objects.get(key);
    return Promise.resolve(object ? { size: Buffer.byteLength(object.text), metadata: object.metadata } : null);
  });
  storage.copyObject.mockImplementation((source: string, destination: string) => {
    objects.set(destination, objects.get(source)!);
    return Promise.resolve();
  });
  storage.listAllKeys.mockImplementation((prefix: string) => Promise.resolve([...objects.keys()].filter(key => key.startsWith(prefix))));
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const respond = (value: unknown) => Promise.resolve(Response.json(value));
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const path = url.pathname;
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const deployment = (id: string) => ({
      _id: id, deploymentId: id, status: "active", objectRoot: root(id),
      manifestKey: `${root(id)}/manifest.json`, treeIndexKey: `${root(id)}/tree.json`,
      previousDeploymentId: active ?? undefined,
    });
    if (path.endsWith("/deployments/start")) return respond({ deployment: deployment(String(++next)) });
    if (path.endsWith("/deployments/staging")) return respond({ deployment: deployment(url.searchParams.get("deploymentId")!) });
    if (path.endsWith("/deployments/active")) return respond({ deployment: active ? deployment(active) : null });
    if (path.endsWith("/deployments/commit")) {
      active = body.deploymentId;
      return respond({ deploymentId: active });
    }
    if (path.endsWith("/publications") && init?.method === "POST") {
      publication = body;
      return respond({ publication, url: "/p/docs" });
    }
    if (path.endsWith("/publications/public")) return respond({ publication, project: { name: "Docs", slug: "docs" }, deployment: deployment(active!) });
    throw new Error(`Unexpected backend request: ${path}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

it.each(["source", "bundle"])("%s CLI preserves exact keys through upload, reuse, commit, publication and reads", async kind => {
  await mkdir("tmp", { recursive: true });
  const scratch = await mkdtemp(resolve("tmp/path-roundtrip-"));
  const source = join(scratch, "docs");
  const paths = [
    "100%.html", "100%25.html", "Case.html", "case.html", "é.html", "e\u0301.html", "folder./index.html",
    "%2e%2e/index.html", "%2f/index.html", "%5c/index.html",
    "%252e%252e/index.html", "%252f/index.html", "%255c/index.html",
  ].sort();
  for (const path of paths) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), `<h1>${path}</h1>`);
  }
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>(done => server.once("listening", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const entry = kind === "source" ? "cli/src/index.ts" : join(scratch, "rendro.mjs");
    if (kind === "bundle") await build({ entryPoints: ["cli/src/index.ts"], bundle: true, platform: "node", target: "node22", format: "esm", outfile: entry });
    const run = (args: string[]) => promisify(execFile)(kind === "source" ? resolve("node_modules/.bin/tsx") : process.execPath, [
      entry, ...args, "--organization", "org", "--project", "project", "--endpoint", `http://127.0.0.1:${address.port}`,
    ], { env: { ...process.env, RENDRO_API_KEY: "disposable-test-key" } });
    for (const id of ["1", "2"]) {
      const { stdout } = await run(["push", "--source", source]);
      expect(stdout).toContain(id === "1" ? `${paths.length} uploaded, 0 reused` : `0 uploaded, ${paths.length} reused`);
      expect(active).toBe(id);
      const manifest = JSON.parse(objects.get(`${root(id)}/manifest.json`)!.text);
      expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(paths);
      expect([...objects.keys()].filter(key => key.startsWith(`${root(id)}/files/`)).sort()).toEqual(paths.map(path => `${root(id)}/files/${path}`));
      for (const path of paths) expect(objects.get(`${root(id)}/files/${path}`)?.text).toBe(`<h1>${path}</h1>`);
    }
    expect(storage.copyObject.mock.calls.map(([from, to]) => [from, to])).toEqual(paths.map(path => [`${root("1")}/files/${path}`, `${root("2")}/files/${path}`]));
    for (const path of paths) {
      const slash = path.lastIndexOf("/");
      const pathPrefix = slash < 0 ? "" : path.slice(0, slash);
      const entryFile = path.slice(slash + 1);
      await run(["publication", "create", "--slug", "docs", "--path", pathPrefix, "--entry", entryFile]);
      expect(publication).toMatchObject({ pathPrefix, entryFile });
      const response = await app.request(`/p/docs/files/${encodeURIComponent(entryFile)}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`<h1>${path}</h1>`);
      expect(storage.getObjectStream).toHaveBeenLastCalledWith(`${root("2")}/files/${path}`);
    }
    // A POSIX backslash is filename data, not a Windows directory delimiter.
    if (process.platform !== "win32") {
      await writeFile(join(source, "invalid\\name.html"), "invalid");
      await expect(run(["push", "--source", source])).rejects.toMatchObject({ stderr: expect.stringContaining("Invalid deployment path") });
      expect(next).toBe(2);
    }
  } finally {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
    await rm(scratch, { recursive: true, force: true });
  }
}, 20_000);

it.each(["/file.html", "../file.html", "folder//file.html", "folder/./file.html", "folder\\file.html", "bad\0.html", "bad\x1f.html", "bad\x7f.html"])("rejects noncanonical manifest/copy paths: %j", async path => {
  expect(cleanDeploymentPath(path)).toBeNull();
  expect(parseStoredManifest(JSON.stringify({ files: [{ path, contentType: "text/html" }] }))).toBeNull();
  const start = await app.request("/api/rendro/deployments/start", { method: "POST", body: JSON.stringify({ organizationId: "org", projectId: "project", manifest: { version: 1, files: [{ path, size: 1, sha256: "a".repeat(64) }] } }) });
  expect(start.status).toBe(400);
  active = "previous";
  const copy = await app.request("/api/rendro/deployments/next/copy?organizationId=org&projectId=project", { method: "POST", body: JSON.stringify({ paths: [path] }) });
  expect(copy.status).toBe(400);
  expect(storage.putObject).not.toHaveBeenCalled();
  expect(storage.copyObject).not.toHaveBeenCalled();
});

it.each(["%2findex.html", "nested%2findex.html", "%5cindex.html", "%00index.html", "%7findex.html", "%FF.html"])("rejects unsafe upload URL segments before storage access: %s", async encoded => {
  const response = await app.request(`/api/rendro/deployments/next/files/${encoded}?organizationId=org&projectId=project`, { method: "PUT", body: "x" });
  expect(response.status).toBe(400);
  expect(storage.getObjectText).not.toHaveBeenCalled();
  expect(storage.putObject).not.toHaveBeenCalled();
});

it.each(["bad\0.html", "bad\x1f.html", "bad\x7f.html"])("rejects control characters in publication fields: %j", async path => {
  expect(cleanPublicationPath(path, false)).toBeNull();
  const response = await app.request("/api/rendro/publications", { method: "POST", body: JSON.stringify({ organizationId: "org", projectId: "project", pathPrefix: "", entryFile: path }) });
  expect(response.status).toBe(400);
  expect(storage.getObjectText).not.toHaveBeenCalled();
});


it("refuses publication when its stored manifest includes a noncanonical path", async () => {
  active = "1";
  objects.set(`${root(active)}/manifest.json`, { text: JSON.stringify({ files: [
    { path: "index.html", contentType: "text/html" },
    { path: "../outside.html", contentType: "text/html" },
  ] }) });
  const response = await app.request("/api/rendro/publications", { method: "POST", body: JSON.stringify({
    organizationId: "org", projectId: "project", pathPrefix: "", entryFile: "index.html",
  }) });
  expect(response.status).toBe(400);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
});
