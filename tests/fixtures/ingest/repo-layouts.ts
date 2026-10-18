import type { TreeEntry } from "../../../src/ingest/detect";

/**
 * Realistic repository layouts, written as GitHub's recursive tree listing
 * would return them: blobs plus their directories, with fake SHAs. Each
 * one is modelled on how the generator's own quick-start lays out a project.
 */
export function tree(paths: string[]): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const dirs = new Set<string>();
  paths.forEach((path, index) => {
    entries.push({ path, type: "blob", sha: index.toString(16).padStart(40, "0"), size: 100 });
    for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) dirs.add(path.slice(0, at));
  });
  for (const dir of dirs) entries.push({ path: dir, type: "tree", sha: "f".repeat(40) });
  return entries;
}

const common = ["README.md", "LICENSE", ".gitignore", ".github/workflows/ci.yml", ".github/ISSUE_TEMPLATE/bug.md", "package.json"];

export const layouts = {
  mkdocs: tree([...common, "mkdocs.yml", "docs/index.md", "docs/getting-started.md", "docs/user-guide/configuration.md", "docs/user-guide/plugins.md", "docs/img/logo.png", "src/app.py", "requirements.txt"]),
  mkdocsCustomDir: tree([...common, "mkdocs.yml", "documentation/index.md", "documentation/usage.md", "docs/old.md"]),
  docusaurus: tree([...common, "website/docusaurus.config.ts", "website/sidebars.ts", "website/docs/intro.md", "website/docs/tutorial-basics/create-a-page.md", "website/docs/tutorial-basics/deploy.mdx", "website/blog/2026-01-01-welcome.md", "website/src/pages/index.tsx", "website/package.json"]),
  vitepress: tree([...common, "docs/.vitepress/config.mts", "docs/.vitepress/theme/index.ts", "docs/index.md", "docs/guide/what-is-it.md", "docs/guide/getting-started.md", "docs/api/reference.md"]),
  vitepressSrcDir: tree([...common, ".vitepress/config.ts", "src/index.md", "src/guide.md", "lib/index.ts"]),
  mdbook: tree(["README.md", "Cargo.toml", "src/main.rs", "guide/book.toml", "guide/src/SUMMARY.md", "guide/src/chapter_1.md", "guide/src/chapter_2/section.md", "guide/theme/index.hbs"]),
  sphinx: tree([...common, ".readthedocs.yaml", "docs/source/conf.py", "docs/source/index.rst", "docs/source/usage.md", "docs/source/api.md", "docs/Makefile", "pkg/__init__.py"]),
  sphinxRstOnly: tree([...common, "docs/conf.py", "docs/index.rst", "docs/usage.rst", "pkg/__init__.py"]),
  gitbook: tree([...common, ".gitbook.yaml", "book/README.md", "book/SUMMARY.md", "book/setup/install.md", "book/setup/configure.md"]),
  gitbookDefaultRoot: tree([".gitbook.yaml", "README.md", "SUMMARY.md", "chapter-1.md", "chapter-2/details.md"]),
  mintlify: tree([...common, "docs/docs.json", "docs/introduction.mdx", "docs/quickstart.mdx", "docs/api-reference/endpoint/get.mdx", "docs/logo/dark.svg"]),
  mintlifyLegacy: tree(["mint.json", "introduction.mdx", "quickstart.mdx"]),
  docsify: tree([...common, "docs/index.html", "docs/README.md", "docs/_sidebar.md", "docs/.nojekyll", "docs/guide.md", "docs/quickstart.md"]),
  plainDocs: tree([...common, "docs/README.md", "docs/install.md", "docs/usage/advanced.md", "docs/usage/basics.md", "docs/diagram.svg", "src/index.ts"]),
  prebuiltHtml: tree(["README.md", "site/index.html", "site/about.html", "site/guide/index.html", "site/guide/install.html", "site/assets/style.css", "site/assets/app.js"]),
  pagesDocsHtml: tree(["README.md", "docs/index.html", "docs/api.html", "docs/changelog.html", "docs/css/main.css"]),
  readmeOnly: tree(["README.md", "CONTRIBUTING.md", "Cargo.toml", "src/main.rs", "tests/fixtures/sample.md", ".github/PULL_REQUEST_TEMPLATE.md"]),
  monorepo: tree([
    "README.md", "package.json",
    "docs/README.md", "docs/architecture.md",
    "packages/core/README.md", "packages/core/docs/api.md", "packages/core/docs/internals.md",
    "packages/cli/mkdocs.yml", "packages/cli/docs/index.md", "packages/cli/docs/commands.md",
    "website/docusaurus.config.js", "website/docs/intro.md", "website/docs/guides/setup.md",
    "examples/demo/docs/README.md", "examples/demo/docs/run.md",
    "node_modules/some-lib/docs/README.md", "node_modules/some-lib/mkdocs.yml",
    "vendor/thing/docs/index.md",
  ]),
  empty: tree(["src/main.go", "go.mod"]),
} satisfies Record<string, TreeEntry[]>;
