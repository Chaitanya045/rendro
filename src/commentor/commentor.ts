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
type ThreadFilter = "active" | "resolved" | "history";
const THREAD_FILTERS: readonly ThreadFilter[] = [
  "active",
  "resolved",
  "history",
];
const THREAD_FILTER_LABELS: Record<ThreadFilter, string> = {
  active: "Active",
  resolved: "Resolved",
  history: "History",
};
interface ToastOptions {
  kind?: "status" | "error";
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

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
  const exactNeedle = quote.trim();
  if (!exactNeedle) return null;

  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    nodes.push(text);
    const index = text.data.indexOf(exactNeedle);
    if (index < 0) continue;
    const range = document.createRange();
    range.setStart(text, index);
    range.setEnd(text, index + exactNeedle.length);
    return range;
  }

  const normalizedNeedle = exactNeedle.replace(/\s+/g, " ");
  type MappedCharacter = {
    node: Text;
    startOffset: number;
    endOffset: number;
  };
  const findMappedRange = (separateNodes: boolean): Range | null => {
    let normalizedText = "";
    const characters: MappedCharacter[] = [];
    const appendSpace = (
      textNode: Text,
      startOffset: number,
      endOffset: number,
    ) => {
      if (!normalizedText || normalizedText.endsWith(" ")) {
        const previous = characters.at(-1);
        if (previous && normalizedText.endsWith(" "))
          previous.endOffset = endOffset;
        return;
      }
      normalizedText += " ";
      characters.push({ node: textNode, startOffset, endOffset });
    };

    nodes.forEach((textNode, nodeIndex) => {
      if (
        separateNodes &&
        nodeIndex > 0 &&
        textNode.data.trim() &&
        normalizedText
      )
        appendSpace(textNode, 0, 0);
      for (let offset = 0; offset < textNode.data.length; offset += 1) {
        const character = textNode.data[offset];
        if (/\s/.test(character)) {
          appendSpace(textNode, offset, offset + 1);
          continue;
        }
        normalizedText += character;
        characters.push({
          node: textNode,
          startOffset: offset,
          endOffset: offset + 1,
        });
      }
    });

    const index = normalizedText.indexOf(normalizedNeedle);
    if (index < 0) return null;
    const start = characters[index];
    const end = characters[index + normalizedNeedle.length - 1];
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.startOffset);
    range.setEnd(end.node, end.endOffset);
    return range;
  };

  return findMappedRange(false) ?? findMappedRange(true);
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

function textRangeClientRects(range: Range): DOMRect[] {
  const common = range.commonAncestorContainer;
  const textNodes: Text[] = [];
  if (common.nodeType === Node.TEXT_NODE) {
    textNodes.push(common as Text);
  } else {
    const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) textNodes.push(node as Text);
  }
  const rects: DOMRect[] = [];
  for (const textNode of textNodes) {
    if (!range.intersectsNode(textNode)) continue;
    const startOffset =
      textNode === range.startContainer ? range.startOffset : 0;
    const endOffset =
      textNode === range.endContainer ? range.endOffset : textNode.length;
    if (startOffset >= endOffset) continue;
    const textRange = document.createRange();
    textRange.setStart(textNode, startOffset);
    textRange.setEnd(textNode, endOffset);
    for (const rect of textRange.getClientRects()) {
      if (rect.width > 0 || rect.height > 0) rects.push(rect);
    }
  }
  return rects;
}

function textAnchorClientRects(
  anchor: Extract<Anchor, { kind: "text-range" }>,
): DOMRect[] {
  const scope =
    resolvePath(anchor.path) ??
    document.querySelector("main, article, [data-page]") ??
    document.body;
  const range = findQuoteRange(scope, anchor.quote);
  return range ? textRangeClientRects(range) : [];
}

function anchorQuote(anchor: Anchor): string | null {
  if (anchor.kind === "text-range")
    return anchor.quote.trim() ? anchor.quote : null;
  const element = resolvePath(anchor.path);
  if (!element) return null;
  const range = document.createRange();
  range.selectNodeContents(element);
  if (textRangeClientRects(range).length === 0) return null;
  const text =
    element instanceof HTMLElement ? element.innerText : element.textContent;
  const quote = text?.replace(/\s+/g, " ").trim();
  return quote || null;
}

function anchorPoint(
  a: Anchor,
): { x: number; y: number; ok: true } | { ok: false } {
  if (a.kind === "text-range") {
    const rect = textAnchorClientRects(a)[0];
    return rect
      ? { x: rect.left, y: rect.top, ok: true }
      : { ok: false };
  }
  const el = resolvePath(a.path);
  if (!el) return { ok: false };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, ok: true };
}

function anchorRect(a: Anchor): Rect | null {
  if (a.kind === "text-range") {
    const rects = textAnchorClientRects(a);
    const first = rects[0];
    if (!first) return null;
    const bounds: Rect = {
      left: first.left,
      top: first.top,
      right: first.right,
      bottom: first.bottom,
    };
    for (let index = 1; index < rects.length; index += 1) {
      const rect = rects[index];
      bounds.left = Math.min(bounds.left, rect.left);
      bounds.top = Math.min(bounds.top, rect.top);
      bounds.right = Math.max(bounds.right, rect.right);
      bounds.bottom = Math.max(bounds.bottom, rect.bottom);
    }
    return bounds;
  }
  const r = resolvePath(a.path)?.getBoundingClientRect();
  return r
    ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    : null;
}

