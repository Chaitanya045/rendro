import { describe, expect, it } from "vitest";

import { configFilesToRead, detectDocs, MAX_CONFIG_BYTES, MAX_CONFIG_READS, MAX_DOC_PAGES, type DetectOptions, type DocSet, type TreeEntry } from "../src/ingest/detect";
import { layouts, tree } from "./fixtures/ingest/repo-layouts";

const summary = (set: DocSet | null) => set && { root: set.root, generator: set.generator, signal: set.signal, kind: set.kind, entry: set.entry };
const primary = (entries: TreeEntry[], options?: DetectOptions) => summary(detectDocs(entries, options).primary);
const configs = (entries: Record<string, string>) => ({ configs: new Map(Object.entries(entries)) });

/** Deterministic Fisher-Yates shuffle. */
function shuffled<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe("generator layouts", () => {
  it("MkDocs: docs_dir, defaulting to docs/", () => {
    expect(primary(layouts.mkdocs)).toEqual({ root: "docs", generator: "mkdocs", signal: "mkdocs.yml", kind: "markdown", entry: "docs/index.md" });
    expect(primary(layouts.mkdocsCustomDir, configs({ "mkdocs.yml": "site_name: X\ndocs_dir: 'documentation'  # custom\n" }))).toMatchObject({ root: "documentation", generator: "mkdocs", entry: "documentation/index.md" });
    // A docs_dir that leaves the repo falls back to the default.
    expect(primary(layouts.mkdocs, configs({ "mkdocs.yml": "docs_dir: ../../outside\n" }))).toMatchObject({ root: "docs", generator: "mkdocs" });
  });

  it("Docusaurus: docs/ next to the config", () => {
    expect(primary(layouts.docusaurus)).toEqual({ root: "website/docs", generator: "docusaurus", signal: "website/docusaurus.config.ts", kind: "markdown", entry: "website/docs/intro.md" });
  });

  it("VitePress: the parent of .vitepress, plus srcDir", () => {
    expect(primary(layouts.vitepress)).toEqual({ root: "docs", generator: "vitepress", signal: "docs/.vitepress/config.mts", kind: "markdown", entry: "docs/index.md" });
    expect(primary(layouts.vitepressSrcDir, configs({ ".vitepress/config.ts": "export default defineConfig({ title: 'x', srcDir: './src' })" }))).toMatchObject({ root: "src", generator: "vitepress", entry: "src/index.md" });
    expect(primary(layouts.vitepressSrcDir)).toMatchObject({ root: "", generator: "vitepress" });
  });

  it("mdBook: [book] src, defaulting to src/, never SUMMARY.md as the entry", () => {
    expect(primary(layouts.mdbook)).toEqual({ root: "guide/src", generator: "mdbook", signal: "guide/book.toml", kind: "markdown", entry: "guide/src/chapter_1.md" });
    expect(primary(tree(["book.toml", "pages/intro.md"]), configs({ "book.toml": "[book]\ntitle = \"T\"\nsrc = \"pages\"\n" }))).toMatchObject({ root: "pages", generator: "mdbook" });
  });

  it("Sphinx via Read the Docs, and conf.py next to an index", () => {
    const sphinx = primary(layouts.sphinx, configs({ ".readthedocs.yaml": "version: 2\nsphinx:\n  configuration: docs/source/conf.py\n" }));
    expect(sphinx).toEqual({ root: "docs/source", generator: "sphinx", signal: ".readthedocs.yaml", kind: "markdown", entry: "docs/source/api.md" });
    expect(primary(layouts.sphinx)).toMatchObject({ root: "docs/source", generator: "sphinx", signal: "docs/source/conf.py" });
    // reStructuredText is not rendered, so an rst-only project falls through to the README.
    expect(primary(layouts.sphinxRstOnly)).toMatchObject({ root: "", generator: "readme", entry: "README.md" });
  });

  it("Read the Docs pointing at MkDocs resolves that config's docs_dir", () => {
    const entries = tree([".readthedocs.yml", "site-docs/mkdocs.yml", "site-docs/content/index.md"]);
    expect(primary(entries, configs({ ".readthedocs.yml": "mkdocs:\n  configuration: site-docs/mkdocs.yml\n", "site-docs/mkdocs.yml": "docs_dir: content\n" }))).toMatchObject({ root: "site-docs/content", generator: "mkdocs", signal: ".readthedocs.yml" });
    // Unusable paths and unrelated keys produce no Read the Docs candidate.
    for (const config of ["sphinx:\n  configuration: /abs/conf.py\n", "mkdocs:\n  configuration: ../x.yml\n", "build:\n  os: ubuntu\n"]) {
      expect(detectDocs(tree([".readthedocs.yaml", "README.md"]), configs({ ".readthedocs.yaml": config })).docSets.map(({ generator }) => generator)).toEqual(["readme"]);
    }
  });

  it("GitBook: root from .gitbook.yaml, defaulting to the repo root", () => {
    expect(primary(layouts.gitbook, configs({ ".gitbook.yaml": "root: ./book/\n" }))).toEqual({ root: "book", generator: "gitbook", signal: ".gitbook.yaml", kind: "markdown", entry: "book/README.md" });
    expect(primary(layouts.gitbookDefaultRoot)).toEqual({ root: "", generator: "gitbook", signal: ".gitbook.yaml", kind: "markdown", entry: "README.md" });
  });

  it("Mintlify: docs.json (verified when read) or legacy mint.json", () => {
    expect(primary(layouts.mintlify, configs({ "docs/docs.json": '{"$schema":"https://mintlify.com/docs.json","navigation":{}}' }))).toEqual({ root: "docs", generator: "mintlify", signal: "docs/docs.json", kind: "markdown", entry: "docs/introduction.mdx" });
    // Unread, a docs.json beside MDX pages is still taken as Mintlify.
    expect(primary(layouts.mintlify)).toMatchObject({ generator: "mintlify" });
    // Another tool's docs.json is not.
    expect(primary(layouts.mintlify, configs({ "docs/docs.json": '{"items": []}' }))).toMatchObject({ root: "docs", generator: "folder" });
    // Unread and without MDX pages, a docs.json is just a JSON file.
    expect(primary(tree(["api/docs.json", "api/notes.md"]))).toBeNull();
    expect(primary(layouts.mintlifyLegacy)).toEqual({ root: "", generator: "mintlify", signal: "mint.json", kind: "markdown", entry: "introduction.mdx" });
  });

  it("Docsify: index.html with window.$docsify, or the tree-only hints", () => {
    const expected = { root: "docs", generator: "docsify", signal: "docs/index.html", kind: "markdown", entry: "docs/README.md" };
    expect(primary(layouts.docsify, configs({ "docs/index.html": "<script>window.$docsify = { name: 'x' }</script>" }))).toEqual(expected);
    expect(primary(layouts.docsify)).toEqual(expected);
    expect(primary(tree(["docs/index.html", "docs/.nojekyll", "docs/README.md"]))).toMatchObject({ generator: "docsify" });
    // Read and not Docsify: an ordinary docs folder.
    expect(primary(layouts.docsify, configs({ "docs/index.html": "<h1>Plain page</h1>" }))).toMatchObject({ root: "docs", generator: "folder", kind: "mixed" });
  });

  it("plain docs/ folder", () => {
    expect(primary(layouts.plainDocs)).toEqual({ root: "docs", generator: "folder", signal: "docs", kind: "markdown", entry: "docs/README.md" });
  });

  it("prebuilt HTML, including GitHub Pages /docs output", () => {
    expect(primary(layouts.prebuiltHtml)).toEqual({ root: "site", generator: "prebuilt-html", signal: "site/index.html", kind: "html", entry: "site/index.html" });
    expect(primary(layouts.pagesDocsHtml)).toEqual({ root: "docs", generator: "prebuilt-html", signal: "docs/index.html", kind: "html", entry: "docs/index.html" });
    expect(primary(tree(["index.html", "a.html", "b.html", "README.md"]))).toMatchObject({ root: "", generator: "prebuilt-html" });
    expect(primary(tree(["docs/_build/html/index.html", "docs/_build/html/a.html", "docs/_build/html/b.html", "docs/conf.py", "docs/index.rst"]))).toMatchObject({ root: "docs/_build/html", generator: "prebuilt-html" });
    // Two HTML files are not a site.
    expect(primary(tree(["build/index.html", "build/a.html"]))).toBeNull();
  });

  it("README only", () => {
    expect(primary(layouts.readmeOnly)).toEqual({ root: "", generator: "readme", signal: "README.md", kind: "markdown", entry: "README.md" });
    // Test fixtures and hidden folders are not pages of the root doc set.
    expect(detectDocs(layouts.readmeOnly).primary?.pages).toEqual(["CONTRIBUTING.md", "README.md"]);
    expect(primary(tree(["readme.markdown"]))).toMatchObject({ entry: "readme.markdown" });
  });

  it("no docs at all", () => {
    expect(detectDocs(layouts.empty)).toEqual({ primary: null, docSets: [] });
    expect(detectDocs([])).toEqual({ primary: null, docSets: [] });
  });

  it("GitHub Pages source", () => {
    const entries = tree(["README.md", "docs/a.md", "docs/b.md", "guide.md"]);
    expect(primary(entries, { pagesSource: "/" })).toMatchObject({ root: "", generator: "github-pages", signal: "github-pages" });
    expect(primary(entries, { pagesSource: "/docs" })).toMatchObject({ root: "docs", generator: "github-pages" });
    expect(primary(entries, { pagesSource: "/elsewhere" })).toMatchObject({ root: "docs", generator: "folder" });
  });
});

