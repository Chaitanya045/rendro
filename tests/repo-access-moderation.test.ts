import { describe, expect, it, vi } from "vitest";
import { RepoAccessUnavailable } from "../src/repo-read/access";
import { MAX_REPOSITORY_PAGES, MIRROR_TTL_MS, PUBLIC_CONFIRM_TTL_MS } from "../src/repo-access/directory";
import type { CommentAccessSink, PurgeAnswer } from "../src/repo-access/directory";
import type { FakeRole } from "./helpers/fake-github";
import { accessFixture } from "./helpers/repo-access-fixture";

/**
 * Moderation roles in the permission mirror (#259). GitHub's admin and maintain may moderate the comments of a
 * repository; write, triage and read may not. The role is recorded where read access is, so it is exactly as
 * current and ends with it (or sooner): by the mirror's TTL, or at once by the webhooks that revoke reads.
 */

class RecordingSink implements CommentAccessSink {
  readonly revoked: Array<[string, number]> = [];
  revoke(userId: string, epoch: number): Promise<void> {
    this.revoked.push([userId, epoch]);
    return Promise.resolve();
  }
  removeRepos(): Promise<void> {
    return Promise.resolve();
  }
  restoreRepos(): Promise<void> {
    return Promise.resolve();
  }
  purgeRepos(): Promise<PurgeAnswer> {
    return Promise.resolve({ notDue: [] });
  }
}

async function world() {
  const sink = new RecordingSink();
  const fixture = accessFixture({ comments: sink });
  await fixture.setup();
  const role = (person: keyof typeof fixture.people, repo: { owner: string; name: string }) => fixture.directory.moderationRole(fixture.userIds[person], repo.owner, repo.name);
  return { ...fixture, sink, role };
}

