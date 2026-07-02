import { describe, it, expect } from "vitest";
import type { DocEntry, DocTree } from "@/minio";
import { buildTree } from "@/minio";

function makeEntries(keys: string[]): DocEntry[] {
  return keys.map((key) => ({
    key,
    name: key.split("/").pop()!,
    size: 100,
    lastModified: new Date("2025-01-01"),
  }));
}

describe("buildTree", () => {
  it("builds a tree from flat entries — single file", () => {
    const entries = makeEntries(["acme-corp/index.html"]);
    const tree = buildTree(entries, "acme-corp/");

    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe("index.html");
    expect(tree[0]!.type).toBe("file");
    expect(tree[0]!.children).toEqual([]);
  });

  it("builds a tree with nested folders", () => {
    const entries = makeEntries([
      "acme-corp/index.html",
      "acme-corp/api/index.html",
      "acme-corp/api/v2/reference.html",
      "acme-corp/onboarding/index.html",
    ]);
    const tree = buildTree(entries, "acme-corp/");

    expect(tree).toHaveLength(3);

    const indexFile = tree.find((n) => n.name === "index.html");
    expect(indexFile).toBeDefined();
    expect(indexFile!.type).toBe("file");

    const apiFolder = tree.find((n) => n.name === "api") as DocTree;
    expect(apiFolder).toBeDefined();
    expect(apiFolder.type).toBe("folder");
    expect(apiFolder.children).toHaveLength(2);

    const onboardingFolder = tree.find((n) => n.name === "onboarding") as DocTree;
    expect(onboardingFolder).toBeDefined();
    expect(onboardingFolder.type).toBe("folder");
    expect(onboardingFolder.children).toHaveLength(1);
  });

  it("handles empty entries", () => {
    const tree = buildTree([], "acme-corp/");
    expect(tree).toEqual([]);
  });

  it("handles deeply nested paths", () => {
    const entries = makeEntries(["org/a/b/c/d/e/deep.html"]);
    const tree = buildTree(entries, "org/");

    expect(tree).toHaveLength(1);
    let node = tree[0]!;
    expect(node.name).toBe("a");
    expect(node.type).toBe("folder");

    while (node.type === "folder" && node.children.length === 1) {
      node = node.children[0]!;
    }
    expect(node.name).toBe("deep.html");
    expect(node.type).toBe("file");
  });

  it("groups files in the same folder", () => {
    const entries = makeEntries(["org/docs/a.html", "org/docs/b.html", "org/docs/c.html"]);
    const tree = buildTree(entries, "org/");

    const docsFolder = tree[0] as DocTree;
    expect(docsFolder.name).toBe("docs");
    expect(docsFolder.type).toBe("folder");
    expect(docsFolder.children).toHaveLength(3);
  });

  it("handles multiple orgs (different prefixes)", () => {
    const entries = makeEntries(["acme-corp/index.html", "startup-io/handbook.html"]);
    const acmeEntries = entries.filter((e) => e.key.startsWith("acme-corp/"));
    const startupEntries = entries.filter((e) => e.key.startsWith("startup-io/"));
    expect(buildTree(acmeEntries, "acme-corp/")).toHaveLength(1);
    expect(buildTree(startupEntries, "startup-io/")).toHaveLength(1);
  });

  it("preserves the full key path in file nodes", () => {
    const entries = makeEntries(["acme-corp/api/v2/reference.html"]);
    const tree = buildTree(entries, "acme-corp/");

    const apiFolder = tree[0] as DocTree;
    const v2Folder = apiFolder.children[0] as DocTree;
    const file = v2Folder.children[0] as DocTree;
    expect(file.path).toBe("acme-corp/api/v2/reference.html");
  });

  it("handles files with same name in different folders", () => {
    const entries = makeEntries([
      "org/api/index.html",
      "org/guides/index.html",
      "org/index.html",
    ]);
    const tree = buildTree(entries, "org/");
    const names = tree.map((n) => n.name).sort();
    expect(names).toEqual(["api", "guides", "index.html"]);
  });

  it("handles single-character file/folder names", () => {
    const entries = makeEntries(["org/a/b.html"]);
    const tree = buildTree(entries, "org/");
    expect(tree[0]!.name).toBe("a");
    expect(tree[0]!.children[0]!.name).toBe("b.html");
  });

  it("handles folder path that collides with file name", () => {
    const entries = makeEntries(["org/api.html", "org/api/index.html"]);
    const tree = buildTree(entries, "org/");
    expect(tree).toHaveLength(2);

    const fileNode = tree.find((n) => n.name === "api.html" && n.type === "file");
    const folderNode = tree.find((n) => n.name === "api" && n.type === "folder");
    expect(fileNode).toBeDefined();
    expect(folderNode).toBeDefined();
  });
});
