import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { REMOVED_REPO_RETENTION_MS } from "../convex/repoCommentAccess";
import schema from "../convex/schema";
import { PURGE_BATCH, PURGE_RETRY_MAX_MS, PURGE_RETRY_MS, REMOVAL_PURGE_DELAY_MS, type CommentAccessSink, type PurgeAnswer } from "../src/repo-access/directory";
import { accessFixture, mintedInstallationTokens } from "./helpers/repo-access-fixture";

const modules = import.meta.glob("../convex/**/*.ts");
const internalSecret = process.env.CONVEX_INTERNAL_SECRET!;
const BLOB = "a".repeat(40);

afterEach(() => vi.useRealTimers());

type World = ReturnType<typeof accessFixture>;

/** Run the Durable Object's alarm as the runtime would: whenever it is due, until nothing is. */
async function fire(world: World): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    const at = world.storage.alarm;
    if (at === null || at > world.clock.time) return;
    world.storage.alarm = null;
    await world.directory.alarm();
  }
  throw new Error("The alarm kept firing");
}

async function ledger(world: World) {
  return [...(await world.storage.list<{ repoId: number; dueAt: number; attempts: number }>({ prefix: "purge:" })).values()];
}

/** The one postponed entry: its attempts, and its delay rounded to the minute (GitHub client back-off moves the clock by under a second). */
async function retry(world: World) {
  const [entry] = await ledger(world);
  return { attempts: entry.attempts, delay: Math.ceil((entry.dueAt - world.clock.time) / 60_000) * 60_000 };
}

/**
 * The control Worker's directory over the fake GitHub, telling a real (convex-test) Convex about
 * removals, purges and restores. Both share the fixture's clock. One public repository has a
 * thread with a reply.
 */
async function convexWorld() {
  vi.useFakeTimers();
  const backend = convexTest(schema, modules);
  let fixture: World | null = null;
  const at = async <T>(work: () => Promise<T>): Promise<T> => {
    vi.setSystemTime((fixture as World).clock.time);
    return work();
  };
  const sink: CommentAccessSink = {
    revoke: (userId, epoch) => at(async () => void await backend.mutation(api.repoCommentAccess.revokeUser, { internalSecret, userId, epoch })),
    removeRepos: (repoIds) => at(async () => void await backend.mutation(api.repoCommentAccess.removeRepos, { internalSecret, repoIds })),
    restoreRepos: (repoIds) => at(async () => void await backend.mutation(api.repoCommentAccess.restoreRepos, { internalSecret, repoIds })),
    purgeRepos: (repoIds) => at(() => backend.mutation(api.repoCommentAccess.purgeRepos, { internalSecret, repoIds })),
  };
  const world = fixture = accessFixture({ comments: sink, installationTokens: mintedInstallationTokens });
  await world.setup();
  const repoId = world.open.id;
  await at(() => backend.mutation(api.repoCommentAccess.grant, { internalSecret, repoId, userId: null, epoch: 0, expiresAt: world.clock.time + 60_000 }));
  await backend.run(async ctx => {
    const anchor = { kind: "repo-text" as const, blobSha: BLOB, headingSlug: "install", prefix: "Run ", exact: "pnpm install", suffix: " first", offset: 4 };
    const threadId = await ctx.db.insert("repoThreads", {
      repoId, path: "docs/guide.md", blobSha: BLOB, anchor, authorId: "user-reader", body: "Keep me", resolved: false, archived: false, createdAt: 1, updatedAt: 1,
    });
    await ctx.db.insert("repoReplies", { repoId, threadId, authorId: "user-reader", body: "Reply", createdAt: 2 });
  });
  const advance = async (ms: number) => {
    world.clock.time += ms;
    await fire(world);
    vi.setSystemTime(world.clock.time);
    await backend.finishAllScheduledFunctions(() => vi.runAllTimers());
  };
  const comments = () => backend.run(async ctx => ({
    threads: (await ctx.db.query("repoThreads").collect()).length,
    replies: (await ctx.db.query("repoReplies").collect()).length,
    hidden: (await ctx.db.query("repoCommentRepos").first())?.removedAt !== undefined,
  }));
  const audits = () => backend.run(async ctx => (await ctx.db.query("auditEvents").collect()).map(event => [event.action, event.resourceId]));
  const removeFromInstallation = () => {
    world.installation.repositories = new Set([world.closed.id, world.teamDocs.id]);
    return world.deliver("installation_repositories", { action: "removed", repositories_removed: [world.github.repoJson(world.open)] });
  };
  return { ...world, backend, advance, comments, audits, removeFromInstallation };
}

