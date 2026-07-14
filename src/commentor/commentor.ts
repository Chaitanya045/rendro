// commentor.ts — a drop-in commenting widget for any HTML file.
//
//   <script>window.COMMENTOR = { convexUrl, orgSlug, filePath, author? };</script>
//   <script src="/commentor.js"></script>
//
// Figma-style pins + inline bubbles. The widget is a single surface that
// DOCKS to a screen edge (magnetic, springy snap; stays where you dropped it
// ALONG the edge — never force-centered) and EXPANDS smoothly into the
// comments list (the dock grows; the toolbar is its handle). Open shadow root.

import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// ─────────────────────────────── types ───────────────────────────────

interface Author {
  name: string;
  email: string;
}
interface Config {
  convexUrl: string;
  orgSlug: string;
  filePath: string;
  author?: Author;
}
type Anchor =
  | {
      kind: "text-range";
      quote: string;
      path: string[];
      startOffset: number;
      endOffset: number;
    }
  | { kind: "element"; path: string[] };
interface Reply {
  _id: Id<"replies">;
  _creationTime: number;
  authorEmail: string;
  authorName: string;
  body: string;
}
interface Thread {
  _id: Id<"threads">;
  _creationTime: number;
  orgSlug: string;
  filePath: string;
  authorEmail: string;
  authorName: string;
  body: string;
  anchor: Anchor;
  resolved: boolean;
  archived?: boolean;
  replies: Reply[];
}
type Edge = "bottom" | "top" | "left" | "right";

// ───────────────────────────── helpers ──────────────────────────────

type Attrs = Record<string, string | ((e: Event) => void)>;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...kids: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on") && typeof v === "function")
        el.addEventListener(k.slice(2).toLowerCase(), v as (e: Event) => void);
      else if (k === "class") (el as Element).className = v as string;
      else el.setAttribute(k, v as string);
    }
  for (const kid of kids)
    if (kid)
      el.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  return el;
}

