import { readJsString, readTomlString, readYamlNestedScalar, readYamlScalar } from "@/ingest/config-values";
import { basenameOf, compareCodeUnits, dirnameOf, extensionOf, isRepoPath, isWithin, joinRepoPath, resolveConfigDir } from "@/ingest/paths";

/** One entry of GitHub's recursive tree listing. */
export interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export type Generator =
  | "mintlify" | "gitbook" | "mkdocs" | "mdbook" | "vitepress" | "docusaurus" | "sphinx" | "docsify"
  | "github-pages" | "folder" | "prebuilt-html" | "readme";

export type DocsKind = "markdown" | "html" | "mixed";

export interface DocSet {
  /** Repo path of the docs root; "" is the repository root. */
  root: string;
  generator: Generator;
  /** The file (or Pages setting) that identified this doc set. */
  signal: string;
  kind: DocsKind;
  /** Repo path of the landing page. */
  entry: string;
  /** Renderable pages under the root, sorted by path. At most MAX_DOC_PAGES. */
  pages: string[];
  truncated: boolean;
}

export interface DocsDetection {
  /** The first doc set by the documented order, or null when the repo has no renderable docs. */
  primary: DocSet | null;
  /** Every doc set found (several in a monorepo), in the same order. */
  docSets: DocSet[];
}

export interface DetectOptions {
  /** Contents of files named by configFilesToRead. Missing files use each generator's default. */
  configs?: ReadonlyMap<string, string>;
  /** GitHub Pages `source.path` ("/" or "/docs"), when the caller knows it. */
  pagesSource?: string | null;
}

export const MAX_DOC_PAGES = 5000;
export const MAX_CONFIG_READS = 24;
export const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_FOLDER_DEPTH = 3;

const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);
const HTML = new Set([".html", ".htm"]);
/** Never part of this repository's own docs. */
const IGNORED = new Set(["node_modules", "vendor", "third_party", "bower_components", "jspm_packages"]);
/** Docs-shaped folders here are usually fixtures or samples; they rank after everything else. */
const PENALISED = new Set(["test", "tests", "__tests__", "testdata", "fixtures", "__fixtures__", "examples", "example", "samples", "e2e", "spec"]);
/** Build output nested inside a source docs root (Sphinx, Jekyll). */
const NESTED_OUTPUT = new Set(["_build", "_site"]);
const FOLDER_NAMES = new Set(["docs", "doc", "documentation", "website", "site", "guide", "guides", "book", "manual", "wiki", "handbook"]);
/** GitHub Pages also publishes prebuilt HTML from docs/. */
const PREBUILT_NAMES = new Set(["docs", "site", "build", "public", "_site", "out", "dist", "html", "book"]);
const ENTRY_NAMES = ["index.md", "index.mdx", "readme.md", "readme.mdx", "readme.markdown", "index.markdown", "index.html", "index.htm"];
/** Navigation files of mdBook, GitBook and Docsify, never a landing page. */
const NAVIGATION_FILE = /^(?:summary\.md|_[^/]*)$/i;
const VITEPRESS_CONFIG = /(?:^|\/)\.vitepress\/config\.(?:[cm]?[jt]s)$/;
const DOCUSAURUS_CONFIG = /^docusaurus\.config\.(?:[cm]?[jt]s)$/;

/**
 * Precedence of signals, strongest first. Doc sets are ordered by:
 *   1. not under a test/example folder,
 *   2. tier: generator config or Pages setting, then conventional folder, then prebuilt HTML, then README,
 *   3. depth of the signal's directory (shallower first),
 *   4. this precedence,
 *   5. more pages first,
 *   6. root path in code-unit order.
 * Every input is sorted first, so the result does not depend on listing order.
 */
const PRECEDENCE: Record<Generator, number> = {
  mintlify: 1, gitbook: 2, mkdocs: 3, mdbook: 4, vitepress: 5, docusaurus: 7, sphinx: 8, docsify: 9,
  "github-pages": 10, folder: 11, "prebuilt-html": 12, readme: 13,
};
/** Read the Docs points at a Sphinx or MkDocs config; it ranks between VitePress and Docusaurus. */
const READTHEDOCS_PRECEDENCE = 6;

