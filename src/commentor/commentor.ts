import { CommentWriteCooldown } from "./write-cooldown";
import { commentErrorMessage, commentRetryAfter } from "./frame-errors";
import { CommentOperationConflictError, editDraftKey } from "./operation-state";
// commentor.ts — a drop-in commenting widget for any HTML file.
//
//   <script>window.COMMENTOR = { ... };</script>
//   <script src="/commentor.js"></script>
//
// Config is a repository doc ({ repoId, documentPath, blobSha, transport: "parent" }, #254), read from
// the script's data-commentor-config because repository frames allow no inline script. Every comment
// call goes through the trusted parent shell, which also says who may write; anchors are heading slug
// plus quote (repo-anchor.ts).
//
// Figma-style pins + inline bubbles. The widget is a single surface that
// DOCKS to a screen edge (magnetic, springy snap; stays where you dropped it
// ALONG the edge — never force-centered) and EXPANDS smoothly into the
// comments list (the dock grows; the toolbar is its handle). Open shadow root.

import type { Id } from "../../convex/_generated/dataModel";
import { draftAfterSuccessfulReply } from "./reply-state";
import { PendingDeletionCoordinator } from "./delete-state";
import { requestParentTheme } from "./theme-message";
import { appendPlainText } from "./text";
import { COMMENTOR_UPGRADE_NOTICE } from "./parent-protocol";
import { COMMENTOR_STYLES } from "./styles";
import { locateRepoAnchor, pageSections, repoAnchorFor, sectionRange, type RepoAnchor } from "./repo-anchor";
import { CommentMutationRejectedError, CommentMutationOutcomeUnknownError, ParentCommentTransport } from "./parent-transport";

// ─────────────────────────────── types ───────────────────────────────

interface Config {
  documentPath: string;
  repoId: number;
  blobSha: string;
  transport: "parent";
}
type ThreadId = Id<"repoThreads">;
type ReplyId = Id<"repoReplies">;

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sandboxed document frames have an opaque origin and cannot persist UI state.
  }
}

type Anchor = RepoAnchor;

// A repository doc (#254): the rendered page and the blob it shows. Anchors resolve once per thread
// snapshot (the page never changes), so pins cost no search while scrolling.
let repoPage!: { root: Element; blobSha: string; sections: ReturnType<typeof pageSections> | null };
const repoRanges = new WeakMap<RepoAnchor, Range | null>();

function repoRange(anchor: RepoAnchor): Range | null {
  if (repoRanges.has(anchor)) return repoRanges.get(anchor)!;
  repoPage.sections ??= pageSections(repoPage.root);
  const found = locateRepoAnchor(repoPage.sections, anchor, repoPage.blobSha);
  const range = found ? sectionRange(found.section, found.start, anchor.exact.length) : null;
  repoRanges.set(anchor, range);
  return range;
}
interface DrawerPlace {
  lastId: string;
  atEnd: boolean;
  anchorId: string;
  anchorOffset: number;
}
interface Reply {
  _id: ReplyId;
  _creationTime: number;
  canDelete?: boolean;
  /** Only the author may edit (#287); `editedAt` is the last edit, `editOperationId` the write that made it. */
  canEdit?: boolean;
  editedAt?: number;
  editOperationId?: string;
  /** The reader's own edit, shown before the live page carries it (#287). */
  saving?: SendingState;
  authorEmail: string;
  authorName: string;
  body: string;
  clientOperationId?: string;
  /** The reader's own reply, shown before the live page carries it (#284). */
  sending?: SendingState;
}
interface Thread {
  _id: ThreadId;
  _creationTime: number;
  canDelete?: boolean;
  canEdit?: boolean;
  editedAt?: number;
  editOperationId?: string;
  saving?: SendingState;
  authorEmail: string;
  authorName: string;
  body: string;
  anchor: Anchor;
  resolved: boolean;
  archived?: boolean;
  replies: Reply[];
  repliesHasMore?: boolean;
  clientOperationId?: string;
  /** The reader's own new thread, shown before the live page carries it (#284). */
  sending?: SendingState;
}
/** An optimistic write (#284): "sending" until acknowledged, then "sent" until the live page carries it. */
type SendingState = "sending" | "sent";
/** The comment being edited (#287), and where: the drawer card or the open thread bubble. */
interface EditTarget { key: string; threadId: ThreadId; replyId?: ReplyId; inBubble: boolean }
/** An edit on its way (#287), laid over the live page until the live row names its operation. */
interface SavingEdit { threadId: ThreadId; replyId?: ReplyId; body: string; clientOperationId: string; sending: SendingState }
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
    if (kid) {
      if (typeof kid === "string") appendPlainText(el, kid);
      else el.append(kid);
    }
  return el;
}

function svg(d: string): SVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  return wrap.querySelector("svg") as SVGElement;
}

const ICONS = {
  comment:
    "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  archive: "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
  trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6",
  edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
};