function svg(d: string, extra = ""): SVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${extra}${
    d ? `<path d="${d}"/>` : ""
  }</svg>`;
  return (
    (wrap.querySelector("svg") as SVGElement) ??
    (document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    ) as SVGElement)
  );
}

const ICONS = {
  comment:
    "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  check: "M20 6L9 17l-5-5",
  reply: "M9 14L4 9l5-5M4 9h11a4 4 0 0 1 0 8h-2",
  x: "M18 6L6 18M6 6l12 12",
  archive: "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
  trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6",
  more: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
};

function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function cssPath(el: Element | null): string[] {
  const segs: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && cur.parentElement) {
    const tag = cur.tagName.toLowerCase();
    const sameTag = Array.from(cur.parentElement.children).filter(
      (s) => s.tagName.toLowerCase() === tag,
    );
    const idx = sameTag.indexOf(cur) + 1;
    segs.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
    cur = cur.parentElement;
  }
  return segs;
}

function resolvePath(path: string[]): Element | null {
  if (path.length === 0) return null;
  return document.querySelector(path.join(" > "));
}

function findQuoteRange(root: Element, quote: string): Range | null {
  const needle = quote.slice(0, 80).trim();
  // Normalize whitespace — the browser adds \n\n between block elements
  // but the TreeWalker sees text nodes without it.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const normalizedNeedle = norm(needle);
  if (!normalizedNeedle) return null;
  // Try exact match in a single text node first (fast path)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType !== 3) continue;
    const text = (node as Text).data;
    if (norm(text).includes(normalizedNeedle)) {
      const idx = text.indexOf(needle.slice(0, 40));
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + Math.min(needle.length, text.length - idx));
        return range;
      }
    }
  }
  // Multi-node fallback: start at firstWord, collect text forward with spaces
  const firstWord = norm(needle.split(/\s+/)[0]);
  if (!firstWord || firstWord.length < 3) return null;
  const w2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n2: Node | null;
  while ((n2 = w2.nextNode())) {
    if (n2.nodeType !== 3) continue;
    const t2 = (n2 as Text).data;
    if (!norm(t2).includes(firstWord)) continue;
    // Start collecting from this node, with spaces between text nodes
    let collected = t2;
    let endNode: Node = n2;
    while (norm(collected).length < normalizedNeedle.length) {
      const next = w2.nextNode();
      if (!next) break;
      collected += " " + (next as Text).data;
      endNode = next;
    }
    if (norm(collected).includes(normalizedNeedle)) {
      const range = document.createRange();
      const startPos = Math.max(0, t2.indexOf(firstWord));
      range.setStart(n2, startPos);
      range.setEnd(n2, startPos + firstWord.length);
      return range;
    }
  }
  return null;
}

function anchorElement(a: Anchor): Element | null {
  if (a.kind === "text-range") {
    return (
      resolvePath(a.path) ??
      findQuoteRange(document.body, a.quote)?.startContainer?.parentElement ??
      null
    );
  }
  return resolvePath(a.path);
}

function anchorPoint(
  a: Anchor,
): { x: number; y: number; ok: true } | { ok: false } {
  if (a.kind === "text-range") {
    const el = resolvePath(a.path);
    if (el) {
      const r = findQuoteRange(el, a.quote)?.getBoundingClientRect();
      if (r) return { x: r.left, y: r.top, ok: true };
    }
    const fallback = findQuoteRange(document.querySelector("main, article, [data-page]") || document.body, a.quote)?.getBoundingClientRect();
    if (fallback) return { x: fallback.left, y: fallback.top, ok: true };
    return { ok: false };
  }
  const el = resolvePath(a.path);
  if (!el) return { ok: false };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, ok: true };
}

function timeAgo(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;",
  );
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
function placeFloating(el: HTMLElement, rect: Rect, gap = 8): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ew = el.offsetWidth;
  const eh = el.offsetHeight;
  const roomBelow = vh - 8 - (rect.bottom + gap);
  const roomAbove = rect.top - gap - 8;
  let top: number;
  let originY: string;
  if (roomBelow >= eh || roomBelow >= roomAbove) {
    top = rect.bottom + gap;
    originY = "top";
  } else if (roomAbove >= eh) {
    top = rect.top - gap - eh;
    originY = "bottom";
  } else {
    top = clamp(8, vh - eh - 8, rect.top);
    originY = "top";
  }
  const left = clamp(8, vw - ew - 8, rect.left);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.transformOrigin = `${clamp(0, ew, rect.left - left + 10)}px ${originY}`;
}

// ──────────────────────────── the widget ────────────────────────────

const MARGIN = 16;

class Commentor {
  private cfg: Config;
  private client: ConvexClient;
  private root: ShadowRoot;
  private dock: HTMLElement;
  private content!: HTMLElement;
  private drawerList!: HTMLElement;
  private toolbar!: HTMLElement;
  private commentsBtn!: HTMLButtonElement;
  private markersLayer: HTMLElement;
  private bubbleLayer: HTMLElement;
  private tip!: HTMLElement;
  private tipTimer = 0;
  private tipTarget: HTMLElement | null = null;
  private threads: Thread[] = [];
  private commentMode = false;
  private canWrite: boolean;
  private raf = 0;
  private openThreadId: Id<"threads"> | null = null;
  private closeTimer = 0;
  private dockEdge: Edge = "bottom";
  private dockOffset = 0;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.canWrite = Boolean(cfg.author);
    this.client = new ConvexClient(cfg.convexUrl);

    const host = document.createElement("div");
    host.id = "commentor-host";
    document.body.append(host);
    this.root = host.attachShadow({ mode: "open" });
    this.root.append(h("style", undefined, STYLES));

    this.markersLayer = h("div", { class: "markers" });
    this.bubbleLayer = h("div", { class: "bubbles" });
    this.tip = h("div", {
      class: "tip",
      "data-testid": "commentor-tip",
      role: "tooltip",
    });
    this.root.append(this.markersLayer, this.bubbleLayer, this.tip);

    this.content = h("div", {
      class: "content",
      "data-testid": "commentor-drawer",
      id: "commentor-drawer",
      role: "complementary",
      "aria-label": "Comments",
    });
    this.content.append(
      h(
        "div",
        { class: "content-head" },
        h("span", undefined, "Comments"),
        h("span", { class: "count" }),
      ),
      (this.drawerList = h("div", {
        class: "content-list",
        "data-testid": "commentor-drawer-list",
      })),
    );

    this.dock = h("div", { class: "dock", "data-testid": "commentor-dock" });
    this.toolbar = this.renderToolbar();
    this.dock.append(this.content, this.toolbar);
    this.root.append(this.dock);

    const savedEdge = localStorage.getItem("commentor-dock") as Edge | null;
    const savedOffset = Number(localStorage.getItem("commentor-dock-offset"));
    this.applyDockEdge(
      savedEdge && ["bottom", "top", "left", "right"].includes(savedEdge)
        ? savedEdge
        : "bottom",
      Number.isFinite(savedOffset)
        ? savedOffset
        : Math.max(0, (window.innerWidth - 200) / 2),
      false,
    );

    this.applyTheme();
    window.addEventListener("storage", (e) => {
      if (e.key === "commentor-theme") this.applyTheme();
    });
    window.addEventListener("message", (e) => this.onThemeMessage(e));
    this.subscribe();
    this.wireTooltips();

    document.addEventListener("click", (e) => this.onDocumentClick(e));
    window.addEventListener("scroll", () => this.scheduleReposition(), {
      passive: true,
    });
    window.addEventListener("resize", () => {
      this.repositionDock();
      this.scheduleReposition();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.commentMode) this.setCommentMode(false);
        else this.closeBubbles(true);
        this.hideTip();
      }
    });
  }

  // ── subscription ──
  private subscribe(): void {
    this.client.onUpdate(
      api.threads.list,
      { orgSlug: this.cfg.orgSlug, filePath: this.cfg.filePath },
      (threads: Thread[]) => {
        this.threads = threads;
        this.renderPins();
        this.renderDrawerList();
        if (this.dock.hasAttribute("data-expanded"))
          requestAnimationFrame(() => this.sizeContent());
        this.refreshOpenBubble();
      },
      (err: Error) => console.error("[commentor] subscription error", err),
    );
  }

  // ── theme ──
  private applyTheme(mode = localStorage.getItem("commentor-theme") ?? "system"): void {
    const host = this.root.host as HTMLElement;
    host.classList.remove("dark", "light");
    if (mode === "dark" || mode === "light") host.classList.add(mode);
  }
  private onThemeMessage(e: MessageEvent): void {
    if (e.source !== window.parent) return;
    const data = e.data;
    if (!data || typeof data !== "object" || !("type" in data)) return;
    if (data.type !== "rendro-theme" || !("theme" in data)) return;
    const theme = data.theme;
    if (theme === "system" || theme === "dark" || theme === "light") this.applyTheme(theme);
  }

  // ── toolbar (the dock handle row) ──
  private renderToolbar(): HTMLElement {
    const commentBtn = h(
      "button",
      {
        "data-testid": "commentor-comment-btn",
        "data-tip": "Comment (select text, or click then click an element)",
        "aria-label": "Comment",
        ...(this.canWrite
          ? { onclick: () => this.onCommentButton() }
          : { disabled: "disabled" }),
      },
      svg(ICONS.comment),
    ) as HTMLButtonElement;
    this.commentsBtn = h(
      "button",
      {
        "data-testid": "commentor-panel-btn",
        "data-tip": "Comments",
        "aria-label": "Comments",
        "aria-expanded": "false",
        "aria-controls": "commentor-drawer",
        onclick: () => this.toggleDrawer(),
      },
      svg(ICONS.list),
    ) as HTMLButtonElement;
    const grip = h("div", {
      class: "grip",
      "data-testid": "commentor-toolbar-grip",
      "data-tip": "Drag — snaps to edge",
      role: "separator",
      "aria-label": "Drag widget",
    });
    const toolbar = h(
      "div",
      { class: "toolbar", role: "toolbar", "aria-label": "Commentor" },
      grip,
      commentBtn,
      this.commentsBtn,
    );
    grip.addEventListener("pointerdown", (e) => this.onDragStart(e));
    return toolbar;
  }

  // ── drag + magnetic edge snap ──
  private dragging = false;
  private dragDx = 0;
  private dragDy = 0;
  private dragPointerId: number | null = null;
  private dragHandle: HTMLElement | null = null;
  private dragDoc: Document | null = null;
  private dragMoveListener: ((e: PointerEvent) => void) | null = null;
  private dragEndListener: ((e: PointerEvent) => void) | null = null;
  private onDragStart(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.dragging = true;
    this.dragPointerId = e.pointerId;
    this.dragHandle = e.currentTarget as HTMLElement;
    this.dragDoc = this.dragHandle.ownerDocument;
    this.hideTip();
    // Collapse the drawer before dragging so the dock returns to its compact
    // handle size — dragging the full expanded panel is unwieldy and breaks.
    if (this.dock.hasAttribute("data-expanded")) this.collapseDrawer(true);
    this.dock.classList.add("dragging");
    this.repositionDock();
    void this.dock.offsetWidth;
    const r = this.dock.getBoundingClientRect();
    this.dragDx = e.clientX - r.left;
    this.dragDy = e.clientY - r.top;
    this.dragMoveListener = (ev) => this.onDragMove(ev);
    this.dragEndListener = (ev) => this.onDragEnd(ev);
    this.dragDoc.addEventListener("pointermove", this.dragMoveListener);
    this.dragDoc.addEventListener("pointerup", this.dragEndListener);
    this.dragDoc.addEventListener("pointercancel", this.dragEndListener);
    try {
      this.dragHandle.setPointerCapture(e.pointerId);
    } catch {
      /* document listeners still keep the drag alive */
    }
    e.preventDefault();
  }
  private onDragMove(e: PointerEvent): void {
    if (!this.dragging || e.pointerId !== this.dragPointerId) return;
    const left = clamp(MARGIN, window.innerWidth - this.dock.offsetWidth - MARGIN, e.clientX - this.dragDx);
    const top = clamp(MARGIN, window.innerHeight - this.dock.offsetHeight - MARGIN, e.clientY - this.dragDy);
    // Clear perpendicular anchors so left/top fully control position.
    this.dock.style.right = "auto";
    this.dock.style.bottom = "auto";
    this.dock.style.left = `${left}px`;
    this.dock.style.top = `${top}px`;
    e.preventDefault();
  }
  private onDragEnd(e: PointerEvent): void {
    if (!this.dragging || e.pointerId !== this.dragPointerId) return;
    this.dragging = false;
    this.dock.classList.remove("dragging");
    if (this.dragDoc && this.dragMoveListener) this.dragDoc.removeEventListener("pointermove", this.dragMoveListener);
    if (this.dragDoc && this.dragEndListener) {
      this.dragDoc.removeEventListener("pointerup", this.dragEndListener);
      this.dragDoc.removeEventListener("pointercancel", this.dragEndListener);
    }
    try {
      this.dragHandle?.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    this.dragPointerId = null;
    this.dragHandle = null;
    this.dragDoc = null;
    this.dragMoveListener = null;
    this.dragEndListener = null;
    this.snapToNearestEdge();
  }
  private snapToNearestEdge(): void {
    const r = this.dock.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const d: Record<Edge, number> = {
      top: cy,
      bottom: vh - cy,
      left: cx,
      right: vw - cx,
    };
    const edge = (Object.keys(d) as Edge[]).reduce<Edge>(
      (best, k) => (d[k] < d[best] ? k : best),
      "bottom",
    );
    // Along-edge offset = where the user dropped it (parallel axis), clamped later.
    const offset = edge === "bottom" || edge === "top" ? r.left : r.top;
    this.applyDockEdge(edge, offset, true);
  }
  private applyDockEdge(edge: Edge, offset: number, animate: boolean): void {
    this.dockEdge = edge;
    this.dockOffset = offset;
    localStorage.setItem("commentor-dock", edge);
    localStorage.setItem("commentor-dock-offset", String(offset));
    this.dock.className = `dock dock-${edge}`;
    if (!animate) {
      this.dock.style.transition = "none";
      this.repositionDock();
      void this.dock.offsetWidth;
      this.dock.style.transition = "";
    } else {
      this.repositionDock();
    }
  }
  // Edge class supplies the perpendicular anchor (bottom/top/left/right).
  // Inline left (bottom/top) or top (left/right) supplies the along-edge
  // offset — the dock's `transition: left/top` springs it into place.
  // Use left/top for ALL edges (never right/bottom). This keeps both
  // properties numeric at all times so the CSS transition always fires
  // from the old value to the new one — smooth snap on every edge.
  //   bottom edge → top = vh - h - MARGIN, left = offset
  //   top edge    → top = MARGIN,          left = offset
  //   left edge   → left = MARGIN,         top = offset
  //   right edge  → left = vw - w - MARGIN, top = offset
  // Position the dock using left/top for all edges. When targetW/targetH
  // are supplied (expand), use those instead of offsetWidth/offsetHeight —
  // the latter return the pre-transition (compact) size because the CSS
  // width/height transition hasn't laid out the target size yet.
  private repositionDock(targetW?: number, targetH?: number): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = targetW ?? this.dock.offsetWidth;
    const h = targetH ?? this.dock.offsetHeight;
    this.dock.style.right = "auto";
    this.dock.style.bottom = "auto";
    this.dock.style.transform = "";
    const off = clamp(MARGIN, (this.dockEdge === "bottom" || this.dockEdge === "top" ? vw - w - MARGIN : vh - h - MARGIN), this.dockOffset);
    switch (this.dockEdge) {
      case "bottom": this.dock.style.left = `${off}px`; this.dock.style.top = `${vh - h - MARGIN}px`; break;
      case "top":    this.dock.style.left = `${off}px`; this.dock.style.top = `${MARGIN}px`; break;
      case "left":   this.dock.style.left = `${MARGIN}px`; this.dock.style.top = `${off}px`; break;
      case "right":  this.dock.style.left = `${vw - w - MARGIN}px`; this.dock.style.top = `${off}px`; break;
    }
  }

  // ── comment authoring ──
  private onCommentButton(): void {
    if (!this.cfg.author) return;
    const sel = window.getSelection();
    if (
      sel &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      sel.toString().trim()
    ) {
      const range = sel.getRangeAt(0);
      const quote = sel.toString();
      const node = range.commonAncestorContainer;
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
      const anchor: Anchor = {
        kind: "text-range",
        quote,
        path: cssPath(el),
        startOffset: range.startOffset,
        endOffset: range.endOffset,
      };
      const r = range.getBoundingClientRect();
      this.openComposer(anchor, {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      });
      return;
    }
    this.setCommentMode(!this.commentMode);
  }

  private setCommentMode(on: boolean): void {
    this.commentMode = on;
    const btn = this.root.querySelector<HTMLElement>(
      '[data-testid="commentor-comment-btn"]',
    );
    btn?.classList.toggle("active", on);
    this.root.querySelector('[data-testid="commentor-comment-hint"]')?.remove();
    if (on) {
      this.root.append(
        h(
          "div",
          {
            class: "hint",
            "data-testid": "commentor-comment-hint",
            role: "status",
          },
          "Click an element (or select text first) — Esc to cancel",
        ),
      );
    }
  }

  private onDocumentClick(e: MouseEvent): void {
    const path = e.composedPath();
    if (path.some((n) => n instanceof HTMLElement && n.id === "commentor-host"))
      return;
    if (!this.commentMode) {
      this.closeBubbles(true);
      return;
    }
    const target = e.target as Element | null;
    // No anchorless comments: clicking empty space (body/html) is disallowed.
    const empty =
      !target ||
      target === document.body ||
      target === document.documentElement;
    if (empty) {
      this.setCommentMode(false);
      this.toast("Click an element or select text to comment.");
      return;
    }
    const anchor: Anchor = { kind: "element", path: cssPath(target) };
    this.setCommentMode(false);
    this.openComposer(anchor, {
      left: e.clientX,
      top: e.clientY,
      right: e.clientX,
      bottom: e.clientY,
    });
  }

  // ── pins ──
  private renderPins(): void {
    this.markersLayer.replaceChildren();
    const ordered = [...this.threads].sort(
      (a, b) => a._creationTime - b._creationTime,
    );
    ordered.forEach((t, i) => {
      const pin = h(
        "button",
        {
          class: `pin${t.resolved ? " resolved" : ""}`,
          "data-testid": "commentor-pin",
          "data-thread-id": t._id,
          "data-tip": `${t.authorName}: ${t.body.slice(0, 60)}`,
          "aria-label": `Thread ${i + 1} by ${t.authorName}`,
          onclick: (ev) => {
            ev.stopPropagation();
            // Toggle: if this thread's bubble is already open, close it.
            if (this.openThreadId === t._id) {
              this.closeBubbles(true);
            } else {
              this.openThreadBubble(t, ev.currentTarget as HTMLElement);
            }
          },
        },
        h("span", { class: "pin-num" }, String(i + 1)),
      );
      this.markersLayer.append(pin);
    });
    this.repositionPins();
  }

  private scheduleReposition(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.repositionPins();
      const open = this.bubbleLayer.querySelector<HTMLElement>(
        '[data-testid="commentor-thread-bubble"]',
      );
      if (open) {
        const tid = open.getAttribute("data-thread-id");
        const pin = this.markersLayer.querySelector<HTMLElement>(
          `[data-thread-id="${tid}"]`,
        );
        if (pin) placeFloating(open, pin.getBoundingClientRect());
      }
    });
  }

  private repositionPins(): void {
    const pins = this.markersLayer.querySelectorAll<HTMLElement>(
      '[data-testid="commentor-pin"]',
    );
    pins.forEach((pin) => {
      const t = this.threads.find(
        (x) => x._id === pin.getAttribute("data-thread-id"),
      );
      if (!t) return;
      const p = anchorPoint(t.anchor);
      if (!p.ok) {
        pin.classList.add("orphan");
        pin.style.display = "none";
        return;
      }
      // Hide the pin when its anchor has scrolled out of the viewport.
      // Without this, clamp() pins the tooltip to the viewport edge and
      // the pin (and its tooltip) appear "sticky" — visible even though
      // the commented element is off-screen.
      if (p.y < 0 || p.y > window.innerHeight) {
        pin.style.display = "none";
        return;
      }
      pin.classList.remove("orphan");
      pin.style.display = "";
      pin.style.left = `${clamp(8, window.innerWidth - 30, p.x - 10)}px`;
      pin.style.top = `${clamp(8, window.innerHeight - 30, p.y - 26)}px`;
    });
  }

  // ── bubbles ──
  private openComposer(anchor: Anchor, rect: Rect): void {
    if (!this.cfg.author) return;
    this.closeBubbles(false);
    const textarea = h("textarea", {
      "data-testid": "commentor-composer-textarea",
      placeholder: "Add a comment…  (Enter to send, Shift+Enter for newline)",
    });
    // Keyboard-native: Enter sends, Shift/Ctrl/Cmd+Enter inserts a newline.
    // No submit button — the hint is in the placeholder.
    textarea.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const body = textarea.value.trim();
        if (!body) return;
        textarea.disabled = true;
        try {
          await this.client.mutation(api.threads.create, {
            orgSlug: this.cfg.orgSlug,
            filePath: this.cfg.filePath,
            authorEmail: this.cfg.author!.email,
            authorName: this.cfg.author!.name,
            body,
            anchor,
          });
          this.closeBubbles(true);
        } catch (err) {
          console.error("[commentor] create failed", err);
          textarea.disabled = false;
          this.toast("Could not post comment. Try again.");
        }
      }
    });
    const bubble = h(
      "div",
      {
        class: "bubble composer",
        "data-testid": "commentor-composer",
        "data-state": "open",
        role: "dialog",
        "aria-label": "New comment",
      },
      h("div", { class: "anchor-label" }, anchorLabel(anchor)),
      textarea,
    );
    this.bubbleLayer.append(bubble);
    placeFloating(bubble, rect);
    setTimeout(() => textarea.focus(), 0);
  }

  private openThreadBubble(t: Thread, pin: HTMLElement): void {
    this.closeBubbles(false);
    this.openThreadId = t._id;
    const bubble = h("div", {
      class: "bubble thread",
      "data-testid": "commentor-thread-bubble",
      "data-thread-id": t._id,
      "data-state": "open",
      role: "dialog",
      "aria-label": `Thread by ${t.authorName}`,
    });
    bubble.append(this.threadView(t));
    this.bubbleLayer.append(bubble);
    placeFloating(bubble, pin.getBoundingClientRect());
  }

  private closeBubbles(animate: boolean): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = 0;
    }
    this.openThreadId = null;
    const kids = Array.from(this.bubbleLayer.children) as HTMLElement[];
    if (animate && kids.length) {
      kids.forEach((k) => k.setAttribute("data-state", "closed"));
      this.closeTimer = window.setTimeout(() => {
        this.bubbleLayer.replaceChildren();
        this.closeTimer = 0;
      }, 150);
    } else {
      this.bubbleLayer.replaceChildren();
    }
  }

  private refreshOpenBubble(): void {
    if (!this.openThreadId) return;
    const bubble = this.bubbleLayer.querySelector<HTMLElement>(
      '[data-testid="commentor-thread-bubble"]',
    );
    if (!bubble) {
      this.openThreadId = null;
      return;
    }
    const t = this.threads.find((x) => x._id === this.openThreadId);
    if (!t) {
      this.closeBubbles(true);
      return;
    }
    bubble.replaceChildren(this.threadView(t));
    const pin = this.markersLayer.querySelector<HTMLElement>(
      `[data-thread-id="${t._id}"]`,
    );
    if (pin) placeFloating(bubble, pin.getBoundingClientRect());
  }

  private threadView(t: Thread): HTMLElement {
    // Header row: author + when + resolved badge on the left, hover action
    // icons (resolve, archive, delete) on the right. Icons are invisible
    // until the card is hovered — keeps the UI clean at rest.
    const head = h(
      "div",
      { class: "head" },
      h("span", { class: "who", title: t.authorEmail }, t.authorName),
      h("span", { class: "when" }, timeAgo(t._creationTime)),
      t.resolved
        ? h("span", { class: "resolved" }, svg(ICONS.check, ""), "Resolved")
        : null,
      t.archived
        ? h("span", { class: "archived-badge" }, svg(ICONS.archive, ""), "Archived")
        : null,
    );
    if (this.canWrite) {
      const actions = h("div", { class: "card-actions" });
      actions.append(
        h(
          "button",
          {
            class: "card-action",
            "data-tip": t.resolved ? "Reopen" : "Resolve",
            "data-testid": "commentor-resolve-btn",
            onclick: async () => {
              try {
                await this.client.mutation(api.threads.resolve, {
                  threadId: t._id,
                });
              } catch (err) {
                console.error("[commentor] resolve failed", err);
              }
            },
          },
          svg(ICONS.check),
        ),
        h(
          "button",
          {
            class: "card-action",
            "data-tip": t.archived ? "Unarchive" : "Archive",
            "data-testid": "commentor-archive-btn",
            onclick: async () => {
              try {
                await this.client.mutation(api.threads.archive, {
                  threadId: t._id,
                });
              } catch (err) {
                console.error("[commentor] archive failed", err);
              }
            },
          },
          svg(ICONS.archive),
        ),
        h(
          "button",
          {
            class: "card-action danger",
            "data-tip": "Delete",
            "data-testid": "commentor-delete-btn",
            onclick: async () => {
              try {
                await this.client.mutation(api.threads.remove, {
                  threadId: t._id,
                });
              } catch (err) {
                console.error("[commentor] delete failed", err);
                this.toast("Could not delete comment.");
              }
            },
          },
          svg(ICONS.trash),
        ),
      );
      head.append(actions);
    }
    const view = h(
      "div",
      {},
      head,
      t.anchor.kind === "text-range"
        ? h(
            "blockquote",
            {
              class: "quote",
              title: "Locate on page",
              onclick: () => this.focusThread(t),
            },
            escapeText(t.anchor.quote),
          )
        : null,
      h("div", { class: "body" }, escapeText(t.body)),
    );
    const replies = h("div", { class: "replies" });
    for (const r of t.replies)
      replies.append(
        h(
          "div",
          { class: "reply" },
          h("span", { class: "reply-who" }, r.authorName),
          escapeText(r.body),
        ),
      );
    view.append(replies);
    if (this.canWrite && this.cfg.author) {
      // Keyboard-native reply: Enter to send, Shift/Ctrl/Cmd+Enter for
      // newline. No send button.
      const input = h("textarea", {
        class: "reply-input",
        "data-testid": "commentor-reply-input",
        placeholder: "Reply…  (Enter to send, Shift+Enter for newline)",
        rows: "1",
      });
      input.addEventListener("keydown", async (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          const body = (e.target as HTMLTextAreaElement).value.trim();
          if (!body) return;
          (e.target as HTMLTextAreaElement).value = "";
          try {
            await this.client.mutation(api.replies.add, {
              threadId: t._id,
              authorEmail: this.cfg.author!.email,
              authorName: this.cfg.author!.name,
              body,
            });
          } catch (err) {
            console.error("[commentor] reply failed", err);
            this.toast("Could not post reply.");
          }
        }
      });
      view.append(h("div", { class: "reply-row" }, input));
    }
    return view;
  }

  // ── drawer (the widget expanding into the comments list) ──
  private toggleDrawer(): void {
    if (this.dock.hasAttribute("data-expanded")) this.collapseDrawer();
    else this.expandDrawer();
  }
  private expandDrawer(): void {
    this.renderDrawerList();
    this.dock.setAttribute("data-expanded", "");
    this.commentsBtn.setAttribute("aria-expanded", "true");
    this.commentsBtn.classList.add("active");
    requestAnimationFrame(() => {
      const { w: cw, h: ch } = this.sizeContent();
      // Compute the TARGET dock dimensions (toolbar + content) so
      // repositionDock can position correctly before the CSS transition
      // settles — offsetWidth would return the compact size here.
      const toolbar = this.dock.querySelector<HTMLElement>(".toolbar");
      const tw = toolbar ? toolbar.offsetWidth : 48;
      const th = toolbar ? toolbar.offsetHeight : 48;
      // offsetWidth includes the element's own border; our tw+cw sum does not
      // include the DOCK's border, so add it to avoid a 2px viewport overflow.
      const ds = getComputedStyle(this.dock);
      const bw = parseFloat(ds.borderLeftWidth) + parseFloat(ds.borderRightWidth);
      const bh = parseFloat(ds.borderTopWidth) + parseFloat(ds.borderBottomWidth);
      const horizontal = this.dockEdge === "left" || this.dockEdge === "right";
      const dockW = (horizontal ? tw + cw : Math.max(tw, cw)) + bw;
      const dockH = (horizontal ? Math.max(th, ch) : th + ch) + bh;
      this.repositionDock(dockW, dockH);
    });
  }
  private collapseDrawer(immediate = false): void {
    this.commentsBtn.setAttribute("aria-expanded", "false");
    this.commentsBtn.classList.remove("active");
    // Collapse BOTH dimensions simultaneously for a smooth diagonal shrink.
    this.content.style.height = "0px";
    this.content.style.width = "0px";
    if (immediate) {
      this.dock.removeAttribute("data-expanded");
      this.content.style.height = "";
      this.content.style.width = "";
    } else {
      // Remove data-expanded NOW so the theme toggle (and other expanded-only
      // toolbar buttons) disappear immediately — in sync with the collapse
      // starting, not 420ms later. The content still animates because the
      // inline height:0/width:0 above drive the CSS transition.
      this.dock.removeAttribute("data-expanded");
      // Reposition the dock to its COMPACT size (toolbar only) so the
      // left/top transition glides it back to the edge in sync with the
      // content shrinking. Without this, right/bottom-edge docks detach
      // from their edge and float toward center during collapse.
      const toolbar = this.dock.querySelector<HTMLElement>(".toolbar");
      const tw = toolbar ? toolbar.offsetWidth : 48;
      const th = toolbar ? toolbar.offsetHeight : 48;
      const ds = getComputedStyle(this.dock);
      const bw = parseFloat(ds.borderLeftWidth) + parseFloat(ds.borderRightWidth);
      const bh = parseFloat(ds.borderTopWidth) + parseFloat(ds.borderBottomWidth);
      this.repositionDock(tw + bw, th + bh);
      window.setTimeout(() => {
        this.content.style.height = "";
        this.content.style.width = "";
      }, 420);
    }
  }
  // Grow the content area to fit its rendered list. Returns the target
  // content dimensions so the caller can compute the target DOCK size for
  // repositionDock (offsetWidth returns the pre-transition compact size).
  // Width is computed from the viewport, not the current dock position —
  // the dock will be repositioned to fit, so we don't artificially narrow
  // the panel just because the compact dock was in a corner.
  private sizeContent(): { w: number; h: number } {
    if (!this.dock.hasAttribute("data-expanded")) return { w: 0, h: 0 };
    const head = this.content.querySelector<HTMLElement>(".content-head");
    const headH = head ? head.offsetHeight : 0;
    const maxH = Math.min(window.innerHeight * 0.6, 520);
    const naturalH = Math.min(headH + this.drawerList.scrollHeight, maxH);
    // For left/right edges the toolbar sits beside the content, so subtract
    // its width from the available space. For top/bottom the toolbar is
    // above/below the content (full width), so no subtraction needed.
    const toolbar = this.dock.querySelector<HTMLElement>(".toolbar");
    const tw = toolbar ? toolbar.offsetWidth : 48;
    const horizontal = this.dockEdge === "left" || this.dockEdge === "right";
    const availW = window.innerWidth - 2 * MARGIN - (horizontal ? tw : 0);
    const targetW = Math.max(200, Math.min(380, availW));
    const targetH = horizontal ? Math.min(maxH, 520) : naturalH;
    this.content.style.height = `${targetH}px`;
    this.content.style.width = `${targetW}px`;
    return { w: targetW, h: targetH };
  }
  private renderDrawerList(): void {
    const count = this.content.querySelector<HTMLElement>(".count");
    if (count) count.textContent = String(this.threads.length);
    this.drawerList.replaceChildren();
    if (this.threads.length === 0) {
      this.drawerList.append(h("div", { class: "empty" }, "No comments yet."));
      return;
    }
    const ordered = [...this.threads].sort(
      (a, b) => a._creationTime - b._creationTime,
    );
    for (const t of ordered)
      this.drawerList.append(
        h("div", { class: "drawer-thread" }, this.threadView(t)),
      );
  }

  private focusThread(t: Thread): void {
    const el = anchorElement(t.anchor);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      this.repositionPins();
      const pin = this.markersLayer.querySelector<HTMLElement>(
        `[data-thread-id="${t._id}"]`,
      );
      if (pin) this.openThreadBubble(t, pin);
    }, 250);
  }

  // ── tooltips (fast, per-element, flip below when no room above) ──
  private tipScrollSuppress = false;
  private wireTooltips(): void {
    const show = (target: HTMLElement) => {
      // Suppress during/after scroll: pins are position:fixed and repositioned
      // via rAF on scroll, which fires pointerover when a pin slides under the
      // stationary cursor. Without this guard the tooltip re-shows immediately
      // after the scroll handler hides it.
      if (this.tipScrollSuppress) return;
      if (this.tipTarget === target) return;
      this.tipTarget = target;
      const text = target.getAttribute("data-tip");
      if (!text) return;
      if (this.tipTimer) clearTimeout(this.tipTimer);
      this.tipTimer = window.setTimeout(() => this.placeTip(target, text), 140);
    };
    const hide = () => {
      if (this.tipTimer) clearTimeout(this.tipTimer);
      this.tipTarget = null;
      this.tip.setAttribute("data-state", "closed");
    };
    this.root.addEventListener("pointerover", (e) => {
      const t = (e.target as HTMLElement)?.closest<HTMLElement>("[data-tip]");
      if (t) show(t);
    });
    this.root.addEventListener("pointerout", () => hide());
    this.root.addEventListener("focusin", (e) => {
      const t = (e.target as HTMLElement)?.closest<HTMLElement>("[data-tip]");
      if (t) show(t);
    });
    this.root.addEventListener("focusout", () => hide());
    // Hide on scroll and suppress re-showing: pins reposition via rAF after
    // scroll, which fires pointerover under a stationary cursor. The suppress
    // flag is cleared 120ms after scrolling stops so normal hover resumes.
    let scrollTimer: number | undefined;
    window.addEventListener("scroll", () => {
      this.tipScrollSuppress = true;
      hide();
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => { this.tipScrollSuppress = false; }, 120);
    }, { passive: true });
  }
  private placeTip(target: HTMLElement, text: string): void {
    // Don't show a tooltip for an element that has scrolled out of view.
    const r = target.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
      this.tip.setAttribute("data-state", "closed");
      return;
    }
    this.tip.textContent = text;
    this.tip.setAttribute("data-state", "open");
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    const left = clamp(
      8,
      window.innerWidth - tw - 8,
      r.left + r.width / 2 - tw / 2,
    );
    const above = r.top - th - 8;
    const top = above >= 8 ? above : r.bottom + 8; // flip below if no room above
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${top}px`;
  }
  private hideTip(): void {
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.tipTarget = null;
    this.tip.setAttribute("data-state", "closed");
  }

  private toast(msg: string): void {
    const el = h("div", { class: "toast" }, msg);
    this.root.append(el);
    setTimeout(() => {
      el.setAttribute("data-state", "closed");
      setTimeout(() => el.remove(), 150);
    }, 2200);
  }
}