function anchorRects(a: Anchor): Rect[] {
  let orderedRects: DOMRect[];
  if (a.kind === "text-range") {
    orderedRects = textAnchorClientRects(a);
  } else {
    const element = resolvePath(a.path);
    if (!element) return [];
    const textRange = document.createRange();
    textRange.selectNodeContents(element);
    orderedRects = textRangeClientRects(textRange);
    if (orderedRects.length === 0)
      orderedRects = [element.getBoundingClientRect()];
  }
  orderedRects.sort(
    (first, second) =>
      first.top - second.top || first.left - second.left,
  );
  const lines: Rect[] = [];
  for (const rect of orderedRects) {
    const previous = lines.at(-1);
    const overlap = previous
      ? Math.min(previous.bottom, rect.bottom) -
        Math.max(previous.top, rect.top)
      : 0;
    const sameLine =
      previous &&
      overlap >=
        Math.min(
          previous.bottom - previous.top,
          rect.bottom - rect.top,
        ) /
          2;
    if (previous && sameLine) {
      previous.left = Math.min(previous.left, rect.left);
      previous.top = Math.min(previous.top, rect.top);
      previous.right = Math.max(previous.right, rect.right);
      previous.bottom = Math.max(previous.bottom, rect.bottom);
      continue;
    }
    lines.push({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    });
  }
  return lines;
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
  private filterButtons!: Record<ThreadFilter, HTMLButtonElement>;
  private filterTabs!: HTMLElement;
  private newCommentsButton!: HTMLButtonElement;
  private markersLayer: HTMLElement;
  private bubbleLayer: HTMLElement;
  private anchorHighlight: HTMLElement;
  private tip!: HTMLElement;
  private tipTimer = 0;
  private tipTarget: HTMLElement | null = null;
  private tipPreviousDescription: string | null = null;
  private selectionRaf = 0;
  private selectionHideTimer = 0;
  private suppressedSelectionKey: string | null = null;
  private bubbleReturnFocus: HTMLElement | null = null;
  private threads: Thread[] = [];
  private threadFilter: ThreadFilter = "active";
  private seenThreadIds = new Set<Id<"threads">>();
  private seenReplyIds = new Set<Id<"replies">>();
  private newThreadIds = new Set<Id<"threads">>();
  private newReplyIds = new Set<Id<"replies">>();
  private subscriptionReady = false;
  private pendingDeletes = new Map<Id<"threads">, number>();
  private newCommentCount = 0;
  private highlightedThreadId: Id<"threads"> | null = null;
  private commentMode = false;
  private canWrite: boolean;
  private raf = 0;
  private openThreadId: Id<"threads"> | null = null;
  private closeTimer = 0;
  private drawerCollapseTimer = 0;
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
    this.anchorHighlight = h("div", {
      class: "anchor-highlight",
      "aria-hidden": "true",
    });
    this.tip = h("div", {
      class: "tip",
      id: "commentor-tooltip",
      "data-testid": "commentor-tip",
      role: "tooltip",
    });
    this.root.append(
      this.markersLayer,
      this.bubbleLayer,
      this.anchorHighlight,
      this.tip,
    );

    this.selectionAction = h(
      "button",
      {
        class: "selection-action",
        "data-testid": "commentor-selection-action",
        "aria-label": "Comment on selected text",
        "data-state": "closed",
        hidden: "",
        onpointerdown: (e: Event) => e.preventDefault(),
        onclick: () => this.openSelectionComposer(),
      },
      svg(ICONS.comment),
      h("span", undefined, "Comment"),
    ) as HTMLButtonElement;
    this.root.append(this.selectionAction);

    this.content = h("div", {
      class: "content",
      "data-testid": "commentor-drawer",
      id: "commentor-drawer",
      role: "complementary",
      "aria-label": "Comments",
      "aria-hidden": "true",
    });
    this.content.inert = true;
    const makeFilter = (
      filter: ThreadFilter,
      label: string,
    ): HTMLButtonElement =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          "data-filter": filter,
          "aria-controls": "commentor-thread-list",
          "aria-selected": String(filter === this.threadFilter),
          onclick: () => this.setThreadFilter(filter),
          onkeydown: (e: KeyboardEvent) =>
            this.onFilterKeyDown(e, filter),
          tabindex: filter === this.threadFilter ? "0" : "-1",
        },
        label,
      ) as HTMLButtonElement;
    this.filterButtons = {
      active: makeFilter("active", "Active"),
      resolved: makeFilter("resolved", "Resolved"),
      history: makeFilter("history", "History"),
    };
    this.newCommentsButton = h(
      "button",
      {
        class: "new-comments",
        type: "button",
        hidden: "",
        "aria-live": "polite",
        onclick: () => this.showNewComments(),
      },
      "New comment",
    ) as HTMLButtonElement;
    this.content.append(
      h(
        "div",
        { class: "content-head" },
        h("span", undefined, "Comments"),
        h("span", { class: "count", "aria-label": "0 active comments" }, "0"),
      ),
      (this.filterTabs = h(
        "div",
        {
          class: "filter-tabs",
          role: "tablist",
          "aria-label": "Comment views",
          "data-active-filter": this.threadFilter,
        },
        this.filterButtons.active,
        this.filterButtons.resolved,
        this.filterButtons.history,
      )),
      (this.drawerList = h("div", {
        class: "content-list",
        id: "commentor-thread-list",
        "data-testid": "commentor-drawer-list",
        role: "tabpanel",
        tabindex: "0",
        "aria-label": "Active comments",
        onscroll: () => this.onDrawerScroll(),
      })),
      this.newCommentsButton,
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
    document.addEventListener("selectionchange", () =>
      this.scheduleSelectionAction(),
    );

    document.addEventListener("click", (e) => this.onDocumentClick(e));
    window.addEventListener("scroll", () => {
      this.hideSelectionAction(false);
      this.scheduleReposition();
    }, {
      passive: true,
    });
    window.addEventListener("resize", () => {
      if (this.dock.hasAttribute("data-expanded")) {
        const { w, h } = this.sizeContent();
        this.repositionExpandedDock(w, h);
      } else {
        this.repositionDock();
      }
      this.scheduleReposition();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.commentMode) this.setCommentMode(false);
        else this.closeBubbles(true, true);
        this.hideSelectionAction(true);
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
        this.newThreadIds = new Set(
          this.subscriptionReady
            ? threads
                .filter((t) => !this.seenThreadIds.has(t._id))
                .map((t) => t._id)
            : [],
        );
        this.newReplyIds = new Set(
          this.subscriptionReady
            ? threads.flatMap((t) =>
                t.replies
                  .filter((r) => !this.seenReplyIds.has(r._id))
                  .map((r) => r._id),
              )
            : [],
        );
        const incomingActive = threads.filter(
          (t) =>
            this.newThreadIds.has(t._id) &&
            !t.resolved &&
            !t.archived &&
            !this.pendingDeletes.has(t._id),
        ).length;
        this.threads = threads;
        this.seenThreadIds = new Set(threads.map((t) => t._id));
        this.seenReplyIds = new Set(
          threads.flatMap((t) => t.replies.map((r) => r._id)),
        );
        for (const [threadId, timer] of this.pendingDeletes) {
          if (threads.some((t) => t._id === threadId)) continue;
          window.clearTimeout(timer);
          this.pendingDeletes.delete(threadId);
        }
        this.renderPins();
        this.renderDrawerList();
        if (incomingActive > 0) this.announceNewComments(incomingActive);
        if (this.dock.hasAttribute("data-expanded")) {
          requestAnimationFrame(() => {
            const { w, h } = this.sizeContent();
            this.repositionExpandedDock(w, h);
          });
        }
        this.refreshOpenBubble();
        this.subscriptionReady = true;
        this.newThreadIds.clear();
        this.newReplyIds.clear();
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
        "aria-pressed": "false",
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
    const grip = h(
      "button",
      {
        class: "grip",
        type: "button",
        "data-testid": "commentor-toolbar-grip",
        "data-tip": "Drag or use arrow keys to move",
        "aria-label": "Move comment widget",
        "aria-keyshortcuts": "ArrowLeft ArrowRight ArrowUp ArrowDown Home End",
        onkeydown: (e: Event) => this.onGripKeyDown(e as KeyboardEvent),
      },
    ) as HTMLButtonElement;
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

  private onGripKeyDown(e: KeyboardEvent): void {
    const horizontal =
      this.dockEdge === "bottom" || this.dockEdge === "top";
    const step = 24;
    let next = this.dockOffset;
    if (horizontal && e.key === "ArrowLeft") next -= step;
    else if (horizontal && e.key === "ArrowRight") next += step;
    else if (!horizontal && e.key === "ArrowUp") next -= step;
    else if (!horizontal && e.key === "ArrowDown") next += step;
    else if (e.key === "Home") next = MARGIN;
    else if (e.key === "End")
      next =
        (horizontal ? window.innerWidth : window.innerHeight) -
        (horizontal ? this.dock.offsetWidth : this.dock.offsetHeight) -
        MARGIN;
    else return;
    e.preventDefault();
    if (this.dock.hasAttribute("data-expanded")) this.collapseDrawer(true);
    this.applyDockEdge(this.dockEdge, Math.max(MARGIN, next), true);
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
  private selectedAnchor(): {
    anchor: Anchor;
    rect: Rect;
    key: string;
  } | null {
    const sel = window.getSelection();
    if (
      !sel ||
      sel.isCollapsed ||
      sel.rangeCount === 0 ||
      !sel.toString().trim()
    )
      return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el || el.closest("#commentor-host")) return null;
    const quote = sel.toString();
    const path = cssPath(el);
    const anchor: Anchor = {
      kind: "text-range",
      quote,
      path,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    };
    const r = range.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return {
      anchor,
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      key: `${quote}\u0000${path.join(">")}\u0000${range.startOffset}:${range.endOffset}`,
    };
  }

  private scheduleSelectionAction(): void {
    if (!this.canWrite) return;
    if (this.selectionRaf) return;
    this.selectionRaf = requestAnimationFrame(() => {
      this.selectionRaf = 0;
      const selected = this.selectedAnchor();
      if (!selected) {
        this.suppressedSelectionKey = null;
        this.hideSelectionAction(false);
        return;
      }
      if (
        selected.key === this.suppressedSelectionKey ||
        this.bubbleLayer.children.length > 0
      ) {
        this.hideSelectionAction(false);
        return;
      }
      clearTimeout(this.selectionHideTimer);
      this.selectionAction.hidden = false;
      requestAnimationFrame(() => {
        this.selectionAction.setAttribute("data-state", "open");
        placeFloating(this.selectionAction, selected.rect, 6);
      });
    });
  }

  private hideSelectionAction(suppressCurrent: boolean): void {
    if (suppressCurrent) {
      this.suppressedSelectionKey = this.selectedAnchor()?.key ?? null;
    }
    clearTimeout(this.selectionHideTimer);
    this.selectionAction.setAttribute("data-state", "closed");
    this.selectionHideTimer = window.setTimeout(() => {
      if (this.selectionAction.getAttribute("data-state") === "closed")
        this.selectionAction.hidden = true;
    }, 150);
  }

  private openSelectionComposer(): boolean {
    const selected = this.selectedAnchor();
    if (!selected) return false;
    this.suppressedSelectionKey = selected.key;
    this.hideSelectionAction(false);
    this.setCommentMode(false);
    const returnFocus =
      this.root.querySelector<HTMLElement>(
        '[data-testid="commentor-comment-btn"]',
      ) ?? this.commentsBtn;
    this.openComposer(selected.anchor, selected.rect, returnFocus);
    return true;
  }

  private onCommentButton(): void {
    if (!this.cfg.author) return;
    if (this.openSelectionComposer()) return;
    this.setCommentMode(!this.commentMode);
  }

  private setCommentMode(on: boolean): void {
    this.commentMode = on;
    const btn = this.root.querySelector<HTMLElement>(
      '[data-testid="commentor-comment-btn"]',
    );
    btn?.classList.toggle("active", on);
    btn?.setAttribute("aria-pressed", String(on));
    this.root.querySelector('[data-testid="commentor-comment-hint"]')?.remove();
    if (on) {
      this.hideSelectionAction(true);
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
    const ordered = this.filteredThreads(
      this.dock.hasAttribute("data-expanded") ? this.threadFilter : "active",
    );
    ordered.forEach((t, i) => {
      const pin = h(
        "button",
        {
          class: `pin${t.resolved ? " resolved" : ""}${
            this.newThreadIds.has(t._id) ? " is-new" : ""
          }`,
          "data-testid": "commentor-pin",
          "data-thread-id": t._id,
          "data-tip": `${t.authorName}: ${t.body.slice(0, 60)}`,
          "aria-label": `Thread ${i + 1} by ${t.authorName}`,
          "aria-pressed": String(this.openThreadId === t._id),
          onpointerenter: () => this.highlightThread(t._id),
          onpointerleave: () => {
            if (this.openThreadId !== t._id) this.highlightThread(null);
          },
          onfocus: () => this.highlightThread(t._id),
          onblur: () => {
            if (this.openThreadId !== t._id) this.highlightThread(null);
          },
          onclick: (ev) => {
            ev.stopPropagation();
            if (this.openThreadId === t._id) {
              this.closeBubbles(true, true);
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
    this.highlightThread(this.highlightedThreadId);
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
      this.positionAnchorHighlight();
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
  private openComposer(
    anchor: Anchor,
    rect: Rect,
    invoker: HTMLElement | null = null,
  ): void {
    if (!this.cfg.author) return;
    this.closeBubbles(false);
    this.hideSelectionAction(true);
    this.bubbleReturnFocus = invoker ?? this.commentsBtn;
    const textarea = h("textarea", {
      "data-testid": "commentor-composer-textarea",
      placeholder: "Add a comment…",
      "aria-describedby": "commentor-composer-help",
    }) as HTMLTextAreaElement;
    const post = h(
      "button",
      {
        class: "primary",
        "data-testid": "commentor-composer-post",
      },
      "Post",
    ) as HTMLButtonElement;
    const cancel = h(
      "button",
      {
        class: "ghost",
        "data-testid": "commentor-composer-cancel",
        onclick: () => this.closeBubbles(true, true),
      },
      "Cancel",
    ) as HTMLButtonElement;
    const submit = async () => {
      const body = textarea.value.trim();
      if (!body || post.disabled) return;
      textarea.disabled = true;
      post.disabled = true;
      cancel.disabled = true;
      post.classList.add("is-pending");
      post.setAttribute("aria-busy", "true");
      post.textContent = "Posting…";
      try {
        await this.client.mutation(api.threads.create, {
          orgSlug: this.cfg.orgSlug,
          filePath: this.cfg.filePath,
          authorEmail: this.cfg.author!.email,
          authorName: this.cfg.author!.name,
          body,
          anchor,
        });
        this.closeBubbles(true, true);
      } catch (err) {
        console.error("[commentor] create failed", err);
        textarea.disabled = false;
        post.disabled = false;
        cancel.disabled = false;
        post.classList.remove("is-pending");
        post.removeAttribute("aria-busy");
        post.textContent = "Post";
        this.toast("Could not post comment. Try again.", { kind: "error" });
        textarea.focus();
      }
    };
    post.addEventListener("click", submit);
    textarea.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        await submit();
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
        "aria-modal": "false",
      },
      h("div", { class: "anchor-label" }, anchorLabel(anchor)),
      textarea,
      h(
        "div",
        { class: "composer-footer" },
        h(
          "span",
          { class: "composer-help", id: "commentor-composer-help" },
          "Enter to post · Shift+Enter for a new line",
        ),
        h("div", { class: "actions" }, cancel, post),
      ),
    );
    this.bubbleLayer.append(bubble);
    placeFloating(bubble, rect);
    queueMicrotask(() => textarea.focus());
  }

  private openThreadBubble(
    t: Thread,
    pin: HTMLElement,
    returnFocus: HTMLElement = pin,
  ): void {
    this.closeBubbles(false);
    this.openThreadId = t._id;
    this.bubbleReturnFocus = returnFocus;
    for (const marker of this.markersLayer.querySelectorAll<HTMLElement>(
      '[data-testid="commentor-pin"]',
    ))
      marker.setAttribute(
        "aria-pressed",
        String(marker.dataset.threadId === t._id),
      );
    this.highlightThread(t._id);
    const bubble = h("div", {
      class: "bubble thread",
      "data-testid": "commentor-thread-bubble",
      "data-thread-id": t._id,
      "data-state": "open",
      role: "dialog",
      "aria-modal": "false",
      "aria-label": `Thread by ${t.authorName}`,
    });
    bubble.append(this.threadView(t, true));
    this.bubbleLayer.append(bubble);
    placeFloating(bubble, pin.getBoundingClientRect());
  }

  private closeBubbles(animate: boolean, restoreFocus = false): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = 0;
    }
    this.openThreadId = null;
    for (const marker of this.markersLayer.querySelectorAll<HTMLElement>(
      '[data-testid="commentor-pin"]',
    ))
      marker.setAttribute("aria-pressed", "false");
    this.highlightThread(null);
    const returnFocus = restoreFocus ? this.bubbleReturnFocus : null;
    this.bubbleReturnFocus = null;
    const finish = () => {
      this.bubbleLayer.replaceChildren();
      this.closeTimer = 0;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
    const kids = Array.from(this.bubbleLayer.children) as HTMLElement[];
    if (animate && kids.length) {
      kids.forEach((k) => k.setAttribute("data-state", "closed"));
      this.closeTimer = window.setTimeout(finish, 150);
    } else {
      finish();
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
    bubble.replaceChildren(this.threadView(t, true));
    const pin = this.markersLayer.querySelector<HTMLElement>(
      `[data-thread-id="${t._id}"]`,
    );
    if (pin) placeFloating(bubble, pin.getBoundingClientRect());
  }

  private async runThreadAction(
    button: HTMLButtonElement,
    label: string,
    action: () => Promise<unknown>,
    errorMessage: string,
  ): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add("is-pending");
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", `${label} in progress`);
    try {
      await action();
    } catch (err) {
      console.error(`[commentor] ${label.toLowerCase()} failed`, err);
      this.toast(errorMessage, { kind: "error" });
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.classList.remove("is-pending");
        button.removeAttribute("aria-busy");
        button.setAttribute("aria-label", label);
      }
    }
  }

  private scheduleDelete(t: Thread): void {
    if (this.pendingDeletes.has(t._id)) return;
    const timer = window.setTimeout(async () => {
      try {
        await this.client.mutation(api.threads.remove, { threadId: t._id });
      } catch (err) {
        console.error("[commentor] delete failed", err);
        this.pendingDeletes.delete(t._id);
        this.renderPins();
        this.renderDrawerList();
        this.toast("Could not delete comment.", { kind: "error" });
      }
    }, 5000);
    this.pendingDeletes.set(t._id, timer);
    if (this.openThreadId === t._id) this.closeBubbles(true);
    this.renderPins();
    this.renderDrawerList();
    this.toast("Comment deleted.", {
      actionLabel: "Undo",
      duration: 5000,
      onAction: () => {
        const pending = this.pendingDeletes.get(t._id);
        window.clearTimeout(pending);
        this.pendingDeletes.delete(t._id);
        this.renderPins();
        this.renderDrawerList();
        this.toast("Deletion undone.");
      },
    });
  }

  private threadView(t: Thread, inBubble = false): HTMLElement {
    const head = h(
      "div",
      { class: "head" },
      h("span", { class: "who", title: t.authorEmail }, t.authorName),
      h("span", { class: "when" }, timeAgo(t._creationTime)),
      t.resolved
        ? h("span", { class: "resolved" }, svg(ICONS.check, ""), "Resolved")
        : null,
      t.archived
        ? h(
            "span",
            { class: "archived-badge" },
            svg(ICONS.archive, ""),
            "Archived",
          )
        : null,
    );
    if (this.canWrite) {
      const actions = h("div", { class: "card-actions" });
      const resolveLabel = t.resolved ? "Reopen" : "Resolve";
      const resolveActionLabel = `${resolveLabel} comment by ${t.authorName}`;
      const resolveButton = h(
        "button",
        {
          class: "card-action",
          type: "button",
          "data-tip": resolveLabel,
          "aria-label": resolveActionLabel,
          "data-testid": "commentor-resolve-btn",
        },
        svg(ICONS.check),
      ) as HTMLButtonElement;
      resolveButton.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.runThreadAction(
          resolveButton,
          resolveActionLabel,
          () =>
            this.client.mutation(api.threads.resolve, { threadId: t._id }),
          `Could not ${resolveLabel.toLowerCase()} comment.`,
        );
      });
      const archiveLabel = t.archived ? "Unarchive" : "Archive";
      const archiveActionLabel = `${archiveLabel} comment by ${t.authorName}`;
      const archiveButton = h(
        "button",
        {
          class: "card-action",
          type: "button",
          "data-tip": archiveLabel,
          "aria-label": archiveActionLabel,
          "data-testid": "commentor-archive-btn",
        },
        svg(ICONS.archive),
      ) as HTMLButtonElement;
      archiveButton.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.runThreadAction(
          archiveButton,
          archiveActionLabel,
          () =>
            this.client.mutation(api.threads.archive, { threadId: t._id }),
          `Could not ${archiveLabel.toLowerCase()} comment.`,
        );
      });
      const deleteButton = h(
        "button",
        {
          class: "card-action danger",
          type: "button",
          "data-tip": "Delete",
          "aria-label": `Delete comment by ${t.authorName}`,
          "data-testid": "commentor-delete-btn",
          onclick: (e: Event) => {
            e.stopPropagation();
            this.scheduleDelete(t);
          },
        },
        svg(ICONS.trash),
      );
      actions.append(resolveButton, archiveButton, deleteButton);
      head.append(actions);
    }
    if (inBubble) {
      head.append(
        h(
          "button",
          {
            class: "card-action thread-close",
            type: "button",
            "data-tip": "Close",
            "aria-label": "Close thread",
            onclick: () => this.closeBubbles(true, true),
          },
          svg(ICONS.x),
        ),
      );
    }
    const quote = anchorQuote(t.anchor);
    const locate = quote
      ? h(
          "button",
          {
            class: "quote",
            type: "button",
            "aria-label": "Locate commented text on page",
            onclick: () => this.focusThread(t),
          },
          h("span", { class: "quote-text" }, escapeText(quote)),
        )
      : h(
          "button",
          {
            class: "locate-link",
            type: "button",
            "aria-label": "Locate commented element on page",
            onclick: () => this.focusThread(t),
          },
          "Locate element",
        );
    const view = h(
      "div",
      { class: "thread-view", "data-thread-id": t._id },
      head,
      locate,
      h("div", { class: "body" }, escapeText(t.body)),
    );
    const replies = h("div", { class: "replies" });
    for (const r of t.replies)
      replies.append(
        h(
          "div",
          {
            class: `reply${this.newReplyIds.has(r._id) ? " is-new" : ""}`,
          },
          h("span", { class: "reply-who" }, r.authorName),
          escapeText(r.body),
        ),
      );
    view.append(replies);
    if (this.canWrite && this.cfg.author) {
      const helpId = `commentor-reply-help-${t._id}`;
      const input = h("textarea", {
        class: "reply-input",
        "data-testid": "commentor-reply-input",
        placeholder: "Reply…",
        rows: "1",
        "aria-describedby": helpId,
      }) as HTMLTextAreaElement;
      const send = h(
        "button",
        {
          class: "primary compact",
          type: "button",
          "data-testid": "commentor-reply-send",
        },
        "Reply",
      ) as HTMLButtonElement;
      const submitReply = async () => {
        const body = input.value.trim();
        if (!body || send.disabled) return;
        input.disabled = true;
        send.disabled = true;
        send.classList.add("is-pending");
        send.setAttribute("aria-busy", "true");
        send.textContent = "Sending…";
        try {
          await this.client.mutation(api.replies.add, {
            threadId: t._id,
            authorEmail: this.cfg.author!.email,
            authorName: this.cfg.author!.name,
            body,
          });
          input.value = "";
        } catch (err) {
          console.error("[commentor] reply failed", err);
          this.toast("Could not post reply.", { kind: "error" });
        } finally {
          if (input.isConnected) {
            input.disabled = false;
            send.disabled = false;
            send.classList.remove("is-pending");
            send.removeAttribute("aria-busy");
            send.textContent = "Reply";
            input.focus();
          }
        }
      };
      send.addEventListener("click", () => void submitReply());
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          void submitReply();
        }
      });
      view.append(
        h(
          "div",
          { class: "reply-row" },
          input,
          h(
            "div",
            { class: "reply-footer" },
            h(
              "span",
              { class: "composer-help", id: helpId },
              "Enter to reply · Shift+Enter for a new line",
            ),
            send,
          ),
        ),
      );
    }
    return view;
  }

  // ── drawer (the widget expanding into the comments list) ──
  private filteredThreads(filter: ThreadFilter): Thread[] {
    return this.threads
      .filter((t) => !this.pendingDeletes.has(t._id))
      .filter((t) => {
        if (filter === "history") return Boolean(t.archived);
        if (t.archived) return false;
        return filter === "resolved" ? t.resolved : !t.resolved;
      })
      .sort((a, b) => a._creationTime - b._creationTime);
  }

  private setThreadFilter(filter: ThreadFilter): void {
    this.threadFilter = filter;
    this.filterTabs.dataset.activeFilter = filter;
    this.drawerList.setAttribute(
      "aria-label",
      `${THREAD_FILTER_LABELS[filter]} comments`,
    );
    for (const [name, button] of Object.entries(this.filterButtons) as [
      ThreadFilter,
      HTMLButtonElement,
    ][]) {
      button.setAttribute("aria-selected", String(name === filter));
      button.tabIndex = name === filter ? 0 : -1;
    }
    this.renderDrawerList();
    this.renderPins();
    requestAnimationFrame(() => {
      const { w, h } = this.sizeContent();
      this.repositionExpandedDock(w, h);
    });
  }

  private onFilterKeyDown(e: KeyboardEvent, filter: ThreadFilter): void {
    const index = THREAD_FILTERS.indexOf(filter);
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % THREAD_FILTERS.length;
    else if (e.key === "ArrowLeft")
      next = (index - 1 + THREAD_FILTERS.length) % THREAD_FILTERS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = THREAD_FILTERS.length - 1;
    else return;
    e.preventDefault();
    const target = THREAD_FILTERS[next];
    this.setThreadFilter(target);
    this.filterButtons[target].focus();
  }

  private toggleDrawer(): void {
    if (this.dock.hasAttribute("data-expanded")) this.collapseDrawer();
    else this.expandDrawer();
  }

  private expandDrawer(): void {
    if (this.drawerCollapseTimer) {
      window.clearTimeout(this.drawerCollapseTimer);
      this.drawerCollapseTimer = 0;
    }
    this.dock.setAttribute("data-expanded", "");
    this.dock.toggleAttribute("data-compact-sheet", window.innerWidth < 420);
    this.content.inert = false;
    this.content.setAttribute("aria-hidden", "false");
    this.commentsBtn.setAttribute("aria-expanded", "true");
    this.commentsBtn.classList.add("active");
    this.renderDrawerList();
    this.renderPins();
    requestAnimationFrame(() => {
      const { w, h } = this.sizeContent();
      this.repositionExpandedDock(w, h);
    });
  }

  private collapseDrawer(immediate = false): void {
    if (this.drawerCollapseTimer) {
      window.clearTimeout(this.drawerCollapseTimer);
      this.drawerCollapseTimer = 0;
    }
    this.commentsBtn.setAttribute("aria-expanded", "false");
    this.commentsBtn.classList.remove("active");
    this.content.inert = true;
    this.content.setAttribute("aria-hidden", "true");
    this.content.style.height = "0px";
    this.content.style.width = "0px";
    this.dock.removeAttribute("data-compact-sheet");
    if (immediate) {
      this.dock.removeAttribute("data-expanded");
      this.content.style.height = "";
      this.content.style.width = "";
      this.renderPins();
      return;
    }
    this.dock.removeAttribute("data-expanded");
    const toolbar = this.dock.querySelector<HTMLElement>(".toolbar");
    const tw = toolbar ? toolbar.offsetWidth : 48;
    const th = toolbar ? toolbar.offsetHeight : 48;
    const ds = getComputedStyle(this.dock);
    const bw = parseFloat(ds.borderLeftWidth) + parseFloat(ds.borderRightWidth);
    const bh = parseFloat(ds.borderTopWidth) + parseFloat(ds.borderBottomWidth);
    this.repositionDock(tw + bw, th + bh);
    this.renderPins();
    this.drawerCollapseTimer = window.setTimeout(() => {
      this.drawerCollapseTimer = 0;
      if (this.dock.hasAttribute("data-expanded")) return;
      this.content.style.height = "";
      this.content.style.width = "";
    }, 300);
  }

  private sizeContent(): { w: number; h: number } {
    if (!this.dock.hasAttribute("data-expanded")) return { w: 0, h: 0 };
    const compact = window.innerWidth < 420;
    this.dock.toggleAttribute("data-compact-sheet", compact);
    const headH =
      this.content.querySelector<HTMLElement>(".content-head")?.offsetHeight ??
      0;
    const tabsH =
      this.content.querySelector<HTMLElement>(".filter-tabs")?.offsetHeight ??
      0;
    const maxH = Math.min(window.innerHeight * 0.6, 520);
    const naturalH = Math.min(
      headH + tabsH + this.drawerList.scrollHeight,
      maxH,
    );
    const toolbar = this.dock.querySelector<HTMLElement>(".toolbar");
    const tw = toolbar ? toolbar.offsetWidth : 48;
    const horizontal =
      !compact && (this.dockEdge === "left" || this.dockEdge === "right");
    const availW = Math.max(
      0,
      window.innerWidth - 2 * MARGIN - (horizontal ? tw : 0),
    );
    const targetW = Math.min(380, availW);
    const targetH = horizontal ? maxH : naturalH;
    this.content.style.height = `${targetH}px`;
    this.content.style.width = `${targetW}px`;
    return { w: targetW, h: targetH };
  }

  private repositionExpandedDock(contentW: number, contentH: number): void {
    if (!this.dock.hasAttribute("data-expanded")) return;
    const toolbar = this.dock.querySelector<HTMLElement>(".toolbar");
    const tw = toolbar ? toolbar.offsetWidth : 48;
    const th = toolbar ? toolbar.offsetHeight : 48;
    const ds = getComputedStyle(this.dock);
    const bw = parseFloat(ds.borderLeftWidth) + parseFloat(ds.borderRightWidth);
    const bh = parseFloat(ds.borderTopWidth) + parseFloat(ds.borderBottomWidth);
    const compact = window.innerWidth < 420;
    const horizontal =
      !compact && (this.dockEdge === "left" || this.dockEdge === "right");
    const dockW = (horizontal ? tw + contentW : Math.max(tw, contentW)) + bw;
    const dockH = (horizontal ? Math.max(th, contentH) : th + contentH) + bh;
    if (compact) {
      this.dock.style.right = "auto";
      this.dock.style.bottom = "auto";
      this.dock.style.left = `${MARGIN}px`;
      this.dock.style.top = `${window.innerHeight - dockH - MARGIN}px`;
      return;
    }
    this.repositionDock(dockW, dockH);
  }

  private renderDrawerList(): void {
    const counts: Record<ThreadFilter, number> = {
      active: this.filteredThreads("active").length,
      resolved: this.filteredThreads("resolved").length,
      history: this.filteredThreads("history").length,
    };
    const count = this.content.querySelector<HTMLElement>(".count");
    if (count) {
      count.textContent = String(counts.active);
      count.setAttribute(
        "aria-label",
        `${counts.active} active comment${counts.active === 1 ? "" : "s"}`,
      );
    }
    for (const filter of THREAD_FILTERS) {
      const button = this.filterButtons[filter];
      button.replaceChildren(
        THREAD_FILTER_LABELS[filter],
        h("span", { class: "filter-count" }, String(counts[filter])),
      );
    }
    this.drawerList.replaceChildren();
    const visible = this.filteredThreads(this.threadFilter);
    if (visible.length === 0) {
      const title: Record<ThreadFilter, string> = {
        active: "No active comments",
        resolved: "No resolved comments",
        history: "No archived comments",
      };
      const empty = h(
        "div",
        { class: "empty" },
        h("strong", undefined, title[this.threadFilter]),
        h(
          "span",
          undefined,
          this.threadFilter === "active"
            ? "Select text to start a discussion."
            : "Threads will appear here when their status changes.",
        ),
      );
      if (this.canWrite && this.threadFilter === "active") {
        empty.append(
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                this.collapseDrawer();
                this.setCommentMode(true);
                this.root
                  .querySelector<HTMLButtonElement>(
                    '[data-testid="commentor-comment-btn"]',
                  )
                  ?.focus();
              },
            },
            svg(ICONS.comment),
            "Start a comment",
          ),
        );
      }
      this.drawerList.append(empty);
      return;
    }
    for (const t of visible) {
      const card = h(
        "div",
        {
          class: `drawer-thread${
            this.newThreadIds.has(t._id) ? " is-new" : ""
          }`,
          "data-thread-id": t._id,
          role: "group",
          tabindex: "0",
          "aria-label": `Comment by ${t.authorName}`,
        },
        this.threadView(t),
      );
      if (!anchorRect(t.anchor)) {
        card.classList.add("is-orphan");
        card.prepend(
          h("span", { class: "orphan-badge" }, "Anchor no longer found"),
        );
      }
      card.addEventListener("pointerenter", () =>
        this.highlightThread(t._id),
      );
      card.addEventListener("pointerleave", () => {
        if (this.openThreadId !== t._id) this.highlightThread(null);
      });
      card.addEventListener("focusin", () => this.highlightThread(t._id));
      card.addEventListener("focusout", (e) => {
        if (
          !(e.relatedTarget instanceof Node) ||
          !card.contains(e.relatedTarget)
        )
          if (this.openThreadId !== t._id) this.highlightThread(null);
      });
      card.addEventListener("click", (e) => {
        if ((e.target as Element).closest("button, textarea")) return;
        this.focusThread(t, card);
      });
      card.addEventListener("keydown", (e) => {
        if (e.target === card && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          this.focusThread(t, card);
        }
      });
      this.drawerList.append(card);
    }
    this.highlightThread(this.highlightedThreadId);
  }

  private highlightThread(threadId: Id<"threads"> | null): void {
    this.highlightedThreadId = threadId;
    for (const el of this.root.querySelectorAll<HTMLElement>(
      "[data-thread-id]",
    )) {
      el.classList.toggle(
        "is-highlighted",
        Boolean(threadId && el.dataset.threadId === threadId),
      );
    }
    this.positionAnchorHighlight();
  }

  private positionAnchorHighlight(): void {
    const thread = this.threads.find(
      (candidate) => candidate._id === this.highlightedThreadId,
    );
    const rects = thread ? anchorRects(thread.anchor) : [];
    let visibleCount = 0;
    for (const rect of rects) {
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      )
        continue;
      let segment = this.anchorHighlight.children[
        visibleCount
      ] as HTMLElement | undefined;
      if (!segment) {
        segment = h("div", { class: "anchor-highlight-segment" });
        this.anchorHighlight.append(segment);
      }
      segment.style.left = `${rect.left - 3}px`;
      segment.style.top = `${rect.top - 3}px`;
      segment.style.width = `${Math.max(6, rect.right - rect.left + 6)}px`;
      segment.style.height = `${Math.max(6, rect.bottom - rect.top + 6)}px`;
      visibleCount += 1;
    }
    while (this.anchorHighlight.children.length > visibleCount)
      this.anchorHighlight.lastElementChild?.remove();
    if (visibleCount === 0) {
      this.anchorHighlight.removeAttribute("data-visible");
      return;
    }
    this.anchorHighlight.setAttribute("data-visible", "");
  }

  private scrollDocumentToRect(
    rect: Rect,
    behavior: ScrollBehavior,
  ): boolean {
    const scroller = document.scrollingElement;
    if (!scroller) return false;
    const viewportHeight =
      document.documentElement.clientHeight || window.innerHeight;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - viewportHeight);
    if (
      maxScrollTop === 0 ||
      (rect.top >= 0 && rect.bottom <= viewportHeight)
    )
      return false;
    const targetTop = Math.min(
      maxScrollTop,
      Math.max(
        0,
        scroller.scrollTop +
          rect.top +
          (rect.bottom - rect.top) / 2 -
          viewportHeight / 2,
      ),
    );
    if (Math.abs(targetTop - scroller.scrollTop) < 1) return false;
    scroller.scrollTo({ top: targetTop, behavior });
    return true;
  }

  private focusThread(t: Thread, returnFocus?: HTMLElement): void {
    const el = anchorElement(t.anchor);
    const rect = anchorRect(t.anchor);
    if (!el || !rect) {
      this.toast("This comment’s anchor is no longer available.", {
        kind: "error",
      });
      return;
    }
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const scrolled = this.scrollDocumentToRect(
      rect,
      reduce ? "auto" : "smooth",
    );
    const reveal = () => {
      this.repositionPins();
      this.highlightThread(t._id);
      const pin = this.markersLayer.querySelector<HTMLElement>(
        `[data-thread-id="${t._id}"]`,
      );
      if (pin) this.openThreadBubble(t, pin, returnFocus);
    };
    if (reduce || !scrolled) {
      requestAnimationFrame(reveal);
      return;
    }
    let revealed = false;
    const once = () => {
      if (revealed) return;
      revealed = true;
      window.removeEventListener("scrollend", once);
      reveal();
    };
    window.addEventListener("scrollend", once, { once: true });
    window.setTimeout(once, 450);
  }

  private announceNewComments(count: number): void {
    const badge = this.content.querySelector<HTMLElement>(".count");
    badge?.classList.remove("is-updated");
    void badge?.offsetWidth;
    badge?.classList.add("is-updated");
    if (
      !this.dock.hasAttribute("data-expanded") ||
      this.threadFilter !== "active"
    )
      return;
    const nearBottom =
      this.drawerList.scrollTop + this.drawerList.clientHeight >=
      this.drawerList.scrollHeight - 48;
    if (nearBottom) return;
    this.newCommentCount += count;
    this.newCommentsButton.textContent = `${this.newCommentCount} new comment${
      this.newCommentCount === 1 ? "" : "s"
    }`;
    this.newCommentsButton.hidden = false;
  }

  private onDrawerScroll(): void {
    const nearBottom =
      this.drawerList.scrollTop + this.drawerList.clientHeight >=
      this.drawerList.scrollHeight - 24;
    if (!nearBottom) return;
    this.newCommentCount = 0;
    this.newCommentsButton.hidden = true;
  }

  private showNewComments(): void {
    this.newCommentCount = 0;
    this.newCommentsButton.hidden = true;
    this.setThreadFilter("active");
    requestAnimationFrame(() => {
      this.drawerList.scrollTo({
        top: this.drawerList.scrollHeight,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    });
  }

  // ── tooltips (fast, per-element, flip below when no room above) ──
  private tipScrollSuppress = false;
  private wireTooltips(): void {
    const show = (target: HTMLElement) => {
      if (this.tipScrollSuppress || this.tipTarget === target) return;
      const text = target.getAttribute("data-tip");
      if (!text) return;
      this.hideTip();
      this.tipTarget = target;
      this.tipPreviousDescription = target.getAttribute("aria-describedby");
      target.setAttribute(
        "aria-describedby",
        [this.tipPreviousDescription, this.tip.id].filter(Boolean).join(" "),
      );
      this.tipTimer = window.setTimeout(
        () => this.placeTip(target, text),
        150,
      );
    };
    this.root.addEventListener("pointerover", (e) => {
      const target = (e.target as HTMLElement)?.closest<HTMLElement>(
        "[data-tip]",
      );
      if (target) show(target);
    });
    this.root.addEventListener("pointerout", () => this.hideTip());
    this.root.addEventListener("focusin", (e) => {
      const target = (e.target as HTMLElement)?.closest<HTMLElement>(
        "[data-tip]",
      );
      if (target) show(target);
    });
    this.root.addEventListener("focusout", () => this.hideTip());
    let scrollTimer: number | undefined;
    window.addEventListener(
      "scroll",
      () => {
        this.tipScrollSuppress = true;
        this.hideTip();
        clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => {
          this.tipScrollSuppress = false;
        }, 120);
      },
      { passive: true },
    );
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
    clearTimeout(this.tipTimer);
    if (this.tipTarget) {
      if (this.tipPreviousDescription)
        this.tipTarget.setAttribute(
          "aria-describedby",
          this.tipPreviousDescription,
        );
      else this.tipTarget.removeAttribute("aria-describedby");
    }
    this.tipTimer = 0;
    this.tipTarget = null;
    this.tipPreviousDescription = null;
    this.tip.setAttribute("data-state", "closed");
  }

  private toast(msg: string, options: ToastOptions = {}): void {
    this.root.querySelector(".toast")?.remove();
    const close = (el: HTMLElement) => {
      el.setAttribute("data-state", "closed");
      window.setTimeout(() => el.remove(), 150);
    };
    const el = h(
      "div",
      {
        class: `toast${options.kind === "error" ? " error" : ""}`,
        role: options.kind === "error" ? "alert" : "status",
        "aria-live": options.kind === "error" ? "assertive" : "polite",
      },
      h("span", undefined, msg),
    );
    if (options.actionLabel && options.onAction) {
      el.append(
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              options.onAction?.();
              close(el);
            },
          },
          options.actionLabel,
        ),
      );
    }
    this.root.append(el);
    window.setTimeout(
      () => close(el),
      options.duration ?? (options.kind === "error" ? 6000 : 3000),
    );
  }
}