describe("monorepos", () => {
  it("returns every doc set in the documented order", () => {
    const sets = detectDocs(layouts.monorepo).docSets.map(summary);
    expect(sets).toEqual([
      { root: "website/docs", generator: "docusaurus", signal: "website/docusaurus.config.js", kind: "markdown", entry: "website/docs/intro.md" },
      { root: "packages/cli/docs", generator: "mkdocs", signal: "packages/cli/mkdocs.yml", kind: "markdown", entry: "packages/cli/docs/index.md" },
      { root: "docs", generator: "folder", signal: "docs", kind: "markdown", entry: "docs/README.md" },
      { root: "packages/core/docs", generator: "folder", signal: "packages/core/docs", kind: "markdown", entry: "packages/core/docs/api.md" },
      // Penalised: an example's docs rank after the project's own.
      { root: "examples/demo/docs", generator: "folder", signal: "examples/demo/docs", kind: "markdown", entry: "examples/demo/docs/README.md" },
    ]);
  });

  it("lets a stronger set absorb overlapping guesses", () => {
    // website/ (folder) contains website/docs (Docusaurus); docs/guide sits inside docs/.
    const sets = detectDocs(tree(["website/docusaurus.config.js", "website/docs/a.md", "website/readme.md", "docs/a.md", "docs/guide/b.md"])).docSets;
    expect(sets.map(({ root }) => root)).toEqual(["website/docs", "docs"]);
    // Nested configs are separate doc sets.
    expect(detectDocs(tree(["mkdocs.yml", "docs/a.md", "docs/sub/mkdocs.yml", "docs/sub/docs/b.md"])).docSets.map(({ root }) => root)).toEqual(["docs", "docs/sub/docs"]);
  });

  it("ignores dependencies, vendored code, hidden folders and deep folders", () => {
    const sets = detectDocs(tree(["node_modules/x/mkdocs.yml", "node_modules/x/docs/a.md", "vendor/y/docs/a.md", ".hidden/docs/a.md", "node_modules/z/docs/.vitepress/config.ts", "a/b/c/docs/deep.md", "a/docs/shallow.md"])).docSets;
    expect(sets.map(({ root }) => root)).toEqual(["a/docs"]);
  });
});

