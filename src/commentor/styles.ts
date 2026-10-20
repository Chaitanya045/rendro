// The widget's whole stylesheet, one <style> element in its shadow root. Repository
// frames allow exactly this text by hash (COMMENTOR_STYLE_HASH), never 'unsafe-inline'.
export const COMMENTOR_STYLES = /* css */ `
.toast.comment-quota{position:fixed;bottom:16px;left:16px;right:16px;z-index:2147483647;max-width:440px;margin:auto;box-sizing:border-box}
.comment-quota[hidden]{display:none}
.quota-live,.live-region{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
:host {
  --bg: #ffffff;
  --bg-elev: #ffffff;
  --fg: #09090b;
  --fg-muted: #52525b;
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
  --fg-muted: #52525b;
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
textarea:disabled {
  opacity: .62;
  cursor: not-allowed;
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
.toolbar button:hover:not(:disabled), .grip:hover { background: var(--border-soft); }
.toolbar button:active:not(:disabled) { transform: scale(.98); }
.toolbar button.active { background: var(--accent); color: var(--accent-fg); }
.toolbar button:disabled { opacity: .38; cursor: not-allowed; transform: none; }
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
  transition:
    color var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard);
}
.filter-tabs button:hover:not(:disabled) { color: var(--fg); }
.filter-tabs button:active:not(:disabled) { transform: scale(.98); }
.filter-tabs button:disabled { opacity: .45; cursor: not-allowed; transform: none; }
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
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard);
}
.new-comments:hover:not(:disabled) { background: var(--border-soft); color: var(--accent-hover); }
.new-comments:active:not(:disabled) { transform: translateX(-50%) scale(.98); }
.new-comments:disabled { opacity: .45; cursor: not-allowed; transform: translateX(-50%); }
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
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.content-list::-webkit-scrollbar { width: 5px; }
.content-list::-webkit-scrollbar-track { background: transparent; }
.content-list::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--border);
}
.content-list::-webkit-scrollbar-button { display: none; }
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
.drawer-thread.is-sending, .reply.is-sending { border-style: dashed; }
.reply.is-sending { border: 1px dashed var(--border); }
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
  transition:
    background var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard);
}
.empty button:hover:not(:disabled) { background: var(--accent-hover); }
.empty button:active:not(:disabled) { transform: scale(.98); }
.empty button:disabled { opacity: .5; cursor: not-allowed; transform: none; }
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
    background var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}
.selection-action:hover:not(:disabled) { background: var(--accent-hover); }
.selection-action[data-state="open"] {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
.selection-action[data-state="open"]:active:not(:disabled) {
  transform: translateY(0) scale(.98);
}
.selection-action[data-state="open"]:disabled {
  opacity: .5;
  cursor: not-allowed;
  transform: translateY(0);
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
.pin.is-sending { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px var(--accent); }

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
.composer-footer, .reply-footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
}
.composer-footer .composer-help, .reply-footer .composer-help {
  flex: 1 1 auto;
  min-width: 0;
  margin-top: 0;
}
.composer-footer .actions { flex: 0 0 auto; margin-top: 0; }
.reply-footer > button { flex: 0 0 auto; margin-top: 0; }
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
.sending-state {
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 650;
}
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
    color var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard);
}
.card-action:hover:not(:disabled) { background: var(--border-soft); color: var(--fg); }
.card-action.danger:hover:not(:disabled) { color: var(--danger); }
.card-action:active:not(:disabled) { transform: scale(.98); }
.card-action:disabled { opacity: .45; cursor: wait; transform: none; }
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
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard);
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
.quote:hover:not(:disabled) { color: var(--fg); background: var(--border); }
.quote:active:not(:disabled) { transform: scale(.98); }
.quote:disabled { opacity: .5; cursor: not-allowed; transform: none; }
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
  transition:
    color var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard);
}
.locate-link:hover:not(:disabled) { color: var(--accent-hover); text-decoration: underline; }
.locate-link:active:not(:disabled) { transform: scale(.98); transform-origin: left center; }
.locate-link:disabled { opacity: .5; cursor: not-allowed; transform: none; }
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
.load-older {
  align-self: center;
  margin-top: 8px;
  border: 0;
  background: transparent;
  color: var(--accent);
  min-height: 32px;
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}
.load-older:hover:not(:disabled) { background: var(--border-soft); color: var(--accent-hover); }
.load-older:disabled { cursor: wait; opacity: .65; }
.load-older-threads { flex: 0 0 auto; margin: 4px auto 8px; }
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
.reply-who { font-weight: 650; }
.reply .when { font-size: 11px; }
.edited { color: var(--fg-muted); font-size: 11px; }
.edit-row { margin: 6px 0; }
.reply .edit-row { margin-bottom: 0; }
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
.actions button.primary:hover:not(:disabled), .reply-row button.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}
.actions button.ghost { background: var(--border-soft); color: var(--fg); }
.actions button.ghost:hover:not(:disabled) { background: var(--border); }
.actions button:active:not(:disabled), .reply-row button:active:not(:disabled) { transform: scale(.98); }
.actions button:disabled, .reply-row button:disabled {
  opacity: .58;
  cursor: wait;
  transform: none;
}
.actions button svg, .reply-row button svg { width: 15px; height: 15px; }

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
.toast-region {
  position: fixed;
  bottom: 96px;
  left: 50%;
  z-index: 2147483647;
  width: max-content;
  max-width: calc(100vw - 24px);
  max-height: max(44px, calc(100vh - 120px));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transform: translateX(-50%);
}
.toast {
  position: relative;
  flex: 0 0 auto;
  max-width: 100%;
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
  animation: toast-rise var(--duration-base) var(--ease-standard);
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
  transition:
    background var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard),
    opacity var(--duration-fast) var(--ease-standard);
}
.toast button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 14%, transparent); }
.toast button:active:not(:disabled) { transform: scale(.98); }
.toast button:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.toast[data-state="closed"] {
  animation: toast-fall var(--duration-fast) var(--ease-standard) forwards;
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
@keyframes rise {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
@keyframes toast-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes toast-fall {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(8px); }
}

@media (max-width: 760px) {
  .card-action { width: 44px; height: 44px; flex: 0 0 44px; }
  .filter-tabs button, .actions button, .reply-row button, .empty button,
  .new-comments, .quote, .locate-link, .toast button {
    min-height: 44px;
  }
}
@media (max-width: 419px) {
  .head { display: grid; grid-template-columns: minmax(0, 1fr) auto 44px; align-items: center; }
  .head .who { grid-column: 1; grid-row: 1; max-width: 100%; }
  .head .when { grid-column: 2; grid-row: 1; }
  .head .thread-close { grid-column: 3; grid-row: 1; }
  .head .resolved, .head .archived-badge { grid-column: 1 / -1; justify-self: start; }
  .head .card-actions { grid-column: 1 / -1; margin-left: 0; justify-content: flex-end; opacity: 1; }
  .composer-footer, .reply-footer { align-items: stretch; flex-direction: column; }
  .composer-footer .actions { justify-content: flex-end; }
  .reply-footer > button { width: 100%; }
  .bubble { width: calc(100vw - 16px); }
  .content-head { min-height: 44px; }
}
@media (hover: none) {
  .card-actions { opacity: 1; }
  .card-action { width: 44px; height: 44px; }
  .filter-tabs button, .actions button, .reply-row button, .empty button,
  .new-comments, .quote, .locate-link, .toast button {
    min-height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pin, .bubble, .reply, .drawer-thread, .selection-action, .anchor-highlight,
  .count, .content, .hint, .toast, .tip, .dock, .filter-tabs::before,
  .toolbar button, .filter-tabs button, .new-comments, .empty button, .card-action,
  .quote, .locate-link, .actions button, .reply-row button, .toast button {
    animation: none !important;
    transition: none !important;
  }
  .toolbar button:active:not(:disabled), .filter-tabs button:active:not(:disabled),
  .new-comments:active:not(:disabled), .empty button:active:not(:disabled),
  .selection-action[data-state="open"]:active:not(:disabled),
  .card-action:active:not(:disabled), .quote:active:not(:disabled),
  .locate-link:active:not(:disabled), .actions button:active:not(:disabled),
  .reply-row button:active:not(:disabled), .toast button:active:not(:disabled) {
    transform: none;
  }
  .new-comments:active:not(:disabled) { transform: translateX(-50%); }
  .pin:hover, .pin.is-highlighted, .pin:active { transform: rotate(-45deg); }
}

`;
