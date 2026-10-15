import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { captureCliPush } from "./helpers/cli-push";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "rendro-upload-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const css = Buffer.from('@charset "windows-1252"; p::before{content:"caf\xe9 \x80"}', "latin1");
it.each([false, true])("pushes byte-exact assets and prints exclusions (bundle=%s)", async bundle => {
  const assets: Record<string, Buffer> = {
    "style.css": css,
    "index.html": Buffer.from('<meta charset="windows-1252"><p>caf\xe9</p>', "latin1"),
    "ascii.txt": Buffer.from("ASCII"),
    "utf8.js": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const text = "café €"')]),
    "utf16.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("café", "utf16le")]),
    "utf16be.txt": Buffer.from([0xfe, 0xff, 0, 65]),
  };
  for (const [path, bytes] of Object.entries(assets)) await writeFile(join(root, path), bytes);
  await mkdir(join(root, ".aws"));
  for (const path of [".env", ".env.qa", ".envrc", ".envrc.local", ".npmrc", "private.key", "id_rsa", ".aws/credentials", "omit.txt"]) {
    await writeFile(join(root, path), "SYNTHETIC_SENSITIVE_CONTENT");
  }
  await writeFile(join(root, ".rendroignore"), "omit.txt\n!.env\n!.envrc\n!.envrc.local\n");
  const result = await captureCliPush(root, { bundle });
  expect(result.manifest.files.map(file => file.path)).toEqual(Object.keys(assets).sort());
  expect(result.manifestSha256).toBe(createHash("sha256").update(JSON.stringify(result.manifest)).digest("hex"));
  const types = ["text/plain", "text/html", "text/css", "text/plain; charset=utf-16le", "text/plain; charset=utf-16be", "text/javascript; charset=utf-8"];
  expect(result.manifest.files.map(file => file.contentType)).toEqual(types);
  for (const file of result.manifest.files) {
    expect(file.sha256).toBe(createHash("sha256").update(assets[file.path]).digest("hex"));
    expect(file.size).toBe(assets[file.path].length);
    expect(result.uploads.get(file.path)).toEqual({ bytes: assets[file.path], contentType: file.contentType });
  }
  for (const path of [".env", ".env.qa", ".envrc", ".envrc.local", ".npmrc", "private.key", "id_rsa", ".aws/", "omit.txt", ".rendroignore"]) {
    expect(result.stdout).toContain(`skipped ${JSON.stringify(path)}`);
  }
  expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_SENSITIVE_CONTENT");
  expect(result.commits).toBe(1);

  await writeFile(join(root, ".rendroignore"), "omit.txt\n.env\n");
  const included = await captureCliPush(root, { bundle, flags: ["--include-sensitive"] });
  expect([...included.uploads.keys()].sort()).toEqual([...Object.keys(assets), ".env.qa", ".envrc", ".envrc.local", ".npmrc", "private.key", "id_rsa"].sort());
  expect(included.stdout).toContain('skipped ".env" (.rendroignore)');
  expect(included.stdout).not.toContain('(sensitive)');
});
it("reuses bytes from old UTF-8 manifests while recording corrected metadata", async () => {
  await writeFile(join(root, "style.css"), css);
  const old = { path: "style.css", sha256: createHash("sha256").update(css).digest("hex"), size: css.length, contentType: "text/css; charset=utf-8" };
  const result = await captureCliPush(root, { previous: [old] });
  expect(result.manifest.files).toEqual([{ ...old, contentType: "text/css" }]);
  expect(old.contentType).toBe("text/css; charset=utf-8");
  expect(result.copied).toEqual(["style.css"]);
  expect(result.uploads.size).toBe(0);
  expect(result.commits).toBe(1);
});
it("stops before deployment when .rendroignore cannot be read", async () => {
  await mkdir(join(root, ".rendroignore"));
  await writeFile(join(root, "index.html"), "<p>docs</p>");
  await expect(captureCliPush(root)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("EISDIR"), requests: [] });
});

it.each([false, true].flatMap(bundle => [false, true].flatMap(includeSensitive =>
  [false, true].map(negate => ({ bundle, includeSensitive, negate })),
)))("selects dot-directories with bundle=$bundle, includeSensitive=$includeSensitive, negate=$negate", async ({ bundle, includeSensitive, negate }) => {
  for (const dir of [".environment", ".cache", ".git", ".ssh", ".aws", "node_modules"]) {
    await mkdir(join(root, dir));
    await writeFile(join(root, dir, "index.html"), `<p>${dir}</p>`);
  }
  await writeFile(join(root, "index.html"), "<p>root</p>");
  if (negate) await writeFile(join(root, ".rendroignore"), "!.environment/\n!.git/\n!.ssh/\n!.aws/\n!node_modules/\n");
  // One subprocess per case keeps cold CLI startup within the test budget.
  const result = await captureCliPush(root, { bundle, flags: includeSensitive ? ["--include-sensitive"] : [] });
  const expected = negate ? [".environment/index.html", "index.html"] : ["index.html"];
  expect(result.manifest.files.map(file => file.path)).toEqual(expected);
  expect([...result.uploads.keys()].sort()).toEqual(expected);
  if (negate) expect(result.uploads.get(".environment/index.html")?.bytes).toEqual(Buffer.from("<p>.environment</p>"));
  expect(result.commits).toBe(1);
});
