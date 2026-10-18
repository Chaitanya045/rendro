import type { DocSet } from "@/ingest/detect";
import { RENDERER_VERSION } from "@/ingest/limits";
import { basenameOf, compareCodeUnits, dirnameOf, extensionOf, isWithin } from "@/ingest/paths";

export interface SidebarPage {
  type: "page";
  path: string;
  title: string;
}

export interface SidebarDirectory {
  type: "directory";
  path: string;
  title: string;
  /** The directory's own landing page (README or index), if it has one. */
  page: string | null;
  children: SidebarNode[];
}

export type SidebarNode = SidebarPage | SidebarDirectory;

export interface SidebarIndex {
  rendererVersion: number;
  root: string;
  entry: string;
  /** The entry page first, then the tree under the docs root. */
  nodes: SidebarNode[];
  truncated: boolean;
}

const INDEX_PAGE = /^(?:readme|index)\.(?:md|markdown|mdx|html?)$/i;
/** Navigation and partial files (SUMMARY.md, _sidebar.md) are not pages. */
const HIDDEN_PAGE = /^(?:summary\.md|_.*)$/i;

/**
 * Build the sidebar for one doc set. `titles` maps page paths to the title
 * found when the page was rendered (first heading or <title>). Pages without
 * one use a title derived from the file name, the way MkDocs does.
 */
export function buildSidebar(docSet: Pick<DocSet, "root" | "entry" | "pages" | "truncated">, titles: ReadonlyMap<string, string | null>): SidebarIndex {
  const titleOf = (path: string) => titles.get(path) || titleFromName(basenameOf(path));
  const root: SidebarDirectory = { type: "directory", path: docSet.root, title: "", page: null, children: [] };
  const directories = new Map<string, SidebarDirectory>([[docSet.root, root]]);
  const directoryFor = (dir: string): SidebarDirectory => {
    const existing = directories.get(dir);
    if (existing) return existing;
    const node: SidebarDirectory = { type: "directory", path: dir, title: titleFromName(basenameOf(dir)), page: null, children: [] };
    directories.set(dir, node);
    directoryFor(dirnameOf(dir)).children.push(node);
    return node;
  };
  for (const path of docSet.pages) {
    const name = basenameOf(path);
    if (path === docSet.entry || HIDDEN_PAGE.test(name) || path === docSet.root || !isWithin(path, docSet.root)) continue;
    const parent = directoryFor(dirnameOf(path));
    if (INDEX_PAGE.test(name) && parent !== root && parent.page === null) {
      parent.page = path;
      // An untitled landing page keeps the directory's own name ("README" says nothing).
      parent.title = titles.get(path) || parent.title;
    } else {
      parent.children.push({ type: "page", path, title: titleOf(path) });
    }
  }
  sortTree(root);
  const nodes: SidebarNode[] = [{ type: "page", path: docSet.entry, title: titleOf(docSet.entry) }, ...root.children];
  return { rendererVersion: RENDERER_VERSION, root: docSet.root, entry: docSet.entry, nodes, truncated: docSet.truncated };
}

function sortTree(directory: SidebarDirectory): void {
  // A directory sorts before a page of the same name; then the full path decides.
  directory.children.sort((a, b) => naturalCompare(nameOf(a), nameOf(b)) || typeRank(a) - typeRank(b) || compareCodeUnits(a.path, b.path));
  for (const child of directory.children) if (child.type === "directory") sortTree(child);
}

function typeRank(node: SidebarNode): number {
  return node.type === "directory" ? 0 : 1;
}

function nameOf(node: SidebarNode): string {
  const name = basenameOf(node.path);
  return node.type === "page" ? name.slice(0, name.length - extensionOf(name).length) : name;
}

/** "getting-started.md" -> "Getting started". */
export function titleFromName(name: string): string {
  const stem = name.slice(0, name.length - extensionOf(name).length).replace(/[-_]+/g, " ").trim() || name;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/**
 * Numbers compare by value ("2-setup" before "10-deploy"), text by lower-cased
 * code units, so the order is the same in every runtime. localeCompare's
 * order depends on the ICU data the runtime ships.
 */
export function naturalCompare(a: string, b: string): number {
  const left = a.toLowerCase().match(/\d+|\D+/g) ?? [];
  const right = b.toLowerCase().match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const p = x.replace(/^0+(?=\d)/, "");
      const q = y.replace(/^0+(?=\d)/, "");
      if (p.length !== q.length) return p.length - q.length;
      if (p !== q) return p < q ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return left.length - right.length || compareCodeUnits(a, b);
}