function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function anchorElement(a: Anchor): Element | null {
  return repoRange(a)?.startContainer.parentElement ?? null;
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

function textAnchorClientRects(anchor: Anchor): DOMRect[] {
  const range = repoRange(anchor);
  return range ? textRangeClientRects(range) : [];
}

function anchorQuote(anchor: Anchor): string | null {
  return anchor.exact.trim() ? anchor.exact : null;
}

function anchorPoint(
  a: Anchor,
): { x: number; y: number; ok: true } | { ok: false } {
  const rect = textAnchorClientRects(a)[0];
  return rect
    ? { x: rect.left, y: rect.top, ok: true }
    : { ok: false };
}

function anchorRect(a: Anchor): Rect | null {
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

function anchorRects(a: Anchor): Rect[] {
  const orderedRects = textAnchorClientRects(a);
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

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface FloatingMeasure {
  vw: number;
  vh: number;
  ew: number;
  eh: number;
}
/** Layout reads for placeFloating, separable so a caller can take them before its own writes. */
function measureFloating(el: HTMLElement): FloatingMeasure {
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    ew: el.offsetWidth,
    eh: el.offsetHeight,
  };
}
function placeFloating(
  el: HTMLElement,
  rect: Rect,
  gap = 8,
  { vw, vh, ew, eh }: FloatingMeasure = measureFloating(el),
): void {
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
  private parentTransport: ParentCommentTransport;
  private root: ShadowRoot;
  private writeCooldown: CommentWriteCooldown;
  private dock: HTMLElement;
  private content!: HTMLElement;
  private drawerList!: HTMLElement;
  // The list's cards in their natural height: the list itself is only as tall as the drawer lets it be.
  private drawerBody!: HTMLElement;
  private toolbar!: HTMLElement;
  private commentButton!: HTMLButtonElement;
  private commentsBtn!: HTMLButtonElement;
  private filterButtons!: Record<ThreadFilter, HTMLButtonElement>;
  private filterTabs!: HTMLElement;
  private newCommentsButton!: HTMLButtonElement;
  private markersLayer: HTMLElement;
  private bubbleLayer: HTMLElement;
  private anchorHighlight: HTMLElement;
  private selectionAction: HTMLButtonElement;
  private tip!: HTMLElement;
  private tipTimer = 0;
  private tipTarget: HTMLElement | null = null;
  private tipPreviousDescription: string | null = null;
  private selectionRaf = 0;
  private selectionHideTimer = 0;
  private suppressedSelectionKey: string | null = null;
  private bubbleReturnFocus: HTMLElement | null = null;
  private threads: Thread[] = [];
  // Optimistic writes (#284): the page as the parent last delivered it, and the reader's own new threads and
  // replies laid over it (into `threads`) until a live page carries them, matched by clientOperationId, or they fail.
  private liveThreads: Thread[] = [];
  private sendingThreads: Thread[] = [];
  private sendingReplies = new Map<ThreadId, Reply>();
  // Edits (#287): whether the parent carries them, the one comment being edited, the unsaved texts (kept in the
  // recovery state like reply drafts, by `editDraftKey`), and saves on their way laid over the live page.
  private canEdits = false;
  private editing: EditTarget | null = null;
  private editDrafts = new Map<string, string>();
  private savingEdits = new Map<string, SavingEdit>();
  // Polite announcements of the editor's outcomes; present (and empty) from the start so assistive technology registers it.
  private live: HTMLElement;
  private threadFilter: ThreadFilter = "active";
  private seenThreadIds = new Set<ThreadId>();
  private seenReplyIds = new Set<ReplyId>();
  private newThreadIds = new Set<ThreadId>();
  private newReplyIds = new Set<ReplyId>();
  private subscriptionReady = false;
  private pendingDeletes = new PendingDeletionCoordinator<ThreadId>();
  private composerHasSubmitted = false;
  private replyDrafts = new Map<ThreadId, string>();
  private pendingReplies = new Map<ThreadId, string>();
  private expandedReplies = new Map<ThreadId, Reply[]>();
  private replyPagination = new Map<ThreadId, { canLoadMore: boolean; loading: boolean }>();
  private canLoadMoreThreads = false;
  private loadingMoreThreads = false;
  private newCommentCount = 0;
  // Where the last restore left the list. While the reader has not scrolled since, the next restore aims at the same
  // offset rather than at the measured one, so a browser that snaps scroll positions to whole pixels cannot drift by
  // a fraction on every update.
  private restoredPlace: { anchorId: string; anchorOffset: number; scrollTop: number } | null = null;
  private highlightedThreadId: ThreadId | null = null;
  private commentMode = false;
  private canWrite: boolean;
  private parentUpgradeRequired = false;
  private canReloadViewer = false;
  private raf = 0;
  private drawerRaf = 0;
  private openThreadId: ThreadId | null = null;
  private closeTimer = 0;
  // Where a close animation in flight will return focus; a later close must not drop it.
  private closingFocus: HTMLElement | null = null;
  private drawerCollapseTimer = 0;
  private dockEdge: Edge = "bottom";
  private dockOffset = 0;

  constructor(cfg: Config) {
    // The parent says whether this reader may write (see the access callback below).
    this.canWrite = false;
    this.parentTransport = new ParentCommentTransport(window.parent, window, cfg.documentPath);

    const host = document.createElement("div");
    host.id = "commentor-host";
    document.body.append(host);
    this.root = host.attachShadow({ mode: "open" });
    this.writeCooldown = new CommentWriteCooldown(this.root);
    this.root.append(h("style", undefined, COMMENTOR_STYLES));
    this.live = h("div", { class: "live-region", role: "status", "aria-live": "polite", "aria-atomic": "true", "data-testid": "commentor-live" });
    this.root.append(this.live);

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
      "data-state": "closed",
      "aria-hidden": "true",
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
          onkeydown: (e: Event) =>
            this.onFilterKeyDown(e as KeyboardEvent, filter),
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
      }, (this.drawerBody = h("div", { class: "content-body" })))),
      this.newCommentsButton,
    );

    this.dock = h("div", { class: "dock", "data-testid": "commentor-dock" });
    this.toolbar = this.renderToolbar();
    this.dock.append(this.content, this.toolbar);
    this.root.append(this.dock);

    const savedEdge = storageGet("commentor-dock") as Edge | null;
    const savedOffsetValue = storageGet("commentor-dock-offset");
    const savedOffset = savedOffsetValue === null ? Number.NaN : Number(savedOffsetValue);
    this.applyDockEdge(
      savedEdge && ["bottom", "top", "left", "right"].includes(savedEdge)
        ? savedEdge
        : "bottom",
      Number.isFinite(savedOffset)
        ? savedOffset
        : Math.max(0, (window.innerWidth - 200) / 2),
      false,
    );

    window.addEventListener("message", (e) => this.onThemeMessage(e));
    this.applyTheme();
    window.addEventListener("storage", (e) => {
      if (e.key === "commentor-theme") this.applyTheme();
    });
    if (window.parent !== window) requestParentTheme(window.parent);
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
      if (this.dock.hasAttribute("data-expanded")) this.layoutDrawer();
      else this.repositionDock();
      this.scheduleReposition();
    });
    // Content that reflows without a scroll or window resize (images, fonts, expanding
    // sections) moves the anchors too. The observer's first callback is the initial frame.
    const reflow = new ResizeObserver(() => this.scheduleReposition());
    reflow.observe(document.documentElement);
    reflow.observe(document.body);
    // The open drawer fits what it shows, however that changes: a re-render, a reply box the reader drags taller,
    // text reflowing once the fonts load. The observer's first callback is the initial frame.
    const drawerReflow = new ResizeObserver(() => this.scheduleDrawerLayout());
    for (const part of [this.content.querySelector(".content-head")!, this.filterTabs, this.drawerBody]) drawerReflow.observe(part);
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
    const update = (
      incomingThreads: Thread[],
      pagination?: { canLoadMore: boolean; loading: boolean },
      suppressNew = false,
    ) => {
      const wasLoadingMore = this.loadingMoreThreads;
      if (pagination) {
        this.canLoadMoreThreads = pagination.canLoadMore;
        this.loadingMoreThreads = pagination.loading;
      }
      // The experimental client may publish an empty LoadingFirstPage state
      // before the first real page (including after a BFCache resubscribe).
      // Keep the current realtime view until that page arrives.
      if (pagination?.loading && incomingThreads.length === 0) {
        this.renderDrawerList();
        return;
      }
      this.syncRecoveryDrafts();
      const currentIds = new Set(incomingThreads.map((thread) => thread._id));
      for (const threadId of this.expandedReplies.keys()) {
        if (currentIds.has(threadId)) continue;
        this.expandedReplies.delete(threadId);
        this.replyPagination.delete(threadId);
      }
      const threads = incomingThreads.map((thread) => {
        const expanded = this.expandedReplies.get(thread._id);
        // Expanded replies and their pagination are always set and cleared together.
        return expanded
          ? { ...thread, replies: expanded, repliesHasMore: this.replyPagination.get(thread._id)!.canLoadMore }
          : thread;
      });
      this.settleSending(threads);
      this.liveThreads = threads;
      // A comment deleted while it was being edited takes its editor with it.
      if (this.editing && !this.editedItem(threads, this.editing)) this.editing = null;
      suppressNew ||= wasLoadingMore || pagination?.loading === true;
      const activeReply = this.root.activeElement instanceof HTMLTextAreaElement
        && this.root.activeElement.matches('[data-testid="commentor-reply-input"]')
        ? this.root.activeElement
        : null;
      const activeThreadId = activeReply
        ?.closest<HTMLElement>("[data-thread-id]")
        ?.dataset.threadId;
      const activeReplyInBubble = Boolean(activeReply?.closest(".bubble"));
      const selectionStart = activeReply?.selectionStart ?? 0;
      const selectionEnd = activeReply?.selectionEnd ?? 0;
      this.newThreadIds = new Set(
        this.subscriptionReady && !suppressNew
          ? threads
              .filter((thread) => !this.seenThreadIds.has(thread._id))
              .map((thread) => thread._id)
          : [],
      );
      this.newReplyIds = new Set(
        this.subscriptionReady && !suppressNew
          ? threads.flatMap((thread) =>
              thread.replies
                .filter((reply) => !this.seenReplyIds.has(reply._id))
                .map((reply) => reply._id),
            )
          : [],
      );
      const incomingActive = threads.filter(
        (thread) =>
          this.newThreadIds.has(thread._id) &&
          !thread.resolved &&
          !thread.archived &&
          !this.pendingDeletes.has(thread._id),
      ).length;
      this.threads = this.withSending(threads);
      this.seenThreadIds = new Set(threads.map((thread) => thread._id));
      this.seenReplyIds = new Set(
        threads.flatMap((thread) => thread.replies.map((reply) => reply._id)),
      );
      for (const threadId of this.pendingDeletes.keys()) {
        if (threads.some((thread) => thread._id === threadId)) continue;
        this.pendingDeletes.acknowledge(threadId);
      }
      this.renderPins();
      this.renderDrawerList();
      if (incomingActive > 0) this.announceNewComments(incomingActive);
      this.refreshOpenBubble();
      if (activeThreadId) {
        requestAnimationFrame(() => {
          const scope = activeReplyInBubble ? this.bubbleLayer : this.drawerList;
          const replacement = Array.from(
            scope.querySelectorAll<HTMLTextAreaElement>(
              '[data-testid="commentor-reply-input"]',
            ),
          ).find(
            (input) =>
              input.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId ===
              activeThreadId,
          );
          if (!replacement) return;
          replacement.focus({ preventScroll: true });
          replacement.setSelectionRange(selectionStart, selectionEnd);
        });
      }
      if (this.subscriptionReady || pagination?.loading !== true) {
        this.subscriptionReady = true;
      }
      this.newThreadIds.clear();
      this.newReplyIds.clear();
    };
    const fail = (error: Error) => {
      console.error("[commentor] subscription error", error);
      this.toast(error.message, { kind: "error" });
    };

    const transport = this.parentTransport;
    transport.subscribe(
      (threads, canLoadMore, loading) => update(
        threads as Thread[],
        { canLoadMore, loading },
      ),
      (threadId, replies, canLoadMore, loading) => {
        const id = threadId as ThreadId;
        const prior = this.replyPagination.get(id);
        if (replies.length > 0 || !loading) this.expandedReplies.set(id, replies as Reply[]);
        this.replyPagination.set(id, { canLoadMore, loading });
        update(this.liveThreads.map((thread) => thread._id === id
          ? {
              ...thread,
              replies: this.expandedReplies.get(id) ?? thread.replies,
              repliesHasMore: canLoadMore,
            }
          : thread), undefined, prior?.loading === true || loading);
      },
      fail,
      () => this.toast("Still waiting for confirmation. Your change is pending; refreshing comments will keep waiting for its result.", {
        actionLabel: "Refresh",
        duration: 30_000,
        onAction: () => {
          void transport.refresh().catch(() => {
            this.toast("Comments could not be refreshed. Still waiting for confirmation.", { kind: "error" });
          });
        },
      }),
      () => {
        // The parent is replacing its reply subscriptions too. Let the new
        // thread snapshots supply replies instead of retaining stale pages.
        this.expandedReplies.clear();
        this.replyPagination.clear();
        this.syncRecoveryDrafts();
        const operations = Object.values(transport.recovery.value.operations);
        if (operations.some((op) => !transport.isMutationPending(op.method, op.args))) {
          this.toast(new CommentMutationOutcomeUnknownError().message, { kind: "error" });
        }
        const draft = transport.recovery.value.drafts.create;
        if (draft && !this.bubbleLayer.querySelector('.composer[data-state="open"]')) {
          this.openComposer(draft.anchor as Anchor, this.commentsBtn.getBoundingClientRect());
        }
      },
      () => {
        this.writeCooldown.reset();
        this.replyDrafts.clear();
        this.closeBubbles(false);
        this.hideSelectionAction(true);
        this.hideTip();
        this.collapseDrawer(true);
        this.expandedReplies.clear();
        this.replyPagination.clear();
        // Another reader's writes are not this one's to show.
        this.sendingThreads = [];
        this.sendingReplies.clear();
        this.savingEdits.clear();
        this.editing = null;
        update([], { canLoadMore: false, loading: false });
      },
      (compatible, canReloadViewer, parentCanWrite, parentEdits) => {
        this.parentUpgradeRequired = !compatible;
        this.canReloadViewer = canReloadViewer;
        const wasWritable = this.canWrite;
        // A repository frame is the same for every reader: the parent says whether this one may write.
        this.canWrite = compatible && parentCanWrite === true;
        this.canEdits = this.canWrite && parentEdits === true;
        if (!this.canEdits) this.editing = null;
        this.commentButton.disabled = !this.canWrite;
        // A mode the disabled Comment control can no longer leave would keep its hint over the drawer.
        if (!this.canWrite && this.commentMode) this.setCommentMode(false);
        if (!compatible) {
          this.closeBubbles(false, true);
          this.threads = [];
          this.liveThreads = [];
          this.sendingThreads = [];
          this.sendingReplies.clear();
          this.savingEdits.clear();
          this.markersLayer.replaceChildren();
        }
        this.renderDrawerList();
        // Access changes only matter when they cross the guard, and the re-read must not
        // defer: a throttled or manually controlled frame schedule would leave a pending
        // rAF in selectionRaf, blocking scheduleSelectionAction and racing a hide timer.
        if (this.canWrite === wasWritable) return;
        const selected = this.canWrite ? this.selectedAnchor() : null;
        if (selected && selected.key !== this.suppressedSelectionKey && this.bubbleLayer.children.length === 0) {
          clearTimeout(this.selectionHideTimer);
          this.selectionAction.hidden = false;
          this.selectionAction.setAttribute("data-state", "open");
          placeFloating(this.selectionAction, selected.rect, 6);
        } else if (!this.selectionAction.hidden) {
          this.hideSelectionAction(false);
        }
      },
    );
  }

  // ── theme ──
  private applyTheme(mode = storageGet("commentor-theme") ?? "system"): void {
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
        onclick: () => this.onCommentButton(),
        // Nobody may write until the parent says so (parentReady).
        disabled: "disabled",
      },
      svg(ICONS.comment),
    ) as HTMLButtonElement;
    this.commentButton = commentBtn;
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
    // Dragging is only set together with the document and its listeners.
    this.dragDoc!.removeEventListener("pointermove", this.dragMoveListener!);
    this.dragDoc!.removeEventListener("pointerup", this.dragEndListener!);
    this.dragDoc!.removeEventListener("pointercancel", this.dragEndListener!);
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
    storageSet("commentor-dock", edge);
    storageSet("commentor-dock-offset", String(offset));
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
  // Use left/top for ALL edges (never right/bottom). This keeps both
  // properties numeric at all times so the dock's `transition: left/top`
  // always fires from the old value to the new one — smooth snap on every edge.
  //   bottom edge → top = vh - h - MARGIN, left = offset
  //   top edge    → top = MARGIN,          left = offset
  //   left edge   → left = MARGIN,         top = offset
  //   right edge  → left = vw - w - MARGIN, top = offset
  // When targetW/targetH are supplied (expand), use those instead of
  // offsetWidth/offsetHeight — the latter return the pre-transition (compact)
  // size because the CSS width/height transition hasn't laid out the target
  // size yet.
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
    // Repository docs: the quote, its heading and its context, so the comment survives new commits.
    const repoAnchor = repoAnchorFor(repoPage.root, repoPage.sections ??= pageSections(repoPage.root), range, repoPage.blobSha);
    const bounds = range.getBoundingClientRect();
    if (!repoAnchor || (!bounds.width && !bounds.height)) return null;
    return {
      anchor: repoAnchor,
      rect: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      key: `${repoAnchor.headingSlug}\u0000${repoAnchor.offset}:${repoAnchor.exact.length}`,
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
    this.openComposer(selected.anchor, selected.rect, this.commentButton);
    return true;
  }

  private onCommentButton(): void {
    if (!this.canWrite) return;
    if (this.openSelectionComposer()) return;
    this.setCommentMode(!this.commentMode);
  }

  private setCommentMode(on: boolean): void {
    this.commentMode = on;
    this.commentButton.classList.toggle("active", on);
    this.commentButton.setAttribute("aria-pressed", String(on));
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
    // Repository docs anchor to text only: the clicked element's text, if it has any.
    const range = document.createRange();
    range.selectNodeContents(target);
    const anchor = repoAnchorFor(repoPage.root, repoPage.sections ??= pageSections(repoPage.root), range, repoPage.blobSha);
    if (!anchor) {
      this.setCommentMode(false);
      this.toast("Select some text to comment on.");
      return;
    }
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
          }${t.sending ? " is-sending" : ""}`,
          "data-testid": "commentor-pin",
          "data-thread-id": t._id,
          "data-tip": `${t.authorName}: ${t.body.slice(0, 60)}`,
          "aria-label": `Thread ${i + 1} by ${t.authorName}${t.sending === "sending" ? ", sending" : ""}`,
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
    this.repositionPins({ highlight: true });
    this.syncHighlightClasses();
  }

  /** Coalesces scroll, resize and content-size changes into one layout pass per animation frame. */
  private scheduleReposition(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.repositionPins({ bubble: true, highlight: true });
    });
  }

  /**
   * One layout pass: every read (viewport, anchors, the open bubble's pin and size, the highlighted
   * anchor) happens before the first write, so the pass costs a single layout however many pins
   * there are. A write ahead of a later read would force a fresh layout for each pin.
   */
  private repositionPins({
    bubble = false,
    highlight = false,
  }: { bubble?: boolean; highlight?: boolean } = {}): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const threadById = new Map(this.threads.map((t) => [t._id, t]));
    const pins = Array.from(
      this.markersLayer.querySelectorAll<HTMLElement>(
        '[data-testid="commentor-pin"]',
      ),
    );
    // Pins are rebuilt from this.threads whenever it changes, so every pin has its thread.
    const points = pins.map((pin) =>
      anchorPoint(
        threadById.get(pin.getAttribute("data-thread-id") as ThreadId)!.anchor,
      ),
    );
    const open = bubble ? this.measureOpenBubble() : null;
    const highlightRects = highlight ? this.measureAnchorHighlight() : null;

    let openRect: Rect | undefined;
    for (const [index, pin] of pins.entries()) {
      const p = points[index];
      if (!p.ok) {
        pin.classList.add("orphan");
        pin.style.display = "none";
        if (pin === open?.pin) openRect = { left: 0, top: 0, right: 0, bottom: 0 };
        continue;
      }
      // Hide the pin when its anchor has scrolled out of the viewport.
      // Without this, clamp() pins the tooltip to the viewport edge and
      // the pin (and its tooltip) appear "sticky" — visible even though
      // the commented element is off-screen.
      if (p.y < 0 || p.y > height) {
        pin.style.display = "none";
        if (pin === open?.pin) openRect = { left: 0, top: 0, right: 0, bottom: 0 };
        continue;
      }
      const left = clamp(8, width - 30, p.x - 10);
      const top = clamp(8, height - 30, p.y - 26);
      pin.classList.remove("orphan");
      pin.style.display = "";
      pin.style.left = `${left}px`;
      pin.style.top = `${top}px`;
      if (pin === open?.pin && open.placed) {
        const { rect } = open.placed;
        const dx = left - open.placed.left;
        const dy = top - open.placed.top;
        openRect = { left: rect.left + dx, right: rect.right + dx, top: rect.top + dy, bottom: rect.bottom + dy };
      }
    }

    if (open) {
      // A fixed pin moves by exactly the change in its left/top, so its new box is its old box
      // shifted, with no layout read after the writes above. Only a pin that was not placed
      // before needs one.
      const rect = openRect ?? open.pin?.getBoundingClientRect();
      if (rect) placeFloating(open.el, rect, 8, open.size);
    }
    if (highlightRects) this.paintAnchorHighlight(highlightRects, width, height);
  }

  /** Reads for re-anchoring the open thread bubble to its pin. */
  private measureOpenBubble(): {
    el: HTMLElement;
    pin: HTMLElement | null;
    size: FloatingMeasure;
    placed: { left: number; top: number; rect: Rect } | null;
  } | null {
    const el = this.bubbleLayer.querySelector<HTMLElement>(
      '[data-testid="commentor-thread-bubble"]',
    );
    if (!el) return null;
    const pin = this.markersLayer.querySelector<HTMLElement>(
      `[data-thread-id="${el.getAttribute("data-thread-id")}"]`,
    );
    const left = parseFloat(pin?.style.left ?? "");
    const top = parseFloat(pin?.style.top ?? "");
    const placed =
      pin &&
      pin.style.display !== "none" &&
      Number.isFinite(left) &&
      Number.isFinite(top)
        ? { left, top, rect: pin.getBoundingClientRect() }
        : null;
    return { el, pin, size: measureFloating(el), placed };
  }

  // ── optimistic writes (#284) ──
  /** The live page with the reader's own writes still on their way laid over it. */
  private withSending(live: Thread[]): Thread[] {
    const threads = live.map((thread) => {
      const reply = this.sendingReplies.get(thread._id);
      const replies = (reply ? [...thread.replies, reply] : thread.replies).map((item) => this.withSavingEdit(item, thread._id, item._id));
      return { ...this.withSavingEdit(thread, thread._id), replies };
    });
    return [...threads, ...this.sendingThreads];
  }

  /** A comment with the reader's edit on its way (#287) shows the new text at once. */
  private withSavingEdit<T extends Thread | Reply>(item: T, threadId: ThreadId, replyId?: ReplyId): T {
    const edit = this.savingEdits.get(editDraftKey(threadId, replyId));
    return edit ? { ...item, body: edit.body, saving: edit.sending } : item;
  }

  /**
   * A live page arrived. What it carries replaces the optimistic copy (no duplicate), and an acknowledged write is
   * retired too: Convex updates its subscriptions before it acknowledges a write, so a page after the
   * acknowledgement has the write wherever it belongs on that page.
   */
  private settleSending(live: Thread[]): void {
    const echoOf = <T extends { clientOperationId?: string }>(item: { clientOperationId?: string }, rows: T[]) =>
      rows.find((row) => row.clientOperationId === item.clientOperationId);
    this.sendingThreads = this.sendingThreads.filter((item) => {
      const echo = echoOf(item, live);
      // An open bubble on the optimistic thread follows it to the real one.
      if (echo && this.openThreadId === item._id) {
        this.openThreadId = echo._id;
        this.bubbleLayer.querySelector<HTMLElement>('[data-testid="commentor-thread-bubble"]')!.dataset.threadId = echo._id;
      }
      return !echo && item.sending === "sending";
    });
    for (const [threadId, reply] of this.sendingReplies) {
      const thread = live.find((candidate) => candidate._id === threadId);
      if (reply.sending === "sent" || (thread && echoOf(reply, thread.replies))) this.sendingReplies.delete(threadId);
    }
    // An edit's echo is the live row naming its operation (#287).
    for (const [key, edit] of this.savingEdits) {
      const row = this.editedItem(live, edit);
      if (edit.sending === "sent" || row?.editOperationId === edit.clientOperationId) this.savingEdits.delete(key);
    }
  }

  /** The thread or reply an edit is for, on this page. */
  private editedItem(threads: Thread[], edit: { threadId: ThreadId; replyId?: ReplyId }): Thread | Reply | undefined {
    const thread = threads.find((candidate) => candidate._id === edit.threadId);
    return edit.replyId === undefined ? thread : thread?.replies.find((reply) => reply._id === edit.replyId);
  }

  /** Show the optimistic writes as they now stand, over the last live page. */
  private applySending(): void {
    this.threads = this.withSending(this.liveThreads);
    this.renderPins();
    this.renderDrawerList();
    this.refreshOpenBubble();
  }

  /** The reader's new thread, in flight with this clientOperationId; nothing when the write was refused before it left. */
  private addSendingThread(body: string, anchor: Anchor): Thread | null {
    const clientOperationId = this.parentTransport.inFlightOperationId("thread.create");
    if (!clientOperationId) return null;
    const thread: Thread = {
      _id: `sending-${clientOperationId}` as ThreadId, _creationTime: Date.now(), authorEmail: "", authorName: "You",
      body, anchor, resolved: false, archived: false, replies: [], clientOperationId, sending: "sending",
    };
    this.sendingThreads.push(thread);
    this.applySending();
    return thread;
  }

  private addSendingReply(threadId: ThreadId, body: string): Reply | null {
    const clientOperationId = this.parentTransport.inFlightOperationId("reply.add", { threadId });
    if (!clientOperationId) return null;
    const reply: Reply = {
      _id: `sending-${clientOperationId}` as ReplyId, _creationTime: Date.now(), authorEmail: "", authorName: "You",
      body, clientOperationId, sending: "sending",
    };
    this.sendingReplies.set(threadId, reply);
    // The text moves from the input into the list; a failure puts it back.
    for (const input of this.replyInputs(threadId)) input.value = "";
    this.applySending();
    return reply;
  }

  /** Acknowledged: no longer sending, and gone with the next live page (normally it is already there). */
  private sentThread(item: Thread): void {
    if (!this.sendingThreads.includes(item)) return;
    item.sending = "sent";
    this.applySending();
  }

  private sentReply(threadId: ThreadId, item: Reply): void {
    if (this.sendingReplies.get(threadId) !== item) return;
    item.sending = "sent";
    this.applySending();
  }

  /** Roll a failed write back. False when it is no longer shown (carried by a live page, or the reader changed). */
  private dropSendingThread(item: Thread): boolean {
    if (!this.sendingThreads.includes(item)) return false;
    this.sendingThreads = this.sendingThreads.filter((candidate) => candidate !== item);
    this.applySending();
    return true;
  }

  private dropSendingReply(threadId: ThreadId, item: Reply): void {
    if (this.sendingReplies.get(threadId) !== item) return;
    this.sendingReplies.delete(threadId);
    this.applySending();
  }

  private syncRecoveryDrafts(): void {
    const state = this.parentTransport.recovery.value;
    if (!state) return;
    this.replyDrafts.clear();
    this.editDrafts.clear();
    for (const [key, draft] of Object.entries(state.drafts)) {
      if (key.startsWith("edit:")) this.editDrafts.set(key, String(draft.body));
      else if (key !== "create") this.replyDrafts.set(key as ThreadId, String(draft.body));
    }
    const composer = this.bubbleLayer.querySelector('.composer[data-state="open"]');
    if (composer && this.composerHasSubmitted && !state.drafts.create) this.closeBubbles(true, true);
  }

  // ── bubbles ──
  private openComposer(
    anchor: Anchor,
    rect: Rect,
    invoker: HTMLElement | null = null,
  ): { textarea: HTMLTextAreaElement; post: HTMLButtonElement } | null {
    if (!this.canWrite) return null;
    if (this.parentTransport.isMutationPending("thread.create")) {
      this.toast("Still waiting for confirmation of your comment.");
      return null;
    }
    const savedDraft = this.parentTransport.recovery.value.drafts.create;
    if (savedDraft) anchor = savedDraft.anchor as Anchor;
    this.composerHasSubmitted = Boolean(Object.values(this.parentTransport.recovery.value.operations).some((op) => op.method === "thread.create"));
    this.closeBubbles(false);
    this.hideSelectionAction(true);
    this.bubbleReturnFocus = invoker ?? this.commentsBtn;
    const textarea = h("textarea", {
      "data-testid": "commentor-composer-textarea",
      placeholder: "Add a comment…",
      "aria-label": "Comment",
      "aria-describedby": "commentor-composer-help",
    }) as HTMLTextAreaElement;
    textarea.value = typeof savedDraft?.body === "string" ? savedDraft.body : "";
    textarea.addEventListener("input", () => this.parentTransport.saveDraft("create", { body: textarea.value, anchor }));
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
      if (!body) return;
      if (this.writeCooldown.active) { this.writeCooldown.reveal(); return; }
      if (post.disabled) return;
      this.writeCooldown.reset();
      this.composerHasSubmitted = true;
      textarea.disabled = true;
      post.disabled = true;
      cancel.disabled = true;
      post.classList.add("is-pending");
      post.setAttribute("aria-busy", "true");
      post.textContent = "Posting…";
      await this.postThread(body, anchor, rect, invoker);
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
    this.writeCooldown.updateButton(post);
    this.bubbleLayer.append(bubble);
    placeFloating(bubble, rect);
    queueMicrotask(() => textarea.focus());
    return { textarea, post };
  }

  /**
   * Post through the parent, optimistically (#284): the thread shows at once, marked as sending, and the composer
   * closes. A failure takes the thread back and reopens the composer with the draft (kept in the recovery state),
   * where the error is shown and Post retries with the same operation when its outcome is unknown.
   */
  private async postThread(body: string, anchor: Anchor, rect: Rect, invoker: HTMLElement | null): Promise<void> {
    const sending = this.parentTransport.mutate("thread.create", { body, anchor });
    const item = this.addSendingThread(body, anchor);
    this.closeBubbles(true, true);
    try {
      await sending;
      // A write that succeeds was dispatched, so it has its optimistic copy.
      this.sentThread(item!);
    } catch (err) {
      // Already carried by a live page, or the reader changed meanwhile: nothing of it is on screen to take back.
      if (item && !this.dropSendingThread(item)) return;
      const reopened = this.openComposer(anchor, rect, invoker);
      if (reopened) this.composerFailed(err, reopened.textarea, reopened.post);
      else this.toast(this.writeErrorMessage(err, "Could not post comment. Try again."), { kind: "error" });
    }
  }

  private writeErrorMessage(err: unknown, fallback: string): string {
    return err instanceof CommentMutationRejectedError || err instanceof CommentMutationOutcomeUnknownError || err instanceof CommentOperationConflictError
      ? err.message : commentErrorMessage(err, fallback);
  }

  private composerFailed(err: unknown, textarea: HTMLTextAreaElement, post: HTMLButtonElement): void {
    console.error("[commentor] create failed", err);
    // A reply may have started a shared cooldown while this create was in flight.
    this.writeCooldown.updateButton(post);
    const retryAfter = commentRetryAfter(err);
    if (retryAfter !== null) this.writeCooldown.start(retryAfter, () => textarea);
    else this.toast(this.writeErrorMessage(err, "Could not post comment. Try again."), { kind: "error" });
    textarea.focus();
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
    const closingFocus = this.closeTimer ? this.closingFocus : null;
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
    // A live update can close the composer before the post's own acknowledgement does.
    const returnFocus = restoreFocus ? this.bubbleReturnFocus ?? closingFocus : null;
    this.closingFocus = returnFocus;
    this.bubbleReturnFocus = null;
    const finish = () => {
      this.bubbleLayer.replaceChildren();
      this.closeTimer = 0;
      this.closingFocus = null;
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
    // openThreadId is cleared whenever the thread bubble is removed.
    const bubble = this.bubbleLayer.querySelector<HTMLElement>(
      '[data-testid="commentor-thread-bubble"]',
    )!;
    const t = this.threads.find((x) => x._id === this.openThreadId);
    if (!t) {
      this.closeBubbles(true);
      return;
    }
    const editor = this.focusedEditor(bubble);
    bubble.replaceChildren(this.threadView(t, true));
    this.refocusEditor(bubble, editor);
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
      this.toast((err instanceof CommentMutationRejectedError || err instanceof CommentMutationOutcomeUnknownError || err instanceof CommentOperationConflictError) ? err.message : commentErrorMessage(err, errorMessage), { kind: "error" });
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.classList.remove("is-pending");
        button.removeAttribute("aria-busy");
        button.setAttribute("aria-label", label);
      }
      this.renderDrawerList();
      this.refreshOpenBubble();
    }
  }

  private removeThread(threadId: ThreadId, clientOperationId: string): Promise<unknown> {
    return this.parentTransport.mutate("thread.remove", { threadId, clientOperationId });
  }

  private resolveThread(threadId: ThreadId, resolved: boolean): Promise<unknown> {
    return this.parentTransport.mutate("thread.resolve", { threadId, resolved });
  }

  private archiveThread(threadId: ThreadId, archived: boolean): Promise<unknown> {
    return this.parentTransport.mutate("thread.archive", { threadId, archived });
  }

  private addReply(threadId: ThreadId, body: string): Promise<unknown> {
    return this.parentTransport.mutate("reply.add", { threadId, body });
  }

  private async loadOlderThreads(): Promise<void> {
    if (!this.parentTransport || this.loadingMoreThreads || !this.canLoadMoreThreads) return;
    this.loadingMoreThreads = true;
    this.renderDrawerList();
    try {
      await this.parentTransport.loadMoreThreads();
    } catch (error) {
      console.error("[commentor] older comments failed", error);
      this.loadingMoreThreads = false;
      this.renderDrawerList();
      this.toast("Could not load older comments.", { kind: "error" });
    }
  }

  private async loadOlderReplies(threadId: ThreadId): Promise<void> {
    const thread = this.threads.find((candidate) => candidate._id === threadId);
    const current = this.replyPagination.get(threadId) ?? {
      canLoadMore: Boolean(thread?.repliesHasMore),
      loading: false,
    };
    if (current.loading || !current.canLoadMore) return;
    this.replyPagination.set(threadId, { ...current, loading: true });
    this.renderDrawerList();
    this.refreshOpenBubble();
    try {
      await this.parentTransport.loadMoreReplies(threadId);
    } catch (error) {
      console.error("[commentor] older replies failed", error);
      this.replyPagination.set(threadId, { ...current, loading: false });
      this.renderDrawerList();
      this.refreshOpenBubble();
      this.toast("Could not load older replies.", { kind: "error" });
    }
  }

  private scheduleDelete(t: Thread): void {
    const clientOperationId = crypto.randomUUID();
    const started = this.pendingDeletes.begin(
      t._id,
      5000,
      () => this.removeThread(t._id, clientOperationId),
      (err) => {
        console.error("[commentor] delete failed", err);
        this.renderPins();
        this.renderDrawerList();
        this.toast((err instanceof CommentMutationRejectedError || err instanceof CommentMutationOutcomeUnknownError || err instanceof CommentOperationConflictError) ? err.message : commentErrorMessage(err, "Could not delete comment."), { kind: "error" });
      },
    );
    if (!started) return;
    if (this.openThreadId === t._id) this.closeBubbles(true);
    this.renderPins();
    this.renderDrawerList();
    this.toast("Comment deleted.", {
      actionLabel: "Undo",
      duration: 5000,
      onAction: () => {
        if (this.pendingDeletes.undo(t._id) !== "undone") {
          this.toast("Deletion is already in progress.");
          return;
        }
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
      // A thread on its way (#284) has no server time yet.
      t.sending ? null : h("span", { class: "when" }, timeAgo(t._creationTime)),
      t.editedAt === undefined ? null : editedMarker(t.editedAt),
      t.resolved
        ? h("span", { class: "resolved" }, svg(ICONS.check), "Resolved")
        : null,
      t.archived
        ? h(
            "span",
            { class: "archived-badge" },
            svg(ICONS.archive),
            "Archived",
          )
        : null,
      t.sending === "sending"
        ? h("span", { class: "sending-state", "data-testid": "commentor-sending" }, "Sending…")
        : null,
      t.saving === "sending"
        ? h("span", { class: "sending-state", "data-testid": "commentor-saving" }, "Saving…")
        : null,
    );
    // The reader's own thread on its way (#284) has no ID to act on until the live page carries it.
    if (this.canWrite && !t.sending) {
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
      resolveButton.disabled = this.parentTransport.isMutationPending("thread.resolve", { threadId: t._id });
      resolveButton.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.runThreadAction(
          resolveButton,
          resolveActionLabel,
          () => this.resolveThread(t._id, !t.resolved),
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
      archiveButton.disabled = this.parentTransport.isMutationPending("thread.archive", { threadId: t._id });
      archiveButton.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.runThreadAction(
          archiveButton,
          archiveActionLabel,
          () => this.archiveThread(t._id, !t.archived),
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
      actions.append(resolveButton);
      if (this.canEdits && t.canEdit === true) actions.append(this.editButton({ key: editDraftKey(t._id), threadId: t._id, inBubble }, t, "Edit comment"));
      if (t.canDelete === true) {
        actions.append(archiveButton, deleteButton);
      }
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
          h("span", { class: "quote-text" }, quote),
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
    const threadKey = editDraftKey(t._id);
    const view = h(
      "div",
      { class: "thread-view", "data-thread-id": t._id, ...(t.saving === "sending" ? { "aria-busy": "true" } : {}) },
      head,
      locate,
      this.isEditing(threadKey, inBubble)
        ? this.editor({ key: threadKey, threadId: t._id, inBubble }, t.body, `Edit comment by ${t.authorName}`)
        : h("div", { class: "body" }, t.body),
    );
    const replies = h("div", { class: "replies" });
    for (const r of t.replies) {
      const replyKey = editDraftKey(t._id, r._id);
      const replyTarget: EditTarget = { key: replyKey, threadId: t._id, replyId: r._id, inBubble };
      const editingReply = this.isEditing(replyKey, inBubble);
      const busy = r.sending === "sending" || r.saving === "sending";
      replies.append(
        h(
          "div",
          {
            class: `reply${this.newReplyIds.has(r._id) ? " is-new" : ""}${r.sending || r.saving === "sending" ? " is-sending" : ""}`,
            ...(busy ? { "aria-busy": "true" } : {}),
          },
          h("span", { class: "reply-who" }, r.authorName),
          " ",
          ...(r.sending ? [] : [h("span", { class: "when" }, timeAgo(r._creationTime)), " "]),
          ...(r.editedAt === undefined ? [] : [editedMarker(r.editedAt), " "]),
          editingReply ? this.editor(replyTarget, r.body, `Edit reply by ${r.authorName}`) : r.body,
          ...(r.sending === "sending"
            ? [" ", h("span", { class: "sending-state", "data-testid": "commentor-sending" }, "Sending…")]
            : []),
          ...(r.saving === "sending"
            ? [" ", h("span", { class: "sending-state", "data-testid": "commentor-saving" }, "Saving…")]
            : []),
          // A reply on its way (#284) has no ID to edit yet.
          this.canEdits && r.canEdit === true && !r.sending ? this.editButton(replyTarget, r, "Edit reply") : null,
          this.canWrite && r.canDelete === true
            ? h("button", {
                class: "card-action danger",
                type: "button",
                "data-tip": "Delete reply",
                "aria-label": `Delete reply by ${r.authorName}`,
                "data-testid": "commentor-delete-reply-btn",
                ...(this.parentTransport.isMutationPending("reply.remove", { threadId: t._id, replyId: r._id })
                  ? { disabled: "" } : {}),
                onclick: (event: Event) => {
                  event.stopPropagation();
                  const button = event.currentTarget as HTMLButtonElement;
                  void this.runThreadAction(
                    button,
                    `Delete reply by ${r.authorName}`,
                    () => this.parentTransport.mutate("reply.remove", { threadId: t._id, replyId: r._id }),
                    "Could not delete reply.",
                  );
                },
              }, svg(ICONS.trash))
            : null,
        ),
      );
    }
    const replyState = this.replyPagination.get(t._id) ?? {
      canLoadMore: Boolean(t.repliesHasMore),
      loading: false,
    };
    if (replyState.canLoadMore || replyState.loading) {
      const loadOlder = h(
        "button",
        {
          class: "load-older",
          type: "button",
          "data-testid": "commentor-load-older-replies",
          "aria-busy": String(replyState.loading),
          onclick: () => void this.loadOlderReplies(t._id),
        },
        replyState.loading ? "Loading older replies…" : "Load older replies",
      ) as HTMLButtonElement;
      loadOlder.disabled = replyState.loading;
      view.append(loadOlder);
    }
    view.append(replies);
    if (this.canWrite && !t.sending) {
      const helpId = `commentor-reply-help-${t._id}`;
      const input = h("textarea", {
        class: "reply-input",
        "data-testid": "commentor-reply-input",
        placeholder: "Reply…",
        "aria-label": "Reply",
        rows: "1",
        "aria-describedby": helpId,
      }) as HTMLTextAreaElement;
      // A reply on its way (#284) shows in the list, not in the input.
      input.value = this.sendingReplies.has(t._id) && this.pendingReplies.has(t._id) ? "" : this.replyDrafts.get(t._id) ?? "";
      input.addEventListener("input", () => {
        if (input.value) this.replyDrafts.set(t._id, input.value);
        else this.replyDrafts.delete(t._id);
        this.parentTransport.saveDraft(t._id, { body: input.value });
      });
      const send = h(
        "button",
        {
          class: "primary compact",
          type: "button",
          "data-testid": "commentor-reply-send",
        },
        "Reply",
      ) as HTMLButtonElement;
      if (this.pendingReplies.has(t._id)) {
        input.disabled = true;
        send.disabled = true;
        send.classList.add("is-pending");
        send.setAttribute("aria-busy", "true");
        send.textContent = "Sending…";
      }
      this.writeCooldown.updateButton(send);
      const submitReply = async () => {
        const submittedDraft = input.value;
        const body = submittedDraft.trim();
        if (!body) return;
        if (this.writeCooldown.active) { this.writeCooldown.reveal(); return; }
        if (send.disabled) return;
        this.writeCooldown.reset();
        const bubble = input.closest(".bubble");
        this.pendingReplies.set(t._id, submittedDraft);
        this.setReplyPendingState(t._id, true);
        const sending = this.addReply(t._id, body);
        // Optimistic (#284): the reply shows at once, marked as sending, while the input stays locked.
        const item = this.addSendingReply(t._id, body);
        try {
          await sending;
          // A write that succeeds was dispatched, so it has its optimistic copy.
          this.sentReply(t._id, item!);
          const nextDraft = draftAfterSuccessfulReply(
            this.replyDrafts.get(t._id),
            submittedDraft,
          );
          if (nextDraft === undefined) this.replyDrafts.delete(t._id);
          else this.replyDrafts.set(t._id, nextDraft);
        } catch (err) {
          console.error("[commentor] reply failed", err);
          if (item) {
            // The draft goes back where the reader wrote it: the inputs are rebuilt from the kept drafts.
            if (!this.replyDrafts.has(t._id)) this.replyDrafts.set(t._id, submittedDraft);
            this.dropSendingReply(t._id, item);
          }
          const retryAfter = commentRetryAfter(err);
          if (retryAfter !== null) this.writeCooldown.start(retryAfter, () => this.replyInputs(t._id).find((candidate) => candidate.closest(".bubble") === bubble));
          else this.toast((err instanceof CommentMutationRejectedError || err instanceof CommentMutationOutcomeUnknownError || err instanceof CommentOperationConflictError) ? err.message : commentErrorMessage(err, "Could not post reply."), { kind: "error" });
        } finally {
          this.pendingReplies.delete(t._id);
          this.setReplyPendingState(t._id, false);
          // A live update may already have replaced this input; the bubble itself persists.
          const replacement = this.replyInputs(t._id).find((candidate) =>
            candidate.closest(".bubble") === bubble,
          );
          replacement?.focus({ preventScroll: true });
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

  // ── edits (#287) ──
  private isEditing(key: string, inBubble: boolean): boolean {
    return this.editing?.key === key && this.editing.inBubble === inBubble;
  }

  private editMethod(target: EditTarget): { method: "thread.edit" | "reply.edit"; args: Record<string, unknown> } {
    return target.replyId === undefined
      ? { method: "thread.edit", args: { threadId: target.threadId } }
      : { method: "reply.edit", args: { threadId: target.threadId, replyId: target.replyId } };
  }

  /** The author's Edit action. While its save is on its way it stays focusable (aria-disabled), so focus can return to it. */
  private editButton(target: EditTarget, item: Thread | Reply, label: string): HTMLButtonElement {
    const { method, args } = this.editMethod(target);
    const saving = item.saving === "sending" || this.parentTransport.isMutationPending(method, args);
    return h(
      "button",
      {
        class: "card-action",
        type: "button",
        "data-tip": target.replyId === undefined ? "Edit" : "Edit reply",
        "aria-label": `${label} by ${item.authorName}`,
        "data-testid": target.replyId === undefined ? "commentor-edit-btn" : "commentor-edit-reply-btn",
        "data-edit-key": target.key,
        ...(saving ? { "aria-disabled": "true" } : {}),
        onclick: (event: Event) => {
          event.stopPropagation();
          this.startEdit(target);
        },
      },
      svg(ICONS.edit),
    ) as HTMLButtonElement;
  }

  /** The inline editor (#287): the reply box's input, its text kept as a draft; Enter or Ctrl/Cmd+Enter saves, Escape cancels. */
  private editor(target: EditTarget, current: string, label: string): HTMLElement {
    const helpId = `commentor-edit-help-${target.key}`;
    const input = h("textarea", {
      class: "reply-input edit-input",
      "data-testid": "commentor-edit-input",
      "data-edit-key": target.key,
      "aria-label": label,
      "aria-describedby": helpId,
      rows: "2",
    }) as HTMLTextAreaElement;
    input.value = this.editDrafts.get(target.key) ?? current;
    input.addEventListener("input", () => {
      this.editDrafts.set(target.key, input.value);
      this.parentTransport.saveDraft(target.key, { body: input.value });
    });
    const save = h("button", { class: "primary", type: "button", "data-testid": "commentor-edit-save" }, "Save") as HTMLButtonElement;
    const cancel = h("button", {
      class: "ghost",
      type: "button",
      "data-testid": "commentor-edit-cancel",
      onclick: (event: Event) => {
        event.stopPropagation();
        this.cancelEdit();
      },
    }, "Cancel");
    const submit = () => void this.saveEdit(target, input, save, current);
    save.addEventListener("click", (event) => {
      event.stopPropagation();
      submit();
    });
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Only the edit ends: the bubble it is in stays open.
        event.preventDefault();
        event.stopPropagation();
        this.cancelEdit();
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    this.writeCooldown.updateButton(save);
    return h(
      "div",
      { class: "edit-row" },
      input,
      h(
        "div",
        { class: "composer-footer" },
        h("span", { class: "composer-help", id: helpId }, "Enter or Ctrl+Enter to save · Shift+Enter for a new line · Esc to cancel"),
        h("div", { class: "actions" }, cancel, save),
      ),
    );
  }

  private editorScope(target: EditTarget): HTMLElement {
    return target.inBubble ? this.bubbleLayer : this.drawerList;
  }

  private editControl(target: EditTarget, testIds: string): HTMLElement | undefined {
    return Array.from(this.editorScope(target).querySelectorAll<HTMLElement>(testIds))
      .find((element) => element.dataset.editKey === target.key);
  }

  /** Show the comments again after the editor opened or closed, and put focus where the reader is now. */
  private showEdit(target: EditTarget, focusEditor: boolean): void {
    this.applySending();
    if (focusEditor) {
      const input = this.editControl(target, '[data-testid="commentor-edit-input"]') as HTMLTextAreaElement | undefined;
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    } else {
      this.editControl(target, '[data-testid="commentor-edit-btn"], [data-testid="commentor-edit-reply-btn"]')?.focus();
    }
  }

  /** Open the editor with the comment's text, or with the reader's unsaved edit of it when one is kept. */
  private startEdit(target: EditTarget): void {
    const { method, args } = this.editMethod(target);
    if (this.savingEdits.get(target.key)?.sending === "sending" || this.parentTransport.isMutationPending(method, args)) return;
    this.editing = target;
    this.showEdit(target, true);
    this.announce(target.replyId === undefined ? "Editing your comment." : "Editing your reply.");
  }

  private endEdit(message: string): void {
    const target = this.editing!;
    this.editing = null;
    this.editDrafts.delete(target.key);
    this.parentTransport.saveDraft(target.key, { body: "" });
    this.showEdit(target, false);
    this.announce(message);
  }

  private cancelEdit(): void {
    this.endEdit("Edit cancelled.");
  }

  /**
   * Save an edit optimistically (#287): the new text shows at once, marked "Saving…", and the editor closes with focus
   * on the comment's Edit. The live row naming the operation replaces it. A failure takes the text back and reopens the
   * editor with what the reader wrote, with the error, quota countdown or unknown-outcome notice.
   */
  private async saveEdit(target: EditTarget, input: HTMLTextAreaElement, save: HTMLButtonElement, current: string): Promise<void> {
    const submitted = input.value;
    const body = submitted.trim();
    if (!body) return;
    if (this.writeCooldown.active) { this.writeCooldown.reveal(); return; }
    if (save.disabled) return;
    // Unchanged text is no edit: nothing to write, and no "edited" marker.
    if (body === current) { this.endEdit("No changes to save."); return; }
    this.writeCooldown.reset();
    save.disabled = true;
    input.disabled = true;
    const { method, args } = this.editMethod(target);
    const sending = this.parentTransport.mutate(method, { ...args, body });
    const clientOperationId = this.parentTransport.inFlightOperationId(method, args);
    const item: SavingEdit | null = clientOperationId
      ? { threadId: target.threadId, replyId: target.replyId, body, clientOperationId, sending: "sending" }
      : null;
    if (item) this.savingEdits.set(target.key, item);
    this.editing = null;
    this.showEdit(target, false);
    try {
      await sending;
      // A write that succeeds was dispatched, so it has its optimistic copy.
      this.editDrafts.delete(target.key);
      if (this.savingEdits.get(target.key) === item) item!.sending = "sent";
      // Edit is offered again now that nothing is on its way.
      this.applySending();
      this.announce("Edit saved.");
    } catch (err) {
      console.error("[commentor] edit failed", err);
      // The reader changed meanwhile: nothing of it is on screen to take back.
      if (item && this.savingEdits.get(target.key) !== item) return;
      this.savingEdits.delete(target.key);
      this.editDrafts.set(target.key, submitted);
      this.editing = target;
      // The reopened editor's Save follows a cooldown another write may have started meanwhile.
      this.showEdit(target, true);
      const retryAfter = commentRetryAfter(err);
      if (retryAfter !== null) this.writeCooldown.start(retryAfter, () => this.editControl(target, '[data-testid="commentor-edit-input"]'));
      else this.toast(this.writeErrorMessage(err, "Could not save your edit."), { kind: "error" });
    }
  }

  /** The edit control (an Edit action or the editor) focused in `scope`, and where the editor's caret is. */
  private focusedEditor(scope: HTMLElement): { key: string; testId: string; caret: [number, number] | null } | null {
    const active = this.root.activeElement as HTMLElement | null;
    if (!active?.dataset.editKey || !scope.contains(active)) return null;
    return {
      key: active.dataset.editKey,
      testId: active.dataset.testid!,
      caret: active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null,
    };
  }

  private refocusEditor(scope: HTMLElement, editor: ReturnType<Commentor["focusedEditor"]>): void {
    if (!editor) return;
    const control = Array.from(scope.querySelectorAll<HTMLElement>(`[data-testid="${editor.testId}"]`))
      .find((candidate) => candidate.dataset.editKey === editor.key);
    control?.focus({ preventScroll: true });
    if (control instanceof HTMLTextAreaElement && editor.caret) control.setSelectionRange(...editor.caret);
  }

  private announce(text: string): void {
    this.live.textContent = text;
  }

  private replyInputs(threadId: ThreadId): HTMLTextAreaElement[] {
    return Array.from(this.root.querySelectorAll<HTMLTextAreaElement>(
      '[data-testid="commentor-reply-input"]',
    )).filter((input) =>
      input.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId === threadId,
    );
  }

  private setReplyPendingState(threadId: ThreadId, pending: boolean): void {
    for (const input of this.replyInputs(threadId)) input.disabled = pending;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      '[data-testid="commentor-reply-send"]',
    )) {
      if (button.closest<HTMLElement>("[data-thread-id]")?.dataset.threadId !== threadId)
        continue;
      button.disabled = pending;
      button.classList.toggle("is-pending", pending);
      button.toggleAttribute("aria-busy", pending);
      button.textContent = pending ? "Sending…" : "Reply";
      this.writeCooldown.updateButton(button);
    }
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
    this.renderDrawerList(false);
    this.renderPins();
  }

  private onFilterKeyDown(e: KeyboardEvent, filter: ThreadFilter): void {
    const index = THREAD_FILTERS.indexOf(filter);
    let next: number;
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
    this.renderDrawerList(false);
    this.renderPins();
  }

  private collapseDrawer(immediate = false): void {
    if (this.drawerCollapseTimer) {
      window.clearTimeout(this.drawerCollapseTimer);
      this.drawerCollapseTimer = 0;
    }
    this.commentsBtn.setAttribute("aria-expanded", "false");
    this.commentsBtn.classList.remove("active");
    delete this.content.dataset.layout;
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
    const tw = this.toolbar.offsetWidth;
    const th = this.toolbar.offsetHeight;
    const ds = getComputedStyle(this.dock);
    const bw = parseFloat(ds.borderLeftWidth) + parseFloat(ds.borderRightWidth);
    const bh = parseFloat(ds.borderTopWidth) + parseFloat(ds.borderBottomWidth);
    this.repositionDock(tw + bw, th + bh);
    this.renderPins();
    this.drawerCollapseTimer = window.setTimeout(() => {
      this.drawerCollapseTimer = 0;
      this.content.style.height = "";
      this.content.style.width = "";
    }, 300);
  }

  /**
   * Coalesces everything that can change the open drawer's size (a re-render, content that resizes on its own) into one
   * layout pass per animation frame. `data-layout` is "pending" while a pass is due and "settled" once the drawer has the
   * size and place its current content gives it, the same a fresh open would.
   */
  private scheduleDrawerLayout(): void {
    if (!this.dock.hasAttribute("data-expanded")) return;
    this.content.dataset.layout = "pending";
    if (this.drawerRaf) return;
    this.drawerRaf = requestAnimationFrame(() => {
      this.drawerRaf = 0;
      this.layoutDrawer();
    });
  }

  private layoutDrawer(): void {
    if (!this.dock.hasAttribute("data-expanded")) return;
    const { w, h } = this.sizeContent();
    this.repositionExpandedDock(w, h);
    this.content.dataset.layout = "settled";
  }

  private sizeContent(): { w: number; h: number } {
    const compact = window.innerWidth < 420;
    this.dock.toggleAttribute("data-compact-sheet", compact);
    const tw = this.toolbar.offsetWidth;
    const horizontal =
      !compact && (this.dockEdge === "left" || this.dockEdge === "right");
    const availW = Math.max(
      0,
      window.innerWidth - 2 * MARGIN - (horizontal ? tw : 0),
    );
    const targetW = Math.min(380, availW);
    // The drawer's parts are laid out at the width it is opening to, not at the one its width transition is passing
    // through, so the height is measured for the text as it will wrap.
    this.content.style.setProperty("--drawer-width", `${targetW}px`);
    const maxH = Math.min(window.innerHeight * 0.6, 520);
    // The list's own height is whatever the drawer gives it; its cards' natural height is the body's. The list starts
    // below the head and the tabs, margins included.
    const naturalH = Math.min(
      this.drawerList.offsetTop + Math.ceil(this.drawerBody.getBoundingClientRect().height),
      maxH,
    );
    const targetH = horizontal ? maxH : naturalH;
    this.content.style.height = `${targetH}px`;
    this.content.style.width = `${targetW}px`;
    return { w: targetW, h: targetH };
  }

  private repositionExpandedDock(contentW: number, contentH: number): void {
    const tw = this.toolbar.offsetWidth;
    const th = this.toolbar.offsetHeight;
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

  // `keepPlace` is false when the list starts afresh (the drawer opening, another tab), so no layout is read for it.
  private renderDrawerList(keepPlace = true): void {
    // The list is rebuilt: an editor the reader is typing in (#287) keeps its focus and caret.
    const editor = this.focusedEditor(this.drawerList);
    this.buildDrawerList(keepPlace);
    this.refocusEditor(this.drawerList, editor);
  }

  private buildDrawerList(keepPlace: boolean): void {
    const counts: Record<ThreadFilter, number> = {
      active: this.filteredThreads("active").length,
      resolved: this.filteredThreads("resolved").length,
      history: this.filteredThreads("history").length,
    };
    const count = this.content.querySelector<HTMLElement>(".count")!;
    count.textContent = String(counts.active);
    count.setAttribute(
      "aria-label",
      `${counts.active} active comment${counts.active === 1 ? "" : "s"}`,
    );
    for (const filter of THREAD_FILTERS) {
      const button = this.filterButtons[filter];
      button.replaceChildren(
        THREAD_FILTER_LABELS[filter],
        h("span", { class: "filter-count" }, String(counts[filter])),
      );
    }
    const place = keepPlace && this.dock.hasAttribute("data-expanded") ? this.captureDrawerPlace() : null;
    this.scheduleDrawerLayout();
    this.drawerBody.replaceChildren();
    if (this.parentUpgradeRequired) {
      this.drawerBody.append(h("div", { class: "empty", role: "status", "aria-live": "polite" },
        h("p", undefined, COMMENTOR_UPGRADE_NOTICE),
        ...(this.canReloadViewer
          ? [h("button", { type: "button", onclick: () => this.parentTransport.requestViewerReload() }, "Show reload notice")]
          : [h("p", undefined, "Use your browser’s Reload button to reload the full page.")]),
      ));
      return;
    }
    const visible = this.filteredThreads(this.threadFilter);
    if (this.canLoadMoreThreads || this.loadingMoreThreads) {
      const loadOlder = h(
        "button",
        {
          class: "load-older load-older-threads",
          type: "button",
          "data-testid": "commentor-load-older-threads",
          "aria-busy": String(this.loadingMoreThreads),
          onclick: () => void this.loadOlderThreads(),
        },
        this.loadingMoreThreads ? "Loading older comments…" : "Load older comments",
      ) as HTMLButtonElement;
      loadOlder.disabled = this.loadingMoreThreads;
      this.drawerBody.append(loadOlder);
    }
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
                this.commentButton.focus();
              },
            },
            svg(ICONS.comment),
            "Start a comment",
          ),
        );
      }
      this.drawerBody.append(empty);
      return;
    }
    for (const t of visible) {
      const card = h(
        "div",
        {
          class: `drawer-thread${
            this.newThreadIds.has(t._id) ? " is-new" : ""
          }${t.sending || t.saving === "sending" ? " is-sending" : ""}`,
          "data-thread-id": t._id,
          ...(t.sending === "sending" || t.saving === "sending" ? { "aria-busy": "true" } : {}),
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
      this.drawerBody.append(card);
    }
    this.restoreDrawerPlace(place, visible);
    this.highlightThread(this.highlightedThreadId);
  }

  // Rebuilding the list resets its scroll, so note where the reader is first:
  // pinned to the end (follow new comments, as a chat does), or else the first
  // card in view and how far below the list's top it sits.
  private captureDrawerPlace(): DrawerPlace | null {
    const list = this.drawerList;
    const cards = Array.from(list.querySelectorAll<HTMLElement>(".drawer-thread"));
    if (cards.length === 0) return null;
    const ids = cards.map((card) => card.dataset.threadId!);
    const listTop = list.getBoundingClientRect().top;
    const first = cards.find((card) => card.getBoundingClientRect().bottom > listTop) ?? cards[0];
    const anchorId = first.dataset.threadId!;
    const restored = this.restoredPlace;
    const unmoved = restored?.anchorId === anchorId && restored.scrollTop === list.scrollTop;
    return {
      lastId: ids[ids.length - 1],
      atEnd: list.scrollTop + list.clientHeight >= list.scrollHeight - 48,
      anchorId,
      anchorOffset: unmoved ? restored.anchorOffset : first.getBoundingClientRect().top - listTop,
    };
  }

  private restoreDrawerPlace(place: DrawerPlace | null, visible: Thread[]): void {
    this.restoredPlace = null;
    if (!place) return;
    const list = this.drawerList;
    if (place.atEnd && visible[visible.length - 1]._id !== place.lastId) {
      list.scrollTop = list.scrollHeight;
      return;
    }
    const anchor = Array.from(list.querySelectorAll<HTMLElement>(".drawer-thread"))
      .find((card) => card.dataset.threadId === place.anchorId);
    if (!anchor) return;
    list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - place.anchorOffset;
    this.restoredPlace = { anchorId: place.anchorId, anchorOffset: place.anchorOffset, scrollTop: list.scrollTop };
  }

  private highlightThread(threadId: ThreadId | null): void {
    this.highlightedThreadId = threadId;
    this.syncHighlightClasses();
    this.positionAnchorHighlight();
  }

  private syncHighlightClasses(): void {
    const threadId = this.highlightedThreadId;
    for (const el of this.root.querySelectorAll<HTMLElement>(
      "[data-thread-id]",
    )) {
      el.classList.toggle(
        "is-highlighted",
        Boolean(threadId && el.dataset.threadId === threadId),
      );
    }
  }

  private positionAnchorHighlight(): void {
    this.paintAnchorHighlight(
      this.measureAnchorHighlight(),
      window.innerWidth,
      window.innerHeight,
    );
  }

  private measureAnchorHighlight(): Rect[] {
    const thread = this.threads.find(
      (candidate) => candidate._id === this.highlightedThreadId,
    );
    return thread ? anchorRects(thread.anchor) : [];
  }

  private paintAnchorHighlight(rects: Rect[], width: number, height: number): void {
    let visibleCount = 0;
    for (const rect of rects) {
      if (
        rect.bottom < 0 ||
        rect.top > height ||
        rect.right < 0 ||
        rect.left > width
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
      // Every tooltip target is built with a non-empty data-tip.
      const text = target.getAttribute("data-tip")!;
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
    if (!text.trim() || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
      this.hideTip();
      return;
    }
    this.tip.textContent = text;
    this.tip.setAttribute("aria-hidden", "false");
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
    this.tip.setAttribute("aria-hidden", "true");
    this.tip.setAttribute("data-state", "closed");
  }

  private toast(msg: string, options: ToastOptions = {}): () => void {
    let region = this.root.querySelector<HTMLElement>(".toast-region");
    if (!region) {
      region = h("div", {
        class: "toast-region",
        "aria-label": "Notifications",
      });
      this.root.append(region);
    }
    const close = (el: HTMLElement) => {
      if (!el.isConnected || el.getAttribute("data-state") === "closed") return;
      el.setAttribute("data-state", "closed");
      window.setTimeout(() => {
        const parent = el.parentElement;
        el.remove();
        if (parent?.classList.contains("toast-region") && !parent.children.length)
          parent.remove();
      }, 150);
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
    region.append(el);
    const timeout = window.setTimeout(
      () => close(el),
      options.duration ?? (options.kind === "error" ? 6000 : 3000),
    );
    return () => {
      window.clearTimeout(timeout);
      close(el);
    };
  }
}

/** "edited", named with when (#287): the time is the reader's local one. */
function editedMarker(editedAt: number): HTMLElement {
  const when = new Date(editedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return h("span", { class: "edited", "data-testid": "commentor-edited", role: "note", "aria-label": `Edited ${when}`, title: `Edited ${when}` }, "edited");
}

/** A new comment's anchor always quotes text: the reader selected it, or a kept draft (validated) did. */
function anchorLabel(a: Anchor): string {
  return `On: “${a.exact.slice(0, 60)}${a.exact.length > 60 ? "…" : ""}”`;
}

// ────────────────────────────── boot ────────────────────────────────

// Read while this script runs: repository frames pass the configuration on the script element.
const configScript = document.currentScript;

function scriptConfig(): Config | undefined {
  const value = configScript?.getAttribute("data-commentor-config");
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Config;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function boot(): void {
  const cfg = scriptConfig();
  if (!cfg || cfg.transport !== "parent" || typeof cfg.repoId !== "number" || typeof cfg.blobSha !== "string" || !cfg.documentPath) {
    console.error("[commentor] not started — configure a repository document scope");
    return;
  }
  repoPage = { root: document.querySelector("article.markdown-body") ?? document.body, blobSha: cfg.blobSha, sections: null };
  new Commentor(cfg);
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
