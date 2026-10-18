import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildStyles, diffStyleBuild, runStyleBuild, styleDirectory, styleSources, writeStyleBuild } from "../scripts/styles/build";
import worker from "@/worker";
import { renderStylesheet, styleCacheControl, styleResponseHeaders } from "@/routes/styles";
import { styleManifest } from "@/routes/style-manifest";
import { renderScopedDocumentShell } from "@/routes/app";
import { securityHeaders } from "@/middleware/security-headers";

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
import { app as local } from "@/index";

const repo = process.cwd();
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "rendro-styles-"));
const build = buildStyles(repo);
const file = styleManifest["viewer-base"];
afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sources = Object.keys(styleSources).length;

function project(): string {
  const root = mkdtempSync(join(scratch, "project-"));
  mkdirSync(join(root, "src/styles"), { recursive: true });
  for (const source of Object.values(styleSources)) writeFileSync(join(root, source), `a{color:red}/* ${source} */\n`);
  return root;
}

describe("viewer stylesheet build", () => {
  it("matches the committed files byte for byte", () => {
    expect(diffStyleBuild(repo, build)).toEqual([]);
    expect([...build.files.keys()]).toEqual(Object.values(styleManifest));
    for (const [name, source] of Object.entries(styleSources)) {
      const committed = styleManifest[name as keyof typeof styleManifest];
      expect(committed).toMatch(new RegExp(`^${name}\\.[0-9a-f]{10}\\.css$`));
      expect(readFileSync(join(repo, styleDirectory, committed))).toEqual(readFileSync(join(repo, source)));
    }
  });

  it("reports drift: missing, changed and stale files and an outdated manifest", () => {
    const root = project();
    const fresh = buildStyles(root);
    const names = [...fresh.files.keys()];
    const [name] = names;
    expect(diffStyleBuild(root, fresh).sort()).toEqual([...names.map(file => `public/styles/${file} is missing`), "src/routes/style-manifest.ts is out of date"].sort());
    mkdirSync(join(root, "src/routes"), { recursive: true });
    writeStyleBuild(root, fresh);
    expect(diffStyleBuild(root, fresh)).toEqual([]);
    writeFileSync(join(root, styleDirectory, name), "changed");
    writeFileSync(join(root, styleDirectory, "viewer-base.0000000000.css"), "old");
    writeFileSync(join(root, "src/routes/style-manifest.ts"), "stale");
    expect(diffStyleBuild(root, fresh).sort()).toEqual([
      "public/styles/viewer-base.0000000000.css is stale",
      `public/styles/${name} differs from its source`,
      "src/routes/style-manifest.ts is out of date",
    ].sort());
    writeStyleBuild(root, fresh);
    expect(readdirSync(join(root, styleDirectory)).sort()).toEqual([...names].sort());
  });

  it("renames the output when the source changes", () => {
    const root = project();
    const before = [...buildStyles(root).files.keys()];
    writeFileSync(join(root, styleSources["viewer-base"]), "a{color:blue}\n");
    expect([...buildStyles(root).files.keys()]).not.toEqual(before);
  });

  it("builds, verifies and detects drift through the CLI entry", () => {
    const root = project();
    mkdirSync(join(root, "src/routes"), { recursive: true });
    const log = vi.fn();
    expect(runStyleBuild(root, ["--check"], log)).toBe(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Run pnpm build:styles"));
    expect(runStyleBuild(root, [], log)).toBe(0);
    expect(log).toHaveBeenLastCalledWith(`Built ${sources} style files.`);
    expect(runStyleBuild(root, ["--check"], log)).toBe(0);
    expect(log).toHaveBeenLastCalledWith(`Styles verified (${sources} files).`);
  });

  it("runs against the working directory with the real console", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const argv = process.argv;
    const code = process.exitCode;
    process.argv = [argv[0], "scripts/build-styles.ts", "--check"];
    try {
      await import("../scripts/build-styles");
      expect(info).toHaveBeenCalledWith(`Styles verified (${sources} files).`);
      expect(process.exitCode).toBe(0);
    } finally {
      process.argv = argv;
      process.exitCode = code;
      info.mockRestore();
    }
  });
});