function anchorLabel(a: Anchor): string {
  const quote = anchorQuote(a);
  return quote
    ? `On: “${quote.slice(0, 60)}${quote.length > 60 ? "…" : ""}”`
    : "On: element";
}

// ───────────────────────────── styles ───────────────────────────────

const STYLES = /* css */ `
:host {
  --bg: #ffffff;
  --bg-elev: #ffffff;
  --fg: #09090b;
  --fg-muted: #71717a;
  --border: #e4e4e7;
  --border-soft: #f4f4f5;
  --accent: #c2410c;
  --accent-hover: #9a3412;
  --accent-fg: #ffffff;
  --resolved: #15803d;
  --resolved-bg: #166534;
  --danger: #b42318;
  --danger-bg: #b42318;
  --shadow: 0 4px 16px rgba(15, 23, 42, .10);
  --shadow-lg: 0 12px 32px rgba(15, 23, 42, .18);
  --radius: 16px;
  --radius-sm: 8px;
  --panel: 380px;
  --ease-standard: cubic-bezier(.4, 0, .2, 1);
  --ease-spring: cubic-bezier(.34, 1.56, .64, 1);
  --duration-fast: 150ms;
  --duration-base: 200ms;
  --duration-expand: 300ms;
  --duration-dock: 400ms;
  color: var(--fg);
  background: transparent;
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #09090b;
    --bg-elev: #18181b;
    --fg: #fafafa;
    --fg-muted: #a1a1aa;
    --border: #3f3f46;
    --border-soft: #27272a;
    --accent: #fb923c;
    --accent-hover: #fdba74;
    --accent-fg: #09090b;
    --resolved: #86efac;
    --resolved-bg: #166534;
    --danger: #fda4af;
    --danger-bg: #9f1239;
    --shadow: 0 4px 16px rgba(0, 0, 0, .48);
    --shadow-lg: 0 12px 32px rgba(0, 0, 0, .56);
  }
}
:host(.light) {
  --bg: #ffffff;
  --bg-elev: #ffffff;
  --fg: #09090b;
  --fg-muted: #71717a;
  --border: #e4e4e7;
  --border-soft: #f4f4f5;
  --accent: #c2410c;
  --accent-hover: #9a3412;
  --accent-fg: #ffffff;
  --resolved: #15803d;
  --resolved-bg: #166534;
  --danger: #b42318;
  --danger-bg: #b42318;
  --shadow: 0 4px 16px rgba(15, 23, 42, .10);
  --shadow-lg: 0 12px 32px rgba(15, 23, 42, .18);
}
:host(.dark) {
  --bg: #09090b;
  --bg-elev: #18181b;
  --fg: #fafafa;
  --fg-muted: #a1a1aa;
  --border: #3f3f46;
  --border-soft: #27272a;
  --accent: #fb923c;
  --accent-hover: #fdba74;
  --accent-fg: #09090b;
  --resolved: #86efac;
  --resolved-bg: #166534;
  --danger: #fda4af;
  --danger-bg: #9f1239;
  --shadow: 0 4px 16px rgba(0, 0, 0, .48);
  --shadow-lg: 0 12px 32px rgba(0, 0, 0, .56);
}

* {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
button { font: inherit; color: inherit; }
button:focus-visible, [tabindex="0"]:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Single movable surface: compact toolbar when closed, review panel when open. */
.dock {
  position: fixed;
  z-index: 2147483646;
  display: flex;
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  transition:
    left var(--duration-dock) var(--ease-spring),
    top var(--duration-dock) var(--ease-spring);
}
.dock.dragging { transition: none; cursor: grabbing; }
.dock.dock-bottom { flex-direction: column; align-items: stretch; }
.dock.dock-top { flex-direction: column-reverse; align-items: stretch; }
.dock.dock-left { flex-direction: row-reverse; align-items: stretch; }
.dock.dock-right { flex-direction: row; align-items: stretch; }

.toolbar { display: flex; align-items: center; gap: 2px; padding: 4px; }
.toolbar button, .grip {
  width: 44px;
  min-width: 44px;
  height: 44px;
  min-height: 44px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fg);
  transition:
    background var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}
.toolbar button:hover, .grip:hover { background: var(--border-soft); }
.toolbar button:active { transform: scale(.96); }
.toolbar button.active { background: var(--accent); color: var(--accent-fg); }
.toolbar button:disabled { opacity: .38; cursor: not-allowed; }
.grip {
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
.grip:active { cursor: grabbing; }
.grip::before {
  content: "";
  width: 4px;
  height: 16px;
  border-radius: 2px;
  background: repeating-linear-gradient(
    to bottom,
    var(--fg-muted) 0 2px,
    transparent 2px 5px
  );
}
.dock.dock-left .toolbar, .dock.dock-right .toolbar {
  flex-direction: column;
}
.dock.dock-left .grip::before, .dock.dock-right .grip::before {
  width: 16px;
  height: 4px;
  background: repeating-linear-gradient(
    to right,
    var(--fg-muted) 0 2px,
    transparent 2px 5px
  );
}

.content {
  position: relative;
  overflow: hidden;
  opacity: 0;
  height: 0;
  width: 0;
  display: flex;
  flex-direction: column;
  transition:
    height var(--duration-expand) var(--ease-spring),
    width var(--duration-expand) var(--ease-spring),
    opacity var(--duration-base) var(--ease-standard);
}
.dock[data-expanded] .content { opacity: 1; }
.dock[data-expanded] .toolbar {
  box-shadow: 0 -1px 0 var(--border-soft) inset;
}
.dock.dock-top[data-expanded] .toolbar,
.dock.dock-left[data-expanded] .toolbar {
  box-shadow: 0 1px 0 var(--border-soft) inset;
}
.content-head {
  flex: 0 0 auto;
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  font-weight: 650;
  white-space: nowrap;
}
.count {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-fg);
  background: var(--accent);
  font-size: 11px;
  font-weight: 750;
}
.count.is-updated { animation: count-tint var(--duration-base) var(--ease-standard); }
.filter-tabs {
  position: relative;
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  margin: 0 10px 8px;
  padding: 3px;
  border-radius: 10px;
  background: var(--border-soft);
}
.filter-tabs::before {
  content: "";
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: calc((100% - 10px) / 3);
  border-radius: 7px;
  background: var(--bg-elev);
  box-shadow: var(--shadow);
  pointer-events: none;
  transform: translateX(0);
  transition: transform var(--duration-base) var(--ease-standard);
}
.filter-tabs[data-active-filter="resolved"]::before {
  transform: translateX(calc(100% + 2px));
}
.filter-tabs[data-active-filter="history"]::before {
  transform: translateX(calc(200% + 4px));
}
.filter-tabs button {
  position: relative;
  z-index: 1;
  min-width: 0;
  min-height: 36px;
  padding: 6px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: color var(--duration-fast) var(--ease-standard);
}
.filter-tabs button[aria-selected="true"] {
  color: var(--fg);
}
.filter-count {
  margin-left: 5px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.new-comments {
  position: absolute;
  z-index: 3;
  top: 88px;
  left: 50%;
  transform: translateX(-50%);
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--accent);
  box-shadow: var(--shadow);
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}
.new-comments[hidden] { display: none; }
.content-list {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.drawer-thread {
  flex: 0 0 auto;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg);
  transition:
    border-color var(--duration-base) var(--ease-standard),
    box-shadow var(--duration-base) var(--ease-standard);
}
.drawer-thread:hover, .drawer-thread:focus-within,
.drawer-thread.is-highlighted {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent);
}
.drawer-thread.is-new { animation: new-card var(--duration-base) var(--ease-standard); }
.orphan-badge {
  display: inline-flex;
  margin-bottom: 7px;
  color: var(--danger);
  font-size: 11px;
  font-weight: 650;
}
.empty {
  min-height: 180px;
  padding: 24px 18px;
  color: var(--fg-muted);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
}
.empty strong { color: var(--fg); font-size: 14px; }
.empty button {
  min-height: 40px;
  margin-top: 6px;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--accent-fg);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-weight: 650;
}
.empty button svg { width: 15px; height: 15px; }

.selection-action {
  position: fixed;
  z-index: 2147483647;
  width: auto;
  min-width: 44px;
  height: 44px;
  padding: 0 12px;
  gap: 6px;
  border: 2px solid var(--bg-elev);
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-fg);
  box-shadow: var(--shadow-lg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transform: translateY(4px) scale(.96);
  pointer-events: none;
  transition:
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}
.selection-action[data-state="open"] {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
.anchor-highlight {
  position: fixed;
  inset: 0;
  z-index: 2147483644;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-standard);
}
.anchor-highlight[data-visible] { opacity: 1; }
.anchor-highlight-segment {
  position: absolute;
  border: 2px solid var(--accent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

/* Pins */
.markers {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483645;
}
.pin {
  position: fixed;
  pointer-events: auto;
  opacity: 1;
  width: 28px;
  height: 28px;
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
  background: var(--accent);
  color: var(--accent-fg);
  border: 2px solid var(--bg);
  box-shadow: var(--shadow);
  font-size: 11px;
  font-weight: 750;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background var(--duration-base) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
}
.pin::after {
  content: "";
  position: absolute;
  inset: -8px;
  border-radius: 999px;
}
.pin-num { display: block; transform: rotate(45deg); line-height: 1; }
.pin.resolved { background: var(--resolved-bg); color: #ffffff; }
.pin:hover, .pin.is-highlighted {
  transform: rotate(-45deg) scale(1.08);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent), var(--shadow);
  z-index: 2;
}
.pin:active { transform: rotate(-45deg) scale(.96); }
.pin.orphan { display: none; }
.pin.is-new { animation: pin-in var(--duration-base) var(--ease-spring); }

/* Composer and thread bubbles */
.bubbles {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
}
.bubble {
  position: fixed;
  pointer-events: auto;
  width: min(320px, calc(100vw - 16px));
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  padding: 12px;
  color: var(--fg);
  animation: bubble-in var(--duration-base) var(--ease-standard);
}
.bubble[data-state="closed"] {
  animation: bubble-out var(--duration-fast) var(--ease-standard) forwards;
}
.anchor-label {
  margin-bottom: 8px;
  color: var(--fg-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.bubble textarea, .reply-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--fg);
  outline: none;
  transition:
    border-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
}
.bubble textarea {
  min-height: 72px;
  padding: 9px 10px;
  resize: vertical;
  font-size: 13px;
}
.reply-input {
  min-height: 40px;
  padding: 8px 10px;
  resize: vertical;
  font-size: 12px;
}
.bubble textarea:focus, .reply-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
}
.composer-buttons { display: flex; gap: 6px; margin-top: 8px; }
.composer-help {
  display: block;
  margin-top: 6px;
  color: var(--fg-muted);
  font-size: 11px;
}
.reply-row { margin-top: 8px; }
.head { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.who {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 650;
}
.when { color: var(--fg-muted); }
.resolved {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--resolved);
  font-size: 11px;
  font-weight: 650;
}
.resolved svg, .archived-badge svg { width: 13px; height: 13px; }
.archived-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 650;
}
.card-actions {
  display: flex;
  gap: 2px;
  margin-left: auto;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-standard);
}
.drawer-thread:hover .card-actions,
.drawer-thread:focus-within .card-actions,
.bubble:hover .card-actions,
.bubble:focus-within .card-actions {
  opacity: 1;
}
.card-action {
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 7px;
  padding: 0;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}
.card-action:hover { background: var(--border-soft); color: var(--fg); }
.card-action.danger:hover { color: var(--danger); }
.card-action:disabled { opacity: .45; cursor: wait; }
.card-action svg { width: 15px; height: 15px; }
.quote {
  width: fit-content;
  max-width: 100%;
  margin: 8px 0;
  padding: 6px 10px;
  border: 0;
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--border-soft);
  color: var(--fg-muted);
  cursor: pointer;
  text-align: left;
  font-size: 12px;
}
.quote-text {
  line-height: 1.5;
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.quote:hover { color: var(--fg); }
.locate-link {
  margin: 6px 0 2px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  font-weight: 650;
}
.locate-link:hover { color: var(--accent-hover); text-decoration: underline; }
.body {
  margin: 6px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-size: 13px;
}
.replies {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.reply {
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--border-soft);
  color: var(--fg);
  overflow-wrap: anywhere;
  word-break: break-word;
  font-size: 12px;
}
.reply.is-new { animation: reply-in var(--duration-base) var(--ease-standard); }
.reply-who { margin-right: 4px; font-weight: 650; }
.actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  align-items: center;
}
.actions button, .reply-row button {
  min-height: 38px;
  border: 0;
  border-radius: var(--radius-sm);
  padding: 7px 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 12px;
  transition:
    background var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard);
}
.reply-row button { margin-top: 7px; }
.actions button.primary, .reply-row button.primary {
  background: var(--accent);
  color: var(--accent-fg);
}
.actions button.primary:hover, .reply-row button.primary:hover {
  background: var(--accent-hover);
}
.actions button.ghost { background: var(--border-soft); color: var(--fg); }
.actions button.ghost:hover { background: var(--border); }
.actions button:active, .reply-row button:active { transform: scale(.96); }
.actions button:disabled, .reply-row button:disabled {
  opacity: .58;
  cursor: wait;
}
.actions button svg, .reply-row button svg { width: 15px; height: 15px; }
.busy svg { display: none; }
.busy::before {
  content: "";
  width: 13px;
  height: 13px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin .8s linear infinite;
}

/* Guidance, status and tooltips */
.hint {
  position: fixed;
  bottom: 96px;
  left: 50%;
  z-index: 2147483647;
  max-width: calc(100vw - 24px);
  padding: 9px 16px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-fg);
  box-shadow: var(--shadow-lg);
  text-align: center;
  font-size: 13px;
  font-weight: 550;
  transform: translateX(-50%);
  animation: rise var(--duration-base) var(--ease-standard);
}
.toast {
  position: fixed;
  bottom: 96px;
  left: 50%;
  z-index: 2147483647;
  max-width: calc(100vw - 24px);
  min-height: 44px;
  padding: 8px 10px 8px 14px;
  border-radius: 999px;
  background: var(--fg);
  color: var(--bg);
  box-shadow: var(--shadow-lg);
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  transform: translateX(-50%);
  animation: rise var(--duration-base) var(--ease-standard);
}
.toast.error { background: var(--danger-bg); color: #ffffff; }
.toast button {
  min-height: 32px;
  padding: 5px 10px;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-weight: 700;
}
.toast[data-state="closed"] {
  animation: fall var(--duration-fast) var(--ease-standard) forwards;
}
.tip {
  position: fixed;
  z-index: 2147483647;
  pointer-events: none;
  max-width: 240px;
  padding: 5px 9px;
  border-radius: 6px;
  background: var(--fg);
  color: var(--bg);
  opacity: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  transform: translateY(2px) scale(.96);
  transition:
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}
.tip[data-state="open"] { opacity: 1; transform: translateY(0) scale(1); }

.dock[data-compact-sheet] {
  flex-direction: column;
  align-items: stretch;
}
.dock[data-compact-sheet] .toolbar {
  order: 2;
  flex-direction: row;
  justify-content: center;
  box-shadow: 0 -1px 0 var(--border-soft) inset;
}
.dock[data-compact-sheet] .content { order: 1; }

@keyframes pin-in {
  from { opacity: 0; transform: rotate(-45deg) scale(.8); }
  to { opacity: 1; transform: rotate(-45deg) scale(1); }
}
@keyframes bubble-in {
  from { opacity: 0; transform: scale(.96); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes bubble-out {
  from { opacity: 1; transform: scale(1); }
  to { opacity: 0; transform: scale(.98); }
}
@keyframes reply-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes new-card {
  from { background: color-mix(in srgb, var(--accent) 18%, var(--bg)); }
  to { background: var(--bg); }
}
@keyframes count-tint {
  50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent); }
}
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes rise {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
@keyframes fall {
  from { opacity: 1; transform: translateX(-50%) translateY(0); }
  to { opacity: 0; transform: translateX(-50%) translateY(8px); }
}

@media (max-width: 419px) {
  .actions button, .reply-row button, .card-action, .filter-tabs button, .empty button {
    min-height: 44px;
  }
  .bubble { width: calc(100vw - 16px); }
  .content-head { min-height: 44px; }
}
@media (hover: none) {
  .card-actions { opacity: 1; }
  .card-action { width: 44px; height: 44px; }
  .filter-tabs button, .actions button, .reply-row button, .toast button {
    min-height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pin, .bubble, .reply, .drawer-thread, .selection-action, .anchor-highlight,
  .count, .content, .hint, .toast, .tip, .dock, .filter-tabs::before, .busy::before {
    animation: none !important;
    transition: none !important;
  }
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