interface Candidate {
  root: string;
  generator: Generator;
  signal: string;
  precedence: number;
  tier: number;
  signalDepth: number;
  /** Which pages count: prebuilt sets are HTML-only, README sets Markdown-only. */
  only: "markdown" | "html" | null;
}

function depthOf(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

function segmentsOf(path: string): string[] {
  return path === "" ? [] : path.split("/");
}

function excluded(path: string): boolean {
  return segmentsOf(path).some((segment) => segment.startsWith(".") || IGNORED.has(segment));
}

/** Repo paths are valid, sorted, de-duplicated blobs; everything else is ignored. */
function blobsOf(entries: readonly TreeEntry[]): string[] {
  return [...new Set(entries.filter((entry) => entry.type === "blob" && isRepoPath(entry.path)).map((entry) => entry.path))].sort(compareCodeUnits);
}

/**
 * Files whose contents refine detection, in a deterministic order, capped at
 * MAX_CONFIG_READS small blobs. Fetch these, then pass them to detectDocs.
 */
export function configFilesToRead(entries: readonly TreeEntry[]): string[] {
  const sizes = new Map(entries.map((entry) => [entry.path, entry.size]));
  const blobs = blobsOf(entries);
  const blobSet = new Set(blobs);
  const wanted: Array<[number, string]> = [];
  for (const path of blobs) {
    const size = sizes.get(path);
    if (size !== undefined && size > MAX_CONFIG_BYTES) continue;
    const name = basenameOf(path);
    const dir = dirnameOf(path);
    let priority = -1;
    if (name === "docs.json") priority = 0;
    else if (name === ".gitbook.yaml") priority = 1;
    else if (name === "mkdocs.yml" || name === "mkdocs.yaml") priority = 2;
    else if (name === "book.toml") priority = 3;
    else if (VITEPRESS_CONFIG.test(path)) priority = 4;
    else if (name === ".readthedocs.yaml" || name === ".readthedocs.yml") priority = 5;
    else if (name === "index.html" && docsifyHint(dir, blobSet)) priority = 6;
    // A config inside node_modules or a hidden folder never names this repo's docs (.vitepress itself excepted).
    if (priority >= 0 && !excluded(VITEPRESS_CONFIG.test(path) ? dirnameOf(dir) : dir)) wanted.push([priority, path]);
  }
  return wanted
    .sort(([pa, a], [pb, b]) => pa - pb || depthOf(dirnameOf(a)) - depthOf(dirnameOf(b)) || compareCodeUnits(a, b))
    .slice(0, MAX_CONFIG_READS)
    .map(([, path]) => path);
}

function docsifyHint(dir: string, blobs: ReadonlySet<string>): boolean {
  return blobs.has(joinRepoPath(dir, "_sidebar.md")) || (blobs.has(joinRepoPath(dir, ".nojekyll")) && blobs.has(joinRepoPath(dir, "README.md")));
}

/** Renderable pages per directory, so each candidate is a lookup rather than a scan. */
class PageIndex {
  private byDir = new Map<string, string[]>();

  constructor(blobs: readonly string[]) {
    for (const path of blobs) {
      const ext = extensionOf(path);
      if (!MARKDOWN.has(ext) && !HTML.has(ext)) continue;
      if (excluded(dirnameOf(path))) continue;
      // Credit every ancestor up to, but not past, a nested build-output folder.
      let dir = dirnameOf(path);
      for (;;) {
        this.add(dir, path);
        if (dir === "" || NESTED_OUTPUT.has(basenameOf(dir))) break;
        dir = dirnameOf(dir);
      }
    }
  }

  private add(dir: string, path: string): void {
    const list = this.byDir.get(dir);
    if (list) list.push(path);
    else this.byDir.set(dir, [path]);
  }

  pages(root: string, only: Candidate["only"]): string[] {
    let pages = this.byDir.get(root) ?? [];
    // At the repo root, test and example folders are not the project's docs.
    if (root === "") pages = pages.filter((path) => !penalised(dirnameOf(path)));
    if (only === null) return pages;
    const allowed = only === "markdown" ? MARKDOWN : HTML;
    return pages.filter((path) => allowed.has(extensionOf(path)));
  }
}

export function detectDocs(entries: readonly TreeEntry[], options: DetectOptions = {}): DocsDetection {
  const configs = options.configs ?? new Map<string, string>();
  const blobs = blobsOf(entries);
  const blobSet = new Set(blobs);
  const dirs = new Set<string>();
  for (const path of blobs) for (let dir = dirnameOf(path); dir !== ""; dir = dirnameOf(dir)) dirs.add(dir);
  const index = new PageIndex(blobs);
  const candidates: Candidate[] = [];
  const add = (root: string, generator: Generator, signal: string, signalDir: string, only: Candidate["only"] = null, precedence = PRECEDENCE[generator]) => {
    if (excluded(root)) return;
    const tier = precedence <= PRECEDENCE["github-pages"] ? 0 : generator === "folder" ? 1 : generator === "prebuilt-html" ? 2 : 3;
    candidates.push({ root, generator, signal, precedence, tier, signalDepth: depthOf(signalDir), only });
  };
  // An unusable configured value (absolute, outside the repo) falls back to the generator default.
  const configDir = (dir: string, value: string | null, fallback: string): string => resolveConfigDir(dir, value ?? fallback) ?? (resolveConfigDir(dir, fallback) as string);
  const mkdocsRoot = (path: string) => configDir(dirnameOf(path), readYamlScalar(configs.get(path) ?? "", "docs_dir"), "docs");

  for (const path of blobs) {
    const name = basenameOf(path);
    const dir = dirnameOf(path);
    const content = configs.get(path);
    if (excluded(dir) && !VITEPRESS_CONFIG.test(path)) continue;
    if (name === "mint.json" || (name === "docs.json" && (content === undefined ? index.pages(dir, "markdown").some((page) => page.endsWith(".mdx")) : /mintlify|"navigation"\s*:/.test(content)))) {
      add(dir, "mintlify", path, dir);
    } else if (name === ".gitbook.yaml") {
      add(configDir(dir, content === undefined ? null : readYamlScalar(content, "root"), "."), "gitbook", path, dir);
    } else if (name === "mkdocs.yml" || name === "mkdocs.yaml") {
      add(mkdocsRoot(path), "mkdocs", path, dir);
    } else if (name === "book.toml") {
      add(configDir(dir, content === undefined ? null : readTomlString(content, "book", "src"), "src"), "mdbook", path, dir);
    } else if (VITEPRESS_CONFIG.test(path)) {
      const project = dirnameOf(dir);
      add(configDir(project, content === undefined ? null : readJsString(content, "srcDir"), "."), "vitepress", path, project);
    } else if ((name === ".readthedocs.yaml" || name === ".readthedocs.yml") && content !== undefined) {
      // Read the Docs paths are relative to the repository root.
      const sphinx = readYamlNestedScalar(content, "sphinx", "configuration");
      const mkdocs = readYamlNestedScalar(content, "mkdocs", "configuration");
      const sphinxConf = sphinx === null ? null : resolveConfigDir("", sphinx);
      const mkdocsConf = mkdocs === null ? null : resolveConfigDir("", mkdocs);
      if (sphinxConf !== null) add(dirnameOf(sphinxConf), "sphinx", path, dir, null, READTHEDOCS_PRECEDENCE);
      else if (mkdocsConf !== null) add(mkdocsRoot(mkdocsConf), "mkdocs", path, dir, null, READTHEDOCS_PRECEDENCE);
    } else if (DOCUSAURUS_CONFIG.test(name)) {
      add(joinRepoPath(dir, "docs"), "docusaurus", path, dir);
    } else if (name === "conf.py" && ["index.rst", "index.md", "index.txt"].some((file) => blobSet.has(joinRepoPath(dir, file)))) {
      add(dir, "sphinx", path, dir);
    } else if (name === "index.html" && (content === undefined ? docsifyHint(dir, blobSet) : content.includes("window.$docsify"))) {
      add(dir, "docsify", path, dir);
    }
  }
  if (options.pagesSource === "/" || options.pagesSource === "/docs") {
    const root = options.pagesSource === "/" ? "" : "docs";
    add(root, "github-pages", "github-pages", root);
  }
  for (const dir of [...dirs].sort(compareCodeUnits)) {
    // A conventional folder must hold Markdown; HTML-only folders are judged as prebuilt output below.
    if (depthOf(dir) <= MAX_FOLDER_DEPTH && FOLDER_NAMES.has(basenameOf(dir).toLowerCase()) && index.pages(dir, "markdown").length) add(dir, "folder", dir, dir);
  }
  for (const dir of ["", ...[...dirs].sort(compareCodeUnits)]) {
    const prebuilt = dir === "" || PREBUILT_NAMES.has(basenameOf(dir).toLowerCase()) || dir === "_build/html" || dir.endsWith("/_build/html");
    if (prebuilt && blobSet.has(joinRepoPath(dir, "index.html")) && index.pages(dir, "html").length >= 3) add(dir, "prebuilt-html", joinRepoPath(dir, "index.html"), dir, "html");
  }
  const readme = blobs.find((path) => !path.includes("/") && /^readme\.(?:md|markdown|mdx)$/i.test(path));
  if (readme) add("", "readme", readme, "", "markdown");

  return finalize(candidates, index);
}

function penalised(root: string): boolean {
  return segmentsOf(root).some((segment) => PENALISED.has(segment.toLowerCase()));
}

function finalize(candidates: Candidate[], index: PageIndex): DocsDetection {
  const built = candidates
    // Docsify's index.html is the app shell that renders the Markdown, not a page.
    .map((candidate) => ({ candidate, pages: index.pages(candidate.root, candidate.only).filter((page) => candidate.generator !== "docsify" || page !== candidate.signal) }))
    .filter(({ pages }) => pages.length > 0)
    .sort((a, b) =>
      Number(penalised(a.candidate.root)) - Number(penalised(b.candidate.root))
      || a.candidate.tier - b.candidate.tier
      || a.candidate.signalDepth - b.candidate.signalDepth
      || a.candidate.precedence - b.candidate.precedence
      || b.pages.length - a.pages.length
      || compareCodeUnits(a.candidate.root, b.candidate.root)
      || compareCodeUnits(a.candidate.signal, b.candidate.signal));

  const kept: typeof built = [];
  for (const item of built) {
    const { root, tier } = item.candidate;
    const overlaps = kept.some(({ candidate }) => {
      if (candidate.root === root) return true;
      // Folder and prebuilt guesses yield to any overlapping stronger set; README only stands alone.
      if (tier === 3) return true;
      return tier > 0 && (isWithin(root, candidate.root) || (candidate.tier === 0 && isWithin(candidate.root, root)));
    });
    if (!overlaps) kept.push(item);
  }
  const docSets = kept.map(({ candidate, pages }) => docSet(candidate, pages));
  return { primary: docSets[0] ?? null, docSets };
}

function docSet(candidate: Candidate, pages: string[]): DocSet {
  const markdown = pages.some((page) => MARKDOWN.has(extensionOf(page)));
  const html = pages.some((page) => HTML.has(extensionOf(page)));
  return {
    root: candidate.root,
    generator: candidate.generator,
    signal: candidate.signal,
    kind: markdown && html ? "mixed" : markdown ? "markdown" : "html",
    entry: candidate.generator === "readme" ? candidate.signal : entryOf(candidate.root, pages),
    pages: pages.slice(0, MAX_DOC_PAGES),
    truncated: pages.length > MAX_DOC_PAGES,
  };
}

function entryOf(root: string, pages: readonly string[]): string {
  const direct = pages.filter((page) => dirnameOf(page) === root);
  for (const name of ENTRY_NAMES) {
    const match = direct.find((page) => basenameOf(page).toLowerCase() === name);
    if (match) return match;
  }
  const content = pages.filter((page) => !NAVIGATION_FILE.test(basenameOf(page)));
  const ordered = (content.length ? content : pages).slice().sort((a, b) => depthOf(a) - depthOf(b) || compareCodeUnits(a, b));
  return ordered[0];
}