describe("who may moderate", () => {
  it("is an admin or a maintainer, never a writer, a triager or a reader", async () => {
    const w = await world();
    const expected: Array<[FakeRole, string | null]> = [["admin", "admin"], ["maintain", "maintain"], ["write", null], ["triage", null], ["read", null]];
    for (const [granted, answer] of expected) {
      w.closed.roles.set(w.people.reader.id, granted);
      w.clock.time += MIRROR_TTL_MS;
      expect(await w.role("reader", w.closed), granted).toBe(answer);
    }
  });

  it("keeps a role through an unchanged refresh, which GitHub answers with free 304s", async () => {
    const w = await world();
    w.closed.roles.set(w.people.reader.id, "admin");
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("reader", w.closed)).toBe("admin");
    w.github.resetLog();
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("reader", w.closed)).toBe("admin");
    expect(w.github.count("installation-repositories", { status: 304 })).toBeGreaterThan(0);
    expect(w.github.billable()).toBe(0);
  });

  it("follows a team's role and the strongest of several grants", async () => {
    const w = await world();
    expect(await w.role("member", w.teamDocs)).toBeNull();
    w.team.role = "maintain";
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("member", w.teamDocs)).toBe("maintain");
    w.teamDocs.roles.set(w.people.member.id, "admin");
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("member", w.teamDocs)).toBe("admin");
  });

  it("gives an owner of the account the admin role", async () => {
    const w = await world();
    const mine = w.github.repo("reader", "notes", { id: 810, private: true });
    w.github.install("reader", { id: 72 });
    await w.apply({ installation: { id: 72, account: "reader", state: "active" }, repos: { change: "confirm", hints: [{ id: mine.id, owner: "reader", name: "notes", private: true }], installation: 72 }, revoke: false });
    expect(await w.role("reader", mine)).toBe("admin");
  });

  it("answers for public repositories too, which a read decision settles without the mirror", async () => {
    const w = await world();
    w.open.roles.set(w.people.reader.id, "maintain");
    w.clock.time += MIRROR_TTL_MS;
    w.github.resetLog();
    expect(await w.role("reader", w.open)).toBe("maintain");
    // The stale mirror was listed again for it.
    expect(w.github.count("installation-repositories")).toBeGreaterThan(0);
    // A reader with no explicit role on a public repository has none, and nobody is asked twice within the TTL.
    w.github.resetLog();
    expect(await w.role("outsider", w.open)).toBeNull();
    expect(await w.role("outsider", w.open)).toBeNull();
    expect(await w.role("reader", w.open)).toBe("maintain");
    expect(w.github.billable()).toBeLessThanOrEqual(2);
  });

  it("has no role for what the viewer cannot read, is not linked to GitHub, or does not exist", async () => {
    const w = await world();
    w.closed.roles.set(w.people.outsider.id, "admin");
    // Before the outsider's mirror lists it, read access is what GitHub's list says: the roles come with that list.
    expect(await w.role("member", w.closed)).toBeNull();
    expect(await w.directory.moderationRole(w.userIds.reader, "octo", "missing")).toBeNull();
    expect(await w.directory.moderationRole("user-unknown", "octo", "closed-docs")).toBeNull();
    await w.directory.forget(w.userIds.reader);
    expect(await w.role("reader", w.closed)).toBeNull();
  });

  it("reads a role through the single-repository check when an installation is listed only in part, and caches it like the mirror", async () => {
    const w = await world();
    const many = Array.from({ length: MAX_REPOSITORY_PAGES * 100 + 5 }, (_, index) => {
      const repo = w.github.repo("octo", `bulk-${index}`, { id: 10_000 + index, private: true });
      repo.collaborators.add(w.people.outsider.id);
      return repo;
    });
    const last = many[many.length - 1];
    last.roles.set(w.people.outsider.id, "maintain");
    await w.deliver("installation_repositories", { action: "added", repositories_added: [w.github.repoJson(last)] });
    w.github.resetLog();
    expect(await w.role("outsider", last)).toBe("maintain");
    expect(await w.role("outsider", last)).toBe("maintain");
    expect(w.github.count("permission")).toBe(1);
    // A check older than the TTL is made again, and a demotion shows.
    last.roles.set(w.people.outsider.id, "write");
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("outsider", last)).toBeNull();
    // A reader the check does not know has no role, whatever the check said before.
    last.collaborators.delete(w.people.outsider.id);
    last.roles.delete(w.people.outsider.id);
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("outsider", last)).toBeNull();
    // A repository listed in a mirror that is not partial and not in it gives nothing.
    expect(await w.role("outsider", w.closed)).toBeNull();
  });

  it("ignores a stored check that predates roles, and any stored value that is not a literal role", async () => {
    const w = await world();
    const many = Array.from({ length: MAX_REPOSITORY_PAGES * 100 + 1 }, (_, index) => {
      const repo = w.github.repo("octo", `bulk-${index}`, { id: 10_000 + index, private: true });
      repo.collaborators.add(w.people.outsider.id);
      return repo;
    });
    const last = many[many.length - 1];
    await w.deliver("installation_repositories", { action: "added", repositories_added: [w.github.repoJson(last)] });
    last.roles.set(w.people.outsider.id, "admin");
    expect(await w.role("outsider", last)).toBe("admin");
    const key = `check:${w.userIds.outsider}:${last.id}`;
    const stored = await w.storage.get<{ allowed: boolean; at: number; gen: number; role?: string }>(key);
    await w.storage.put(key, { allowed: stored!.allowed, at: stored!.at, gen: stored!.gen });
    expect(await w.role("outsider", last)).toBeNull();
    await w.storage.put(key, { ...stored, allowed: false });
    expect(await w.role("outsider", last)).toBeNull();
    // A mirror page whose roles are not literals (corrupted storage) grants no role either.
    w.closed.roles.set(w.people.reader.id, "admin");
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("reader", w.closed)).toBe("admin");
    const mirrorKey = `mirror:${w.userIds.reader}`;
    const mirror = await w.storage.get<{ repoPages: Record<string, Array<{ roles?: Record<string, string> }>> }>(mirrorKey);
    for (const pages of Object.values(mirror!.repoPages)) for (const page of pages) page.roles = Object.fromEntries(Object.keys(page.roles ?? {}).map((id) => [id, "owner"]));
    await w.storage.put(mirrorKey, mirror);
    expect(await w.role("reader", w.closed)).toBeNull();
  });
});

