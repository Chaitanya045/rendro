/**
 * Lazy tree — matches design.html spec with Material Symbols icons,
 * max-height animations, active indicator, and border-line indentation.
 */

interface TreeNode { name: string; path: string; type: "file" | "folder"; size?: number; }

const ORG = (document.querySelector("[data-tree-org]") as HTMLElement)?.dataset.treeOrg;
const TREE = document.getElementById("tree-container") as HTMLElement;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let activeEl: HTMLElement | null = null;

// ── active indicator ──

function updateIndicator(el: HTMLElement) {
  const indicator = document.getElementById("active-indicator");
  if (!indicator || !TREE) return;
  activeEl = el;

  // Check if visible (all parent folders must be open)
  let visible = true;
  let cur: HTMLElement | null = el.parentElement;
  while (cur && cur !== TREE) {
    if (cur.classList.contains("tree-folder") && !cur.classList.contains("open")) { visible = false; break; }
    cur = cur.parentElement;
  }
  if (!visible) { indicator.style.opacity = "0"; return; }

  const ir = el.getBoundingClientRect();
  const cr = TREE.getBoundingClientRect();
  indicator.style.transition = "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease";
  indicator.style.opacity = "1";
  indicator.style.transform = `translate(${ir.left - cr.left}px, ${ir.top - cr.top}px)`;
}

// ── fold icon toggle ──

function setFolderIcon(folder: HTMLElement, open: boolean) {
  const icon = folder.querySelector(":scope > .tree-item .folder-icon") as HTMLElement | null;
  if (icon) icon.textContent = open ? "folder_open" : "folder";
}

// ── expand / collapse ──

async function expand(folder: HTMLElement) {
  const path = folder.dataset.path;
  if (!path) return;
  const content = folder.querySelector(":scope > .tree-folder-content") as HTMLElement | null;
  if (!content) return;

  if (folder.classList.contains("loaded")) {
    folder.classList.add("open");
    setFolderIcon(folder, true);
    if (activeEl) updateIndicator(activeEl);
    return;
  }

  folder.classList.add("loading");
  try {
    const res = await fetch(`/api/tree/${ORG}?prefix=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    content.innerHTML = renderRows(data.children as TreeNode[]);
    folder.classList.add("loaded", "open");
    setFolderIcon(folder, true);
    if (activeEl) updateIndicator(activeEl);
  } catch {
    content.innerHTML = `<div class="tree-error">Failed to load</div>`;
  } finally {
    folder.classList.remove("loading");
  }
}

function collapse(folder: HTMLElement) {
  folder.classList.remove("open");
  setFolderIcon(folder, false);
  if (activeEl) updateIndicator(activeEl);
}

// ── rendering ──

function renderFile(node: TreeNode): string {
  const fp = `/files/${node.path}`;
  const meta = node.size != null ? `<span class="tree-size">${humanSize(node.size)}</span>` : "";
  return `<div class="tree-item flex items-center gap-2 px-3 py-1.5 rounded-lg text-on-surface-variant cursor-pointer" data-path="${esc(node.path)}">
    <span class="material-symbols-outlined text-[18px] flex-shrink-0">article</span>
    <a href="${esc(fp)}" class="tree-link flex-1 min-w-0" target="content-frame">${esc(node.name)}</a>
    ${meta}
  </div>`;
}

function renderFolder(node: TreeNode): string {
  const path = node.path.endsWith("/") ? node.path : `${node.path}/`;
  return `<div class="tree-folder" data-path="${esc(path)}">
    <div class="tree-item flex items-center gap-2 px-3 py-1.5 rounded-lg text-on-surface-variant cursor-pointer">
      <span class="material-symbols-outlined text-[18px] caret-icon flex-shrink-0">chevron_right</span>
      <span class="material-symbols-outlined text-[18px] folder-icon flex-shrink-0">folder</span>
      <span class="font-body-md flex-1 min-w-0">${esc(node.name)}</span>
    </div>
    <div class="tree-folder-content ml-4 space-y-0.5 border-l border-outline-variant/30 pl-2"></div>
  </div>`;
}

function renderRows(nodes: TreeNode[]): string {
  return nodes.map((n) => (n.type === "folder" ? renderFolder(n) : renderFile(n))).join("");
}

// ── event handling ──

function handleClick(e: Event) {
  const target = e.target as HTMLElement;
  const item = target.closest(".tree-item") as HTMLElement | null;
  if (!item) return;

  // Only toggle folder if this is the folder's OWN toggle item (direct child of .tree-folder)
  const folder = item.parentElement?.classList.contains("tree-folder") ? item.parentElement as HTMLElement : null;
  if (folder) {
    e.preventDefault();
    folder.classList.contains("open") ? collapse(folder) : expand(folder);
    return;
  }

  // File click: show iframe and set active
  if (item.dataset.path) {
    const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
    const placeholder = document.getElementById("main-placeholder");
    if (frame) frame.style.display = "";
    if (placeholder) placeholder.style.display = "none";
    document.querySelectorAll(".tree-item.active").forEach((el) => el.classList.remove("active"));
    item.classList.add("active");
    updateIndicator(item);
  }
}

async function navigateToDoc(relPath: string) {
  const fullPath = `${ORG}/${relPath}`;

  // Expand all ancestor folders (bottom-up to avoid race conditions)
  const ancestors: HTMLElement[] = [];
  // We don't have the item yet, so walk the path segments
  const parts = relPath.split("/");
  let currentPath = ORG!;
  for (let i = 0; i < parts.length - 1; i++) {
    currentPath += "/" + parts[i];
    const folder = document.querySelector(`.tree-folder[data-path="${CSS.escape(currentPath)}/"]`) as HTMLElement | null;
    if (folder) ancestors.push(folder);
  }

  // Expand each ancestor sequentially
  for (const folder of ancestors) {
    if (!folder.classList.contains("open")) {
      const toggle = folder.querySelector(":scope > .tree-item") as HTMLElement | null;
      if (toggle) {
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        // Wait for async expansion to complete
        await new Promise<void>((resolve) => {
          const check = () => {
            if (folder.classList.contains("open")) resolve();
            else setTimeout(check, 50);
          };
          check();
        });
      }
    }
  }

  // Now find and activate the item
  const item = document.querySelector(`.tree-item[data-path="${CSS.escape(fullPath)}"]`) as HTMLElement | null;
  if (!item) return;
  document.querySelectorAll(".tree-item.active").forEach((el) => el.classList.remove("active"));
  item.classList.add("active");
  updateIndicator(item);
}

function init() {
  if (!TREE) return;
  TREE.addEventListener("click", handleClick);
  document.querySelectorAll(".tree-folder.open").forEach((f) => setFolderIcon(f as HTMLElement, true));
  window.addEventListener("message", (e) => {
    if (!e.data || typeof e.data.path !== "string") return;
    const { type, path } = e.data as { type: string; path: string };
    if (type === "doc-navigate") {
      const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
      const placeholder = document.getElementById("main-placeholder");
      if (frame) {
        frame.style.display = "";
        frame.src = `/files/${ORG}/${path}`;
      }
      if (placeholder) placeholder.style.display = "none";
    }
    navigateToDoc(path);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
