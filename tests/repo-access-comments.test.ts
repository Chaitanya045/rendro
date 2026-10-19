import { describe, expect, it } from "vitest";
import { convexCommentSink } from "../src/repo-access/comments";
import type { CommentAccessSink, PurgeAnswer } from "../src/repo-access/directory";
import { accessFixture } from "./helpers/repo-access-fixture";

/** Convex's comment grants as the directory sees them (#254): every call, in order, with a switch to fail. */
class RecordingSink implements CommentAccessSink {
  readonly calls: Array<["revoke", string, number] | ["remove" | "restore" | "purge", number[]]> = [];
  fail = false;
  constructor(private readonly order: string[] = []) {}

  revoke(userId: string, epoch: number): Promise<void> {
    if (this.fail) return Promise.reject(new Error("Convex down"));
    this.order.push(`convex:${userId}`);
    this.calls.push(["revoke", userId, epoch]);
    return Promise.resolve();
  }

  removeRepos(repoIds: number[]): Promise<void> {
    if (this.fail) return Promise.reject(new Error("Convex down"));
    this.calls.push(["remove", [...repoIds].sort((a, b) => a - b)]);
    return Promise.resolve();
  }

  restoreRepos(repoIds: number[]): Promise<void> {
    this.calls.push(["restore", repoIds]);
    return Promise.resolve();
  }

  purgeRepos(repoIds: number[]): Promise<PurgeAnswer> {
    this.calls.push(["purge", repoIds]);
    return Promise.resolve({ notDue: [] });
  }
}

async function world(sink = new RecordingSink()) {
  const fixture = accessFixture({ comments: sink });
  await fixture.setup();
  sink.calls.length = 0;
  return { ...fixture, sink };
}

describe("comment access follows the epoch outbox (#254)", () => {
  it("tells Convex the very epoch KV holds, after KV, when a reader loses access", async () => {
    const order: string[] = [];
    const sink = new RecordingSink(order);
    const fixture = await world(sink);
    order.length = 0;
    fixture.kv.beforePut = (key) => void order.push(`kv:${key.slice("epoch:".length)}`);
    fixture.team.members.delete(fixture.people.member.id);
    await fixture.deliver("membership", { action: "removed", member: fixture.userPayload(fixture.people.member) });
    expect(sink.calls).toEqual([["revoke", fixture.userIds.member, fixture.kv.epoch(fixture.userIds.member)]]);
    expect(order).toEqual([`kv:${fixture.userIds.member}`, `convex:${fixture.userIds.member}`]);
    expect((await fixture.storage.list({ prefix: "notify:" })).size).toBe(0);
  });

  it("retries Convex from the alarm without writing KV again", async () => {
    const fixture = await world();
    fixture.sink.fail = true;
    await fixture.apply({ users: [fixture.people.member.id], revoke: true });
    const puts = fixture.kv.puts.length;
    const epoch = fixture.kv.epoch(fixture.userIds.member);
    expect(fixture.storage.alarm).toBe(fixture.clock.time + 10_000);
    expect(fixture.logs.some(entry => entry.event === "access.comments-failed")).toBe(true);
    expect(fixture.logs.some(entry => entry.event === "access.epochs-failed")).toBe(false);
    fixture.sink.fail = false;
    await fixture.directory.alarm();
    expect(fixture.kv.puts.length).toBe(puts);
    expect(fixture.sink.calls).toEqual([["revoke", fixture.userIds.member, epoch]]);
  });

  it("keeps a newer epoch queued while an older one is sent", async () => {
    const fixture = await world();
    const sink = fixture.sink;
    const original = sink.revoke.bind(sink);
    let raced = false;
    sink.revoke = async (userId, epoch) => {
      if (!raced) {
        raced = true;
        await fixture.storage.put(`notify:${userId}`, epoch + 1);
      }
      return original(userId, epoch);
    };
    await fixture.apply({ users: [fixture.people.member.id], revoke: true });
    expect(await fixture.storage.get(`notify:${fixture.userIds.member}`)).toBe(fixture.kv.epoch(fixture.userIds.member) + 1);
    await fixture.directory.alarm();
    expect(await fixture.storage.get(`notify:${fixture.userIds.member}`)).toBeUndefined();
  });

  it("drains full batches at once", async () => {
    const fixture = await world();
    for (let index = 0; index < 70; index += 1) await fixture.storage.put(`notify:bulk-${index}`, index);
    fixture.storage.alarms.length = 0;
    await fixture.directory.flushEpochs();
    expect(fixture.storage.alarms).toEqual([fixture.clock.time]);
    await fixture.directory.alarm();
    expect((await fixture.storage.list({ prefix: "notify:" })).size).toBe(0);
    for (let index = 0; index < 100; index += 1) await fixture.storage.put(`removed:${index + 1}`, 1);
    fixture.storage.alarms.length = 0;
    await fixture.directory.flushEpochs();
    expect(fixture.storage.alarms).toEqual([fixture.clock.time]);
  });

  it("removes every repository of an uninstalled or deleted installation", async () => {
    for (const plan of [
      (fixture: Awaited<ReturnType<typeof world>>) => fixture.deliver("installation", { action: "deleted" }),
      (fixture: Awaited<ReturnType<typeof world>>) => fixture.deliver("organization", { action: "deleted" }),
    ]) {
      const fixture = await world();
      // Another installation's repository stays.
      await fixture.storage.put("repo:999", { id: 999, owner: "elsewhere", name: "docs", private: false, defaultBranch: "main", installation: 72, removed: false, check: false, seq: 0 });
      fixture.github.installations.delete(fixture.installation.id);
      await plan(fixture);
      expect(fixture.sink.calls.filter(call => call[0] === "remove")).toEqual([["remove", [fixture.open.id, fixture.closed.id, fixture.teamDocs.id]]]);
    }
  });

  it("removes a repository taken out of the installation or deleted, and nothing for a suspension", async () => {
    const fixture = await world();
    await fixture.deliver("installation_repositories", { action: "removed", repositories_removed: [fixture.github.repoJson(fixture.closed)] });
    await fixture.deliver("repository", { action: "deleted", ...fixture.repoPayload(fixture.teamDocs) });
    expect(fixture.sink.calls.filter(call => call[0] === "remove")).toEqual([["remove", [fixture.closed.id]], ["remove", [fixture.teamDocs.id]]]);
    fixture.sink.calls.length = 0;
    await fixture.deliver("installation", { action: "suspend" });
    expect(fixture.sink.calls.filter(call => call[0] === "remove")).toEqual([]);
  });

  it("retries a failed removal from the alarm", async () => {
    const fixture = await world();
    fixture.sink.fail = true;
    await fixture.deliver("repository", { action: "deleted", ...fixture.repoPayload(fixture.open) });
    expect(await fixture.storage.get(`removed:${fixture.open.id}`)).toBe(1);
    fixture.sink.fail = false;
    await fixture.directory.alarm();
    expect(fixture.sink.calls.filter(call => call[0] === "remove")).toEqual([["remove", [fixture.open.id]]]);
    expect(await fixture.storage.get(`removed:${fixture.open.id}`)).toBeUndefined();
  });

  it("queues nothing for Convex where comments are not configured", async () => {
    const fixture = accessFixture();
    await fixture.setup();
    await fixture.apply({ users: [fixture.people.member.id], revoke: true });
    await fixture.deliver("installation", { action: "deleted" });
    expect((await fixture.storage.list({ prefix: "notify:" })).size).toBe(0);
    expect((await fixture.storage.list({ prefix: "removed:" })).size).toBe(0);
    expect((await fixture.storage.list({ prefix: "purge:" })).size).toBe(0);
  });
});

