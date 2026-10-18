import { describe, expect, it, vi } from "vitest";
import { GitHubError } from "../src/ingest/github/source";
import { RepoAccessUnavailable } from "../src/repo-read/access";
import { EPOCH_TTL_SECONDS, FAILURE_COOLDOWN_MS, MAX_REPOSITORY_PAGES, MIRROR_TTL_MS } from "../src/repo-access/directory";
import { openTokens, sealTokens, type TokenRefresher } from "../src/repo-access/tokens";
import { accessFixture, TOKEN_KEY } from "./helpers/repo-access-fixture";

/**
 * The permission mirror and revocation epochs (#243) against a fake GitHub:
 * who may read what, how webhooks revoke it (mirror first, then the epoch),
 * and that every doubt is a 503 or a denial, never a stale grant.
 */

const revoked = (world: { kv: { puts: Array<{ key: string }> } }) => world.kv.puts.map((put) => put.key.slice("epoch:".length)).sort();

const record = (repo: { id: number; owner: string; name: string; isPrivate: boolean }) =>
  ({ id: repo.id, owner: repo.owner, name: repo.name, private: repo.isPrivate, defaultBranch: "main" });

describe("answers from the registry and the mirror", () => {
  it("lets anyone read a public repository, and only readers a private one", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read(null, world.open)).toEqual(record(world.open));
    expect(await world.read("outsider", world.open)).toEqual(record(world.open));
    expect(await world.read(null, world.closed)).toBeNull();
    expect(await world.read("reader", world.closed)).toEqual(record(world.closed));
    expect(await world.read("member", world.closed)).toBeNull();
    expect(await world.read("member", world.teamDocs)).toEqual(record(world.teamDocs));
    expect(await world.read("outsider", world.closed)).toBeNull();
    // Names match GitHub's case-insensitively; unknown names and unlinked users are denials, not errors.
    expect(await world.directory.authorize(world.userIds.reader, "OCTO", "Closed-Docs")).toEqual(record(world.closed));
    expect(await world.directory.authorize(world.userIds.reader, "octo", "missing")).toBeNull();
    expect(await world.directory.authorize("user-unknown", "octo", "closed-docs")).toBeNull();
  });

  it("never calls GitHub per view: a mirror answers until its TTL, then a free conditional refresh", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("reader", world.closed)).not.toBeNull();
    expect(await world.read("reader", world.teamDocs)).toBeNull();
    const first = world.github.requests.length;
    expect(first).toBeGreaterThan(0);
    for (let view = 0; view < 20; view += 1) {
      expect(await world.read("reader", world.closed)).not.toBeNull();
      expect(await world.read("reader", world.teamDocs)).toBeNull();
    }
    expect(world.github.requests.length).toBe(first);
    world.clock.time += MIRROR_TTL_MS;
    world.github.resetLog();
    expect(await world.read("reader", world.closed)).not.toBeNull();
    // Installations and repositories both answer 304: no primary quota spent.
    expect(world.github.requests.map((request) => [request.endpoint, request.status])).toEqual([["user-installations", 304], ["installation-repositories", 304]]);
    expect(world.github.billable()).toBe(0);
  });

  it("denies a linked user whose GitHub account has no installation", async () => {
    const world = accessFixture();
    await world.setup();
    const stranger = world.github.user("stranger");
    await world.directory.link({ userId: "user-stranger", githubId: stranger.id, login: stranger.login, tokens: world.github.signIn(stranger) });
    expect(await world.directory.authorize("user-stranger", "octo", "closed-docs")).toBeNull();
    expect(await world.directory.authorize("user-stranger", "octo", "open-docs")).not.toBeNull();
  });

  it("learns repositories from a user's listing when no webhook announced them", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("reader", world.closed)).not.toBeNull();
    const quiet = world.github.repo("octo", "quiet-docs", { id: 804, private: true });
    quiet.collaborators.add(world.people.reader.id);
    expect(await world.read("reader", quiet)).toBeNull();
    world.clock.time += MIRROR_TTL_MS;
    expect(await world.read("reader", quiet)).toEqual(record(quiet));
    expect(await world.read("member", quiet)).toBeNull();
    // A public repository learned the same way is then open to everyone.
    const shown = world.github.repo("octo", "shown-docs", { id: 807 });
    shown.collaborators.add(world.people.reader.id);
    world.clock.time += MIRROR_TTL_MS;
    expect(await world.read("reader", shown)).toEqual(record(shown));
    expect(await world.read(null, shown)).toEqual(record(shown));
  });

  it("works before any webhook was ever applied", async () => {
    const world = accessFixture();
    const stranger = world.github.user("stranger");
    await world.directory.link({ userId: "user-stranger", githubId: stranger.id, login: stranger.login, tokens: world.github.signIn(stranger) });
    expect(await world.directory.authorize("user-stranger", "octo", "closed-docs")).toBeNull();
  });

  it("never asks GitHub on behalf of an anonymous reader of a repository recorded as private", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read(null, world.closed)).toBeNull();
    expect(world.github.requests.filter((request) => request.endpoint === "repository")).toEqual([]);
  });

  it("confirms a repository an event announced with GitHub before it grants anything", async () => {
    const world = accessFixture();
    await world.setup();
    // The installation event said nothing about default branches: the first view asked GitHub once per repository.
    world.github.resetLog();
    await world.deliver("installation_repositories", { action: "added", repositories_added: [{ id: 805, name: "new-docs", full_name: "octo/new-docs", private: false }] });
    const added = world.github.repo("octo", "new-docs", { id: 805 });
    added.defaultBranch = "trunk";
    expect(await world.read(null, added)).toEqual({ ...record(added), defaultBranch: "trunk" });
    // The installation is confirmed once (the "created" event announced it), then the repository.
    expect(world.github.requests.map((request) => request.endpoint)).toEqual(["installation", "repository"]);
    expect(await world.read(null, added)).not.toBeNull();
    expect(world.github.count("repository")).toBe(1);
  });
});

