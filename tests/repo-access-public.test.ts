import { describe, expect, it } from "vitest";
import { RepoAccessLimited, RepoAccessUnavailable } from "../src/repo-read/access";
import {
  PUBLIC_CONFIRM_MAX_MS, PUBLIC_CONFIRM_TTL_MS, PUBLIC_REGISTER_GLOBAL_LIMIT, PUBLIC_RESOLVE_USER_LIMIT, PUBLIC_RESOLVE_WINDOW_MS, UNRESOLVED_TTL_MS,
} from "../src/repo-access/directory";
import { planEvent } from "../src/repo-access/events";
import { accessFixture, STRANGER } from "./helpers/repo-access-fixture";

/**
 * Public repositories without the App (#354): a signed-in reader asks for a name nothing installed covers, and the
 * directory resolves it against the fake GitHub, with their user token first and Rendro's public-read token when
 * GitHub refuses that. The fake refuses user tokens for such repositories unless `userTokensReadPublic` is set.
 */

const record = (repo: { id: number; owner: string; name: string }) => ({ id: repo.id, owner: repo.owner, name: repo.name, private: false, defaultBranch: "main" });
const repoRequests = (world: ReturnType<typeof accessFixture>) => world.github.requests.filter(request => request.endpoint === "repository");

function lonelyWorld(options: Parameters<typeof accessFixture>[0] = {}) {
  const world = accessFixture(options);
  const lib = world.github.repo("lib-org", "docs", { id: 901 });
  const secret = world.github.repo("lib-org", "secret", { id: 902, private: true });
  return { world, lib, secret };
}