describe("convexCommentSink", () => {
  const url = "https://convex.rendro.test";
  function sink(answer: () => Response) {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: input as string, body: JSON.parse(init?.body as string) });
      return Promise.resolve(answer());
    }) as typeof fetch;
    return { requests, sink: convexCommentSink(url, "secret-value", fetcher) };
  }

  it("calls the internal-secret mutations", async () => {
    const { requests, sink: target } = sink(() => Response.json({ status: "success", value: null }));
    await expect(target.revoke("u", 7)).resolves.toBeUndefined();
    await expect(target.removeRepos([1, 2])).resolves.toBeUndefined();
    await expect(target.restoreRepos([3])).resolves.toBeUndefined();
    expect(requests).toEqual([
      { url: `${url}/api/mutation`, body: { path: "repoCommentAccess:revokeUser", args: [{ userId: "u", epoch: 7, internalSecret: "secret-value" }], format: "json" } },
      { url: `${url}/api/mutation`, body: { path: "repoCommentAccess:removeRepos", args: [{ repoIds: [1, 2], internalSecret: "secret-value" }], format: "json" } },
      { url: `${url}/api/mutation`, body: { path: "repoCommentAccess:restoreRepos", args: [{ repoIds: [3], internalSecret: "secret-value" }], format: "json" } },
    ]);
  });

  it("returns Convex's purge answer, and refuses one it cannot read", async () => {
    const notDue = [{ repoId: 4, dueAt: 1_000 }];
    const { requests, sink: target } = sink(() => Response.json({ status: "success", value: { notDue } }));
    expect(await target.purgeRepos([4, 5])).toEqual({ notDue });
    expect(requests).toEqual([
      { url: `${url}/api/mutation`, body: { path: "repoCommentAccess:purgeRepos", args: [{ repoIds: [4, 5], internalSecret: "secret-value" }], format: "json" } },
    ]);
    for (const value of [null, {}, { notDue: [null] }, { notDue: [{ repoId: 4 }] }, { notDue: [{ repoId: "4", dueAt: 1 }] }]) {
      await expect(sink(() => Response.json({ status: "success", value })).sink.purgeRepos([4])).rejects.toThrow("answered unexpectedly");
    }
  });

  it.each([
    ["an HTTP failure", () => new Response("down", { status: 500 })],
    ["a Convex error", () => Response.json({ status: "error", errorMessage: "Forbidden" })],
    ["an unreadable body", () => new Response("not json", { status: 200 })],
  ])("throws on %s so the outbox retries", async (_name, answer) => {
    await expect(sink(answer).sink.revoke("u", 1)).rejects.toThrow("repoCommentAccess:revokeUser");
  });
});