describe("webhooks update the mirror, then the epoch", () => {
  it("revokes a user removed from a team: the mirror denies before the epoch is written", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("member", world.teamDocs)).not.toBeNull();
    world.team.members.delete(world.people.member.id);
    const seen: Array<unknown> = [];
    world.kv.beforePut = async (key) => {
      if (key === `epoch:${world.userIds.member}`) seen.push(await world.read("member", world.teamDocs));
    };
    world.clock.time += 1_000;
    expect(await world.deliver("membership", { action: "removed", member: world.userPayload(world.people.member), team: { slug: "writers" } })).toBe("applied");
    expect(seen).toEqual([null]);
    expect(world.kv.epoch(world.userIds.member)).toBe(world.clock.time);
    expect(world.kv.puts).toEqual([{ key: `epoch:${world.userIds.member}`, value: String(world.clock.time), expirationTtl: EPOCH_TTL_SECONDS }]);
    expect(await world.read("member", world.teamDocs)).toBeNull();
    // Nobody else was touched.
    expect(await world.read("reader", world.closed)).not.toBeNull();
  });

  it("re-grants on additions without revoking anyone", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("outsider", world.teamDocs)).toBeNull();
    world.team.members.add(world.people.outsider.id);
    await world.deliver("membership", { action: "added", member: world.userPayload(world.people.outsider) });
    expect(await world.read("outsider", world.teamDocs)).not.toBeNull();
    expect(world.kv.puts).toEqual([]);
  });

  it("revokes a removed collaborator and an organization member who left", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("reader", world.closed)).not.toBeNull();
    world.closed.collaborators.delete(world.people.reader.id);
    await world.deliver("member", { action: "removed", member: world.userPayload(world.people.reader), ...world.repoPayload(world.closed) });
    expect(await world.read("reader", world.closed)).toBeNull();
    expect(revoked(world)).toEqual([world.userIds.reader]);

    expect(await world.read("member", world.teamDocs)).not.toBeNull();
    world.team.members.clear();
    await world.deliver("organization", { action: "member_removed", membership: { user: world.userPayload(world.people.member) }, organization: { login: "octo" } });
    expect(await world.read("member", world.teamDocs)).toBeNull();
    expect(revoked(world)).toEqual([world.userIds.member, world.userIds.reader]);
  });

  it("reaches everyone holding a repository when a team loses it, and the whole installation when a team is deleted", async () => {
    const world = accessFixture();
    await world.setup();
    for (const person of ["reader", "member", "outsider"] as const) await world.read(person, world.closed);
    world.team.repos.delete(world.teamDocs.id);
    await world.deliver("team", { action: "removed_from_repository", team: { slug: "writers" }, ...world.repoPayload(world.teamDocs) });
    // Only the member held team-docs.
    expect(world.kv.puts.map((put) => put.key)).toEqual([`epoch:${world.userIds.member}`]);
    expect(await world.read("member", world.teamDocs)).toBeNull();

    // The member now holds nothing in the installation; the outsider never did (no explicit access, so it is not listed for them).
    world.kv.puts.length = 0;
    await world.deliver("team", { action: "deleted", team: { slug: "writers" } });
    expect(revoked(world)).toEqual([world.userIds.reader]);
  });

  it("denies anonymous readers as soon as a repository is made private", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read(null, world.open)).not.toBeNull();
    world.open.isPrivate = true;
    await world.deliver("repository", { action: "privatized", ...world.repoPayload(world.open) });
    expect(await world.read(null, world.open)).toBeNull();
    expect(await world.read("outsider", world.open)).toBeNull();
    // Whoever GitHub lets read it still can, once their mirror shows it.
    world.open.collaborators.add(world.people.outsider.id);
    world.clock.time += MIRROR_TTL_MS;
    expect(await world.read("outsider", world.open)).toEqual(record(world.open));
    // Making public again is confirmed with GitHub first.
    world.open.isPrivate = false;
    await world.deliver("repository", { action: "publicized", ...world.repoPayload(world.open) });
    expect(await world.read(null, world.open)).toEqual(record(world.open));
  });

  it("treats a replayed 'publicized' body under a fresh delivery ID as a hint GitHub refutes", async () => {
    const world = accessFixture();
    await world.setup();
    const replayed = { action: "publicized", repository: { ...world.github.repoJson(world.closed), private: false } };
    await world.deliver("repository", replayed);
    expect(await world.read(null, world.closed)).toBeNull();
    expect(await world.read("reader", world.closed)).toEqual(record(world.closed));
  });

  it("ignores a replayed delivery", async () => {
    const world = accessFixture();
    await world.setup();
    world.team.members.delete(world.people.member.id);
    const payload = { action: "removed", member: world.userPayload(world.people.member) };
    expect(await world.deliver("membership", payload, "delivery-1")).toBe("applied");
    world.team.members.add(world.people.member.id);
    await world.deliver("membership", { action: "added", member: world.userPayload(world.people.member) }, "delivery-2");
    expect(await world.read("member", world.teamDocs)).not.toBeNull();
    world.kv.puts.length = 0;
    expect(await world.deliver("membership", payload, "delivery-1")).toBe("duplicate");
    expect(world.kv.puts).toEqual([]);
    expect(await world.read("member", world.teamDocs)).not.toBeNull();
  });

  it("denies everyone when the app is uninstalled or suspended", async () => {
    for (const action of ["deleted", "suspend"] as const) {
      const world = accessFixture();
      await world.setup();
      for (const person of ["reader", "member", "outsider"] as const) await world.read(person, world.closed);
      world.installation.suspended = action === "suspend";
      if (action === "deleted") world.github.installations.delete(world.installation.id);
      await world.deliver("installation", { action });
      expect(await world.read(null, world.open)).toBeNull();
      expect(await world.read("reader", world.closed)).toBeNull();
      expect(await world.read("member", world.teamDocs)).toBeNull();
      // Everyone the installation lists anything for; the outsider holds nothing there.
      expect(revoked(world)).toEqual([world.userIds.member, world.userIds.reader]);
    }
  });

  it("re-enables an installation only after GitHub confirms it", async () => {
    let refuse = false;
    const world = accessFixture({ installationTokens: { token: () => (refuse ? Promise.reject(new Error("installation suspended")) : Promise.resolve("fake-installation-token")), invalidate: () => {} } });
    await world.setup();
    await world.deliver("installation", { action: "suspend" });
    // A replayed "unsuspend": GitHub refuses the installation's token, so nothing is granted.
    refuse = true;
    await world.deliver("installation", { action: "unsuspend" });
    await expect(world.read(null, world.open)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    refuse = false;
    world.clock.time += FAILURE_COOLDOWN_MS;
    expect(await world.read(null, world.open)).not.toBeNull();
  });

  it("keeps a suspended installation closed when GitHub says so", async () => {
    let scoped = "";
    const world = accessFixture({ installationTokens: { token: () => Promise.resolve(scoped), invalidate: () => {} } });
    scoped = world.github.installationToken(world.installation);
    await world.setup();
    expect(await world.read(null, world.open)).not.toBeNull();
    world.installation.suspended = true;
    await world.deliver("installation", { action: "suspend" });
    // A replayed "unsuspend": GitHub answers the installation's own token with 403, so it stays closed.
    await world.deliver("installation", { action: "unsuspend" });
    expect(await world.read(null, world.open)).toBeNull();
    expect((await world.storage.get<{ state: string }>(`inst:${world.installation.id}`))?.state).toBe("suspended");
  });

  it("removes repositories taken out of the installation, for everyone holding them", async () => {
    const world = accessFixture();
    await world.setup();
    await world.read("reader", world.closed);
    world.installation.repositories = new Set([world.open.id, world.teamDocs.id]);
    await world.deliver("installation_repositories", { action: "removed", repositories_removed: [{ id: world.closed.id, name: "closed-docs", full_name: "octo/closed-docs", private: true }] });
    expect(await world.read("reader", world.closed)).toBeNull();
    expect(revoked(world)).toEqual([world.userIds.reader]);
  });

  it("forgets a user who revoked the app's authorization", async () => {
    const world = accessFixture();
    await world.setup();
    await world.read("reader", world.closed);
    world.github.revokeAuthorization(world.people.reader);
    await world.deliver("github_app_authorization", { action: "revoked", sender: world.userPayload(world.people.reader) });
    world.github.resetLog();
    expect(await world.read("reader", world.closed)).toBeNull();
    expect(await world.read("reader", world.open)).not.toBeNull();
    expect(revoked(world)).toEqual([world.userIds.reader]);
    expect(world.github.requests.filter((request) => request.authorization?.startsWith("Bearer ghu_"))).toHaveLength(0);
  });

  it("deletes and transfers repositories", async () => {
    const world = accessFixture();
    await world.setup();
    await world.read("reader", world.closed);
    world.github.repos.delete("octo/closed-docs");
    await world.deliver("repository", { action: "deleted", ...world.repoPayload(world.closed) });
    expect(await world.read("reader", world.closed)).toBeNull();
    expect(revoked(world)).toEqual([world.userIds.reader]);

    world.kv.puts.length = 0;
    await world.read("member", world.teamDocs);
    const moved = world.github.rename(world.teamDocs, "elsewhere", "team-docs");
    await world.deliver("repository", { action: "transferred", ...world.repoPayload(moved) });
    // The new owner has no installation of the app: nobody reads it through Rendro.
    expect(await world.read("member", moved)).toBeNull();
    expect(await world.directory.authorize(world.userIds.member, "octo", "team-docs")).toBeNull();
    expect(revoked(world)).toEqual([world.userIds.member]);
  });

  it("follows renames of a repository and of its organization", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("reader", world.closed)).not.toBeNull();
    const renamed = world.github.rename(world.closed, "octo", "handbook");
    renamed.collaborators.add(world.people.reader.id);
    await world.deliver("repository", { action: "renamed", ...world.repoPayload(renamed) });
    expect(await world.directory.authorize(world.userIds.reader, "octo", "closed-docs")).toBeNull();
    expect(await world.read("reader", renamed)).toEqual(record(renamed));

    // An organization rename: names move, and each repository is confirmed with GitHub (which redirects old paths).
    await world.apply({ repos: { change: "confirm", hints: [{ id: 950, owner: "other-org", name: "docs", private: null }], installation: 72 }, revoke: false });
    const installation = world.installation;
    installation.account = "octo-labs";
    const openMoved = world.github.rename(world.open, "octo-labs", "open-docs");
    await world.deliver("organization", { action: "renamed", organization: { login: "octo-labs" }, changes: { login: { from: "octo" } } });
    expect(await world.directory.authorize(null, "octo", "open-docs")).toBeNull();
    expect(await world.read(null, openMoved)).toEqual(record(openMoved));
    expect((await world.storage.get<{ owner: string; private: boolean }>("repo:950"))).toMatchObject({ owner: "other-org", private: true });
    // Its installation was never announced: nobody reads it.
    expect(await world.directory.authorize(null, "other-org", "docs")).toBeNull();
    // A hint without visibility or installation keeps what the registry knew.
    await world.apply({ repos: { change: "confirm", hints: [{ id: world.open.id, owner: "octo-labs", name: "open-docs", private: null }], installation: null }, revoke: false });
    expect(await world.storage.get(`repo:${world.open.id}`)).toMatchObject({ private: false, installation: world.installation.id, check: true });
  });

  it("closes an installation whose organization was deleted", async () => {
    const world = accessFixture();
    await world.setup();
    await world.read("reader", world.closed);
    await world.deliver("organization", { action: "deleted", organization: { login: "octo" } });
    expect(await world.storage.get(`inst:${world.installation.id}`)).toMatchObject({ account: "octo", state: "deleted" });
    expect(await world.read(null, world.open)).toBeNull();
    expect(revoked(world)).toEqual([world.userIds.reader]);
    await world.apply({ installation: { id: 999, account: null, state: "deleted" }, revoke: true });
    expect(await world.storage.get("inst:999")).toMatchObject({ account: null });
  });

  it("does not let a stale removal of an old repository shadow the live one that took its name", async () => {
    const world = accessFixture();
    await world.setup();
    await world.apply({ repos: { change: "remove", hints: [{ id: 999, owner: "octo", name: "open-docs", private: false }], installation: world.installation.id }, holders: [999], revoke: true });
    expect(await world.read(null, world.open)).toEqual(record(world.open));
    // Privatizing a repository the registry never saw changes nothing.
    await world.apply({ repos: { change: "privatize", hints: [{ id: 998, owner: "octo", name: "ghost", private: true }], installation: null }, revoke: false });
    expect(await world.storage.get("repo:998")).toBeUndefined();
  });

  it("marks a repository GitHub no longer shows the installation as removed", async () => {
    const world = accessFixture();
    await world.setup();
    world.github.repos.delete("octo/open-docs");
    await world.deliver("repository", { action: "edited", ...world.repoPayload(world.open) });
    expect(await world.read(null, world.open)).toBeNull();
    // Another repository now owns the name: the old record is retired, the new one is learned from a listing.
    const replacement = world.github.repo("octo", "open-docs", { id: 806 });
    await world.deliver("repository", { action: "edited", ...world.repoPayload(world.open) });
    expect(await world.read(null, world.open)).toBeNull();
    expect((await world.storage.get<{ removed: boolean }>(`repo:${world.open.id}`))?.removed).toBe(true);
    await world.deliver("repository", { action: "created", ...world.repoPayload(replacement) });
    expect(await world.read(null, replacement)).toEqual(record(replacement));
  });
});