describe("determinism and robustness", () => {
  it("does not depend on listing order", () => {
    for (const [name, entries] of Object.entries(layouts)) {
      const expected = detectDocs(entries);
      for (const seed of [1, 2, 3]) expect(detectDocs(shuffled(entries, seed)), name).toEqual(expected);
    }
  });

  it("ignores invalid paths, non-blob entries and duplicates", () => {
    const entries: TreeEntry[] = [
      ...tree(["docs/a.md"]),
      { path: "docs/a.md", type: "blob", sha: "1".repeat(40) },
      { path: "../escape.md", type: "blob", sha: "2".repeat(40) },
      { path: "docs//b.md", type: "blob", sha: "3".repeat(40) },
      { path: "docs\\c.md", type: "blob", sha: "4".repeat(40) },
      { path: "docs/sub", type: "commit", sha: "5".repeat(40) },
      { path: "/abs.md", type: "blob", sha: "6".repeat(40) },
    ];
    expect(detectDocs(entries).primary?.pages).toEqual(["docs/a.md"]);
  });

  it("caps pages per doc set", () => {
    const paths = Array.from({ length: MAX_DOC_PAGES + 2 }, (_, i) => `docs/p${String(i).padStart(5, "0")}.md`);
    const set = detectDocs(tree(paths)).primary as DocSet;
    expect(set.pages).toHaveLength(MAX_DOC_PAGES);
    expect(set.truncated).toBe(true);
    expect(detectDocs(layouts.plainDocs).primary?.truncated).toBe(false);
  });

  it("chooses entries by name, then shallowest page, skipping navigation files", () => {
    expect(primary(tree(["docs/z.md", "docs/sub/a.md", "docs/Index.MD"]))).toMatchObject({ entry: "docs/Index.MD" });
    expect(primary(tree(["docs/z.md", "docs/sub/a.md", "docs/_sidebar.md", "docs/SUMMARY.md"]))).toMatchObject({ entry: "docs/z.md" });
    expect(primary(tree(["docs/SUMMARY.md", "docs/_sidebar.md"]))).toMatchObject({ entry: "docs/SUMMARY.md" });
  });

  it("excludes nested build output from a source root", () => {
    expect(detectDocs(tree(["docs/a.md", "docs/_site/a.html", "docs/_site/b.html"])).primary?.pages).toEqual(["docs/a.md"]);
  });
});