describe("resolving a public repository nobody installed the App on", () => {
  it("registers it for a reader with no GitHub link through the public-read token, then answers from the registry", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    world.github.resetLog();
    expect(await world.read(null, lib)).toEqual(record(lib));
    expect(repoRequests(world).map(request => request.authorization)).toEqual([`Bearer ${world.github.publicReadToken}`]);
    expect(await world.storage.get(`repo:${lib.id}`)).toMatchObject({ id: 901, installation: null, publicOnly: true, private: false, removed: false });
    expect(await world.storage.get(`repo:${lib.id}`)).toMatchObject({ etagVia: "service", etag: expect.any(String) });
    // The registry answers, to anyone signed in, with no GitHub request.
    world.github.resetLog();
    expect(await world.read("reader", lib)).toEqual(record(lib));
    expect(await world.directory.authorize("user-else", "LIB-ORG", "Docs")).toEqual(record(lib));
    expect(world.github.requests).toEqual([]);
    expect(world.logs.filter(entry => entry.event === "access.public-registered")).toHaveLength(1);
    // A registered repository has no role to moderate.
    expect(await world.directory.moderationRole(world.userIds.reader, "lib-org", "docs")).toBeNull();
  });

  it("reads with the reader's user token first, and never asks for the public-read token when GitHub lets it read", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    world.github.userTokensReadPublic = true;
    await world.setup();
    world.github.resetLog();
    expect(await world.read("reader", lib)).toEqual(record(lib));
    const [asked, ...rest] = repoRequests(world);
    expect(asked.authorization).not.toBe(`Bearer ${world.github.publicReadToken}`);
    expect(asked.authorization).toMatch(/^Bearer /);
    expect(rest).toEqual([]);
    expect(await world.storage.get(`repo:${lib.id}`)).toMatchObject({ publicOnly: true });
    expect(await world.storage.get(`repo:${lib.id}`)).not.toHaveProperty("etagVia");
  });

  it("falls back to the public-read token when GitHub refuses the user token", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    world.github.resetLog();
    expect(await world.read("reader", lib)).toEqual(record(lib));
    const asked = repoRequests(world);
    expect(asked.map(request => request.status)).toEqual([403, 200]);
    expect(asked[1].authorization).toBe(`Bearer ${world.github.publicReadToken}`);
  });

  it("falls back when GitHub answers the user token with a 404 or a 401, and keeps going when the user's tokens are gone", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    world.github.userTokensReadPublic = true;
    await world.setup();
    // The user token cannot see it (404 for an uninstalled repository): the service token can.
    world.github.fault(request => request.endpoint === "repository" && request.url.pathname === "/repos/lib-org/docs", () => Response.json({ message: "Not Found" }, { status: 404 }));
    expect(await world.read("reader", lib)).toEqual(record(lib));
    const other = world.github.repo("lib-org", "second", { id: 903 });
    world.github.fault(request => request.endpoint === "repository" && request.url.pathname === "/repos/lib-org/second", () => Response.json({ message: "Bad credentials" }, { status: 401 }));
    expect(await world.read("reader", other)).toEqual(record(other));
  });

  it("is a plain denial, remembered for a minute, when no credential can show it", async () => {
    const { world, lib } = lonelyWorld();
    await world.setup();
    world.github.resetLog();
    // The user token is refused and there is no public-read token: ambiguous, so not registered.
    expect(await world.read("reader", lib)).toBeNull();
    expect(repoRequests(world).map(request => request.status)).toEqual([403]);
    expect(await world.storage.get(`repo:${lib.id}`)).toBeUndefined();
    world.github.resetLog();
    expect(await world.read("reader", lib)).toBeNull();
    expect(await world.read(null, lib)).toBeNull();
    expect(world.github.requests).toEqual([]);
    world.clock.time += UNRESOLVED_TTL_MS;
    expect(await world.read("reader", lib)).toBeNull();
    expect(repoRequests(world)).toHaveLength(1);
    // A reader with no GitHub tokens and no service token asks GitHub nothing at all.
    world.github.resetLog();
    expect(await world.read(null, world.github.repo("lib-org", "other", { id: 910 }))).toBeNull();
    expect(world.github.requests).toEqual([]);
  });

  it("denies a private or missing repository, whoever asks, and does not register it", async () => {
    const { world, lib, secret } = lonelyWorld({ publicRead: true });
    world.github.userTokensReadPublic = true;
    await world.setup();
    expect(await world.read("reader", secret)).toBeNull();
    expect(await world.read(null, secret)).toBeNull();
    expect(await world.directory.authorize(world.userIds.reader, "lib-org", "no-such-repo")).toBeNull();
    expect(await world.storage.get(`repo:${secret.id}`)).toBeUndefined();
    // A user token that can read the private repository through some installation still does not make it public.
    const anywhere = world.github.repo("octo", "private-elsewhere", { id: 920, private: true });
    anywhere.collaborators.add(world.people.reader.id);
    world.github.fault(request => request.endpoint === "repository", () => Response.json({ ...world.github.repoJson(anywhere) }), 1);
    expect(await world.directory.authorize(world.userIds.reader, "octo", "private-elsewhere")).toBeNull();
    expect(await world.storage.get(`repo:${anywhere.id}`)).toBeUndefined();
    expect(lib.isPrivate).toBe(false);
  });

  it("asks GitHub once for readers who ask together", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    world.github.resetLog();
    // Held at GitHub, so all three are waiting on the same lookup.
    let release = () => {};
    world.github.gate = new Promise<void>(resolve => { release = resolve; });
    world.github.gateFilter = endpoint => endpoint === "repository";
    const answers = Promise.all([world.read(null, lib), world.read(null, lib), world.directory.authorize("user-else", "lib-org", "docs")]);
    for (let spins = 0; spins < 200 && world.github.held === 0; spins += 1) await new Promise(resolve => setImmediate(resolve));
    for (let spins = 0; spins < 20; spins += 1) await new Promise(resolve => setImmediate(resolve));
    world.github.gate = null;
    release();
    expect(await answers).toEqual([record(lib), record(lib), record(lib)]);
    expect(repoRequests(world)).toHaveLength(1);
  });

  it("skips a reader whose tokens GitHub no longer honours, and is an outage when renewing them fails or GitHub rate-limits them", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    // Short-lived access tokens, so a mirror that is still fresh outlives the token behind it.
    world.github.userTokenLifetime = 90_000;
    await world.setup();
    await world.read("member", world.teamDocs);
    await world.read("reader", world.closed);
    world.clock.time += 100_000;
    // Their authorization was revoked: the service token answers, and the user is not an error.
    world.github.revokeAuthorization(world.people.member);
    expect(await world.directory.authorize(world.userIds.member, "lib-org", "docs")).toEqual(record(lib));
    // The token endpoint is down: nothing is registered, and nothing is denied either.
    const other = world.github.repo("lib-org", "other", { id: 905 });
    world.github.fault(/login\/oauth/, () => new Response("unavailable", { status: 503 }), 5);
    await expect(world.read("reader", other)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(await world.storage.get(`repo:${other.id}`)).toBeUndefined();
    // A reader whose token works but whom GitHub rate-limits.
    await world.link("outsider");
    const third = world.github.repo("lib-org", "third", { id: 906 });
    world.github.fault(request => request.endpoint === "repository", () => Response.json({ message: "API rate limit exceeded for user." }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(world.clock.time / 1000) + 3_600) } }), 3);
    await expect(world.read("outsider", third)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(world.github.requests.filter(request => request.endpoint === "repository" && request.path.startsWith("/repos/lib-org/third")).at(-1)?.authorization).not.toBe(`Bearer ${world.github.publicReadToken}`);
    expect(await world.storage.get(`repo:${third.id}`)).toBeUndefined();
  });

  it("fails closed, and cools down, while GitHub cannot answer", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    world.github.fault(request => request.endpoint === "repository", () => new Response("down", { status: 502 }), 4);
    await expect(world.read(null, lib)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(await world.storage.get(`repo:${lib.id}`)).toBeUndefined();
    world.github.resetLog();
    await expect(world.read(null, lib)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(world.github.requests).toEqual([]);
  });

  it("spends none of the allowance on an outage that registered nothing it could not see through", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    world.github.fault(request => request.endpoint === "repository", () => new Response("down", { status: 502 }), 2);
    await expect(world.read(null, lib)).rejects.toBeInstanceOf(RepoAccessUnavailable);
    expect(await world.storage.get("allowance:global")).toBeUndefined();
  });
});

