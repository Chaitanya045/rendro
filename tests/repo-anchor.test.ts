// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { locateRepoAnchor, MAX_QUOTE_LENGTH, pageSections, QUOTE_CONTEXT, repoAnchorFor, sectionRange, validRepoAnchor, type RepoAnchor } from "../src/commentor/repo-anchor";

/*
 * Anchors on repository docs (#254), on a page shaped like ingest's output: headings with `user-content-<slug>` ids,
 * one without an id, an author-set id, and text before the first heading.
 */
const BLOB = "a".repeat(40);
const OTHER = "b".repeat(40);
let root: Element;

beforeEach(() => {
  document.body.innerHTML = `<article class="markdown-body"><p id="lead">Lead text.</p>`
    + `<h2 id="user-content-install">Install</h2><p id="install">Run <code>pnpm install</code>, then pnpm install.</p>`
    + `<h2>🚀</h2><p id="unnamed">Launch.</p>`
    + `<h2 id="custom">Custom</h2><p id="custom-text">Own id.</p></article><p id="outside">Outside.</p>`;
  root = document.querySelector("article")!;
});

function rangeOf(id: string, text: string, occurrence = 0): Range {
  const element = document.getElementById(id)!;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let index = node.data.indexOf(text); index !== -1; index = node.data.indexOf(text, index + 1)) {
      if (seen++ !== occurrence) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      return range;
    }
  }
  throw new Error(`No ${text}`);
}

describe("page sections", () => {
  it("splits at headings with ids; an id-less heading stays in the section before it", () => {
    const sections = pageSections(root);
    expect(sections.map(section => [section.slug, section.text])).toEqual([
      ["", "Lead text."],
      ["install", "InstallRun pnpm install, then pnpm install.🚀Launch."],
      ["custom", "CustomOwn id."],
    ]);
  });
});

describe("making anchors", () => {
  it("records the quote, its offset in the section, its context and the blob", () => {
    const sections = pageSections(root);
    expect(repoAnchorFor(root, sections, rangeOf("install", "pnpm install", 1), BLOB)).toEqual({
      kind: "repo-text", blobSha: BLOB, headingSlug: "install", exact: "pnpm install", offset: 30,
      prefix: "InstallRun pnpm install, then ", suffix: ".🚀Launch.",
    });
    expect(repoAnchorFor(root, sections, rangeOf("lead", "Lead"), BLOB)).toMatchObject({ headingSlug: "", offset: 0, prefix: "" });
    expect(repoAnchorFor(root, sections, rangeOf("custom-text", "Own"), BLOB)).toMatchObject({ headingSlug: "custom" });
    const long = "x".repeat(QUOTE_CONTEXT * 3);
    document.getElementById("lead")!.textContent = `${long}needle${long}`;
    const fresh = pageSections(root);
    const anchor = repoAnchorFor(root, fresh, rangeOf("lead", "needle"), BLOB)!;
    expect([anchor.prefix.length, anchor.suffix.length]).toEqual([QUOTE_CONTEXT, QUOTE_CONTEXT]);
  });

  it("anchors element boundaries, such as a whole element's contents", () => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("install")!);
    expect(repoAnchorFor(root, pageSections(root), range, BLOB)).toMatchObject({ exact: "Run pnpm install, then pnpm install.", offset: 7 });
    const between = document.createRange();
    between.setStart(document.getElementById("install")!, 1);
    between.setEnd(document.getElementById("install")!, 2);
    expect(repoAnchorFor(root, pageSections(root), between, BLOB)).toMatchObject({ exact: "pnpm install" });
  });

  it("makes no anchor for empty, oversized, cross-heading or outside selections", () => {
    const sections = pageSections(root);
    const blank = document.createRange();
    blank.setStart(document.getElementById("lead")!.firstChild!, 0);
    blank.setEnd(document.getElementById("lead")!.firstChild!, 0);
    expect(repoAnchorFor(root, sections, blank, BLOB)).toBeNull();
    const collapsed = document.createRange();
    collapsed.setStart(document.getElementById("lead")!, 0);
    collapsed.setEnd(document.getElementById("lead")!, 0);
    expect(repoAnchorFor(root, sections, collapsed, BLOB)).toBeNull();
    const across = document.createRange();
    across.setStart(document.getElementById("lead")!.firstChild!, 0);
    across.setEnd(document.getElementById("install")!.firstChild!, 2);
    expect(repoAnchorFor(root, sections, across, BLOB)).toBeNull();
    expect(repoAnchorFor(root, sections, rangeOf("outside", "Outside"), BLOB)).toBeNull();
    document.getElementById("lead")!.textContent = "y".repeat(MAX_QUOTE_LENGTH + 1);
    const huge = document.createRange();
    huge.selectNodeContents(document.getElementById("lead")!);
    expect(repoAnchorFor(root, pageSections(root), huge, BLOB)).toBeNull();
  });
});