describe("configFilesToRead", () => {
  it("lists config files by priority, depth and path", () => {
    expect(configFilesToRead(layouts.monorepo)).toEqual(["packages/cli/mkdocs.yml"]);
    expect(configFilesToRead(tree([
      "z/index.html", "z/_sidebar.md", ".readthedocs.yaml", "docs/.vitepress/config.ts", "book.toml", "a/mkdocs.yaml", "mkdocs.yml", ".gitbook.yaml", "docs/docs.json", "x/index.html",
    ]))).toEqual(["docs/docs.json", ".gitbook.yaml", "mkdocs.yml", "a/mkdocs.yaml", "book.toml", "docs/.vitepress/config.ts", ".readthedocs.yaml", "z/index.html"]);
  });

  it("skips large files, ignored folders and anything past the cap", () => {
    const entries = tree(["mkdocs.yml", "node_modules/a/mkdocs.yml", ".github/book.toml"]);
    (entries[0] as TreeEntry).size = MAX_CONFIG_BYTES + 1;
    expect(configFilesToRead(entries)).toEqual([]);
    const many = tree(Array.from({ length: MAX_CONFIG_READS + 5 }, (_, i) => `p${String(i).padStart(2, "0")}/mkdocs.yml`));
    expect(configFilesToRead(many)).toHaveLength(MAX_CONFIG_READS);
    expect(configFilesToRead([{ path: "mkdocs.yml", type: "blob", sha: "0".repeat(40) }])).toEqual(["mkdocs.yml"]);
  });
});
