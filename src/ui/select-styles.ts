import { menuSurfaceStyles } from "./menu-styles";
export const selectStyles = menuSurfaceStyles + String.raw`
.cp-refresh-notice{position:fixed;bottom:16px;right:16px;z-index:100;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);padding:10px 12px;background:var(--cp-surface);color:var(--cp-strong);border:1px solid var(--cp-border);border-radius:8px;box-shadow:var(--cp-shadow);font-size:13px}
.cp-refresh-notice[hidden]{display:none}
.rd-select-native{position:absolute!important;width:1px!important;height:1px!important;min-height:0!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip-path:inset(50%)!important;opacity:0!important;pointer-events:none!important}
.select.rd-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:start;min-width:0;min-height:40px;cursor:pointer;background-image:none!important;font:inherit;font-weight:500;line-height:20px}
.rd-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.rd-select-validation{display:block;font-size:12px;line-height:18px;color:var(--cp-danger)}
.rd-select-validation[hidden]{display:none}
.rd-select-caret{width:7px;height:7px;flex:none;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-2px) rotate(45deg);margin-inline:3px;opacity:.65;transition:transform 150ms cubic-bezier(.4,0,.2,1)}
.rd-select-trigger[aria-expanded=true] .rd-select-caret{transform:translateY(2px) rotate(225deg)}
.rd-select-popup{position:fixed;inset:auto;margin:0;box-sizing:border-box;z-index:10000;padding:4px;border:1px solid var(--cp-border);border-radius:8px;background:var(--cp-surface);color:var(--cp-strong);box-shadow:0 8px 24px rgb(0 0 0 / .12),0 2px 4px rgb(0 0 0 / .06);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--cp-border-strong) transparent;font:400 14px/20px Inter,system-ui,sans-serif;animation:rdSelectIn 150ms cubic-bezier(.4,0,.2,1);transform-origin:top}
.rd-select-popup[hidden]{display:none!important}
.rd-select-popup[data-side=top]{transform-origin:bottom}
.rd-select-popup::backdrop{background:transparent}
.rd-select-option{display:flex;align-items:center;gap:8px;min-height:36px;box-sizing:border-box;padding:8px;border-radius:4px;cursor:default;user-select:none;transition:background-color 150ms cubic-bezier(.4,0,.2,1);overflow-wrap:anywhere}
.rd-select-option[hidden]{display:none}
.rd-select-option[data-active=true]{background:var(--cp-container);outline:1px solid transparent}
.rd-select-option[aria-disabled=true]{opacity:.45;pointer-events:none}
.rd-select-check{width:14px;height:14px;flex:none;position:relative}
.rd-select-option[aria-selected=true] .rd-select-check::after{content:"";position:absolute;width:4px;height:8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);left:5px;top:1px}
.rd-select-group{padding:8px;font-size:12px;font-weight:600;color:var(--cp-muted)}
html.dark .rd-select-popup{box-shadow:0 8px 24px rgb(0 0 0 / .4),0 2px 4px rgb(0 0 0 / .2)}
@keyframes rdSelectIn{from{opacity:0;transform:scale(.98) translateY(-2px)}to{opacity:1;transform:none}}
@media(max-width:760px){.rd-select-option{min-height:44px}.select.rd-select-trigger{min-height:44px}}
@media(prefers-reduced-motion:reduce){.rd-select-popup{animation:none}.rd-select-option,.rd-select-caret{transition:none}}
@media(forced-colors:active){.rd-select-popup{border-color:CanvasText;background:Canvas;color:CanvasText}.rd-select-option[data-active=true]{outline-color:Highlight}.rd-select-option[aria-disabled=true]{color:GrayText}}
`;