describe("confirming a public repository registered without an installation", () => {
  it("re-reads it after the confirmation TTL with the service token's ETag, and a 304 renews it for free", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    expect(await world.read(null, lib)).toEqual(record(lib));
    const stored = await world.storage.get<{ etag: string; etagVia: string; confirmedAt: number }>(`repo:${lib.id}`);
    expect(stored?.etagVia).toBe("service");
    world.github.resetLog();
    world.clock.time += PUBLIC_CONFIRM_TTL_MS - 1;
    expect(await world.read("reader", lib)).toEqual(record(lib));
    expect(world.github.requests).toEqual([]);
    world.clock.time += 1;
    expect(await world.read("reader", lib)).toEqual(record(lib));
    // The reader's user token is tried first; GitHub refuses it, so the conditional service-token read answers 304.
    expect(repoRequests(world).map(request => request.status)).toEqual([403, 304]);
    expect((await world.storage.get<{ confirmedAt: number }>(`repo:${lib.id}`))?.confirmedAt).toBe(world.clock.time);
    expect(world.kv.visibilityEpoch(lib.id)).toBe(0);
  });

  it("follows a rename, and keeps the user token's answer as unconditional", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    world.github.userTokensReadPublic = true;
    await world.setup();
    expect(await world.read("reader", lib)).toEqual(record(lib));
    world.github.rename(lib, "lib-org", "renamed");
    world.clock.time += PUBLIC_CONFIRM_TTL_MS;
    // The old name is a plain denial after the rename, as for an installed repository; the new one reads.
    expect(await world.directory.authorize(world.userIds.reader, "lib-org", "docs")).toBeNull();
    expect(await world.storage.get(`repo:${lib.id}`)).toMatchObject({ name: "renamed" });
    expect(await world.storage.get(`repo:${lib.id}`)).not.toHaveProperty("etagVia");
    expect(await world.directory.authorize(world.userIds.reader, "lib-org", "renamed")).toEqual({ ...record(lib), name: "renamed" });
  });

  it("denies, tombstones and bumps the visibility epoch at once when the repository was made private", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    expect(await world.read(null, lib)).not.toBeNull();
    lib.isPrivate = true;
    world.clock.time += PUBLIC_CONFIRM_TTL_MS;
    expect(await world.read(null, lib)).toBeNull();
    expect(await world.storage.get(`repo:${lib.id}`)).toMatchObject({ removed: true });
    expect(world.kv.visibilityEpoch(lib.id)).toBeGreaterThan(0);
    // The tombstone is not a repository: the name is asked about again, and GitHub still says no.
    world.clock.time += UNRESOLVED_TTL_MS;
    expect(await world.read(null, lib)).toBeNull();
  });

  it("tombstones a repository another one has taken the name of, and registers the new one", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    expect(await world.read(null, lib)).not.toBeNull();
    world.github.repos.delete("lib-org/docs");
    const successor = world.github.repo("lib-org", "docs", { id: 950 });
    world.clock.time += PUBLIC_CONFIRM_TTL_MS;
    expect(await world.read(null, successor)).toEqual(record(successor));
    expect(await world.storage.get(`repo:${lib.id}`)).toMatchObject({ removed: true });
    expect(await world.storage.get(`name:lib-org/docs`)).toBe(950);
  });

  it("keeps granting through an outage for an hour, then answers 503, never a stale grant", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    expect(await world.read(null, lib)).not.toBeNull();
    world.github.fault(request => request.endpoint === "repository", () => new Response("down", { status: 502 }), 100);
    world.clock.time += PUBLIC_CONFIRM_TTL_MS;
    expect(await world.read(null, lib)).toEqual(record(lib));
    world.clock.time += PUBLIC_CONFIRM_MAX_MS;
    await expect(world.read(null, lib)).rejects.toBeInstanceOf(RepoAccessUnavailable);
  });

  it("cannot confirm without a credential: granted until the bound, then 503", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    expect(await world.read(null, lib)).not.toBeNull();
    // The service token is gone (rotated out), and a reader with no tokens has nothing else to ask with.
    const bare = accessFixture();
    await bare.setup();
    await bare.storage.put(`repo:${lib.id}`, await world.storage.get(`repo:${lib.id}`));
    await bare.storage.put(`name:lib-org/docs`, lib.id);
    bare.clock.time = world.clock.time + PUBLIC_CONFIRM_TTL_MS;
    expect(await bare.read(null, lib)).toEqual(record(lib));
    expect(bare.logs.some(entry => entry.event === "access.visibility-unconfirmed")).toBe(true);
    bare.clock.time += PUBLIC_CONFIRM_MAX_MS;
    await expect(bare.read(null, lib)).rejects.toBeInstanceOf(RepoAccessUnavailable);
  });

  it("treats a record with no confirmation time as never confirmed", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    expect(await world.read(null, lib)).not.toBeNull();
    const { confirmedAt: _confirmedAt, ...legacy } = await world.storage.get<Record<string, unknown>>(`repo:${lib.id}`) as Record<string, unknown>;
    await world.storage.put(`repo:${lib.id}`, legacy);
    world.github.resetLog();
    expect(await world.read(null, lib)).toEqual(record(lib));
    expect(repoRequests(world)).toHaveLength(1);
  });

  it("drops a confirmation an event overtook", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    expect(await world.read(null, lib)).not.toBeNull();
    world.clock.time += PUBLIC_CONFIRM_TTL_MS;
    world.github.fault(request => request.endpoint === "repository", async () => {
      await world.deliver("repository", { action: "privatized", ...world.repoPayload(lib) });
      return Response.json({ ...world.github.repoJson(lib) });
    });
    // The privatization event (any repository event bumps the sequence) wins over the answer GitHub was giving.
    expect(await world.read(null, lib)).toEqual(record(lib));
  });
});