describe("a role ends with read access, or sooner", () => {
  it("is withdrawn at once by the webhook that changes a collaborator's role, and the grant epoch moves", async () => {
    const w = await world();
    w.closed.roles.set(w.people.reader.id, "admin");
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("reader", w.closed)).toBe("admin");
    w.sink.revoked.length = 0;
    w.kv.puts.length = 0;
    w.clock.time += 1_000;
    w.closed.roles.set(w.people.reader.id, "write");
    await w.deliver("member", { action: "edited", member: w.userPayload(w.people.reader), ...w.repoPayload(w.closed) });
    // Within the same second, well before the TTL: the mirror was invalidated, so it is listed again.
    expect(await w.role("reader", w.closed)).toBeNull();
    expect(await w.read("reader", w.closed)).not.toBeNull();
    // Convex heard the epoch KV holds, which deletes every grant the reader held, moderation included.
    expect(w.sink.revoked).toEqual([[w.userIds.reader, w.kv.epoch(w.userIds.reader)]]);
    expect(w.kv.epoch(w.userIds.reader)).toBeGreaterThan(0);
  });

  it("is withdrawn by a team losing the repository or its role, and by leaving the team", async () => {
    const w = await world();
    w.team.role = "admin";
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("member", w.teamDocs)).toBe("admin");
    w.team.role = "read";
    await w.deliver("team", { action: "edited", team: { id: 1 }, ...w.repoPayload(w.teamDocs) });
    expect(await w.role("member", w.teamDocs)).toBeNull();
    w.team.role = "maintain";
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("member", w.teamDocs)).toBe("maintain");
    w.team.members.delete(w.people.member.id);
    await w.deliver("membership", { action: "removed", member: w.userPayload(w.people.member) });
    expect(await w.role("member", w.teamDocs)).toBeNull();
    expect(await w.read("member", w.teamDocs)).toBeNull();
  });

  it("without any webhook, a downgrade is seen no later than a read revocation is", async () => {
    const downgraded = await world();
    const revoked = await world();
    for (const w of [downgraded, revoked]) {
      w.closed.roles.set(w.people.reader.id, "admin");
      w.clock.time += MIRROR_TTL_MS;
      expect(await w.role("reader", w.closed)).toBe("admin");
    }
    downgraded.closed.roles.set(downgraded.people.reader.id, "read");
    revoked.closed.collaborators.delete(revoked.people.reader.id);
    revoked.closed.roles.delete(revoked.people.reader.id);
    let roleEnded = Infinity;
    let readEnded = Infinity;
    for (let elapsed = 0; elapsed <= 2 * MIRROR_TTL_MS; elapsed += 30_000) {
      if (roleEnded === Infinity && await downgraded.role("reader", downgraded.closed) === null) roleEnded = elapsed;
      if (readEnded === Infinity && await revoked.read("reader", revoked.closed) === null) readEnded = elapsed;
      downgraded.clock.time += 30_000;
      revoked.clock.time += 30_000;
    }
    expect(roleEnded).toBeLessThanOrEqual(MIRROR_TTL_MS);
    expect(roleEnded).toBeLessThanOrEqual(readEnded);
  });

  it("is withdrawn when the user's tokens are revoked, or the repository leaves the app", async () => {
    const w = await world();
    w.closed.roles.set(w.people.reader.id, "admin");
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("reader", w.closed)).toBe("admin");
    await w.deliver("installation_repositories", { action: "removed", repositories_removed: [w.github.repoJson(w.closed)] });
    expect(await w.role("reader", w.closed)).toBeNull();
    await w.apply({ unauthorize: w.people.member.id, revoke: true });
    expect(await w.role("member", w.teamDocs)).toBeNull();
  });
});

