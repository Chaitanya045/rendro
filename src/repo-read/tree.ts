/**
 * The snapshot's sidebar as the viewer's lazy tree reads it: one directory at
 * a time, `{ name, type, title }` children in sidebar order. Pages keep their
 * real repository paths (they are what links and the frame URLs name), so the
 * folders between the repository root and the docs root appear too; a deep
 * link expands them. A directory's landing page is its first child.
 */
import { titleFromName, type SidebarIndex, type SidebarNode } from "@/ingest/sidebar";
import { isCanonicalStorageKey } from "@/storage-boundary";

export interface TreeChild {
  name: string;
  type: "file" | "folder";
  title: string;
}

export const TREE_PAGE_SIZE = 200;

/** A directory query: the root (`""`) or a canonical path of at most 1,024 characters ending in `/`. */
export function validTreeDirectory(directory: string): boolean {
  if (directory === "") return true;
  const path = directory.slice(0, -1);
  return directory.endsWith("/") && path.length <= 1024 && isCanonicalStorageKey(path);
}
const indexes = new WeakMap<SidebarIndex, Map<string, TreeChild[]>>();

function buildIndex(sidebar: SidebarIndex, isPage: (path: string) => boolean): Map<string, TreeChild[]> {
  const directories = new Map<string, TreeChild[]>([["", []]]);
  const folders = new Map<string, TreeChild>();
  const folder = (dir: string): TreeChild[] => {
    let children = directories.get(dir);
    if (!children) {
      children = [];
      directories.set(dir, children);
      const parent = dir.slice(0, dir.slice(0, -1).lastIndexOf("/") + 1);
      const name = dir.slice(parent.length, -1);
      const entry: TreeChild = { name, type: "folder", title: titleFromName(name) };
      folders.set(dir, entry);
      folder(parent).push(entry);
    }
    return children;
  };
  const addPage = (path: string, title: string) => {
    if (!isCanonicalStorageKey(path) || !isPage(path)) return;
    const slash = path.lastIndexOf("/");
    const children = folder(path.slice(0, slash + 1));
    const name = path.slice(slash + 1);
    if (!children.some(child => child.name === name)) children.push({ name, type: "file", title: title || titleFromName(name) });
  };
  const visit = (node: SidebarNode) => {
    if (node.type === "directory") {
      if (!isCanonicalStorageKey(node.path)) return;
      folder(`${node.path}/`);
      // Also when the folder was created earlier, as an ancestor of another page.
      if (node.title) (folders.get(`${node.path}/`) as TreeChild).title = node.title;
      if (node.page) addPage(node.page, node.title);
      node.children.forEach(visit);
    } else addPage(node.path, node.title);
  };
  sidebar.nodes.forEach(visit);
  return directories;
}

/** One page of a directory (`""` is the repository root, others end in `/`), or null for an unknown directory. */
export function treePage(sidebar: SidebarIndex, isPage: (path: string) => boolean, directory: string, page: number): { children: TreeChild[]; more: boolean } | null {
  let index = indexes.get(sidebar);
  if (!index) {
    index = buildIndex(sidebar, isPage);
    indexes.set(sidebar, index);
  }
  const children = index.get(directory);
  if (!children) return null;
  const start = page * TREE_PAGE_SIZE;
  return { children: children.slice(start, start + TREE_PAGE_SIZE), more: start + TREE_PAGE_SIZE < children.length };
}
