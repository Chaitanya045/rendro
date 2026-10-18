import { beforeEach, describe, expect, it } from "vitest";
import { kvRevocationEpochs } from "../src/repo-read/access";
import { authorizeRepo, CAPABILITY_TTL_SECONDS, clearAuthorizationMemory, mintTicket, authorizeTicket, type AuthorizeDependencies, type Viewer } from "../src/repo-read/authorize";
import { accessFixture } from "./helpers/repo-access-fixture";

/**
 * Revocation end to end (#243): the serving Worker's real authorization
 * (#234: capability cookie, epoch, permission source) over the access
 * directory and a shared epoch store. The fake KV propagates at once, so the
 * bound here is the read path's own; docs/TECHNICAL.md adds KV propagation.
 */

const SECRET = "test-repo-capability-secret-32-chars";
const sessions: Record<string, string> = { "member-session": "user-member", "reader-session": "user-reader" };

function readPath(world: ReturnType<typeof accessFixture>) {
  const background: Array<Promise<unknown>> = [];
  const deps: AuthorizeDependencies = {
    secret: SECRET, permissions: world.directory, epochs: kvRevocationEpochs(world.kv),
    identity: (request) => {
      const token = /better-auth\.session_token=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      const id = token ? sessions[token] : undefined;
      return Promise.resolve<Viewer>(id ? { kind: "user", id } : { kind: "anonymous" });
    },
    now: world.clock.now, waitUntil: (promise) => background.push(promise),
  };
  let jar: Record<string, string> = {};
  async function view(session: string | null, repo: { owner: string; name: string }) {
    const cookie = [session ? `better-auth.session_token=${session}` : "", ...Object.entries(jar).map(([name, value]) => `${name}=${value}`)].filter(Boolean).join("; ");
    const result = await authorizeRepo(deps, new Request(`https://rendro.test/r/${repo.owner}/${repo.name}`, { headers: { cookie } }), repo.owner, repo.name);
    for (const set of "cookies" in result ? result.cookies : []) {
      const [pair] = set.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (value) jar[name] = value;
      else delete jar[name];
    }
    await Promise.all(background.splice(0));
    return result.kind;
  }
  return { deps, view, clear: () => { jar = {}; }, jar: () => jar };
}

beforeEach(() => clearAuthorizationMemory());

describe("revocation through the read path", () => {
  it("denies a reader removed from a team on the very next view, with their cookie and tickets", async () => {
    const world = accessFixture();
    await world.setup();
    const read = readPath(world);
    expect(await read.view("member-session", world.teamDocs)).toBe("granted");
    expect(Object.keys(read.jar())).toEqual(["__Host-rendro-repo.803"]);
    // The cookie answers on its own: no permission lookups while it is valid.
    const requests = world.github.requests.length;
    expect(await read.view("member-session", world.teamDocs)).toBe("granted");
    expect(world.github.requests.length).toBe(requests);
    const grant = await authorizeRepo(read.deps, new Request("https://rendro.test/", { headers: { cookie: `better-auth.session_token=member-session; __Host-rendro-repo.803=${read.jar()["__Host-rendro-repo.803"]}` } }), "octo", "team-docs");
    const ticket = await mintTicket(read.deps, (grant as { grant: Parameters<typeof mintTicket>[1] }).grant, "a".repeat(40));
    expect((await authorizeTicket(read.deps, ticket, "octo", "team-docs", "a".repeat(40))).kind).toBe("granted");

    world.clock.time += 1_000;
    world.team.members.delete(world.people.member.id);
    await world.deliver("membership", { action: "removed", member: world.userPayload(world.people.member) });
    expect(await read.view("member-session", world.teamDocs)).toBe("denied");
    expect(read.jar()).toEqual({});
    expect((await authorizeTicket(read.deps, ticket, "octo", "team-docs", "a".repeat(40))).kind).toBe("denied");
    // Another reader is untouched.
    expect(await read.view("reader-session", world.closed)).toBe("granted");
  });

  it("without a webhook, ends a grant within the mirror TTL plus the cookie's lifetime", async () => {
    const world = accessFixture();
    await world.setup();
    const read = readPath(world);
    expect(await read.view("member-session", world.teamDocs)).toBe("granted");
    // GitHub changes, but no event arrives (enterprise policy, a lost delivery).
    world.team.members.delete(world.people.member.id);
    let deniedAfter = 0;
    for (let seconds = 0; seconds <= 15 * 60; seconds += 30) {
      world.clock.time += 30_000;
      if (await read.view("member-session", world.teamDocs) === "denied") {
        deniedAfter = seconds + 30;
        break;
      }
    }
    expect(deniedAfter).toBeGreaterThan(0);
    expect(deniedAfter * 1000).toBeLessThanOrEqual(5 * 60_000 + CAPABILITY_TTL_SECONDS * 1000);
  });

  it("denies anonymous readers of a repository made private once the serving isolate's public memory expires", async () => {
    const world = accessFixture();
    await world.setup();
    const read = readPath(world);
    expect(await read.view(null, world.open)).toBe("granted");
    world.open.isPrivate = true;
    await world.deliver("repository", { action: "privatized", ...world.repoPayload(world.open) });
    // The isolate remembers a public repository for a minute (#234), then asks again.
    world.clock.time += 59_000;
    expect(await read.view(null, world.open)).toBe("granted");
    world.clock.time += 1_000;
    expect(await read.view(null, world.open)).toBe("denied");
  });

  it("denies everyone after an uninstall, and 503s rather than allowing when GitHub is down past the TTL", async () => {
    const world = accessFixture();
    await world.setup();
    const read = readPath(world);
    expect(await read.view("reader-session", world.closed)).toBe("granted");
    world.clock.time += CAPABILITY_TTL_SECONDS * 1000;
    world.github.fault(() => true, () => new Response("down", { status: 502 }), 1_000);
    world.clock.time += 5 * 60_000;
    expect(await read.view("reader-session", world.closed)).toBe("unavailable");

    const fresh = accessFixture();
    await fresh.setup();
    const other = readPath(fresh);
    clearAuthorizationMemory();
    expect(await other.view("reader-session", fresh.closed)).toBe("granted");
    expect(await other.view(null, fresh.open)).toBe("granted");
    fresh.github.installations.delete(fresh.installation.id);
    await fresh.deliver("installation", { action: "deleted" });
    expect(await other.view("reader-session", fresh.closed)).toBe("denied");
    clearAuthorizationMemory();
    expect(await other.view(null, fresh.open)).toBe("denied");
  });
});
