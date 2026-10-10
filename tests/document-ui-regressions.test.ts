import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { draftAfterSuccessfulReply } from "../src/commentor/reply-state";
import { PendingDeletionCoordinator } from "../src/commentor/delete-state";
import { isThemeReadyMessage, requestParentTheme } from "../src/commentor/theme-message";
import {
  injectMobileViewportScrollbarStream,
  injectMobileViewportScrollbarStyle,
  injectHtmlHeadStream,
} from "../src/routes/document-html";
import { renderScopedDocumentShell } from "../src/routes/app";

import {
  isContentFrameSource,
  loadedDocumentAction,
  normalizeLoadedDocumentPath,
  validRelativeDocumentPath,
} from "../src/lazy-tree/messages";
import { documentLoadAccessibility } from "../src/lazy-tree/load-state";
import { emptyTreeAction, shouldUseNativeLinkNavigation } from "../src/lazy-tree/navigation";
import { folderTransitionOverride, indicatorTransition } from "../src/lazy-tree/motion";

describe("document UI regressions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("contains the viewer's top margin inside the viewport instead of scrolling its fixed header over the document", () => {
    const source = readFileSync(new URL("../src/routes/app.ts", import.meta.url), "utf8");
    expect(source).toContain("body{display:flow-root;");
    expect(source).toContain(".content-frame{display:block;");
  });

  it("bounds the notification stack itself without shrinking independent Undo controls", () => {
    const source = readFileSync(new URL("../src/commentor/commentor.ts", import.meta.url), "utf8");
    const region = source.match(/\.toast-region \{([^}]+)\}/)?.[1];
    expect(region).toContain("max-height: max(44px, calc(100vh - 120px))");
    expect(region).toContain("overflow-y: auto");
    expect(region).toContain("overscroll-behavior: contain");
    expect(source.match(/\.toast \{([^}]+)\}/)?.[1]).toContain("flex: 0 0 auto");
    const mobile = source.slice(source.indexOf("@media (max-width: 419px)"));
    expect(mobile).toContain("grid-template-columns: minmax(0, 1fr) auto 44px; align-items: center");
    expect(mobile).toContain(".head .thread-close { grid-column: 3; grid-row: 1; }");
  });

  it("normalizes legacy, project, and public document load messages safely", () => {
    expect(normalizeLoadedDocumentPath("acme/guide/index.html", "acme"))
      .toBe("acme/guide/index.html");
    expect(normalizeLoadedDocumentPath("guide/index.html", "public-docs"))
      .toBe("public-docs/guide/index.html");
    expect(validRelativeDocumentPath("guide/index.html")).toBe(true);
    for (const unsafe of ["", "../secret.html", "guide//index.html", "guide\\index.html", "./index.html"]) {
      expect(validRelativeDocumentPath(unsafe), unsafe).toBe(false);
      expect(normalizeLoadedDocumentPath(unsafe, "acme"), unsafe).toBeNull();
    }
  });

  it("accepts document messages only from the active content frame", () => {
    const contentFrame = {} as WindowProxy;
    expect(isContentFrameSource(contentFrame, contentFrame)).toBe(true);
    expect(isContentFrameSource({} as WindowProxy, contentFrame)).toBe(false);
    expect(isContentFrameSource(contentFrame, null)).toBe(false);
  });

  it("ignores a stale loaded message until the latest shell navigation is acknowledged", () => {
    expect(loadedDocumentAction("project/a.html", "project/b.html", "project/b.html"))
      .toBe("ignore");
    expect(loadedDocumentAction("project/b.html", "project/b.html", "project/b.html"))
      .toBe("sync");
    expect(loadedDocumentAction("project/c.html", "project/b.html", null))
      .toBe("reload");
  });

  it("passes comment text to a text node without entity encoding", async () => {
    const appended: unknown[] = [];
    vi.stubGlobal("document", {
      createTextNode: vi.fn((value: string) => ({ nodeValue: value })),
    });
    const { appendPlainText } = await import("../src/commentor/text");
    const parent = {
      append: (...nodes: unknown[]) => appended.push(...nodes),
    } as unknown as ParentNode;
    appendPlainText(parent, "Use <main> & keep > visible");
    expect(appended).toEqual([{ nodeValue: "Use <main> & keep > visible" }]);
  });

  it("clears only the submitted reply draft after realtime replacement", () => {
    expect(draftAfterSuccessfulReply("Sent reply", "Sent reply")).toBeUndefined();
    expect(draftAfterSuccessfulReply("A newer edit", "Sent reply")).toBe("A newer edit");
  });

  it("coordinates independent Undo timers and restores a rejected deletion", async () => {
    vi.useFakeTimers();
    try {
      const deletions = new PendingDeletionCoordinator<string>();
      let rejectSecond!: (error: Error) => void;
      const firstMutation = vi.fn().mockResolvedValue(undefined);
      const secondMutation = vi.fn(() => new Promise((_resolve, reject) => { rejectSecond = reject; }));
      const restoreFirst = vi.fn();
      const restoreSecond = vi.fn();

      expect(deletions.begin("first", 5000, firstMutation, restoreFirst)).toBe(true);
      expect(deletions.begin("second", 5000, secondMutation, restoreSecond)).toBe(true);
      expect(deletions.undo("first")).toBe("undone");
      expect(deletions.has("first")).toBe(false);
      expect(deletions.has("second")).toBe(true);

      await vi.advanceTimersByTimeAsync(5000);
      expect(firstMutation).not.toHaveBeenCalled();
      expect(secondMutation).toHaveBeenCalledTimes(1);
      expect(deletions.undo("second")).toBe("committing");
      expect(deletions.has("second")).toBe(true);

      const failure = new Error("mutation rejected");
      rejectSecond(failure);
      await Promise.resolve();
      await Promise.resolve();
      expect(restoreSecond).toHaveBeenCalledWith(failure);
      expect(deletions.has("second")).toBe(false);
      expect(restoreFirst).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests the parent theme only after the iframe listener is ready", () => {
    const postMessage = vi.fn();
    requestParentTheme({ postMessage } as unknown as WindowProxy);
    expect(postMessage).toHaveBeenCalledWith({ type: "commentor-theme-ready" }, "*");
    expect(isThemeReadyMessage(postMessage.mock.calls[0]?.[0])).toBe(true);
    expect(isThemeReadyMessage({ type: "rendro-theme" })).toBe(false);
  });

  it("exposes actionable document loading and failure semantics", () => {
    expect(documentLoadAccessibility("loading")).toEqual({
      busy: true,
      message: "Loading document",
      assertive: false,
    });
    expect(documentLoadAccessibility("error")).toEqual({
      busy: false,
      message: "Document failed to load. Select it again to retry.",
      assertive: true,
    });
    expect(documentLoadAccessibility("loaded")).toEqual({
      busy: false,
      message: "",
      assertive: false,
    });
  });

  it("does not expose legacy creation actions in scoped empty document trees", () => {
    expect(emptyTreeAction("/organizations/org-1/projects/project-1/docs")).toEqual({
      message: "No documents deployed yet.",
      href: "/organizations/org-1/projects/project-1",
      label: "Return to project",
    });
    expect(emptyTreeAction("/p/public-docs")).toEqual({ message: "No documents available." });
    expect(emptyTreeAction("")).toEqual({ message: "No documents yet." });
  });

  it("preserves native modified-click behavior for document links", () => {
    const activation = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(shouldUseNativeLinkNavigation(activation)).toBe(false);
    expect(shouldUseNativeLinkNavigation({ ...activation, ctrlKey: true })).toBe(true);
    expect(shouldUseNativeLinkNavigation({ ...activation, metaKey: true })).toBe(true);
    expect(shouldUseNativeLinkNavigation({ ...activation, shiftKey: true })).toBe(true);
    expect(shouldUseNativeLinkNavigation({ ...activation, altKey: true })).toBe(true);
    expect(shouldUseNativeLinkNavigation({ ...activation, button: 1 })).toBe(true);
  });

  it("removes JavaScript-driven tree motion when reduced motion is requested", () => {
    expect(indicatorTransition(true, false)).toContain("transform 0.3s");
    expect(indicatorTransition(false, false)).toBe("none");
    expect(indicatorTransition(true, true)).toBe("none");
    expect(folderTransitionOverride(true)).toBe("none");
    expect(folderTransitionOverride(false)).toBe("");
  });

  it("hides only the mobile document viewport scrollbar without disabling scroll", () => {
    const html = injectMobileViewportScrollbarStyle(
      "<!doctype html><html><head><title>Fixture</title></head><body><div class=scrollable>Body</div></body></html>",
    );
    expect(html).toContain("@media (max-width: 760px)");
    expect(html).toContain(":root::-webkit-scrollbar");
    expect(html).toContain(":root { scrollbar-width: none; }");
    expect(html).not.toContain("overflow: hidden");
    expect(html.match(/data-rendro-mobile-viewport/g)).toHaveLength(1);
    expect(injectMobileViewportScrollbarStyle(html)).toBe(html);
  });

  it("keeps the doctype first when injecting into a document without a head", () => {
    const html = injectMobileViewportScrollbarStyle(
      "<!doctype html><body><main>Standards mode fixture</main></body>",
    );
    expect(html.startsWith("<!doctype html><style data-rendro-mobile-viewport>")).toBe(true);
    expect(html.indexOf("<style")).toBeLessThan(html.indexOf("<body"));
  });

  it.each([
    '<script>const sentinel = "</head>";</script>',
    '<style>p::before { content: "</head>"; }</style>',
    '<!-- a fake </head> and <body> -->',
    '<meta name="description" content="a fake </head> and <body>">',
    '<title>A fake </head> and &lt;body&gt;</title>',
    '<noscript>A fake </head> and <body></noscript>',
  ])("preserves publisher raw text and markup: %s", (content) => {
    const source = `<!doctype html><html><head>${content}</head><body>Résumé 📖</body></html>`;
    const styled = injectMobileViewportScrollbarStyle(source);
    expect(styled).toContain(content);
    expect(styled).toContain('<head><style data-rendro-mobile-viewport>');
    expect(styled.replace(/<style data-rendro-mobile-viewport>[\s\S]*?<\/style>/, "")).toBe(source);
    if (content.startsWith("<script>")) {
      const script = styled.match(/<script>([\s\S]*?)<\/script>/)![1];
      expect(() => new Script(script)).not.toThrow();
    }
  });

  it("does not treat commented or quoted head tags as insertion points", () => {
    const prelude = '<!-- <head></head><body> --><!doctype html><html data-note="<head></head>">';
    const source = `${prelude}<head><title>Actual head</title></head><body>Body</body></html>`;
    expect(injectMobileViewportScrollbarStyle(source)).toContain(`${prelude}<head><style data-rendro-mobile-viewport>`);
  });

  it.each(["ok", "<h1>Docs</h1>", '<script>const sentinel="</head>";</script>'])("styles headless fragments without changing their content: %s", source => {
    const styled = injectMobileViewportScrollbarStyle(source);
    expect(styled).toMatch(/^<style data-rendro-mobile-viewport>/);
    expect(styled.replace(/<style data-rendro-mobile-viewport>[\s\S]*?<\/style>/, "")).toBe(source);
  });

  it("leaves long or incomplete publisher prefixes untouched when there is no safe anchor", () => {
    for (const source of [
      '<!doctype html PUBLIC "unfinished',
      '<!-- <head></head>',
      '<!doctype html><html><head data-note="' + 'x'.repeat(70_000) + '"></head><body>Body</body>',
      '<!-- ' + 'x'.repeat(70_000) + ' --><!doctype html><head></head>',
    ]) expect(injectMobileViewportScrollbarStyle(source)).toBe(source);
  });

  it("preserves raw text and multibyte characters across every streamed byte boundary", async () => {
    const source = '<!-- <head></head> --><!doctype html><head><script>const sentinel="</head>";</script></head><body>Résumé 📖</body>';
    const bytes = new TextEncoder().encode(source);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    });
    const styled = await new Response(injectMobileViewportScrollbarStream(stream)).text();
    expect(styled).toContain('<head><style data-rendro-mobile-viewport>');
    expect(styled.replace(/<style data-rendro-mobile-viewport>[\s\S]*?<\/style>/, "")).toBe(source);
  });

  it("streams an oversized unfinished tag without rewriting or buffering the whole document", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const reader = injectMobileViewportScrollbarStream(source, 32).getReader();
    const prefix = '<!doctype html><head data-note="' + 'x'.repeat(32);
    controller.enqueue(new TextEncoder().encode(prefix));
    const first = await reader.read();
    const second = await reader.read();
    expect(new TextDecoder().decode(new Uint8Array([
      ...(first.value ?? []),
      ...(second.value ?? []),
    ]))).toBe(prefix);
    const tail = '"></head><body>Body</body>';
    controller.enqueue(new TextEncoder().encode(tail)); controller.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(tail);
    expect((await reader.read()).done).toBe(true);
  });

  it("bounds one oversized storage chunk and preserves a code point split at the byte budget", async () => {
    const encoder = new TextEncoder();
    const original = encoder.encode(`${"x".repeat(31)}€${"y".repeat(100_000)}`);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(original);
        controller.close();
      },
    });
    const output = new Uint8Array(await new Response(
      injectHtmlHeadStream(source, "<script>integration()</script>", undefined, 32),
    ).arrayBuffer());
    expect(output).toEqual(original);
  });

  it("injects into one oversized storage chunk while preserving all publisher bytes", async () => {
    const markup = "<script>integration()</script>";
    const original = `<!doctype html><head><title>Docs</title></head><body>Résumé 📖${"x".repeat(100_000)}</body>`;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(original));
        controller.close();
      },
    });
    const output = await new Response(injectHtmlHeadStream(source, markup)).text();
    expect(output.replace(markup, "")).toBe(original);
    expect(output.match(/integration\(\)/g)).toHaveLength(1);
  });

  it("passes an invalid UTF-8 publisher prefix through without unsafe byte-offset splicing", async () => {
    const suffix = new TextEncoder().encode("--><head></head><body>Publisher</body>");
    const original = new Uint8Array([60, 33, 45, 45, 0xff, ...suffix]);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(original);
        controller.close();
      },
    });
    const output = new Uint8Array(await new Response(
      injectHtmlHeadStream(source, "<script>integration()</script>"),
    ).arrayBuffer());
    expect(output).toEqual(original);
  });

  it("preserves a UTF-8 BOM while injecting at the corresponding source-byte offset", async () => {
    const encoder = new TextEncoder();
    const body = encoder.encode("<!doctype html><head></head><body>Résumé</body>");
    const original = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    const markup = "<script>integration()</script>";
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(original);
        controller.close();
      },
    });
    const output = new Uint8Array(await new Response(injectHtmlHeadStream(source, markup)).arrayBuffer());
    expect(Array.from(output.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const markupBytes = encoder.encode(markup);
    const restored = new Uint8Array(output.byteLength - markupBytes.byteLength);
    const markerAt = new TextDecoder("utf-8", { ignoreBOM: true }).decode(output).indexOf(markup);
    const byteMarkerAt = encoder.encode(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(output).slice(0, markerAt),
    ).byteLength;
    restored.set(output.slice(0, byteMarkerAt));
    restored.set(output.slice(byteMarkerAt + markupBytes.byteLength), byteMarkerAt);
    expect(restored).toEqual(original);
  });

  it("streams injected HTML once its bounded prefix is complete without corrupting split UTF-8", async () => {
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(controller) { sourceController = controller; },
    });
    const reader = injectMobileViewportScrollbarStream(source).getReader();
    const bytes = new TextEncoder().encode("<!doctype html><head><title>Résumé 📖</title></head><body>");
    const emoji = new TextEncoder().encode("📖");
    const emojiStart = bytes.findIndex((_value, index) =>
      emoji.every((part, offset) => bytes[index + offset] === part),
    );
    const firstRead = reader.read();
    sourceController.enqueue(bytes.slice(0, emojiStart + 2));
    sourceController.enqueue(bytes.slice(emojiStart + 2));
    const chunks = [await firstRead, await reader.read(), await reader.read(), await reader.read()];
    const prefix = new TextDecoder().decode(new Uint8Array(chunks.flatMap((chunk) => [
      ...(chunk.value ?? []),
    ])));
    expect(prefix.startsWith("<!doctype html>")).toBe(true);
    expect(prefix).toContain("Résumé 📖");
    expect(prefix).toContain("data-rendro-mobile-viewport");
    expect(chunks.every((chunk) => chunk.done === false)).toBe(true);
    await reader.cancel();
  });

  it("injects document features at a parsed head boundary without corrupting body-close lookalikes", async () => {
    const source = '<!doctype html><body><script id="publisher-script">const bodyEnd="</body>"; globalThis.publisherRan=true;</script><p>Publisher body</p></body>';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(source));
        controller.close();
      },
    });
    const integrated = await new Response(injectHtmlHeadStream(
      stream,
      '<script data-rendro-document-features>globalThis.rendroLoaded=true;</script>',
      "data-rendro-document-features",
    )).text();
    const publisherScript = integrated.match(/<script id="publisher-script">([\s\S]*?)<\/script>/)?.[1];
    expect(publisherScript).toBe('const bodyEnd="</body>"; globalThis.publisherRan=true;');
    expect(() => new Script(publisherScript!)).not.toThrow();
    expect(integrated).toContain("<p>Publisher body</p></body>");
    expect(integrated.indexOf("data-rendro-document-features")).toBeLessThan(integrated.indexOf("<body>"));
  });

  it("does not let a publisher marker lookalike disable document feature injection", async () => {
    const source = '<!doctype html><head><script>const sample="data-rendro-document-features";</script></head><body>Publisher body</body>';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(source));
        controller.close();
      },
    });
    const integrated = await new Response(injectHtmlHeadStream(
      stream,
      '<script data-rendro-document-features>globalThis.rendroLoaded=true;</script>',
    )).text();
    expect(integrated).toContain('<script>const sample="data-rendro-document-features";</script>');
    expect(integrated.match(/data-rendro-document-features/g)).toHaveLength(2);
    expect(integrated).toContain("globalThis.rendroLoaded=true");
  });

  it("renders one accessible mobile More panel while keeping primary viewer actions", () => {
    const html = renderScopedDocumentShell({
      user: { email: "reader@example.com", name: "Reader" } as never,
      namespace: "project-1",
      title: "A useful and descriptive project title",
      basePath: "/organizations/org-1/projects/project-1/docs",
      selectedPath: "guide.html",
      backHref: "/organizations/org-1/projects/project-1",
      backLabel: "Project",
      shareConfig: { organizationId: "org-1", projectId: "project-1" },
    });
    expect(html.match(/id="mobile-more-btn"/g)).toHaveLength(1);
    expect(html).toContain('aria-controls="mobile-more-menu"');
    expect(html).toContain('role="dialog" aria-label="More document actions" hidden');
    expect(html).toContain('id="shell-mobile-label">Enter reading mode</span>');
    expect(html).toContain('mobileTreeMode()?(hidden?"Exit reading mode":"Enter reading mode")');
    expect(html).toContain('function focusShellControl(){if(mobileTreeMode()&&mobileMoreButton)mobileMoreButton.focus()');
    expect(html).toContain('.topbar-logo{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis');
    expect(html).toContain('mobileMoreItems=[document.querySelector(".topbar-btn-back"),document.querySelector(".shortcut-tooltip-wrap"),document.getElementById("theme-toggle"),document.querySelector(".avatar-wrap")]');
    for (const id of ["mobile-tree-toggle", "share-btn", "shell-toggle", "theme-toggle", "avatar-btn"]) {
      expect(html.match(new RegExp(`id="${id}"`, "g")), id).toHaveLength(1);
    }
  });
});
