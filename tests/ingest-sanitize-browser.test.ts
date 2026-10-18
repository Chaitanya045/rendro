import { beforeAll, expect, it } from "vitest";

import { renderDocument } from "../src/ingest/render";
import { hostileCorpus } from "./fixtures/ingest/hostile-corpus";
import { browserStep, createBrowserHarness } from "./helpers/browser";
import { ALLOWED_ATTRIBUTES, ALLOWED_TAGS } from "./helpers/ingest-invariants";
import { initNodeMarkdownEngine } from "./helpers/markdown-engine";

/*
 * The decisive check for parser differentials: Chromium itself parses each
 * sanitized output, with no CSP to fall back on. The page installs a canary
 * before the content. Any handler or script that runs records a hit, and any
 * request to another origin fails the harness.
 */
const harness = createBrowserHarness();
const pages = new Map<string, string>();

const CANARY = `<script>window.__hits=[];window.__xss=(n)=>__hits.push(n);for(const k of ["alert","confirm","prompt","print","open"])window[k]=()=>__hits.push(k);</script>`;

beforeAll(async () => {
  initNodeMarkdownEngine();
  // Positive control: the same payloads unsanitized must trip the canary.
  pages.set("/control", `<!doctype html><html><head><meta charset="utf-8">${CANARY}</head><body><img src="x" onerror="__xss(1)"><details open ontoggle="__xss(2)"></details></body></html>`);
  hostileCorpus.forEach((entry, index) => {
    const html = renderDocument(entry.source, entry.kind === "html" ? "docs/page.html" : "docs/page.md").html;
    pages.set(`/case/${index}`, `<!doctype html><html><head><meta charset="utf-8">${CANARY}</head><body>${html}</body></html>`);
  });
  await harness.start((request, response) => {
    const page = pages.get(new URL(request.url ?? "/", "http://localhost").pathname);
    response.writeHead(page ? 200 : 404, { "Content-Type": page ? "text/html; charset=utf-8" : "text/plain" });
    response.end(page ?? "not found");
  });
});

it("detects payloads that do run (canary control)", async () => {
  const page = await harness.newPage();
  await browserStep("load unsanitized control", () => page.goto(`${harness.origin}/control`, { waitUntil: "load" }));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hits: number[] }).__hits.sort())).toEqual([1, 2]);
});

it.each(hostileCorpus.map((entry, index) => [entry.name, index] as const))("Chromium runs nothing from %s", async (_name, index) => {
  const page = await harness.newPage();
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await browserStep("load sanitized case", () => page.goto(`${harness.origin}/case/${index}`, { waitUntil: "load" }));
  const result = await browserStep("inspect the parsed DOM", () => page.evaluate(async ([tags, attributes]) => {
    // Give image errors, focus, toggle and animation events time to fire.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))));
    const allowedTags = new Set(tags);
    const allowedAttributes = new Set(attributes);
    const violations: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll("*"))) {
      const tag = element.localName;
      if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") violations.push(`foreign <${tag}>`);
      if (!allowedTags.has(tag)) violations.push(`<${tag}>`);
      for (const attribute of Array.from(element.attributes)) if (!allowedAttributes.has(attribute.name)) violations.push(`${attribute.name} on <${tag}>`);
      if (element instanceof HTMLAnchorElement && element.hasAttribute("href") && !["http:", "https:", "mailto:"].includes(element.protocol)) violations.push(`href ${element.href}`);
      if (element instanceof HTMLImageElement && element.hasAttribute("src") && !["http:", "https:"].includes(new URL(element.src).protocol)) violations.push(`src ${element.src}`);
    }
    const head = Array.from(document.head.children).map((child) => child.localName);
    return { hits: (window as unknown as { __hits: unknown[] }).__hits, violations, head, location: location.pathname };
  }, [[...ALLOWED_TAGS], [...ALLOWED_ATTRIBUTES]] as const));
  expect(result.hits).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(result.violations).toEqual([]);
  // Nothing was hoisted into <head> and nothing navigated the page away.
  expect(result.head).toEqual(["meta", "script"]);
  expect(result.location).toBe(`/case/${index}`);
});
