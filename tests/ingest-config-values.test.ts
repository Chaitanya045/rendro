import { describe, expect, it } from "vitest";

import { readJsString, readTomlString, readYamlNestedScalar, readYamlScalar, splitFrontMatter, stripMdxEsm } from "../src/ingest/config-values";

describe("YAML scalars", () => {
  const yaml = "\uFEFFsite_name: Demo\r\ndocs_dir: 'source docs'   # where pages live\ntheme:\n  name: material\nempty:\nblock: |\n  text\nflow: [a, b]\nanchor: &x value\ntag: !!python/name:x\nquoted: \"a # not a comment\"\nunterminated: 'oops\nplain: value # comment\n";
  it("reads top-level plain and quoted scalars", () => {
    expect(readYamlScalar(yaml, "site_name")).toBe("Demo");
    expect(readYamlScalar(yaml, "docs_dir")).toBe("source docs");
    expect(readYamlScalar(yaml, "quoted")).toBe("a # not a comment");
    expect(readYamlScalar(yaml, "plain")).toBe("value");
  });

  it("returns null for anything that is not a one-line scalar", () => {
    for (const key of ["theme", "empty", "block", "flow", "anchor", "tag", "unterminated", "missing", "name"]) expect(readYamlScalar(yaml, key), key).toBeNull();
  });

  it("reads one level of nesting", () => {
    const rtd = "version: 2\nbuild:\n  os: ubuntu\nsphinx:   # comment\n  builder: html\n  configuration: \"docs/conf.py\"\nmkdocs:\n  configuration: mkdocs.yml\n";
    expect(readYamlNestedScalar(rtd, "sphinx", "configuration")).toBe("docs/conf.py");
    expect(readYamlNestedScalar(rtd, "mkdocs", "configuration")).toBe("mkdocs.yml");
    expect(readYamlNestedScalar(rtd, "build", "configuration")).toBeNull();
    expect(readYamlNestedScalar("  configuration: x\n", "sphinx", "configuration")).toBeNull();
  });
});

describe("TOML strings", () => {
  const toml = "title = \"Top\"\n[book] # the book table\ntitle = 'Book'\nsrc = \"pages\"\nnumber = 3\n[output.html]\nsrc = \"other\"\n";
  it("reads keys in a table or before the first table", () => {
    expect(readTomlString(toml, "book", "src")).toBe("pages");
    expect(readTomlString(toml, "book", "title")).toBe("Book");
    expect(readTomlString(toml, null, "title")).toBe("Top");
    expect(readTomlString(toml, "output.html", "src")).toBe("other");
    expect(readTomlString(toml, "book", "number")).toBeNull();
    expect(readTomlString(toml, "book", "missing")).toBeNull();
  });
});

describe("JS config strings", () => {
  it("reads a string-literal property", () => {
    expect(readJsString("export default defineConfig({ srcDir: './src', title: \"T\" })", "srcDir")).toBe("./src");
    expect(readJsString("module.exports = {srcDir:`docs`}", "srcDir")).toBe("docs");
    expect(readJsString("const mySrcDir: 'x'", "srcDir")).toBeNull();
    expect(readJsString("srcDir: resolve('x')", "srcDir")).toBeNull();
  });
});

describe("front matter", () => {
  it("splits YAML front matter and reads the title", () => {
    expect(splitFrontMatter("---\ntitle: Hello\n---\n# Body")).toEqual({ body: "# Body", title: "Hello" });
    expect(splitFrontMatter("\uFEFF---\r\ntitle: 'Quoted'\r\n...\r\nBody")).toEqual({ body: "Body", title: "Quoted" });
    expect(splitFrontMatter("---\nlayout: page\n---\nBody")).toEqual({ body: "Body", title: null });
    expect(splitFrontMatter("---\ntitle: \"  \"\n---\nBody")).toEqual({ body: "Body", title: null });
  });

  it("splits TOML front matter", () => {
    expect(splitFrontMatter("+++\ntitle = \"Hugo\"\n+++\nBody")).toEqual({ body: "Body", title: "Hugo" });
  });

  it("leaves documents without complete front matter alone", () => {
    for (const source of ["# Title\n---\n", "---\ntitle: open", "--- not a fence\n---\n", "Text"]) expect(splitFrontMatter(source)).toEqual({ body: source, title: null });
  });
});

describe("stripMdxEsm", () => {
  it("removes import/export blocks up to the next blank line", () => {
    expect(stripMdxEsm("import A from 'a';\nimport {\n  B,\n} from 'b';\n\n# Title\nexport const x = 1;\n\nText")).toBe("\n# Title\n\nText");
  });

  it("keeps import/export inside fenced code and in prose", () => {
    const source = "```js\nimport x from 'y';\n```\n~~~~\nexport default 1;\n```\n~~~~\nWe import things.\n  import indented";
    expect(stripMdxEsm(source)).toBe(source);
  });
});