describe("the allowances on repositories nobody has read yet", () => {
  it("limits one reader's lookups per hour, found or not, and starts a new window after it", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    for (let index = 0; index < PUBLIC_RESOLVE_USER_LIMIT; index += 1) {
      expect(await world.directory.authorize(STRANGER, "lib-org", `missing-${index}`)).toBeNull();
      // A name asked about a moment ago costs nothing again.
      expect(await world.directory.authorize(STRANGER, "lib-org", `missing-${index}`)).toBeNull();
    }
    const error = await world.read(null, lib).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RepoAccessLimited);
    expect((error as RepoAccessLimited).retryAfterSeconds).toBeGreaterThan(PUBLIC_RESOLVE_WINDOW_MS / 1000 - 60);
    expect((error as RepoAccessLimited).retryAfterSeconds).toBeLessThanOrEqual(PUBLIC_RESOLVE_WINDOW_MS / 1000);
    // Others are untouched, and so are repositories already registered.
    expect(await world.read("reader", lib)).toEqual(record(lib));
    expect(await world.read(null, lib)).toEqual(record(lib));
    world.clock.time += PUBLIC_RESOLVE_WINDOW_MS;
    expect(await world.directory.authorize(STRANGER, "lib-org", "fresh-name")).toBeNull();
  });

  it("limits the repositories all readers together register per hour", async () => {
    const { world } = lonelyWorld({ publicRead: true });
    await world.setup();
    const repos = Array.from({ length: PUBLIC_REGISTER_GLOBAL_LIMIT + 1 }, (_, index) => world.github.repo("many-org", `repo-${index}`, { id: 2000 + index }));
    let registered = 0;
    let limited: unknown = null;
    for (const [index, repo] of repos.entries()) {
      try {
        await world.directory.authorize(`user-${Math.floor(index / PUBLIC_RESOLVE_USER_LIMIT)}`, repo.owner, repo.name);
        registered += 1;
      } catch (error) {
        limited = error;
      }
    }
    expect(registered).toBe(PUBLIC_REGISTER_GLOBAL_LIMIT);
    expect(limited).toBeInstanceOf(RepoAccessLimited);
    // Nothing registered is limited again, and a window later registrations resume.
    expect(await world.directory.authorize("user-0", "many-org", "repo-0")).toMatchObject({ id: 2000 });
    world.clock.time += PUBLIC_RESOLVE_WINDOW_MS;
    expect(await world.directory.authorize("user-0", "many-org", `repo-${PUBLIC_REGISTER_GLOBAL_LIMIT}`)).toMatchObject({ id: 2000 + PUBLIC_REGISTER_GLOBAL_LIMIT });
  });

  it("refuses a registration the global allowance ran out for while GitHub was answering", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    world.github.fault(request => request.endpoint === "repository", async () => {
      await world.storage.put("allowance:global", { startedAt: world.clock.time, count: PUBLIC_REGISTER_GLOBAL_LIMIT });
      return Response.json({ ...world.github.repoJson(lib) });
    });
    await expect(world.read(null, lib)).rejects.toBeInstanceOf(RepoAccessLimited);
    expect(await world.storage.get(`repo:${lib.id}`)).toBeUndefined();
  });

  it("speaks the limit over the directory's internal protocol", async () => {
    const { world } = lonelyWorld({ publicRead: true });
    await world.setup();
    await world.storage.put(`allowance:user:${STRANGER}`, { startedAt: world.clock.time, count: PUBLIC_RESOLVE_USER_LIMIT });
    const response = await world.directory.fetch(new Request("https://directory/authorize", { method: "POST", body: JSON.stringify({ viewer: STRANGER, owner: "lib-org", name: "docs" }) }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Limited", retryAfter: expect.any(Number) });
  });
});

