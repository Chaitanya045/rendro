import { beforeEach, describe, expect, it } from "vitest";
import { RepoAccessUnavailable } from "../src/repo-read/access";
import {
  clearCommentGrantMemory, commentSnapshot, convexCommentGrants, moderatorDecision, recordModerator, type CommentGrants, type CommentSnapshots, type ModerationSources,
} from "../src/repo-read/comments";
import { issueGrant } from "../src/repo-read/grant";
import { privateRepo, publicRepo } from "./helpers/repo-read-fixture";

/** The serving Worker's half of moderator grants (#259): who it asks, under which epoch, and what it remembers. */

function sources(role: "admin" | "maintain" | null | Error, epochs: Record<string, number> = {}) {
  const asked: Array<{ viewer: string; repo: string }> = [];
  const epochReads: string[] = [];
  const value: ModerationSources = {
    roles: { moderationRole: (viewer, owner, name) => {
      asked.push({ viewer, repo: `${owner}/${name}` });
      return role instanceof Error ? Promise.reject(role) : Promise.resolve(role);
    } },
    epochs: { currentEpoch: (userId) => { epochReads.push(userId); return Promise.resolve(epochs[userId] ?? 0); } },
  };
  return { value, asked, epochReads };
}

function recorder(answer: number | null | Error = 61_000) {
  const calls: unknown[] = [];
  const grants: CommentGrants = {
    record: () => Promise.resolve(null),
    recordModerator: (input) => {
      calls.push(input);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { calls, grants };
}

beforeEach(() => clearCommentGrantMemory());

describe("moderatorDecision", () => {
  it("is nothing for no reader, and for an authorization that has already lapsed", async () => {
    const { value, asked } = sources("admin");
    expect(await moderatorDecision(value, issueGrant(privateRepo, "u", 3, 61_000), null, 1_000)).toBeNull();
    expect(await moderatorDecision(value, issueGrant(privateRepo, "u", 3, 1_000), "u", 1_000)).toBeNull();
    expect(asked).toEqual([]);
  });

  it("decides a private grant under the epoch its authorization rested on, and a public one under the reader's own, read first", async () => {
    const world = sources("maintain", { v: 77 });
    expect(await moderatorDecision(world.value, issueGrant(privateRepo, "u", 3, 61_000), "u", 1_000)).toEqual({ viewer: "u", role: "maintain", epoch: 3, recorded: false });
    expect(world.epochReads).toEqual([]);
    expect(await moderatorDecision(world.value, issueGrant(publicRepo, null, 0, 61_000), "v", 1_000)).toEqual({ viewer: "v", role: "maintain", epoch: 77, recorded: false });
    expect(world.epochReads).toEqual(["v"]);
    expect(world.asked).toEqual([{ viewer: "u", repo: "octo/secret-docs" }, { viewer: "v", repo: "Octo/public-docs" }]);
  });

  it("remembers 'no role' for half the grant, per reader and epoch, and asks again after", async () => {
    const world = sources(null);
    const grant = issueGrant(privateRepo, "u", 3, 61_000);
    expect(await moderatorDecision(world.value, grant, "u", 1_000)).toBeNull();
    expect(await moderatorDecision(world.value, grant, "u", 30_000)).toBeNull();
    expect(world.asked).toHaveLength(1);
    expect(await moderatorDecision(world.value, grant, "u", 31_001)).toBeNull();
    expect(await moderatorDecision(world.value, issueGrant(privateRepo, "u", 4, 61_000), "u", 31_001)).toBeNull();
    expect(world.asked).toHaveLength(3);
  });

  it("throws when the control Worker cannot be asked, and remembers nothing of it", async () => {
    const world = sources(new RepoAccessUnavailable());
    const grant = issueGrant(privateRepo, "u", 3, 61_000);
    await expect(moderatorDecision(world.value, grant, "u", 1_000)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    await expect(moderatorDecision(world.value, grant, "u", 1_000)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(world.asked).toHaveLength(2);
  });
});

describe("recordModerator", () => {
  const decision = { viewer: "u", role: "admin" as const, epoch: 3, recorded: false };

  it("records the role with the read grant's expiry, then reuses it for half of what Convex holds", async () => {
    const { calls, grants } = recorder(61_000);
    const grant = issueGrant(privateRepo, "u", 3, 61_000);
    expect(await recordModerator(grants, grant, decision, 1_000)).toBe("admin");
    expect(calls).toEqual([{ repoId: privateRepo.id, userId: "u", role: "admin", epoch: 3, expiresAt: 61_000 }]);
    // Within the first half the decision comes from memory and nothing is written again.
    const remembered = await moderatorDecision(sources("admin").value, grant, "u", 30_000);
    expect(remembered).toEqual({ viewer: "u", role: "admin", epoch: 3, recorded: true });
    expect(await recordModerator(grants, grant, remembered!, 30_000)).toBe("admin");
    expect(calls).toHaveLength(1);
    // Past half it is asked of the control Worker and written again, which also picks up a demotion.
    const demoted = sources("maintain");
    const again = await moderatorDecision(demoted.value, grant, "u", 31_001);
    expect(again).toEqual({ viewer: "u", role: "maintain", epoch: 3, recorded: false });
    expect(demoted.asked).toHaveLength(1);
  });

  it("is nothing, and forgets the reader, when Convex refuses; and throws when Convex cannot be asked", async () => {
    const grant = issueGrant(privateRepo, "u", 3, 61_000);
    expect(await recordModerator(recorder(null).grants, grant, decision, 1_000)).toBeNull();
    const failing = recorder(new Error("Convex down"));
    await expect(recordModerator(failing.grants, grant, decision, 1_000)).rejects.toThrow("Convex down");
    // Neither left a memory: the same reader is asked about and recorded again.
    const world = sources("admin");
    expect(await moderatorDecision(world.value, grant, "u", 1_001)).toMatchObject({ recorded: false });
    expect(world.asked).toHaveLength(1);
  });

  it("keeps a bounded memory", async () => {
    const { calls, grants } = recorder(100_000);
    for (let index = 0; index <= 1_024; index += 1) {
      const grant = issueGrant({ ...privateRepo, id: index + 1 }, "u", 0, 100_000);
      await recordModerator(grants, grant, { viewer: "u", role: "admin", epoch: 0, recorded: false }, 0);
    }
    const world = sources("admin");
    // The oldest entry was evicted and is asked about again; the newest is still remembered.
    expect(await moderatorDecision(world.value, issueGrant({ ...privateRepo, id: 1 }, "u", 0, 100_000), "u", 0)).toMatchObject({ recorded: false });
    expect(await moderatorDecision(world.value, issueGrant({ ...privateRepo, id: 1_025 }, "u", 0, 100_000), "u", 0)).toMatchObject({ recorded: true });
    expect(calls).toHaveLength(1_025);
  });
});

describe("Convex's answer and the first page", () => {
  it("reads Convex's moderator answer strictly", async () => {
    const stub = (value: unknown) => {
      globalThis.fetch = (() => Promise.resolve(Response.json({ status: "success", value }))) as typeof fetch;
    };
    const input = { repoId: 1, userId: "u", role: "admin" as const, epoch: 0, expiresAt: 5 };
    stub({ granted: true, expiresAt: 5 });
    expect(await convexCommentGrants.recordModerator(input)).toBe(5);
    stub({ granted: true });
    expect(await convexCommentGrants.recordModerator(input)).toBeNull();
    stub({ granted: false });
    expect(await convexCommentGrants.recordModerator(input)).toBeNull();
    stub(null);
    expect(await convexCommentGrants.recordModerator(input)).toBeNull();
  });

  it("tells Convex the page's reader moderates only when there is a reader to name", async () => {
    const asked: unknown[] = [];
    const snapshots: CommentSnapshots = { threads: (input) => { asked.push(input); return Promise.resolve({ page: [], isDone: true }); } };
    await commentSnapshot(snapshots, issueGrant(privateRepo, "u", 3, 61_000), "a.md", null, true);
    await commentSnapshot(snapshots, issueGrant(privateRepo, "u", 3, 61_000), "a.md", null, false);
    await commentSnapshot(snapshots, issueGrant(publicRepo, null, 0, 61_000), "a.md", "v", true);
    await commentSnapshot(snapshots, issueGrant(publicRepo, null, 0, 61_000), "a.md", null, true);
    expect(asked).toEqual([
      { repoId: privateRepo.id, path: "a.md", userId: "u", epoch: 3, moderator: true },
      { repoId: privateRepo.id, path: "a.md", userId: "u", epoch: 3 },
      { repoId: publicRepo.id, path: "a.md", userId: null, epoch: 0, viewerId: "v", moderator: true },
      { repoId: publicRepo.id, path: "a.md", userId: null, epoch: 0 },
    ]);
  });
});
