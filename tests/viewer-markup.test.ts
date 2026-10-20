import { describe, expect, it } from "vitest";
import { nonceContext } from "@/middleware/html-nonce";
import { PRIVATE_VIEWER_VERSION } from "@/viewer/asset-versions";
import { viewerScript } from "@/viewer/markup";

describe("private viewer script tag", () => {
  it("gives the request nonce to the trusted shell's viewer only, never to a publisher frame", () => {
    nonceContext.run("abc", () => {
      expect(viewerScript("parent", { base: "/r/o/n/@c" })).toBe(`<script nonce="abc" src="/private-viewer.js?v=${PRIVATE_VIEWER_VERSION}" data-viewer="parent" data-config="{&quot;base&quot;:&quot;/r/o/n/@c&quot;}"></script>`);
      expect(viewerScript("frame", { base: "/r/o/n/@c" }, "https://rendro.test/r/o/n/files/a.md")).toBe(`<script src="https://rendro.test/private-viewer.js?v=${PRIVATE_VIEWER_VERSION}" data-viewer="frame" data-config="{&quot;base&quot;:&quot;/r/o/n/@c&quot;}"></script>`);
    });
  });
});
