import { describe, expect, it } from "vitest";

import { detectDocs, type DocSet } from "../src/ingest/detect";
import { RENDERER_VERSION } from "../src/ingest/limits";
import { buildSidebar, naturalCompare, titleFromName } from "../src/ingest/sidebar";
import { layouts, tree } from "./fixtures/ingest/repo-layouts";

describe("buildSidebar", () => {
  it("builds a titled tree with the entry first and directory landing pages", () => {
    const set = detectDocs(tree([
      "docs/README.md", "docs/10-deploy.md", "docs/2-setup.md", "docs/api/index.md", "docs/api/endpoints.md",
      "docs/api/v2/README.md", "docs/faq.md", "docs/_sidebar.md", "docs/SUMMARY.md", "docs/guides/first-steps.md",
    ])).primary as DocSet;
    const titles = new Map<string, string | null>([["docs/README.md", "Home"], ["docs/api/index.md", "API"], ["docs/faq.md", null], ["docs/2-setup.md", "Setup"]]);
    expect(buildSidebar(set, titles)).toEqual({
      rendererVersion: RENDERER_VERSION,
      root: "docs",
      entry: "docs/README.md",
      truncated: false,
      nodes: [
        { type: "page", path: "docs/README.md", title: "Home" },
        { type: "page", path: "docs/2-setup.md", title: "Setup" },
        { type: "page", path: "docs/10-deploy.md", title: "10 deploy" },
        {
          type: "directory", path: "docs/api", title: "API", page: "docs/api/index.md",
          children: [
            { type: "page", path: "docs/api/endpoints.md", title: "Endpoints" },
            { type: "directory", path: "docs/api/v2", title: "V2", page: "docs/api/v2/README.md", children: [] },
          ],
        },
        { type: "page", path: "docs/faq.md", title: "Faq" },
        { type: "directory", path: "docs/guides", title: "Guides", page: null, children: [{ type: "page", path: "docs/guides/first-steps.md", title: "First steps" }] },
      ],
    });
  });

  it("works at the repo root and keeps a second index page as a page", () => {
    const set = { root: "", entry: "README.md", pages: ["README.md", "index.md", "a/README.md", "a/index.md", "outside/../x.md"].slice(0, 4), truncated: true };
    const sidebar = buildSidebar(set, new Map());
    expect(sidebar.truncated).toBe(true);
    expect(sidebar.nodes).toEqual([
      { type: "page", path: "README.md", title: "README" },
      { type: "directory", path: "a", title: "A", page: "a/README.md", children: [{ type: "page", path: "a/index.md", title: "Index" }] },
      { type: "page", path: "index.md", title: "Index" },
    ]);
  });

  it("orders a directory and a page of the same name directory first", () => {
    const sidebar = buildSidebar({ root: "docs", entry: "docs/index.md", pages: ["docs/index.md", "docs/setup.md", "docs/setup/more.md"], truncated: false }, new Map());
    expect(sidebar.nodes.map(({ type, path }) => `${type}:${path}`)).toEqual(["page:docs/index.md", "directory:docs/setup", "page:docs/setup.md"]);
  });

  it("skips pages outside the root", () => {
    const sidebar = buildSidebar({ root: "docs", entry: "docs/a.md", pages: ["docs/a.md", "other/b.md", "docs"], truncated: false }, new Map());
    expect(sidebar.nodes).toEqual([{ type: "page", path: "docs/a.md", title: "A" }]);
  });

  it("indexes every realistic layout", () => {
    for (const [name, entries] of Object.entries(layouts)) {
      for (const set of detectDocs(entries).docSets) {
        const sidebar = buildSidebar(set, new Map());
        expect(sidebar.nodes[0], name).toMatchObject({ type: "page", path: set.entry });
      }
    }
  });
});

describe("titleFromName", () => {
  it("humanizes file names", () => {
    expect(["getting-started.md", "api_reference.mdx", "v2", "README.md", "-.md", ".md"].map(titleFromName)).toEqual(["Getting started", "Api reference", "V2", "README", "-.md", ".md"]);
  });
});

describe("naturalCompare", () => {
  it("orders numbers by value and text by code unit, independent of locale", () => {
    const names = ["10-deploy", "2-setup", "1-intro", "01-intro", "B", "a", "a10", "a2", "", "Ä", "z"];
    expect(names.slice().sort(naturalCompare)).toEqual(["", "01-intro", "1-intro", "2-setup", "10-deploy", "a", "a2", "a10", "B", "z", "Ä"]);
    expect(naturalCompare("a", "a")).toBe(0);
    expect(naturalCompare("abc", "ab")).toBeGreaterThan(0);
    expect(naturalCompare("x9", "x10")).toBeLessThan(0);
    expect(naturalCompare("x10", "x09")).toBeGreaterThan(0);
  });
});
