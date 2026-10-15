import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sourceFiles } from "../cli/src/source-files";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "rendro-source-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function file(path: string, content = "synthetic fixture") {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}
const sensitive = [".env", ".env.qa", ".env.local", ".envrc", ".envrc.local", ".ENVRC.QA", ".npmrc", ".pypirc", ".netrc", ".git-credentials",
  "certificate.pem", "private.key", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "id_ed25519_sk", "id_custom",
  ".ENV.QA", "CERT.PEM", "KEY.KEY"];

it.each([false, true])("filters sensitive files at every depth, includeSensitive=%s", async include => {
  const paths = [...sensitive, ...sensitive.map(path => `nested/${path}`), "index.html", ".nojekyll", "nested/good.txt", ".environment"];
  await Promise.all(paths.map(path => file(path)));
  await Promise.all([".git/config", ".cache/data", "node_modules/package/index.js", ".aws/credentials", "nested/.aws/credentials", ".ssh/config", ".SSH/config"].map(path => file(path)));
  await symlink(join(root, "index.html"), join(root, "link.html"));
  await symlink(join(root, "nested"), join(root, "linked-folder"));
  const skipped: string[] = [];
  const files = (await sourceFiles(root, include, (path, reason) => skipped.push(`${path}:${reason}`))).map(path => relative(root, path));
  expect(files.sort()).toEqual((include ? paths : ["index.html", ".nojekyll", "nested/good.txt", ".environment"]).sort());
  expect(skipped).toContain("link.html:not a regular file");
  expect(skipped).toContain("linked-folder:not a regular file");
  expect(skipped).toContain(".git/:excluded directory");
  expect(skipped).toContain("node_modules/:excluded directory");
  expect(skipped).toContain("nested/.aws/:excluded directory");
  if (!include) {
    expect(skipped).toContain(".env:sensitive");
    expect(skipped).toContain("nested/id_rsa:sensitive");
  }
});
it.each([false, true])("honors root ignore rules even with sensitive opt-in=%s", async include => {
  await file(".rendroignore", "# local policy\n*.txt\n!keep.txt\ncache/\n!cache/kept.html\n.env\n!.env.qa\nnested/*.map\n/root-only.html\n");
  const paths = ["omit.txt", "keep.txt", "nested/keep.txt", "nested/omit.txt", "cache/kept.html", "cache/other.html", ".env", ".env.qa", "nested/site.map", "nested/root-only.html", "root-only.html", "nested/.rendroignore", "index.html"];
  await Promise.all(paths.map(path => file(path)));
  const skipped: string[] = [];
  const files = await sourceFiles(root, include, (path, reason) => skipped.push(`${path}:${reason}`));
  expect(files.map(path => relative(root, path)).sort()).toEqual(["keep.txt", "nested/keep.txt", "nested/root-only.html", "index.html", ...(include ? [".env.qa"] : [])].sort());
  expect(skipped).toContain("cache/:.rendroignore");
  expect(skipped).toContain(".rendroignore:ignore file");
  expect(skipped).toContain("nested/.rendroignore:ignore file");
  expect(skipped).toContain(`.env:${include ? ".rendroignore" : "sensitive"}`);
});
it("allows re-including a directory before selecting its children", async () => {
  await file(".rendroignore", "cache/\n!cache/\ncache/*\n!cache/keep.html\n");
  await file("cache/keep.html"); await file("cache/drop.html");
  expect(await sourceFiles(root, false, () => {})).toEqual([join(root, "cache/keep.html")]);
});
it("fails closed when the root ignore file cannot be read", async () => {
  await mkdir(join(root, ".rendroignore"));
  await expect(sourceFiles(root, false, () => {})).rejects.toMatchObject({ code: "EISDIR" });
});

it.each([false, true])("requires ignore negation to traverse real dot-directories, includeSensitive=%s", async include => {
  const paths = [".environment/index.html", ".environment/.nested/index.html", "nested/.environment/index.html", ".cache/index.html", "index.html"];
  await Promise.all(paths.map(path => file(path)));
  const selected = async () => (await sourceFiles(root, include, () => {})).map(path => relative(root, path)).sort();
  expect(await selected()).toEqual(["index.html"]);
  // Negating a child cannot traverse its still-excluded parent.
  await file(".rendroignore", "!.environment/index.html\n");
  expect(await selected()).toEqual(["index.html"]);
  await file(".rendroignore", "!.environment/\n");
  expect(await selected()).toEqual([".environment/index.html", "index.html", "nested/.environment/index.html"]);
  await file(".rendroignore", "!.environment/\n!.nested/\n.environment/\n!/nested/.environment/\n");
  expect(await selected()).toEqual(["index.html", "nested/.environment/index.html"]);
  await file(".rendroignore", "!.environment/\n!.nested/\n");
  expect(await selected()).toEqual(paths.filter(path => !path.startsWith(".cache/")).sort());
});
it.each([false, true])("never re-includes metadata or credential directories, includeSensitive=%s", async include => {
  const directories = [".git", ".ssh", ".aws", "node_modules", ".SSH", ".AWS", ".GIT", "NODE_MODULES"];
  await Promise.all(directories.flatMap(dir => [file(`${dir}/index.html`), file(`nested/${dir}/index.html`)]));
  await file(".environment/index.html");
  await file(".rendroignore", "!**/\n");
  expect(await sourceFiles(root, include, () => {})).toEqual([join(root, ".environment/index.html")]);
});
