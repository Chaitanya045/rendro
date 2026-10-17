import { createRequire } from "node:module";
import { dirname } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";

const require = createRequire(import.meta.url);
const installedParser = globalThis.DOMParser;

afterEach(() => vi.unstubAllGlobals());

describe("Worker XML runtime used by the real S3 SDK", () => {
  it("deserializes empty continuation tokens, names, and prefixed listings with the browser SDK parser", async () => {
    const bundle = await build({
      stdin: { contents: 'export { parseXML } from "@aws-sdk/xml-builder";', resolveDir: dirname(require.resolve("@aws-sdk/client-s3")) },
      platform: "browser", bundle: true, format: "esm", write: false,
    });
    const parser = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as { parseXML(xml: string): unknown };
    expect(parser.parseXML('<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>docs</Name><Prefix>files/</Prefix><ContinuationToken/><IsTruncated>false</IsTruncated><Contents><Key>files/index.html</Key><Size>42</Size></Contents></ListBucketResult>')).toEqual({
      ListBucketResult: { xmlns: "http://s3.amazonaws.com/doc/2006-03-01/", Name: "docs", Prefix: "files/", ContinuationToken: "", IsTruncated: "false", Contents: { Key: "files/index.html", Size: "42" } },
    });
    expect(parser.parseXML('<Error><Code>NoSuchKey</Code><Message/></Error>')).toEqual({ Error: { Code: "NoSuchKey", Message: "" } });
  });

  it("retains DOM node kinds, attributes, children and empty-document fallbacks", () => {
    const parser = new installedParser();
    const document = parser.parseFromString('<!DOCTYPE root><!--ignored--><root id="fixture"><child>value</child><empty/></root>', "text/xml");
    const root = document.documentElement;
    expect(Array.from(root.attributes)).toEqual([{ name: "id", value: "fixture" }]);
    expect(root.firstChild?.nodeName).toBe("child");
    expect(root.firstChild?.firstChild?.nodeValue).toBe("value");
    expect(root.getElementsByTagName("empty")[0].firstChild).toBeNull();
    expect(document.getElementsByTagName("child")).toHaveLength(1);
    expect(document.childNodes).toHaveLength(2);
    expect(parser.parseFromString("", "text/xml").documentElement.nodeType).toBe(Node.DOCUMENT_NODE);
    expect(parser.parseFromString("text</unmatched>", "text/xml").documentElement.nodeType).toBe(Node.TEXT_NODE);
    expect(parser.parseFromString("<root></unmatched></root>", "text/xml").documentElement.nodeName).toBe("root");
  });

  it("preserves a functioning DOM parser and replaces an incomplete host parser", async () => {
    vi.resetModules();
    await import("../src/worker");
    expect(globalThis.DOMParser).toBe(installedParser);
    vi.stubGlobal("DOMParser", class { parseFromString() { return {}; } });
    vi.resetModules();
    await import("../src/worker");
    expect(new globalThis.DOMParser().parseFromString("<root/>", "text/xml").getElementsByTagName("child")).toEqual([]);
  });
});

describe("Worker runtime bindings and asset fallbacks", () => {
  it("copies only missing string bindings and tolerates an absent Node process", async () => {
    delete process.env.RUNTIME_FIXTURE_MISSING;
    process.env.RUNTIME_FIXTURE_EXISTING = "existing";
    try {
      expect((await worker.request("/health", {}, { RUNTIME_FIXTURE_MISSING: "copied", RUNTIME_FIXTURE_EXISTING: "keep", OTHER: 42 })).status).toBe(200);
      expect(process.env.RUNTIME_FIXTURE_MISSING).toBe("copied");
      expect(process.env.RUNTIME_FIXTURE_EXISTING).toBe("existing");
      expect((await worker.request("/health")).status).toBe(200);
      vi.stubGlobal("process", undefined);
      expect((await worker.request("/health", {}, {})).status).toBe(200);
      vi.unstubAllGlobals();
    } finally {
      delete process.env.RUNTIME_FIXTURE_MISSING;
      delete process.env.RUNTIME_FIXTURE_EXISTING;
    }
  });

  it("serves assets, gives opaque missing responses, and handles binding failures", async () => {
    expect((await worker.request("/management-query.js")).status).toBe(404);
    expect((await worker.request("/missing.svg")).status).toBe(404);
    const found = await worker.request("/select.js", {}, { ASSETS: { fetch: () => new Response("fixture") } });
    expect(await found.text()).toBe("fixture");
    expect((await worker.request("/select.js", {}, { ASSETS: { fetch: () => new Response(null, { status: 404 }) } })).status).toBe(404);
    // Only allowlisted paths ever reach the binding, even when it would serve them.
    const unlisted = { fetch: vi.fn(() => new Response("fixture")) };
    expect((await worker.request("/fixture.txt", {}, { ASSETS: unlisted })).status).toBe(404);
    expect(unlisted.fetch).not.toHaveBeenCalled();
    const failed = await worker.request("/select.js", {}, { ASSETS: { fetch: () => { throw new Error("Private diagnostic"); } } });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("Private diagnostic");
    expect((await worker.request("/missing", { method: "PATCH" })).status).toBe(404);
  });
});
