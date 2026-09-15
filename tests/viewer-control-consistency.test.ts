import { describe, expect, it } from "vitest";
import { renderScopedDocumentShell } from "../src/routes/app";

function shell() {
  return renderScopedDocumentShell({ user: null, namespace: "qa", title: "QA", basePath: "/p/qa", selectedPath: "index.html", publicDocument: true });
}

describe("viewer control consistency", () => {
  it("preserves the back-link border and aligns desktop toolbar controls", () => {
    const html = shell();
    expect(html).toContain(".topbar-btn.topbar-btn-back{color:#52525b;background:transparent;border:1px solid #e4e4e7");
    expect(html).toContain(".topbar-btn{min-height:36px;");
    expect(html).toContain(".topbar-btn-icon{width:36px;height:36px;flex:none;border-radius:6px");
    expect(html).toContain(".topbar-avatar{width:36px;height:36px;");
    expect(html).toContain(".topbar-logo{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
    expect(html).toContain(".topbar-actions{display:flex;align-items:center;gap:16px;flex:none}");
  });

  it("gives menu and retry actions visible focus and motion-safe feedback", () => {
    const html = shell();
    expect(html).toContain(".avatar-menu-item:focus-visible,.load-more-btn:focus-visible{outline:2px solid var(--viewer-focus);outline-offset:2px}");
    expect(html).toContain(".load-more-btn{display:inline-flex;");
    expect(html).toContain(".load-more-btn:hover:not(:disabled)");
    expect(html).toContain("html.dark .load-more-btn:hover:not(:disabled)");
    expect(html).toContain(".load-more-btn:disabled{color:#71717a;cursor:not-allowed;opacity:.5}");
    expect(html).toContain(".avatar-menu,.mobile-more-menu{animation:none!important}");
    expect(html).toContain(".topbar-btn:active,.avatar-menu-item:active,.load-more-btn:active{transform:none!important}");
  });

  it("keeps mobile tree and menu targets at 44px with matching sticky offsets", () => {
    const html = shell();
    expect(html).toContain(":root{--tree-row-height:44px}");
    expect(html).toContain(".avatar-menu-item,.load-more-btn{min-height:44px}");
    expect(html).toContain('data-depth="2"].open>.tree-item{top:calc(var(--tree-row-height) * 2)');
    expect(html).toContain(".tree-item:has(.tree-link:focus-visible){outline:2px solid var(--viewer-focus);outline-offset:-2px}");
    expect(html).toContain("html.dark{--viewer-focus:#fb923c;");
  });
});
