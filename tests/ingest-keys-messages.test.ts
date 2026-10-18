import { describe, expect, it } from "vitest";
import { gitBlobId, isGitObjectId, matchesBlobId, toHex } from "../src/ingest/github/git-objects";
import {
  blobKey, isBranchName, manifestKey, REDELIVERY_CHECKPOINT_KEY, refKey, renderObjectKey, repoPrefix, sidebarKey, TRACKED_PREFIX, trackedKey, treeKey,
} from "../src/ingest/orchestrator/keys";
import { parseIngestMessage, parseRepoRef } from "../src/ingest/orchestrator/messages";

const SHA = "a".repeat(40);
const SHA256 = "b".repeat(64);
const encoder = new TextEncoder();

describe("git object IDs", () => {
  it("hashes blobs exactly as git does", async () => {
    // `git hash-object` of an empty file and of "hello\n".
    expect(await gitBlobId(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await gitBlobId(encoder.encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // `git hash-object --object-format=sha256` of an empty file.
    expect(await gitBlobId(new Uint8Array(), "SHA-256")).toBe("473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813");
  });

  it("matches content against SHA-1 and SHA-256 IDs", async () => {
    expect(await matchesBlobId(encoder.encode("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a")).toBe(true);
    expect(await matchesBlobId(encoder.encode("hello!\n"), "ce013625030ba8dba906f756967f9e9ca394464a")).toBe(false);
    expect(await matchesBlobId(new Uint8Array(), "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813")).toBe(true);
  });

  it("recognizes object IDs and hex-encodes bytes", () => {
    expect(isGitObjectId(SHA)).toBe(true);
    expect(isGitObjectId(SHA256)).toBe(true);
    expect(isGitObjectId("A".repeat(40))).toBe(false);
    expect(isGitObjectId("a".repeat(41))).toBe(false);
    expect(isGitObjectId(40)).toBe(false);
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});

describe("storage key schema", () => {
  it("puts everything a repository owns under its ID", () => {
    expect(repoPrefix(7)).toBe("gh/v1/repo/7/");
    expect(blobKey(7, SHA)).toBe(`gh/v1/repo/7/blob/${SHA}`);
    expect(treeKey(7, SHA)).toBe(`gh/v1/repo/7/tree/${SHA}.json`);
    expect(renderObjectKey(7, `render/v1/markdown/${SHA}/0123`)).toBe(`gh/v1/repo/7/render/v1/markdown/${SHA}/0123`);
    expect(manifestKey(7, SHA, 3)).toBe(`gh/v1/repo/7/snapshot/${SHA}/r3/manifest.json`);
    expect(sidebarKey(7, SHA256, 0)).toBe(`gh/v1/repo/7/snapshot/${SHA256}/r0/sidebar.json`);
    expect(refKey(7, "feature/x")).toBe("gh/v1/repo/7/ref/feature%2Fx.json");
    expect(trackedKey(7)).toBe(`${TRACKED_PREFIX}7.json`);
    expect(REDELIVERY_CHECKPOINT_KEY).toBe("gh/v1/reconcile/redelivery.json");
  });

  it("rejects anything that could escape its slot", () => {
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => repoPrefix(id)).toThrow(TypeError);
    expect(() => trackedKey(0)).toThrow(TypeError);
    expect(() => blobKey(7, "../x")).toThrow(TypeError);
    expect(() => treeKey(7, "x")).toThrow(TypeError);
    expect(() => manifestKey(7, "HEAD", 1)).toThrow(TypeError);
    expect(() => manifestKey(7, SHA, -1)).toThrow(TypeError);
    expect(() => manifestKey(7, SHA, 1.5)).toThrow(TypeError);
    for (const key of ["blob/x", "render/../x", "render/./x", "render//x", "render/x/", "render/a b"]) {
      expect(() => renderObjectKey(7, key)).toThrow(TypeError);
    }
    expect(() => refKey(7, "../main")).toThrow(TypeError);
  });

  it("accepts branch names git accepts and nothing else", () => {
    for (const name of ["main", "feature/x", "release-1.2", "a.b/c_d", "x".repeat(255)]) expect(isBranchName(name)).toBe(true);
    for (const name of ["", "x".repeat(256), "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a\u0000b", "a\u007fb",
      "@", "a@{b", "/a", "a/", "a//b", ".a", "a/.b", "a.lock", "a/b.lock", "a.", 7, null]) {
      expect(isBranchName(name)).toBe(false);
    }
  });
});

describe("queue messages", () => {
  const repo = { id: 7, owner: "octo-cat", name: "docs.site", private: true, installationId: 42 };
  const message = { v: 1, repo, branch: "main", sha: SHA, deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958", reason: "push" };

  it("round-trips valid messages and repositories", () => {
    expect(parseIngestMessage(message)).toEqual(message);
    expect(parseIngestMessage({ ...message, sha: null, deliveryId: null, reason: "reconcile" })).toMatchObject({ sha: null, deliveryId: null });
    expect(parseRepoRef({ ...repo, installationId: null, extra: true })).toEqual({ ...repo, installationId: null });
  });

  it("drops malformed messages", () => {
    for (const bad of [null, "x", { ...message, v: 2 }, { ...message, repo: null }, { ...message, branch: "a..b" }, { ...message, sha: "HEAD" },
      { ...message, deliveryId: "has space" }, { ...message, deliveryId: 5 }, { ...message, reason: "other" }]) {
      expect(parseIngestMessage(bad)).toBeNull();
    }
    for (const bad of [null, "repo", { ...repo, id: 0 }, { ...repo, owner: "-x" }, { ...repo, owner: 5 }, { ...repo, name: "a/b" }, { ...repo, name: 5 },
      { ...repo, name: ".." }, { ...repo, name: "." }, { ...repo, private: "yes" }, { ...repo, installationId: 0 }, { ...repo, installationId: undefined }]) {
      expect(parseRepoRef(bad)).toBeNull();
    }
  });
});