describe("a repository that becomes installed, or was installed before", () => {
  it("moves to the installed path when the App is installed on it: the installation's records replace the public ones", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true });
    await world.setup();
    expect(await world.read(null, lib)).not.toBeNull();
    const installation = world.github.install("lib-org", { id: 72 });
    const plan = planEvent("installation", { action: "created", installation: { id: installation.id, account: { login: "lib-org" } }, repositories: [world.github.repoJson(lib)] });
    if (typeof plan === "string") throw new Error(plan);
    await world.directory.applyWebhook("delivery-install", plan);
    expect(await world.storage.get(`repo:${lib.id}`)).toMatchObject({ installation: 72, check: true });
    expect(await world.storage.get(`repo:${lib.id}`)).not.toHaveProperty("publicOnly", true);
    world.github.resetLog();
    expect(await world.read("outsider", lib)).toEqual(record(lib));
    // Now confirmed through the installation's token, as any installed repository is.
    expect(repoRequests(world).some(request => request.authorization === `Bearer ${world.github.token}`)).toBe(true);
  });

  it("registers a repository the App lost again when a reader shows it to be public, and cancels its pending purge", async () => {
    const { world, lib } = lonelyWorld({ publicRead: true, content: { purge: () => Promise.resolve() } });
    const installation = world.github.install("lib-org", { id: 72 });
    await world.setup();
    const plan = planEvent("installation", { action: "created", installation: { id: installation.id, account: { login: "lib-org" } }, repositories: [world.github.repoJson(lib)] });
    if (typeof plan === "string") throw new Error(plan);
    await world.directory.applyWebhook("delivery-install", plan);
    expect(await world.read(null, lib)).not.toBeNull();
    world.github.installations.delete(installation.id);
    const gone = planEvent("installation", { action: "deleted", installation: { id: installation.id, account: { login: "lib-org" } } });
    if (typeof gone === "string") throw new Error(gone);
    await world.directory.applyWebhook("delivery-uninstall", gone);
    expect(await world.storage.get(`purging:${lib.id}`)).toBeDefined();
    // An uninstalled repository covers nothing: GitHub is asked, and shows it public.
    expect(await world.read(null, lib)).toEqual(record(lib));
    expect(await world.storage.get(`repo:${lib.id}`)).toMatchObject({ installation: null, publicOnly: true, removed: false });
    expect(await world.storage.get(`purging:${lib.id}`)).toBeUndefined();
  });

  it("leaves an installed record alone when a lookup finds the name covered by the app's own records", async () => {
    const { world } = lonelyWorld({ publicRead: true });
    await world.setup();
    // The name index lost an installed repository (as after a rename): resolving must not re-register over it.
    await world.storage.delete([`name:octo/open-docs`]);
    expect(await world.directory.authorize(world.userIds.outsider, "octo", "open-docs")).toBeNull();
    expect(await world.storage.get(`repo:${world.open.id}`)).toMatchObject({ installation: 71 });
    expect(await world.storage.get(`repo:${world.open.id}`)).not.toHaveProperty("publicOnly", true);
  });
});