function anchorLabel(a: Anchor): string {
  return a.kind === "text-range"
    ? `On: “${a.quote.slice(0, 60)}${a.quote.length > 60 ? "…" : ""}”`
    : "On: element";
}

// ───────────────────────────── styles ───────────────────────────────

const STYLES = /* css */ `
:host {
  --bg: #ffffff; --bg-elev: #ffffff; --fg: #09090b; --fg-muted: #71717a;
  --border: #e4e4e7; --border-soft: #f4f4f5;
  --accent: #c2410c; --accent-hover: #9a3412; --accent-fg: #ffffff;
  --resolved: #1a7f37; --resolved-bg: #1a7f37;
  --shadow: 0 4px 16px rgba(15,23,42,.10);
  --shadow-lg: 0 12px 32px rgba(15,23,42,.18);
  --radius: 16px; --radius-sm: 8px;
  --panel: 380px;
  --ease: cubic-bezier(.22,1,.36,1);
  --spring: cubic-bezier(.2,1.3,.4,1);
  --dur: 180ms;
  color: var(--fg);
  background: transparent;
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #09090b; --bg-elev: #18181b; --fg: #fafafa; --fg-muted: #a1a1aa;
    --border: #27272a; --border-soft: #18181b;
    --accent: #fb923c; --accent-hover: #fdba74; --accent-fg: #09090b;
    --resolved: #22c55e; --resolved-bg: #14532d;
    --shadow: 0 4px 16px rgba(0,0,0,.48);
    --shadow-lg: 0 12px 32px rgba(0,0,0,.56);
  }
}
:host(.light) {
  --bg: #ffffff; --bg-elev: #ffffff; --fg: #09090b; --fg-muted: #71717a;
  --border: #e4e4e7; --border-soft: #f4f4f5;
  --accent: #c2410c; --accent-hover: #9a3412; --accent-fg: #ffffff;
  --resolved: #1a7f37; --resolved-bg: #1a7f37;
  --shadow: 0 4px 16px rgba(15,23,42,.10);
  --shadow-lg: 0 12px 32px rgba(15,23,42,.18);
}
:host(.dark) {
  --bg: #09090b; --bg-elev: #18181b; --fg: #fafafa; --fg-muted: #a1a1aa;
  --border: #27272a; --border-soft: #18181b;
  --accent: #fb923c; --accent-hover: #fdba74; --accent-fg: #09090b;
  --resolved: #22c55e; --resolved-bg: #14532d;
  --shadow: 0 4px 16px rgba(0,0,0,.48);
  --shadow-lg: 0 12px 32px rgba(0,0,0,.56);
}

* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
button { font: inherit; color: inherit; }

/* dock = the single widget surface; it docks to an edge and expands */
.dock {
  position: fixed; z-index: 2147483646; display: flex; overflow: hidden;
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  transition: left .42s var(--spring), top .42s var(--spring);
}
.dock.dragging { transition: none; cursor: grabbing; }
.dock.dock-bottom { flex-direction: column; align-items: stretch; }
.dock.dock-top    { flex-direction: column-reverse; align-items: stretch; }
.dock.dock-left   { flex-direction: row-reverse; align-items: stretch; }
.dock.dock-right  { flex-direction: row; align-items: stretch; }

/* toolbar = the handle row inside the dock */
.toolbar { display: flex; align-items: center; gap: 2px; padding: 6px 8px; }
.toolbar button {
  background: transparent; border: none; border-radius: 10px;
  padding: 8px; cursor: pointer; color: var(--fg);
  display: inline-flex; align-items: center; justify-content: center;
  transition: background var(--dur) var(--ease), transform var(--dur) var(--spring);
}
.toolbar button:hover { background: var(--border-soft); }
.toolbar button:active { transform: scale(.9); }
.toolbar button.active { background: var(--accent); color: var(--accent-fg); }
.toolbar button:disabled { opacity: .35; cursor: not-allowed; }
.toolbar button:focus-visible, .pin:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
.grip {
  width: 20px; height: 28px; cursor: grab; display: flex;
  align-items: center; justify-content: center; border-radius: 10px;
  touch-action: none; user-select: none; -webkit-user-select: none;
  transition: background var(--dur) var(--ease);
}
.grip:hover { background: var(--border-soft); }
.grip:active { cursor: grabbing; }
.grip::before {
  content: ""; width: 4px; height: 14px; border-radius: 2px;
  background: repeating-linear-gradient(to bottom, var(--fg-muted) 0 2px, transparent 2px 4px);
}
/* Portrait orientation when docked to left/right edges. */
.dock.dock-left .toolbar, .dock.dock-right .toolbar { flex-direction: column; padding: 8px 6px; }
.dock.dock-left .grip, .dock.dock-right .grip { width: 28px; height: 20px; }
.dock.dock-left .grip::before, .dock.dock-right .grip::before {
  width: 14px; height: 4px;
  background: repeating-linear-gradient(to right, var(--fg-muted) 0 2px, transparent 2px 4px);
}

/* content = the expandable comments list (the dock grows into it) */
.content {
  overflow: hidden; opacity: 0; height: 0; width: 0;
  display: flex; flex-direction: column;
  transition: height .42s var(--spring), width .42s var(--spring), opacity .22s var(--ease);
}
.dock[data-expanded] .content { opacity: 1; }
.dock.dock-bottom[data-expanded] .content, .dock.dock-top[data-expanded] .content { width: min(var(--panel), calc(100vw - 32px)); max-height: min(60vh, 520px); }
.dock.dock-left[data-expanded] .content, .dock.dock-right[data-expanded] .content { height: min(60vh, 520px); max-width: var(--panel); }
.dock[data-expanded] .toolbar { box-shadow: 0 -1px 0 var(--border-soft) inset; }
.dock.dock-top[data-expanded] .toolbar, .dock.dock-left[data-expanded] .toolbar { box-shadow: 0 1px 0 var(--border-soft) inset; }
.content-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; font-weight: 600; white-space: nowrap;
}
.count {
  font-size: 11px; font-weight: 700; color: var(--accent-fg); background: var(--accent);
  min-width: 18px; height: 18px; border-radius: 999px; display: inline-flex;
  align-items: center; justify-content: center; padding: 0 5px;
}
.content-list { flex: 1 1 0; min-height: 0; overflow-y: auto; padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 8px; width: min(var(--panel), calc(100vw - 32px)); }
.drawer-thread {
  padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm);
  background: var(--bg); transition: border-color var(--dur) var(--ease);
}
.drawer-thread:hover { border-color: var(--border); }
.empty { padding: 18px; color: var(--fg-muted); font-size: 13px; text-align: center; }

/* pins */
.markers { position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; }
.pin {
  position: fixed; pointer-events: auto; opacity: 1;
  width: 24px; height: 24px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg);
  background: var(--accent); color: var(--accent-fg); border: 2px solid var(--bg);
  box-shadow: var(--shadow);
  font-size: 11px; font-weight: 700; cursor: pointer; padding: 0;
  display: flex; align-items: center; justify-content: center;
  animation: pin-in var(--dur) var(--spring) 0s 1 normal forwards;
  transition: background var(--dur) var(--ease), transform var(--dur) var(--spring);
}
.pin-num { display: block; transform: rotate(45deg); line-height: 1; }
.pin.resolved { background: var(--resolved-bg); }
.pin:hover { transform: rotate(-45deg) scale(1.18); z-index: 2; }
.pin:active { transform: rotate(-45deg) scale(.95); }
.pin.orphan { display: none; }

/* bubbles */
.bubbles { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
.bubble {
  position: fixed; pointer-events: auto; width: min(320px, calc(100vw - 16px));
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-lg); padding: 12px; color: var(--fg);
  animation: bubble-in var(--dur) var(--spring);
}
.bubble[data-state="closed"] { animation: bubble-out 140ms var(--ease) forwards; }
.anchor-label { font-size: 12px; color: var(--fg-muted); margin-bottom: 8px; overflow-wrap: anywhere; }
.bubble textarea, .reply-input {
  width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg); color: var(--fg); outline: none;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.bubble textarea { padding: 8px 10px; font-size: 13px; min-height: 64px; resize: vertical; }
.reply-input { padding: 6px 10px; font-size: 12px; min-height: 36px; resize: none; }
.bubble textarea:focus, .reply-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
.reply-row { margin-top: 8px; }

.head { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.who { font-weight: 600; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.when { color: var(--fg-muted); }
.resolved { display: inline-flex; align-items: center; gap: 3px; color: var(--resolved); font-size: 11px; font-weight: 600; }
.resolved svg { width: 13px; height: 13px; }
.archived-badge { display: inline-flex; align-items: center; gap: 3px; color: var(--fg-muted); font-size: 11px; font-weight: 600; }
.archived-badge svg { width: 13px; height: 13px; }
/* Hover-only action icons on the card header (resolve, archive, delete).
   Invisible at rest, fade in on hover. Pushed right via margin-left:auto. */
.card-actions { display: flex; gap: 2px; margin-left: auto; opacity: 0; transition: opacity var(--dur) var(--ease); }
.drawer-thread:hover .card-actions, .bubble:hover .card-actions { opacity: 1; }
.card-action {
  background: transparent; border: none; border-radius: 6px; padding: 4px;
  cursor: pointer; color: var(--fg-muted); display: inline-flex; align-items: center;
  justify-content: center; transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.card-action:hover { background: var(--border-soft); color: var(--fg); }
.card-action.danger:hover { color: #e5484d; }
.card-action svg { width: 14px; height: 14px; }
.quote {
  margin: 8px 0; padding: 6px 10px; border-left: 3px solid var(--accent);
  color: var(--fg-muted); font-size: 12px; background: var(--border-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0; overflow-wrap: anywhere; cursor: pointer;
}
.quote:hover { color: var(--fg); }
.body { font-size: 13px; margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.replies { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.reply {
  font-size: 12px; color: var(--fg); background: var(--border-soft);
  padding: 6px 8px; border-radius: var(--radius-sm); overflow-wrap: anywhere; word-break: break-word;
  animation: reply-in var(--dur) var(--ease);
}
.reply-who { font-weight: 600; margin-right: 4px; }
.actions { display: flex; gap: 6px; margin-top: 10px; align-items: center; }
.actions button {
  border: none; border-radius: var(--radius-sm); padding: 7px 12px; font-size: 12px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 4px;
  transition: background var(--dur) var(--ease), transform var(--dur) var(--spring), opacity var(--dur) var(--ease);
}
.actions button.primary { background: var(--accent); color: var(--accent-fg); }
.actions button.primary:hover { background: var(--accent-hover); }
.actions button.ghost { background: var(--border-soft); color: var(--fg); }
.actions button.ghost:hover { background: var(--border); }
.actions button:active { transform: scale(.92); }
.actions button:disabled { opacity: .5; cursor: not-allowed; }
.actions button svg { width: 15px; height: 15px; }

/* hint + toast + tooltip */
.hint {
  position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; background: var(--accent); color: var(--accent-fg);
  padding: 9px 16px; border-radius: 999px; font-size: 13px; font-weight: 500;
  box-shadow: var(--shadow-lg); max-width: calc(100vw - 24px); text-align: center;
  animation: rise var(--dur) var(--spring);
}
.toast {
  position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; background: var(--fg); color: var(--bg);
  padding: 9px 16px; border-radius: 999px; font-size: 13px; max-width: calc(100vw - 24px);
  animation: rise var(--dur) var(--ease);
}
.toast[data-state="closed"] { animation: fall 140ms var(--ease) forwards; }
.tip {
  position: fixed; z-index: 2147483647; pointer-events: none;
  background: var(--fg); color: var(--bg); padding: 5px 9px; border-radius: 6px;
  font-size: 12px; white-space: nowrap; max-width: 240px; overflow: hidden; text-overflow: ellipsis;
  opacity: 0; transform: translateY(2px) scale(.96);
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--spring);
}
.tip[data-state="open"] { opacity: 1; transform: translateY(0) scale(1); }

/* keyframes */
@keyframes pin-in { from { opacity: 0; transform: rotate(-45deg) scale(.3); } to { opacity: 1; transform: rotate(-45deg) scale(1); } }
@keyframes bubble-in { from { opacity: 0; transform: scale(.88); } to { opacity: 1; transform: scale(1); } }
@keyframes bubble-out { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(.96); } }
@keyframes reply-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
@keyframes rise { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
@keyframes fall { from { opacity: 1; transform: translateX(-50%) translateY(0); } to { opacity: 0; transform: translateX(-50%) translateY(10px); } }

@media (prefers-reduced-motion: reduce) {
  .pin, .bubble, .reply, .content, .hint, .toast, .dock { animation: none !important; transition: none !important; }
}
`;

// ────────────────────────────── boot ────────────────────────────────

function boot(): void {
  const cfg = (window as unknown as { COMMENTOR?: Config }).COMMENTOR;
  if (!cfg || !cfg.convexUrl || !cfg.orgSlug || !cfg.filePath) {
    console.error(
      "[commentor] not started — set window.COMMENTOR = { convexUrl, orgSlug, filePath } before loading commentor.js",
    );
    return;
  }
  new Commentor(cfg);
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
