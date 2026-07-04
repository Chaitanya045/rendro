/**
 * Lazy tree — matches design.html spec with Material Symbols icons,
 * max-height animations, active indicator, and border-line indentation.
 */
const ORG = (document.querySelector("[data-tree-org]") as HTMLElement)?.dataset.treeOrg;
const DEV_USER = new URLSearchParams(location.search).get("dev_user") || "";
interface TreeNode { name: string; path: string; type: "file" | "folder"; size?: number; }

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

function updateIndicator(el: HTMLElement, animate = true) {
  const indicator = document.getElementById("active-indicator");
  if (!indicator || !TREE) return;
  activeEl = el;

  let visible = true;
  let cur: HTMLElement | null = el.parentElement;
  while (cur && cur !== TREE) {
    if (cur.classList.contains("tree-folder") && !cur.classList.contains("open")) { visible = false; break; }
    cur = cur.parentElement;
  }
  if (!visible) { indicator.style.opacity = "0"; return; }

  indicator.style.transition = animate
    ? "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease"
    : "none";
  const ir = el.getBoundingClientRect();
  const cr = TREE.getBoundingClientRect();
  indicator.style.opacity = "1";
  indicator.style.transform = `translate(${ir.left - cr.left}px, ${ir.top - cr.top}px)`;
}

// ── fold icon toggle ──

function setFolderIcon(folder: HTMLElement, open: boolean) {
  const icon = folder.querySelector(":scope > .tree-item .folder-icon") as HTMLElement | null;
  if (icon) icon.textContent = open ? "folder_open" : "folder";
}

// ── expand / collapse ──

const PAGE_SIZE = 50;

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
    await loadPage(folder, path, content, undefined);
    folder.classList.add("loaded", "open");
    setFolderIcon(folder, true);
    if (activeEl) updateIndicator(activeEl);
  } catch {
    content.innerHTML = `<div class="tree-error">Failed to load</div>`;
  } finally {
    folder.classList.remove("loading");
  }
}

async function loadPage(folder: HTMLElement, path: string, content: HTMLElement, startAfter?: string) {
  const url = `/api/tree/${ORG}?prefix=${encodeURIComponent(path)}&limit=${PAGE_SIZE}${startAfter ? `&startAfter=${encodeURIComponent(startAfter)}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json();

  const existingMore = content.querySelector(".tree-load-more");
  if (existingMore) existingMore.remove();

  const rows = renderRows(data.children as TreeNode[]);
  content.insertAdjacentHTML("beforeend", rows);

  if (data.isTruncated && data.nextStartAfter) {
    folder.dataset.nextStartAfter = data.nextStartAfter;
    content.insertAdjacentHTML("beforeend",
      `<div class="tree-load-more"><button class="load-more-btn">Load more...</button></div>`);
  }

  if (activeEl) updateIndicator(activeEl);
}

function collapse(folder: HTMLElement) {
  folder.classList.remove("open");
  setFolderIcon(folder, false);
  if (activeEl) updateIndicator(activeEl);
}

// ── rendering ──

function renderFile(node: TreeNode): string {
  const fp = `/files/${node.path}`;
  return `<div class="tree-item flex items-center gap-2 px-3 py-1.5 rounded-lg text-on-surface-variant cursor-pointer" data-path="${esc(node.path)}">
    <span class="material-symbols-outlined text-[18px] flex-shrink-0">article</span>
    <a href="${esc(fp)}" class="tree-link flex-1 min-w-0" target="content-frame">${esc(node.name)}</a>
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

  // Load-more button
  const loadMoreBtn = target.closest(".load-more-btn") as HTMLButtonElement | null;
  if (loadMoreBtn) {
    e.preventDefault();
    const folder = loadMoreBtn.closest(".tree-folder") as HTMLElement | null;
    if (folder) {
      const path = folder.dataset.path!;
      const content = folder.querySelector(":scope > .tree-folder-content") as HTMLElement | null;
      const next = folder.dataset.nextStartAfter;
      if (path && content && next) {
        loadMoreBtn.textContent = "Loading...";
        loadMoreBtn.disabled = true;
        loadPage(folder, path, content, next);
      }
    }
    return;
  }

  const item = target.closest(".tree-item") as HTMLElement | null;
  if (!item) return;

  const folder = item.parentElement?.classList.contains("tree-folder") ? item.parentElement as HTMLElement : null;
  if (folder) {
    e.preventDefault();
    folder.classList.contains("open") ? collapse(folder) : expand(folder);
    return;
  }

  if (item.dataset.path) {
    e.preventDefault();
    const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
    const placeholder = document.getElementById("main-placeholder");
    if (frame) { frame.style.display = "block"; frame.src = `/files/${item.dataset.path}${DEV_USER ? `?dev_user=${DEV_USER}` : ""}`; }
    if (placeholder) placeholder.style.display = "none";
    document.querySelectorAll(".tree-item.active").forEach((el) => el.classList.remove("active"));
    item.classList.add("active");
    updateIndicator(item, true);
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
  updateIndicator(item, true);
}

function init() {
  if (!TREE) return;
  TREE.addEventListener("click", handleClick);

  // Re-sync indicator after folder expand/collapse animations finish
  TREE.addEventListener("transitionend", (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("tree-folder-content") && activeEl) {
      updateIndicator(activeEl);
    }
  });
  window.addEventListener("message", (e) => {
    if (!e.data || typeof e.data.path !== "string") return;
    const { type, path } = e.data as { type: string; path: string };
    if (type === "doc-navigate") {
      const frame = document.getElementById("content-frame") as HTMLIFrameElement | null;
      const placeholder = document.getElementById("main-placeholder");
      if (frame) {
        frame.style.display = "block";
        frame.src = `/files/${ORG}/${path}${DEV_USER ? `?dev_user=${DEV_USER}` : ""}`;
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