describe("finding anchors again", () => {
  const second = (): RepoAnchor => repoAnchorFor(root, pageSections(root), rangeOf("install", "pnpm install", 1), BLOB)!;

  it("takes the offset on the same blob, and re-finds the quote by its context on another", () => {
    const sections = pageSections(root);
    expect(locateRepoAnchor(sections, second(), BLOB)).toMatchObject({ start: 30 });
    expect(locateRepoAnchor(sections, { ...second(), offset: 0 }, OTHER)).toMatchObject({ start: 30 });
    // A wrong offset on the same blob is not trusted: the text decides.
    expect(locateRepoAnchor(sections, { ...second(), offset: 3 }, BLOB)).toMatchObject({ start: 30 });
    expect(locateRepoAnchor(sections, { ...second(), prefix: "", suffix: "" }, OTHER)).toBeNull();
    const range = sectionRange(sections[1], 30, "pnpm install".length)!;
    expect(range.toString()).toBe("pnpm install");
  });

  it("takes the only occurrence when the context changed, and orphans everything ambiguous or gone", () => {
    const sections = pageSections(root);
    const launch: RepoAnchor = { kind: "repo-text", blobSha: OTHER, headingSlug: "install", exact: "Launch", prefix: "changed", suffix: "changed", offset: 0 };
    expect(locateRepoAnchor(sections, launch, BLOB)).toMatchObject({ start: "InstallRun pnpm install, then pnpm install.🚀".length });
    expect(locateRepoAnchor(sections, { ...second(), prefix: "changed ", suffix: " changed", blobSha: OTHER }, BLOB)).toBeNull();
    expect(locateRepoAnchor(sections, { ...launch, exact: "Deploy" }, BLOB)).toBeNull();
    expect(locateRepoAnchor(sections, { ...launch, headingSlug: "gone" }, BLOB)).toBeNull();
    expect(locateRepoAnchor(sections, { ...launch, exact: "" }, BLOB)).toBeNull();
    // Slug "" is only the text before the first heading.
    expect(locateRepoAnchor(sections, { ...launch, headingSlug: "", exact: "Lead" }, BLOB)).toMatchObject({ section: sections[0], start: 0 });
    expect(locateRepoAnchor(sections, { ...launch, headingSlug: "", exact: "Launch" }, BLOB)).toBeNull();
  });

  it("maps section offsets onto the DOM, and nothing past the section", () => {
    const sections = pageSections(root);
    expect(sectionRange(sections[1], 0, "InstallRun".length)!.toString()).toBe("InstallRun");
    expect(sectionRange(sections[1], 10_000, 1)).toBeNull();
    expect(sectionRange(sections[1], 0, 10_000)).toBeNull();
  });
});

describe("anchor shape over the parent protocol", () => {
  const valid = { kind: "repo-text", blobSha: BLOB, headingSlug: "install", prefix: "", exact: "x", suffix: "", offset: 0 };
  it.each([
    [{}], [{ kind: "text-range" }], [{ blobSha: "A".repeat(40) }], [{ blobSha: 1 }], [{ headingSlug: "a b" }], [{ headingSlug: "x".repeat(257) }], [{ headingSlug: 1 }],
    [{ exact: " " }], [{ exact: "x".repeat(MAX_QUOTE_LENGTH + 1) }], [{ exact: 1 }], [{ prefix: "p".repeat(65) }], [{ prefix: 1 }], [{ suffix: "s".repeat(65) }], [{ suffix: 1 }],
    [{ offset: -1 }], [{ offset: 0.5 }], [{ offset: 10_000_001 }],
  ])("rejects %j", (overrides) => {
    expect(validRepoAnchor({ ...valid, ...overrides, ...(Object.keys(overrides).length ? {} : { kind: undefined }) })).toBe(false);
  });
  it("accepts a well-formed anchor, including a SHA-256 blob", () => {
    expect(validRepoAnchor(valid)).toBe(true);
    expect(validRepoAnchor({ ...valid, blobSha: "c".repeat(64), headingSlug: "" })).toBe(true);
  });
});