describe("a removal is confirmed with GitHub before anything is purged (#258)", () => {
  it("never purges a still-installed repository after a replayed removal, and shows it again", async () => {
    const world = await convexWorld();
    const removal = { action: "removed", repositories_removed: [world.github.repoJson(world.open)] };
    // A captured delivery, replayed under fresh delivery IDs: deduplication cannot tell.
    await world.deliver("installation_repositories", removal);
    await world.advance(60_000);
    await world.deliver("installation_repositories", removal);
    // Hiding still happens at once, straight from the payload.
    expect(await world.read(null, world.open)).toBeNull();
    expect(await world.comments()).toEqual({ threads: 1, replies: 1, hidden: true });
    expect(await ledger(world)).toHaveLength(1);
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    // GitHub still shows the repository to the installation: restored, with an audit event, and nothing deleted.
    expect(await world.comments()).toEqual({ threads: 1, replies: 1, hidden: false });
    expect(await world.audits()).toEqual([["repository.removal_reverted", String(world.open.id)]]);
    expect(world.logs.filter(entry => entry.event === "access.purge").map(entry => entry.fields)).toEqual([{ confirmed: 0, content: 0, restored: 1, postponed: 0 }]);
    expect(await world.read(null, world.open)).toMatchObject({ id: world.open.id });
    expect(await ledger(world)).toEqual([]);
    await world.advance(REMOVED_REPO_RETENTION_MS * 2);
    expect(await world.comments()).toEqual({ threads: 1, replies: 1, hidden: false });
  });

  it("restores every repository of a replayed uninstall, and the installation is decided by GitHub again", async () => {
    const world = await convexWorld();
    await world.deliver("installation", { action: "deleted" });
    expect(await world.read(null, world.open)).toBeNull();
    expect((await world.comments()).hidden).toBe(true);
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    expect(await world.comments()).toEqual({ threads: 1, replies: 1, hidden: false });
    world.github.resetLog();
    expect(await world.read(null, world.open)).toMatchObject({ id: world.open.id });
    expect(world.github.count("installation")).toBe(1);
    expect(await world.read("reader", world.closed)).toMatchObject({ id: world.closed.id });
  });

  it("purges a real removal once its window has ended, and not before", async () => {
    const world = await convexWorld();
    const removedAt = world.clock.time;
    await world.removeFromInstallation();
    // The removal's own alarm (now) runs the outbox, then waits for the window.
    await world.advance(0);
    expect(world.storage.alarm).toBe(removedAt + REMOVAL_PURGE_DELAY_MS);
    await world.advance(REMOVAL_PURGE_DELAY_MS - 1);
    expect(await world.comments()).toEqual({ threads: 1, replies: 1, hidden: true });
    await world.advance(1);
    expect(await world.comments()).toEqual({ threads: 0, replies: 0, hidden: false });
    expect(await world.audits()).toEqual([["repository.comments_purged", String(world.open.id)]]);
    expect(await ledger(world)).toEqual([]);
    expect(world.storage.alarm).toBeNull();
  });

  it("purges every repository of an installation GitHub no longer has", async () => {
    const world = await convexWorld();
    world.github.installations.delete(world.installation.id);
    await world.deliver("installation", { action: "deleted" });
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    expect((await world.comments()).threads).toBe(0);
    expect(world.logs.filter(entry => entry.event === "access.purge").map(entry => entry.fields)).toEqual([{ confirmed: 3, content: 0, restored: 0, postponed: 0 }]);
  });

  it("postpones the purge while GitHub cannot answer, backing off, and purges once it can", async () => {
    const world = await convexWorld();
    await world.removeFromInstallation();
    world.github.fault(/^\/repos\//, () => new Response("down", { status: 502 }), 4);
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    expect(await world.comments()).toEqual({ threads: 1, replies: 1, hidden: true });
    // Asked again after 15 minutes, then 30 (counted from the alarm; the client's own retry pauses move the clock a little).
    expect(await retry(world)).toEqual({ attempts: 1, delay: PURGE_RETRY_MS });
    await world.advance(PURGE_RETRY_MS);
    expect(await retry(world)).toEqual({ attempts: 2, delay: 2 * PURGE_RETRY_MS });
    expect((await world.comments()).threads).toBe(1);
    // Minting tokens fails too: still nothing.
    world.tokens.invalidate(world.installation.id);
    (world.tokens as ReturnType<typeof mintedInstallationTokens>).fail = new Error("Key unavailable");
    await world.advance(2 * PURGE_RETRY_MS);
    expect((await world.comments()).threads).toBe(1);
    (world.tokens as ReturnType<typeof mintedInstallationTokens>).fail = null;
    await world.advance(4 * PURGE_RETRY_MS);
    expect((await world.comments()).threads).toBe(0);
  });

  it("restores a repository reinstalled within the window as soon as GitHub confirms it, and a later removal starts a new window", async () => {
    const world = await convexWorld();
    await world.removeFromInstallation();
    await world.advance(10 * 24 * 60 * 60_000);
    world.installation.repositories = "all";
    await world.deliver("installation_repositories", { action: "added", repositories_added: [world.github.repoJson(world.open)] });
    // The next read asks GitHub about the repository, which also cancels the purge.
    expect(await world.read(null, world.open)).toMatchObject({ id: world.open.id });
    expect(await ledger(world)).toEqual([]);
    await world.advance(0);
    expect(await world.comments()).toEqual({ threads: 1, replies: 1, hidden: false });
    expect(await world.audits()).toEqual([["repository.removal_reverted", String(world.open.id)]]);
    // Removed again ten days later: the window counts from this removal.
    await world.advance(10 * 24 * 60 * 60_000);
    const removedAgain = world.clock.time;
    await world.removeFromInstallation();
    await world.advance(REMOVAL_PURGE_DELAY_MS - 20 * 24 * 60 * 60_000);
    expect((await world.comments()).threads).toBe(1);
    await world.advance(removedAgain + REMOVAL_PURGE_DELAY_MS - world.clock.time);
    expect((await world.comments()).threads).toBe(0);
  });

  it("restores a repository reinstalled within the window that nobody read, when the window ends", async () => {
    const world = await convexWorld();
    await world.removeFromInstallation();
    await world.advance(5 * 24 * 60 * 60_000);
    world.installation.repositories = "all";
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    expect(await world.comments()).toEqual({ threads: 1, replies: 1, hidden: false });
  });
});

/** Convex as the directory sees it, scripted: every call recorded, any of them made to fail or answer differently. */
class ScriptedSink implements CommentAccessSink {
  readonly calls: Array<[string, number[]]> = [];
  failRevoke = false;
  failRemove = false;
  failRestore = false;
  failPurge = false;
  notDue: PurgeAnswer["notDue"] = [];
  onPurge: (() => Promise<void>) | null = null;

  revoke(): Promise<void> {
    return this.failRevoke ? Promise.reject(new Error("Convex down")) : Promise.resolve();
  }

  removeRepos(repoIds: number[]): Promise<void> {
    if (this.failRemove) return Promise.reject(new Error("Convex down"));
    this.calls.push(["remove", repoIds]);
    return Promise.resolve();
  }

  restoreRepos(repoIds: number[]): Promise<void> {
    if (this.failRestore) return Promise.reject(new Error("Convex down"));
    this.calls.push(["restore", repoIds]);
    return Promise.resolve();
  }

  async purgeRepos(repoIds: number[]): Promise<PurgeAnswer> {
    await this.onPurge?.();
    if (this.failPurge) throw new Error("Convex down");
    this.calls.push(["purge", repoIds]);
    return { notDue: this.notDue };
  }
}

async function scriptedWorld() {
  const sink = new ScriptedSink();
  const world = accessFixture({ comments: sink, installationTokens: mintedInstallationTokens });
  await world.setup();
  const removeFromInstallation = (...repos: Array<typeof world.open>) => {
    world.installation.repositories = new Set([world.open.id, world.closed.id, world.teamDocs.id].filter(id => !repos.some(repo => repo.id === id)));
    return world.deliver("installation_repositories", { action: "removed", repositories_removed: repos.map(repo => world.github.repoJson(repo)) });
  };
  const advance = async (ms: number) => {
    world.clock.time += ms;
    await fire(world);
  };
  return { ...world, sink, removeFromInstallation, advance };
}

async function untilHeld(world: World): Promise<void> {
  while (world.github.held === 0) await new Promise(resolve => setImmediate(resolve));
}

describe("the purge ledger", () => {
  it("keeps the first removal's time when a removal repeats", async () => {
    const world = await scriptedWorld();
    await world.removeFromInstallation(world.open);
    const [first] = await ledger(world);
    await world.advance(60_000);
    await world.deliver("repository", { action: "deleted", ...world.repoPayload(world.open) });
    expect(await ledger(world)).toEqual([first]);
  });

  it("waits for Convex's own window when Convex heard of the removal later", async () => {
    const world = await scriptedWorld();
    await world.removeFromInstallation(world.open);
    const later = world.clock.time + REMOVAL_PURGE_DELAY_MS + 60_000;
    world.sink.notDue = [{ repoId: world.open.id, dueAt: later }];
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    expect(await ledger(world)).toEqual([{ repoId: world.open.id, dueAt: later, attempts: 0 }]);
    expect(world.storage.alarm).toBe(later);
    world.sink.notDue = [];
    world.github.resetLog();
    await world.advance(60_000);
    // Confirmed with GitHub again, not from the earlier answer.
    expect(world.github.count("repository")).toBe(1);
    expect(world.sink.calls.filter(call => call[0] === "purge")).toEqual([["purge", [world.open.id]], ["purge", [world.open.id]]]);
    expect(await ledger(world)).toEqual([]);
  });

  it("confirms again after Convex failed to purge, and waits while Convex has not heard of the removal", async () => {
    const world = await scriptedWorld();
    world.sink.failRemove = true;
    await world.removeFromInstallation(world.open);
    world.sink.failPurge = true;
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    // The removal never reached Convex: nothing is asked of it yet.
    expect(world.sink.calls).toEqual([]);
    expect(await ledger(world)).toMatchObject([{ attempts: 1 }]);
    world.sink.failRemove = false;
    await world.advance(PURGE_RETRY_MS);
    expect(world.sink.calls).toEqual([["remove", [world.open.id]]]);
    expect(await ledger(world)).toMatchObject([{ attempts: 2 }]);
    world.sink.failPurge = false;
    world.github.resetLog();
    await world.advance(2 * PURGE_RETRY_MS);
    expect(world.github.count("repository")).toBe(1);
    expect(world.sink.calls.at(-1)).toEqual(["purge", [world.open.id]]);
  });

  it("caps the back-off at a day", async () => {
    const world = await scriptedWorld();
    await world.removeFromInstallation(world.open);
    const [entry] = await ledger(world);
    await world.storage.delete([...(await world.storage.list({ prefix: "purge:" })).keys()]);
    await world.storage.put(`purge:${String(entry.dueAt).padStart(16, "0")}:${entry.repoId}`, { ...entry, attempts: 30 });
    world.github.fault(/^\/repos\//, () => new Response("down", { status: 502 }), 2);
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    expect(await retry(world)).toEqual({ attempts: 31, delay: PURGE_RETRY_MAX_MS });
  });

  it("asks again later when an event lands while GitHub answers", async () => {
    const world = await scriptedWorld();
    await world.removeFromInstallation(world.open);
    world.clock.time += REMOVAL_PURGE_DELAY_MS;
    let release = () => {};
    world.github.gate = new Promise(resolve => { release = resolve; });
    world.github.gateFilter = endpoint => endpoint === "repository";
    const alarm = world.directory.alarm();
    await untilHeld(world);
    await world.deliver("repository", { action: "privatized", ...world.repoPayload(world.open) });
    world.github.gate = null;
    release();
    await alarm;
    expect(world.sink.calls.filter(call => call[0] === "purge")).toEqual([]);
    expect(await ledger(world)).toMatchObject([{ attempts: 1 }]);
  });

  it("drops a confirmation the ledger no longer asks for", async () => {
    const world = await scriptedWorld();
    await world.removeFromInstallation(world.open);
    world.clock.time += REMOVAL_PURGE_DELAY_MS;
    let release = () => {};
    world.github.gate = new Promise(resolve => { release = resolve; });
    world.github.gateFilter = endpoint => endpoint === "repository";
    const alarm = world.directory.alarm();
    await untilHeld(world);
    // Cancelled meanwhile (as a GitHub-confirmed read does).
    await world.storage.delete([`purging:${world.open.id}`]);
    world.github.gate = null;
    release();
    await alarm;
    expect(world.sink.calls.filter(call => call[0] === "purge")).toEqual([]);
  });

  it("keeps what replaced an entry while Convex purged", async () => {
    const world = await scriptedWorld();
    await world.removeFromInstallation(world.open);
    const later = { repoId: world.open.id, dueAt: world.clock.time + 2 * REMOVAL_PURGE_DELAY_MS, attempts: 0 };
    world.sink.onPurge = async () => {
      // Rescheduled meanwhile, as a newer decision would.
      world.sink.onPurge = null;
      const key = `purge:${String(later.dueAt).padStart(16, "0")}:${later.repoId}`;
      await world.storage.delete([await world.storage.get<string>(`purging:${later.repoId}`) as string]);
      await world.storage.put(key, later);
      await world.storage.put(`purging:${later.repoId}`, key);
    };
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    expect(await ledger(world)).toEqual([later]);
  });

  it("restores a repository whose installation the registry never saw", async () => {
    const world = await scriptedWorld();
    const elsewhere = world.github.install("elsewhere", { id: 72 });
    const repo = world.github.repo("elsewhere", "docs", { id: 999 });
    await world.apply({ repos: { change: "remove", hints: [{ id: repo.id, owner: "elsewhere", name: "docs", private: false }], installation: elsewhere.id }, revoke: false });
    await world.advance(REMOVAL_PURGE_DELAY_MS);
    expect(world.sink.calls.at(-1)).toEqual(["restore", [repo.id]]);
    expect(await world.storage.get(`inst:${elsewhere.id}`)).toBeUndefined();
  });

  it("keeps the newer of a removal and a restore, so Convex hears only the last", async () => {
    const world = await scriptedWorld();
    world.sink.failRemove = true;
    world.sink.failRestore = true;
    await world.removeFromInstallation(world.open);
    world.installation.repositories = "all";
    await world.deliver("installation_repositories", { action: "added", repositories_added: [world.github.repoJson(world.open)] });
    expect(await world.read(null, world.open)).toMatchObject({ id: world.open.id });
    expect([await world.storage.get(`removed:${world.open.id}`), await world.storage.get(`restore:${world.open.id}`)]).toEqual([undefined, 1]);
    await world.removeFromInstallation(world.open);
    expect([await world.storage.get(`removed:${world.open.id}`), await world.storage.get(`restore:${world.open.id}`)]).toEqual([1, undefined]);
    world.sink.failRemove = false;
    world.sink.failRestore = false;
    await world.advance(10_000);
    expect(world.sink.calls).toEqual([["remove", [world.open.id]]]);
  });

  it("drains full restore batches at once", async () => {
    const world = await scriptedWorld();
    for (let index = 0; index < 100; index += 1) await world.storage.put(`restore:${index + 1}`, 1);
    world.storage.alarms.length = 0;
    await world.directory.flushEpochs();
    expect(world.storage.alarms).toEqual([world.clock.time]);
  });

  it("never lets a later purge push back an alarm the outbox needs sooner", async () => {
    const world = await scriptedWorld();
    await world.removeFromInstallation(world.open);
    world.sink.failRevoke = true;
    world.sink.failPurge = true;
    world.clock.time += REMOVAL_PURGE_DELAY_MS;
    await world.apply({ users: [world.people.member.id], revoke: true });
    world.storage.alarm = null;
    await world.directory.alarm();
    // Epochs retry in 10 s; the postponed purge (15 min) does not replace that.
    expect(world.storage.alarm).toBe(world.clock.time + 10_000);
  });

  it("works through a backlog a batch at a time", async () => {
    const world = await scriptedWorld();
    const dueAt = world.clock.time;
    for (let index = 0; index <= PURGE_BATCH; index += 1) {
      const repoId = 10_000 + index;
      await world.storage.put(`repo:${repoId}`, { id: repoId, owner: "octo", name: `gone-${index}`, private: false, defaultBranch: "main", installation: world.installation.id, removed: true, check: false, seq: 0 });
      const key = `purge:${String(dueAt).padStart(16, "0")}:${repoId}`;
      await world.storage.put(key, { repoId, dueAt, attempts: 0 });
      await world.storage.put(`purging:${repoId}`, key);
    }
    world.sink.failRevoke = true;
    await world.apply({ users: [world.people.member.id], revoke: true });
    world.storage.alarm = null;
    await world.directory.alarm();
    // One left over and already due: sooner than the outbox's retry.
    expect(world.storage.alarm).toBe(dueAt);
    expect(world.sink.calls.filter(call => call[0] === "purge")).toEqual([["purge", Array.from({ length: PURGE_BATCH }, (_, index) => 10_000 + index)]]);
  });
});