describe("fails closed", () => {
  it("serves a fresh mirror through a GitHub outage, then 503s once the TTL passes, without hammering GitHub", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("reader", world.closed)).not.toBeNull();
    expect(await world.read("reader", world.open)).not.toBeNull();
    let down = true;
    world.github.fault(() => down, () => new Response("down", { status: 502 }), 1_000);
    world.clock.time += MIRROR_TTL_MS - 1;
    expect(await world.read("reader", world.closed)).not.toBeNull();
    world.clock.time += 1;
    await expect(world.read("reader", world.closed)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    const calls = world.github.requests.length;
    await expect(world.read("reader", world.closed)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(world.github.requests.length).toBe(calls);
    // Every user gets their own cooldown.
    await expect(world.read("member", world.closed)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(world.github.requests.length).toBeGreaterThan(calls);
    // Public repositories need no mirror and keep working.
    expect(await world.read("reader", world.open)).not.toBeNull();
    down = false;
    world.clock.time += FAILURE_COOLDOWN_MS;
    expect(await world.read("reader", world.closed)).not.toBeNull();
    expect(world.logs.some((entry) => entry.event === "access.unavailable" && entry.fields.reason === "server")).toBe(true);
  });

  it("503s while GitHub rate-limits the user, and never grants from an expired mirror", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("member", world.teamDocs)).not.toBeNull();
    world.clock.time += MIRROR_TTL_MS;
    world.github.rate.remaining = 0;
    await expect(world.read("member", world.teamDocs)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    world.github.rate.remaining = 5000;
    world.clock.time += 3_600_000;
    world.github.rate.reset = Math.floor(world.clock.time / 1000) + 3600;
    expect(await world.read("member", world.teamDocs)).not.toBeNull();
  });

  it("renews an expiring token, keeps the rotated refresh token, and 503s when renewal fails", async () => {
    const world = accessFixture();
    await world.setup();
    world.clock.time += 8 * 60 * 60 * 1000;
    expect(await world.read("reader", world.closed)).not.toBeNull();
    expect(world.github.count("oauth")).toBe(1);
    // The rotated pair was stored: the next renewal uses it.
    world.clock.time += 8 * 60 * 60 * 1000;
    expect(await world.read("reader", world.closed)).not.toBeNull();
    expect(world.github.count("oauth")).toBe(2);
    world.clock.time += 8 * 60 * 60 * 1000;
    world.github.fault(/login\/oauth/, () => new Response("unavailable", { status: 503 }));
    await expect(world.read("reader", world.closed)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    world.clock.time += FAILURE_COOLDOWN_MS;
    expect(await world.read("reader", world.closed)).not.toBeNull();
  });

  it("503s for an expired token when no refresher is configured", async () => {
    const refresher: TokenRefresher = { refresh: () => Promise.reject(new Error("not configured")) };
    const world = accessFixture({ refresher });
    await world.setup();
    world.clock.time += 8 * 60 * 60 * 1000;
    await expect(world.read("reader", world.closed)).rejects.toBeInstanceOf(RepoAccessUnavailable);
  });

  it("forgets a user whose refresh token GitHub refuses, or whose token is refused after renewal", async () => {
    const world = accessFixture();
    await world.setup();
    world.github.revokeAuthorization(world.people.reader);
    // The access token is refused (401): one renewal, refused for good.
    await expect(world.read("reader", world.closed)).resolves.toBeNull();
    expect(world.logs.some((entry) => entry.event === "access.tokens-rejected")).toBe(true);
    // Revoked by the alarm, after the mirror is gone.
    expect(revoked(world)).toEqual([]);
    await world.directory.alarm();
    expect(revoked(world)).toEqual([world.userIds.reader]);
    expect(await world.read("reader", world.closed)).toBeNull();

    // A refresh token that already expired is never sent.
    const expired = accessFixture();
    await expired.setup();
    expired.clock.time += 200 * 24 * 60 * 60 * 1000;
    await expect(expired.read("member", expired.teamDocs)).resolves.toBeNull();
    expect(expired.github.count("oauth")).toBe(0);

    // Without a refresh token (non-expiring tokens), a refused token cannot be renewed.
    const plain = accessFixture();
    await plain.setup();
    const tokens = plain.github.signIn(plain.people.member);
    await plain.directory.link({ userId: plain.userIds.member, githubId: plain.people.member.id, login: "member", tokens: { ...tokens, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null } });
    plain.github.revokeAuthorization(plain.people.member);
    await expect(plain.read("member", plain.teamDocs)).resolves.toBeNull();

    // Renewed, then refused again with the fresh token: revoked.
    const again = accessFixture();
    await again.setup();
    again.github.fault((request) => request.endpoint === "user-installations", () => Response.json({ message: "Bad credentials" }, { status: 401 }), 2);
    await expect(again.read("member", again.teamDocs)).resolves.toBeNull();
    expect(again.github.count("oauth")).toBe(1);
  });

  it("forgets a user whose second listing call is refused after an earlier renewal", async () => {
    const world = accessFixture();
    await world.setup();
    world.github.fault((request) => request.endpoint === "user-installations", () => Response.json({ message: "Bad credentials" }, { status: 401 }));
    world.github.fault((request) => request.endpoint === "installation-repositories", () => Response.json({ message: "Bad credentials" }, { status: 401 }));
    await expect(world.read("member", world.teamDocs)).resolves.toBeNull();
  });

  it("503s when a renewed token fails with something other than a refusal", async () => {
    const world = accessFixture();
    await world.setup();
    world.github.fault((request) => request.endpoint === "user-installations", () => Response.json({ message: "Bad credentials" }, { status: 401 }));
    world.github.fault((request) => request.endpoint === "user-installations", () => new Response("down", { status: 500 }), 2);
    await expect(world.read("member", world.teamDocs)).rejects.toBeInstanceOf(RepoAccessUnavailable);
  });

  it("503s when stored tokens cannot be opened (a rotated key)", async () => {
    const world = accessFixture();
    await world.setup();
    const user = await world.storage.get<{ tokens: string }>(`user:${world.userIds.reader}`);
    await world.storage.put(`user:${world.userIds.reader}`, { ...user, tokens: await sealTokens("another-key-0123456789abcdef0123456789", world.userIds.reader, world.github.signIn(world.people.reader)) });
    await expect(world.read("reader", world.closed)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(world.logs.some((entry) => entry.event === "access.unavailable" && entry.fields.reason === "error")).toBe(true);
  });

  it("503s when a confirmation is refused or the installation check fails", async () => {
    const world = accessFixture();
    await world.setup();
    await world.deliver("repository", { action: "publicized", ...world.repoPayload(world.open) });
    world.github.fault((request) => request.endpoint === "repository", () => new Response("down", { status: 500 }), 2);
    await expect(world.read(null, world.open)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    // In cooldown: no second request.
    await expect(world.read(null, world.open)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(world.github.count("repository")).toBe(2);
    world.clock.time += FAILURE_COOLDOWN_MS;
    expect(await world.read(null, world.open)).not.toBeNull();

    await world.deliver("installation", { action: "unsuspend" });
    world.github.fault((request) => request.endpoint === "installation", () => new Response("down", { status: 500 }), 2);
    await expect(world.read(null, world.open)).rejects.toBeInstanceOf(RepoAccessUnavailable);
  });

  it("retries an installation call once with a fresh token after a 401", async () => {
    const invalidate = vi.fn();
    const world = accessFixture({ installationTokens: { token: () => Promise.resolve("fake-installation-token"), invalidate } });
    await world.setup();
    await world.deliver("repository", { action: "publicized", ...world.repoPayload(world.open) });
    world.github.fault((request) => request.endpoint === "repository", () => Response.json({ message: "Bad credentials" }, { status: 401 }));
    expect(await world.read(null, world.open)).not.toBeNull();
    expect(invalidate).toHaveBeenCalledWith(world.installation.id);
  });
});

describe("races with webhooks", () => {
  it("never commits a listing GitHub sent before an invalidation landed", async () => {
    const world = accessFixture();
    await world.setup();
    let release!: () => void;
    world.github.gate = new Promise<void>((resolve) => { release = resolve; });
    world.github.gateFilter = (endpoint) => endpoint === "installation-repositories";
    const pending = world.read("member", world.teamDocs);
    await vi.waitFor(() => expect(world.github.held).toBe(1));
    // GitHub already answered with the old team; the removal webhook lands while that response is in flight.
    world.team.members.delete(world.people.member.id);
    world.github.gate = null;
    await world.deliver("membership", { action: "removed", member: world.userPayload(world.people.member) });
    // A view after the webhook never joins the old refresh: it asks GitHub afresh, while the old one is still out.
    expect(await world.read("member", world.teamDocs)).toBeNull();
    release();
    // The stale listing is dropped and the decision is taken again from GitHub's current answer.
    await expect(pending).resolves.toBeNull();
    expect(await world.read("member", world.teamDocs)).toBeNull();
  });

  it("keeps an event's visibility when a listing started before it commits afterwards", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("reader", world.closed)).not.toBeNull();
    world.closed.collaborators.add(world.people.member.id);
    // GitHub briefly shows closed-docs as public to the member's listing; the "privatized" event lands before that listing commits.
    world.closed.isPrivate = false;
    let release!: () => void;
    world.github.gate = new Promise<void>((resolve) => { release = resolve; });
    world.github.gateFilter = (endpoint) => endpoint === "installation-repositories";
    const pending = world.read("member", world.teamDocs);
    await vi.waitFor(() => expect(world.github.held).toBe(1));
    world.github.gate = null;
    world.closed.isPrivate = true;
    await world.deliver("repository", { action: "privatized", ...world.repoPayload(world.closed) });
    await world.deliver("installation", { action: "new_permissions_accepted" });
    release();
    expect(await pending).toEqual(record(world.teamDocs));
    expect(await world.read(null, world.closed)).toBeNull();
  });

  it("joins one refresh per user, and discards a confirmation an event overtook", async () => {
    const world = accessFixture();
    await world.setup();
    world.clock.time += MIRROR_TTL_MS;
    world.github.resetLog();
    const views = await Promise.all([world.read("member", world.teamDocs), world.read("member", world.teamDocs), world.read("member", world.closed)]);
    expect(views.map(Boolean)).toEqual([true, true, false]);
    expect(world.github.count("user-installations")).toBe(1);

    await world.deliver("repository", { action: "publicized", ...world.repoPayload(world.open) });
    let release!: () => void;
    world.github.gate = new Promise<void>((resolve) => { release = resolve; });
    world.github.gateFilter = (endpoint) => endpoint === "repository" || endpoint === "installation";
    const checks = world.github.count("repository");
    const pending = world.read(null, world.open);
    await vi.waitFor(() => expect(world.github.held).toBe(1));
    world.github.gate = null;
    await world.deliver("repository", { action: "edited", ...world.repoPayload(world.open) });
    release();
    // The overtaken confirmation is dropped; the event's own check runs, then the answer.
    expect(await pending).toEqual(record(world.open));
    expect(world.github.count("repository") - checks).toBe(2);

    await world.deliver("installation", { action: "unsuspend" });
    world.github.gate = new Promise<void>((resolve) => { release = resolve; });
    const installationChecks = world.github.count("installation");
    const installationCheck = world.read(null, world.open);
    await vi.waitFor(() => expect(world.github.held).toBe(1));
    world.github.gate = null;
    await world.deliver("installation", { action: "new_permissions_accepted" });
    release();
    expect(await installationCheck).toEqual(record(world.open));
    expect(world.github.count("installation") - installationChecks).toBe(2);
  });

  it("never answers from records a webhook changed while GitHub was being asked", async () => {
    const world = accessFixture();
    await world.setup();
    // The app is uninstalled while the first view confirms the repository: the answer is the uninstall's.
    let release!: () => void;
    world.github.gate = new Promise<void>((resolve) => { release = resolve; });
    world.github.gateFilter = (endpoint) => endpoint === "repository";
    const pending = world.read(null, world.open);
    await vi.waitFor(() => expect(world.github.held).toBe(1));
    world.github.gate = null;
    await world.deliver("installation", { action: "deleted" });
    release();
    expect(await pending).toBeNull();
  });

  it("gives up with a 503 when webhooks keep overtaking every check", async () => {
    const world = accessFixture();
    await world.setup();
    world.github.fault((request) => request.endpoint === "repository", async () => {
      await world.deliver("repository", { action: "edited", ...world.repoPayload(world.open) });
      return Response.json(world.github.repoJson(world.open));
    }, 10);
    await expect(world.read(null, world.open)).rejects.toBeInstanceOf(RepoAccessUnavailable);
  });

  it("serializes token renewals, and drops one a new sign-in overtook", async () => {
    const world = accessFixture();
    await world.setup();
    world.clock.time += 8 * 60 * 60 * 1000;
    let release!: () => void;
    world.github.gate = new Promise<void>((resolve) => { release = resolve; });
    world.github.gateFilter = (endpoint) => endpoint === "oauth";
    const pending = world.read("reader", world.closed);
    await vi.waitFor(() => expect(world.github.held).toBe(1));
    world.github.gate = null;
    await world.link("reader");
    release();
    await expect(pending).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(await world.read("reader", world.closed)).not.toBeNull();
  });
});

describe("token renewal races", () => {
  it("shares one renewal between a refresh and the one an invalidation started", async () => {
    const world = accessFixture();
    await world.setup();
    world.clock.time += 8 * 60 * 60 * 1000;
    let release!: () => void;
    world.github.gate = new Promise<void>((resolve) => { release = resolve; });
    world.github.gateFilter = (endpoint) => endpoint === "oauth";
    const first = world.read("member", world.teamDocs);
    await vi.waitFor(() => expect(world.github.held).toBe(1));
    await world.deliver("membership", { action: "added", member: world.userPayload(world.people.member) });
    const second = world.read("member", world.teamDocs);
    release();
    // The first refresh's listing is dropped; that view joins the second refresh, which used the same renewal.
    expect(await first).toEqual(record(world.teamDocs));
    expect(await second).toEqual(record(world.teamDocs));
    expect(world.github.count("oauth")).toBe(1);
  });

  it("stops at a renewal for a user whose tokens were dropped meanwhile", async () => {
    const world = accessFixture();
    await world.setup();
    let release!: () => void;
    world.github.gate = new Promise<void>((resolve) => { release = resolve; });
    world.github.gateFilter = (endpoint) => endpoint === "user-installations";
    const pending = world.read("member", world.teamDocs);
    await vi.waitFor(() => expect(world.github.held).toBe(1));
    world.github.gate = null;
    world.github.revokeAuthorization(world.people.member);
    await world.deliver("github_app_authorization", { action: "revoked", sender: world.userPayload(world.people.member) });
    release();
    await expect(pending).resolves.toBeNull();
    expect(world.github.count("oauth")).toBe(0);
  });
});

describe("large accounts", () => {
  it("lists in pages up to a budget, then checks single repositories of partly listed installations", async () => {
    const world = accessFixture();
    await world.setup();
    const many = Array.from({ length: MAX_REPOSITORY_PAGES * 100 + 5 }, (_, index) => {
      const repo = world.github.repo("octo", `bulk-${index}`, { id: 10_000 + index, private: true });
      repo.collaborators.add(world.people.outsider.id);
      return repo;
    });
    const last = many[many.length - 1];
    // A second installation, listed after the budget is spent: also checked repository by repository.
    world.github.install("zeta", { id: 79 });
    const zeta = world.github.repo("zeta", "docs", { id: 30_000, private: true });
    zeta.collaborators.add(world.people.outsider.id);
    await world.apply({ installation: { id: 79, account: "zeta", state: "active" }, repos: { change: "confirm", hints: [{ id: zeta.id, owner: "zeta", name: "docs", private: true }], installation: 79 }, revoke: false });
    await world.deliver("installation_repositories", { action: "added", repositories_added: [world.github.repoJson(last)] });
    world.github.resetLog();
    expect(await world.read("outsider", many[0])).not.toBeNull();
    expect(world.github.count("installation-repositories")).toBe(MAX_REPOSITORY_PAGES);
    expect(await world.read("outsider", zeta)).toEqual(record(zeta));
    // Beyond the listing budget: one permission check, then cached like the mirror.
    expect(await world.read("outsider", last)).toEqual(record(last));
    expect(await world.read("outsider", last)).toEqual(record(last));
    expect(world.github.count("permission")).toBe(2);
    expect(await world.read("member", last)).toBeNull();
    // An invalidation retires cached checks.
    last.collaborators.delete(world.people.outsider.id);
    await world.deliver("member", { action: "removed", member: world.userPayload(world.people.outsider), ...world.repoPayload(last) });
    expect(await world.read("outsider", last)).toBeNull();
    expect(world.logs.some((entry) => entry.event === "access.refresh" && entry.fields.partial === 2)).toBe(true);
  });

  it("skips listing a suspended installation and lists the user's others", async () => {
    const world = accessFixture();
    const other = world.github.install("other-org", { id: 72, suspended: true });
    const elsewhere = world.github.repo("other-org", "docs", { id: 901, private: true });
    elsewhere.collaborators.add(world.people.reader.id);
    void other;
    await world.setup();
    expect(await world.read("reader", world.closed)).not.toBeNull();
    expect(world.github.requests.filter((request) => request.path.startsWith("/user/installations/72"))).toEqual([]);
  });

  it("discards a check that an invalidation overtook", async () => {
    const world = accessFixture();
    await world.setup();
    const many = Array.from({ length: MAX_REPOSITORY_PAGES * 100 + 1 }, (_, index) => world.github.repo("octo", `bulk-${index}`, { id: 20_000 + index, private: true }));
    const last = many[many.length - 1];
    last.collaborators.add(world.people.member.id);
    for (const repo of many) repo.collaborators.add(world.people.member.id);
    await world.deliver("installation_repositories", { action: "added", repositories_added: [world.github.repoJson(last)] });
    world.clock.time += MIRROR_TTL_MS;
    expect(await world.read("member", many[0])).not.toBeNull();
    let release!: () => void;
    world.github.gate = new Promise<void>((resolve) => { release = resolve; });
    world.github.gateFilter = (endpoint) => endpoint === "permission";
    const pending = world.read("member", last);
    await vi.waitFor(() => expect(world.github.held).toBe(1));
    world.github.gate = null;
    await world.deliver("membership", { action: "added", member: world.userPayload(world.people.member) });
    release();
    // The check from before the invalidation is dropped; a new mirror and a new check decide.
    expect(await pending).toEqual(record(last));
    expect(world.github.count("permission")).toBe(2);
  });
});

describe("accounts", () => {
  it("binds one GitHub account to one Rendro user, revoking whoever held it", async () => {
    const world = accessFixture();
    await world.setup();
    expect(await world.read("reader", world.closed)).not.toBeNull();
    await world.directory.link({ userId: "user-new", githubId: world.people.reader.id, login: "reader", tokens: world.github.signIn(world.people.reader) });
    expect(await world.read("reader", world.closed)).toBeNull();
    expect(await world.directory.authorize("user-new", "octo", "closed-docs")).toEqual(record(world.closed));
    // Switching the GitHub account behind a Rendro user drops the old mirror.
    await world.directory.link({ userId: "user-new", githubId: world.people.member.id, login: "member", tokens: world.github.signIn(world.people.member) });
    expect(await world.directory.authorize("user-new", "octo", "closed-docs")).toBeNull();
    expect(await world.directory.authorize("user-new", "octo", "team-docs")).not.toBeNull();
    await world.directory.alarm();
    // The reader lost the account to user-new, and the member's account then moved to user-new as well.
    expect(revoked(world)).toEqual([world.userIds.member, "user-new", world.userIds.reader]);
    await world.directory.forget("user-nobody");
    // Unlinking the old holder leaves the account's new owner alone.
    await world.directory.forget(world.userIds.reader);
    expect(await world.storage.get(`gh:${world.people.member.id}`)).toBe("user-new");
    await world.directory.forget("user-new");
    expect(await world.directory.authorize("user-new", "octo", "team-docs")).toBeNull();
  });

  it("stores tokens sealed and never logs or answers with them", async () => {
    const world = accessFixture();
    const tokens = world.github.signIn(world.people.reader);
    await world.setup();
    await world.link("reader", tokens);
    await world.read("reader", world.closed);
    const stored = JSON.stringify([...world.storage.data.values()]);
    expect(stored).not.toContain(tokens.accessToken);
    expect(stored).not.toContain(tokens.refreshToken);
    const user = await world.storage.get<{ tokens: string }>(`user:${world.userIds.reader}`);
    expect((await openTokens(TOKEN_KEY, world.userIds.reader, user!.tokens)).accessToken).toBe(tokens.accessToken);
    const response = await world.directory.fetch(new Request("https://directory/authorize", { method: "POST", body: JSON.stringify({ viewer: world.userIds.reader, owner: "octo", name: "closed-docs" }) }));
    const answer = await response.text();
    expect(answer).not.toMatch(/gh[usr]_/);
    expect(JSON.stringify(world.logs)).not.toMatch(/gh[usr]_/);
  });
});

describe("epoch outbox", () => {
  it("retries failed writes from the alarm, and epochs only grow", async () => {
    const world = accessFixture();
    await world.setup();
    world.kv.failPut = () => true;
    world.team.members.delete(world.people.member.id);
    await world.deliver("membership", { action: "removed", member: world.userPayload(world.people.member) });
    // The mirror already denies; the epoch waits for the alarm.
    expect(await world.read("member", world.teamDocs)).toBeNull();
    expect(revoked(world)).toEqual([]);
    expect(world.storage.alarm).toBe(world.clock.time + 10_000);
    expect(world.logs.some((entry) => entry.event === "access.epochs-failed")).toBe(true);
    world.kv.failPut = null;
    const before = world.clock.time;
    world.clock.time -= 5_000;
    await world.directory.alarm();
    // The clock went backwards: the epoch still moves forward.
    expect(world.kv.epoch(world.userIds.member)).toBeGreaterThanOrEqual(before - 5_000);
    const first = world.kv.epoch(world.userIds.member);
    await world.apply({ users: [world.people.member.id], revoke: true });
    expect(world.kv.epoch(world.userIds.member)).toBe(Math.max(world.clock.time, first + 1));
    expect(world.kv.epoch(world.userIds.member)).toBeGreaterThan(first);
  });

  it("keeps a revocation queued while an older one is being written, and drains big batches", async () => {
    const world = accessFixture();
    await world.setup();
    let requeued = false;
    world.kv.beforePut = async (key) => {
      if (!requeued && key === `epoch:${world.userIds.member}`) {
        requeued = true;
        await world.storage.put(`pending:${world.userIds.member}`, "newer");
      }
    };
    await world.apply({ users: [world.people.member.id], revoke: true });
    expect(await world.storage.get(`pending:${world.userIds.member}`)).toBe("newer");
    await world.directory.alarm();
    expect(await world.storage.get(`pending:${world.userIds.member}`)).toBeUndefined();

    world.kv.beforePut = null;
    for (let index = 0; index < 70; index += 1) await world.storage.put(`pending:bulk-${index}`, "m");
    world.storage.alarms.length = 0;
    await world.directory.flushEpochs();
    expect(world.storage.alarms).toEqual([world.clock.time]);
    await world.directory.alarm();
    expect((await world.storage.list({ prefix: "pending:" })).size).toBe(0);
  });

  it("keeps later passes running after a storage failure", async () => {
    const world = accessFixture();
    await world.setup();
    const list = world.storage.list.bind(world.storage);
    world.storage.list = () => Promise.reject(new Error("storage down"));
    await expect(world.directory.flushEpochs()).rejects.toThrow("storage down");
    world.storage.list = list;
    await world.directory.flushEpochs();
  });
});

describe("internal protocol", () => {
  it("answers authorize, link, unlink and webhook requests", async () => {
    const world = accessFixture();
    await world.setup();
    const call = (path: string, body: unknown) => world.directory.fetch(new Request(`https://directory${path}`, { method: "POST", body: JSON.stringify(body) }));
    expect(await (await call("/authorize", { viewer: world.userIds.reader, owner: "octo", name: "closed-docs" })).json()).toEqual({ repo: record(world.closed) });
    expect((await call("/authorize", { viewer: null, owner: "octo", name: "closed-docs" })).status).toBe(404);
    const tokens = world.github.signIn(world.people.outsider);
    expect((await call("/link", { userId: "user-x", githubId: world.people.outsider.id, login: "outsider", tokens })).status).toBe(204);
    expect((await call("/unlink", { userId: "user-x" })).status).toBe(204);
    expect(await (await call("/webhook", { deliveryId: "d-9", plan: { users: [1], revoke: false } })).json()).toEqual({ status: "applied" });
    expect((await call("/nowhere", {})).status).toBe(404);
    world.github.fault(() => true, () => new Response("down", { status: 500 }), 10);
    world.clock.time += MIRROR_TTL_MS;
    expect((await call("/authorize", { viewer: world.userIds.reader, owner: "octo", name: "closed-docs" })).status).toBe(503);
  });

  it("reports GitHub failures by kind only", async () => {
    const world = accessFixture();
    await world.setup();
    world.clock.time += MIRROR_TTL_MS;
    world.github.fault(() => true, () => { throw new GitHubError("network", "boom"); }, 10);
    await expect(world.read("reader", world.closed)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(world.logs.filter((entry) => entry.event === "access.unavailable").map((entry) => entry.fields)).toEqual([{ reason: "network" }]);
  });
});