describe("failing closed", () => {
  it("503s while GitHub cannot refresh the mirror, and never answers from an expired one", async () => {
    const w = await world();
    w.closed.roles.set(w.people.reader.id, "admin");
    w.clock.time += MIRROR_TTL_MS;
    expect(await w.role("reader", w.closed)).toBe("admin");
    w.clock.time += MIRROR_TTL_MS;
    w.github.fault(/\/user\/installations/, () => new Response("down", { status: 500 }), 4);
    await expect(w.role("reader", w.closed)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(w.logs.some((entry) => entry.event === "access.unavailable")).toBe(true);
  });

  it("503s when webhooks keep overtaking every refresh", async () => {
    const w = await world();
    // A public repository is read without the mirror, so only the role lookup asks for a fresh one.
    w.clock.time += MIRROR_TTL_MS - PUBLIC_CONFIRM_TTL_MS + 1;
    await w.read("reader", w.open);
    w.clock.time += PUBLIC_CONFIRM_TTL_MS;
    await w.read(null, w.open);
    const refresh = vi.spyOn(w.directory as unknown as { refreshMirror(): Promise<null> }, "refreshMirror").mockResolvedValue(null);
    await expect(w.role("reader", w.open)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(refresh).toHaveBeenCalledTimes(6);
  });

  it("has no role for a user who is not linked, or whose tokens are gone, even on a public repository", async () => {
    const w = await world();
    expect(await w.directory.moderationRole("user-unknown", "octo", "open-docs")).toBeNull();
    await w.directory.forget(w.userIds.reader);
    expect(await w.role("reader", w.open)).toBeNull();
  });

  it("decides again from fresh state when a webhook lands between the read decision and the role, and 503s when GitHub fails then", async () => {
    const many = (w: Awaited<ReturnType<typeof world>>) => {
      const bulk = Array.from({ length: MAX_REPOSITORY_PAGES * 100 + 1 }, (_, index) => {
        const repo = w.github.repo("octo", `bulk-${index}`, { id: 10_000 + index, private: true });
        repo.collaborators.add(w.people.outsider.id);
        return repo;
      });
      return bulk[bulk.length - 1];
    };
    const w = await world();
    const last = many(w);
    await w.deliver("installation_repositories", { action: "added", repositories_added: [w.github.repoJson(last)] });
    last.roles.set(w.people.outsider.id, "maintain");
    const authorize = w.directory.authorize.bind(w.directory);
    let overtake: (() => Promise<unknown>) | null = async () => w.deliver("membership", { action: "added", member: w.userPayload(w.people.outsider) });
    vi.spyOn(w.directory, "authorize").mockImplementation(async (...args) => {
      const repo = await authorize(...args);
      const run = overtake;
      overtake = null;
      await run?.();
      return repo;
    });
    // The mirror and the check the read decision made are from before the webhook: both are made again.
    w.github.resetLog();
    expect(await w.role("outsider", last)).toBe("maintain");
    expect(w.github.count("permission")).toBe(2);
    vi.restoreAllMocks();

    const failing = await world();
    const last2 = many(failing);
    await failing.deliver("installation_repositories", { action: "added", repositories_added: [failing.github.repoJson(last2)] });
    const authorizeFailing = failing.directory.authorize.bind(failing.directory);
    let again: (() => Promise<unknown>) | null = async () => {
      await failing.deliver("membership", { action: "added", member: failing.userPayload(failing.people.outsider) });
      failing.github.fault(/permission$/, () => new Response("down", { status: 500 }), 2);
    };
    vi.spyOn(failing.directory, "authorize").mockImplementation(async (...args) => {
      const repo = await authorizeFailing(...args);
      const run = again;
      again = null;
      await run?.();
      return repo;
    });
    await expect(failing.role("outsider", last2)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(failing.logs.some((entry) => entry.event === "access.unavailable" && entry.fields.reason === "server")).toBe(true);
    vi.restoreAllMocks();
    // Anything else that goes wrong is unavailable too, and logged as a plain error.
    const broken = await world();
    broken.clock.time += 2 * MIRROR_TTL_MS;
    await broken.read(null, broken.open);
    vi.spyOn(broken.directory as unknown as { refreshMirror(): Promise<null> }, "refreshMirror").mockRejectedValue(new Error("boom"));
    await expect(broken.role("reader", broken.open)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(broken.logs.some((entry) => entry.event === "access.unavailable" && entry.fields.reason === "error")).toBe(true);
  });

  it("serves roles through the directory's protocol, 503 when unavailable", async () => {
    const w = await world();
    w.closed.roles.set(w.people.reader.id, "maintain");
    w.clock.time += MIRROR_TTL_MS;
    const ask = (viewer: string, name: string) => w.directory.fetch(new Request("https://directory/moderation", { method: "POST", body: JSON.stringify({ viewer, owner: "octo", name }) }));
    const answer = await ask(w.userIds.reader, "closed-docs");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ role: "maintain" });
    expect(await (await ask(w.userIds.member, "closed-docs")).json()).toEqual({ role: null });
    w.clock.time += MIRROR_TTL_MS;
    w.github.fault(/\/user\/installations/, () => new Response("down", { status: 500 }), 4);
    expect((await ask(w.userIds.reader, "closed-docs")).status).toBe(503);
  });
});
