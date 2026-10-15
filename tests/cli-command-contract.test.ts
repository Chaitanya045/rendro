import { version } from "../package.json";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ readdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), git: vi.fn() }));
vi.mock("node:fs/promises", () => io);
vi.mock("node:child_process", () => ({ execFileSync: io.git }));
const originalArgv = process.argv;
const source = resolve("docs");
const bytes = Buffer.from("<h1>Docs</h1>");
const hash = createHash("sha256").update(bytes).digest("hex");
const identity = ["--organization", "org", "--project", "project"];
const entry = (name: string, kind = "file") => ({ name, isDirectory: () => kind === "dir", isFile: () => kind === "file" });
let requests: Array<{ url: string; body: Record<string, unknown> }>;
let handle: (url: string, init?: RequestInit) => Promise<Response>;
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  for (const name of ["CI", "GITHUB_SHA", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_WORKFLOW", "GITHUB_JOB", "GITHUB_ACTOR", "RENDRO_API_KEY"]) vi.stubEnv(name, "");
  io.readdir.mockResolvedValue([entry("index.html")]);
  io.readFile.mockResolvedValue(bytes); io.writeFile.mockResolvedValue(undefined); io.mkdir.mockResolvedValue(undefined);
  io.git.mockReturnValue("");
  requests = [];
  handle = (url) => Promise.resolve(Response.json(url.includes("/check?") ? { deployment: null, manifest: null }
    : url.endsWith("/start") ? { deployment: { deploymentId: "test" } }
    : url.includes("publications?") ? { publications: [] }
    : url.endsWith("/publications") ? { publication: { slug: "docs" }, url: "/p/docs" } : {}));
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    requests.push({ url: input, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {} });
    return handle(input, init);
  }));
});
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Run the real CLI entry point in-process so coverage observes capture and dispatch.
// Subprocess tests separately exercise Node, real git and the packaged executable.
async function run(args: string[], end: string, validationExit = false) {
  process.argv = ["node", "rendro", ...args];
  const output: string[] = [], errors: string[] = [];
  let finish!: () => void;
  const done = new Promise<void>(resolveDone => { finish = resolveDone; });
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    const line = values.map(String).join(" "); output.push(line);
    if (line.includes(end)) finish();
  });
  vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => { errors.push(values.map(String).join(" ")); });
  let exits = 0;
  vi.spyOn(process, "exit").mockImplementation(() => {
    exits++;
    if (validationExit && exits === 1) throw new Error("Test process exit");
    finish(); return undefined as never;
  });
  await import("../cli/src/index");
  await done;
  return { output: output.join("\n"), errors: errors.join("\n"), exits };
}
it.for([[], ["help"], ["--help"], ["--version"]])("handles informational arguments %j", async args => {
  const result = await run(args, args[0] === "--version" ? version : "Usage:");
  expect(result.exits).toBe(0); expect(requests).toHaveLength(0);
});
it.for([
  ["unknown"], ["push"], ["push", "--organization", "org"], ["push", ...identity],
  ["publication", "list"], ["publication", "list", "--organization", "org"], ["publication", "list", ...identity],
  ["publication", "remove", ...identity, "--token", "key"], ["publication", "create", ...identity, "--token", "key"],
  ["publication", "unknown", ...identity, "--token", "key"],
])("rejects incomplete commands %j before network activity", async args => {
  const result = await run(args, "never", true);
  expect(result.errors).toMatch(/required|Unknown command|action must/); expect(requests).toHaveLength(0);
});
it.for([[], ["--source", "custom"], ["--source"]])("initializes the selected source %j", async flags => {
  io.mkdir.mockRejectedValueOnce(new Error("already exists"));
  expect((await run(["init", ...flags], "Run: rendro push")).exits).toBe(0);
  expect(io.writeFile).toHaveBeenCalledWith(resolve(flags[1] ?? "docs", "index.html"), expect.stringContaining("Welcome"));
});
it.each([false, true])("creates tracked or pinned publications (%s)", async pinned => {
  vi.stubEnv("RENDRO_API_KEY", "key");
  const result = await run(["publication", "create", ...identity, "--slug", "docs", ...(pinned ? ["--pin", "deploy", "--path", "guide", "--entry", "home.html", "--title", "Guide", "--endpoint", "http://fixture.test/"] : [])], "Published docs:");
  expect(result.exits).toBe(0);
  expect(requests[0].body).toMatchObject({ trackingMode: pinned ? "pinned" : "track_active", slug: "docs" });
});
it.for([["--path", "../private"], ["--entry", "../private"]])("rejects unsafe publication paths %j", async flags => {
  const result = await run(["publication", "create", ...identity, "--token", "key", "--slug", "docs", ...flags], "never");
  expect(result.errors).toContain("Invalid publication path"); expect(requests).toHaveLength(0);
});
it.for([[], [{ _id: "one", slug: "docs", title: "Docs", trackingMode: "pinned" }, { _id: "two", slug: "other", trackingMode: "track_active" }]])("lists publication metadata %j", async publications => {
  handle = () => Promise.resolve(Response.json({ publications }));
  const result = await run(["publication", "list", ...identity, "--token", "key"], publications.length ? "two  other" : "No publications.");
  expect(result.exits).toBe(0);
});
it("removes a selected publication", async () => {
  expect((await run(["publication", "remove", ...identity, "--token", "key", "--id", "pub"], "Removed publication pub")).exits).toBe(0);
  expect(requests[0].body.publicationId).toBe("pub");
});
it.each(["local", "git", "github", "ci"])("sanitizes %s provenance through push dispatch", async mode => {
  vi.stubEnv("RENDRO_API_KEY", "key");
  if (mode === "local") io.git.mockImplementation(() => { throw new Error("not git"); });
  else io.git.mockImplementation((_command: string, args: string[]) => args[0] === "config" ? "https://user:secret@host/docs.git?token=secret#secret" : args[0] === "status" ? (mode === "git" ? "changed" : "") : "abc123");
  if (mode === "github") {
    for (const [name, value] of Object.entries({ CI: "true", GITHUB_ACTIONS: "true", GITHUB_SHA: "env-sha", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "team/docs", GITHUB_RUN_ID: "1" })) vi.stubEnv(name, value);
  }
  if (mode === "ci") vi.stubEnv("CI", "true");
  const result = await run(["push", ...identity], " total");
  expect(result.exits).toBe(0);
  const provenance = requests.find(request => request.url.endsWith("/start"))!.body.provenance;
  expect(JSON.stringify(provenance)).not.toContain("secret");
  expect(provenance).toMatchObject({ source: { kind: mode === "local" ? "local" : "git" }, execution: { kind: ["github", "ci"].includes(mode) ? "ci" : "local" } });
});
it("walks directories, sorts manifest entries and reuses only matching files", async () => {
  io.readdir.mockImplementation((directory: string) => Promise.resolve(directory === source
    ? [entry("z.bin"), entry("a.html"), entry("a.html"), entry(".git", "dir"), entry("node_modules", "dir"), entry("assets", "dir"), entry("pipe", "other")]
    : [entry("style.css")]));
  const fallback = handle;
  handle = (url, init) => url.includes("/check?") ? Promise.resolve(Response.json({ manifest: { files: [
    { path: "a.html", size: bytes.byteLength, sha256: hash },
    { path: "assets/style.css", size: 0, sha256: hash },
  ] } })) : fallback(url, init);
  const result = await run(["push", ...identity, "--token", "key", "--concurrency", "1"], " total");
  expect(result.output).toContain("2 uploaded, 2 reused");
  expect(io.readdir).toHaveBeenCalledWith(join(source, "assets"), expect.anything());
  expect(requests.find(request => request.url.includes("/copy?"))?.body).toEqual({ paths: ["a.html", "a.html"] });
});
it("rejects a noncanonical source filename before starting a deployment", async () => {
  io.readdir.mockResolvedValue([entry("bad\\name.html")]);
  expect((await run(["push", ...identity, "--token", "key"], "never")).errors).toContain("Invalid deployment path");
  expect(requests).toHaveLength(0);
});
it.each(["upload", "commit", "literal", "cleanup-error", "cleanup-literal"])("reports %s failures and attempts deployment cleanup", async failure => {
  const fallback = handle;
  handle = (url, init) => {
    if (url.includes("/files/")) {
      if (failure === "upload") return Promise.resolve(Response.json({ error: "Upload rejected" }, { status: 400 }));
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise non-Error transport failures.
      if (failure === "literal" || failure === "cleanup-literal") return Promise.reject("literal upload failure");
      if (failure === "cleanup-error") return Promise.reject(new Error("upload failure"));
    }
    if (url.includes("/commit?")) return Promise.resolve(Response.json({ error: "Commit rejected" }, { status: 409 }));
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Exercise non-Error cleanup failures.
    if (url.endsWith("/fail") && failure.startsWith("cleanup-")) return Promise.reject(failure === "cleanup-error" ? new Error("cleanup failure") : "literal cleanup failure");
    return fallback(url, init);
  };
  const result = await run(["push", ...identity, "--token", "key"], "never");
  expect(result.exits).toBe(1);
  expect(requests.some(request => request.url.endsWith("/fail"))).toBe(true);
  expect(result.errors).toContain(failure.startsWith("cleanup-") ? "Failed to mark deployment" : failure === "commit" ? "Commit rejected" : failure === "upload" ? "Upload failed" : "literal upload failure");
});

it("reports an expired upload lease as actionable conflict and attempts cleanup", async () => {
  const fallback = handle;
  handle = (url, init) => url.includes("/files/")
    ? Promise.resolve(Response.json({ error: "Staging lease expired. Run rendro push again to start a new deployment." }, { status: 409 }))
    : fallback(url, init);
  const result = await run(["push", ...identity, "--token", "key"], "never");
  expect(result.exits).toBe(1);
  expect(result.errors).toContain("409 Staging lease expired. Run rendro push again to start a new deployment.");
  expect(result.errors).not.toContain("Backend unavailable");
  expect(requests.some(request => request.url.endsWith("/fail"))).toBe(true);
  expect(requests.some(request => request.url.includes("/commit?"))).toBe(false);
});