describe("self-hosted stylesheet responses", () => {
  const assetsFor = (bytes: Buffer) => ({ fetch: vi.fn(() => Promise.resolve(new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream" } }))) });

  it("marks hashed stylesheets immutable with the CSS MIME type", () => {
    expect(styleCacheControl).toBe("public, max-age=31536000, immutable");
    expect(styleResponseHeaders(`/styles/${file}`)).toEqual({ "Content-Type": "text/css; charset=utf-8", "Cache-Control": styleCacheControl });
  });

  it.each(["/styles/viewer-base.css", "/styles/viewer-base.ABCDEF0123.css", "/styles/sub/viewer-base.abcdef0123.css", "/styles/viewer-base.abcdef0123.js", "/styles/", "/styles/%2e%2e/worker.ts"])(
    "does not treat %s as a stylesheet", path => expect(styleResponseHeaders(path)).toBeUndefined());

  it("serves the stylesheet identically from Node and the Worker without a session", async () => {
    const path = `/styles/${file}`;
    const bytes = readFileSync(`public${path}`);
    const assets = assetsFor(bytes);
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockClear();
    for (const response of [await local.request(path), await worker.request(path, {}, { ASSETS: assets })]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe(styleCacheControl);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    expect(assets.fetch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["/styles/viewer-base.css", "/styles/", "/styles/viewer-base.0123456789.css"])("returns a non-immutable 404 for %s", async path => {
    const assets = { fetch: vi.fn(() => Promise.resolve(new Response("missing", { status: 404 }))) };
    for (const response of [await local.request(path), await worker.request(path, {}, { ASSETS: assets })]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("keeps the outer security headers without replacing the cache policy", async () => {
    const app = new Hono().use(securityHeaders).get("/styles/x", c => c.body("x", 200, styleResponseHeaders(`/styles/${file}`)!));
    const response = await app.request("https://rendro.test/styles/x");
    expect(response.headers.get("cache-control")).toBe(styleCacheControl);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});

describe("viewer shell without the Tailwind runtime", () => {
  const html = renderScopedDocumentShell({ user: null, namespace: "org", title: "Docs", basePath: "/p/docs", selectedPath: "" });
  const shellCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join("\n")
    + readFileSync(join(repo, styleSources["viewer-base"]), "utf8");

  it("links the hashed base stylesheet as the last head element and loads no third-party script", () => {
    expect(renderStylesheet("viewer-base")).toBe(`<link rel="stylesheet" href="/styles/${file}">`);
    expect(html).toContain(`${renderStylesheet("viewer-base")}\n<body>`);
    expect(html.indexOf(renderStylesheet("viewer-base"))).toBeGreaterThan(html.lastIndexOf("</style>", html.indexOf("<body>")));
    expect(html).not.toMatch(/tailwind/i);
    expect(html).not.toMatch(/<script[^>]+src="(?:https?:)?\/\//i);
  });

  it("styles every class the shell and document tree render", () => {
    const tree = readFileSync(join(repo, "src/lazy-tree/lazy-tree.ts"), "utf8");
    const classes = new Set<string>();
    for (const source of [html, tree]) {
      for (const [, list] of source.matchAll(/class="([^"$]*)"/g)) for (const name of list.split(/\s+/)) if (name) classes.add(name);
    }
    // Hooks that only scripts read. A Tailwind utility left in markup would fail here.
    for (const hook of ["shell-toggle", "folder-retry-btn", "tree-load-more", "tree-root-retry-btn"]) classes.delete(hook);
    const unstyled = [...classes].filter(name => !new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w-])`).test(shellCss));
    expect(unstyled).toEqual([]);
    expect([...classes]).toEqual(expect.arrayContaining(["tree-item", "tree-icon", "tree-folder-name", "tree-stack"]));
  });
});
