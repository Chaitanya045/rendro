import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

class NodeMock {
  parentNode: ParentMock | null = null;
  focus = vi.fn();
  listeners = new Map<string, (...args: unknown[]) => unknown>();
  attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  get nextSibling(): NodeMock | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] ?? null;
  }

  addEventListener(type: string, listener: (...args: unknown[]) => unknown) {
    this.listeners.set(type, listener);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}

class ParentMock extends NodeMock {
  children: NodeMock[] = [];
  appendCount = 0;
  insertCount = 0;
  hidden = true;

  appendChild(node: NodeMock) {
    this.appendCount += 1;
    this.detach(node);
    this.children.push(node);
    node.parentNode = this;
    return node;
  }

  insertBefore(node: NodeMock, reference: NodeMock | null) {
    this.insertCount += 1;
    this.detach(node);
    const index = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    node.parentNode = this;
    return node;
  }

  querySelector(selector: string) {
    if (selector !== "a,button") return null;
    return this.children.find((node) => node.tagName === "a" || node.tagName === "button") ?? null;
  }

  private detach(node: NodeMock) {
    if (!node.parentNode) return;
    const index = node.parentNode.children.indexOf(node);
    if (index >= 0) node.parentNode.children.splice(index, 1);
  }
}

describe("mobile document toolbar layout", () => {
  it("uses resize as a breakpoint-only fallback when the media-query change callback is missed", () => {
    const source = readFileSync(new URL("../src/routes/app.ts", import.meta.url), "utf8");
    const start = source.indexOf('  var mobileMoreButton=document.getElementById("mobile-more-btn")');
    const end = source.indexOf("\n\n  var avatarButton=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const toolbar = new ParentMock("div");
    const menu = new ParentMock("div");
    const moreButton = new NodeMock("button");
    const back = new NodeMock("a");
    const shortcut = new NodeMock("span");
    const theme = new NodeMock("button");
    const avatar = new NodeMock("span");
    for (const item of [back, shortcut, theme, avatar]) toolbar.appendChild(item);

    const media = {
      matches: false,
      changeListener: null as null | (() => void),
      addEventListener(_type: string, listener: () => void) { this.changeListener = listener; },
      addListener(listener: () => void) { this.changeListener = listener; },
    };
    const windowListeners = new Map<string, () => void>();
    const shellSync = vi.fn();
    const document = {
      getElementById(id: string) {
        if (id === "mobile-more-btn") return moreButton;
        if (id === "mobile-more-menu") return menu;
        if (id === "theme-toggle") return theme;
        return null;
      },
      querySelector(selector: string) {
        if (selector === ".topbar-btn-back") return back;
        if (selector === ".shortcut-tooltip-wrap") return shortcut;
        if (selector === ".avatar-wrap") return avatar;
        return null;
      },
      createComment() { return new NodeMock("#comment"); },
    };
    const context = {
      document,
      root: { classList: { contains: () => false } },
      setShellHidden: shellSync,
      window: {
        matchMedia: () => media,
        addEventListener(type: string, listener: () => void) { windowListeners.set(type, listener); },
      },
    };

    vm.runInNewContext(source.slice(start, end), context);
    expect(menu.children).toHaveLength(0);
    expect(shellSync).toHaveBeenCalledTimes(1);

    media.matches = true;
    windowListeners.get("resize")?.();
    expect(menu.children).toEqual([back, shortcut, theme, avatar]);
    expect(menu.appendCount).toBe(4);
    expect(shellSync).toHaveBeenCalledTimes(2);

    windowListeners.get("resize")?.();
    media.changeListener?.();
    expect(menu.appendCount).toBe(4);
    expect(shellSync).toHaveBeenCalledTimes(2);
    expect(moreButton.focus).not.toHaveBeenCalled();

    media.matches = false;
    windowListeners.get("resize")?.();
    expect(menu.children).toHaveLength(0);
    expect(toolbar.children.filter((node) => node !== moreButton && node.tagName !== "#comment"))
      .toEqual([back, shortcut, theme, avatar]);
    expect(shellSync).toHaveBeenCalledTimes(3);
  });
});
