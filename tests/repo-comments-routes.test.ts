import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "@/worker";
import { COMMENTOR_STYLE_HASH } from "@/commentor/style-hash";
import { COMMENTOR_STYLES } from "@/commentor/styles";
import { clearCommentGrantMemory, commentAccess, convexCommentGrants, type CommentGrants } from "@/repo-read/comments";
import { CAPABILITY_TTL_SECONDS } from "@/repo-read/authorize";
import { issueGrant } from "@/repo-read/grant";
import { parseRepoPath } from "@/repo-read/paths";
import { COMMENTOR_PARENT_VERSION } from "@/viewer/asset-versions";
import { privateRepo, publicRepo, repoReadFixture, sessionCookies, stubSessions, users } from "./helpers/repo-read-fixture";

const ORIGIN = "https://rendro.test";
const pub = `/r/${publicRepo.owner}/${publicRepo.name}`;
const priv = `/r/${privateRepo.owner}/${privateRepo.name}`;

let fixture: Awaited<ReturnType<typeof repoReadFixture>>;
let grants: Array<Record<string, unknown>>;
let convex: { answer: (args: Record<string, unknown>) => Response };

beforeEach(async () => {
  // Cookie writes are pinned to the canonical site, which these fixtures serve.
  vi.stubEnv("SITE_URL", ORIGIN);
  fixture = await repoReadFixture();
  clearCommentGrantMemory();
  stubSessions();
  grants = [];
  convex = { answer: args => Response.json({ status: "success", value: { granted: true, expiresAt: args.expiresAt } }) };
  const sessions = globalThis.fetch;
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${process.env.CONVEX_URL}/api/mutation`) {
      const { path, args: [args] } = JSON.parse(init?.body as string) as { path: string; args: [Record<string, unknown>] };
      expect(path).toBe("repoCommentAccess:grant");
      expect(args.internalSecret).toBe(process.env.CONVEX_INTERNAL_SECRET);
      const { internalSecret: _secret, ...recorded } = args;
      grants.push(recorded);
      return Promise.resolve(convex.answer(args));
    }
    return sessions(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return app.request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers: init.headers ?? {} }, fixture.env, fixture.ctx);
}

function access(base: string, headers: Record<string, string> = {}) {
  return request(`${base}/comment-access`, { method: "POST", headers: { Origin: ORIGIN, ...headers } });
}

function capability(response: Response): string {
  const cookie = response.headers.getSetCookie().find(value => /^__Host-rendro-repo\.\d+=v1\./.test(value));
  if (!cookie) throw new Error("No capability cookie");
  return cookie.split(";", 1)[0];
}

function expectPlainNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Retry-After")).toBeNull();
}

describe("the repository shell carries the one comments connection", () => {
  it.each([["public", pub, publicRepo.id], ["private", priv, privateRepo.id]])("configures comments in the %s shell", async (_kind, base, repoId) => {
    const response = await request(base, { headers: { cookie: sessionCookies.reader } });
    const html = await response.text();
    const config = /window\.RENDRO_REPO_COMMENT_CONFIG=(\{[^;]+\});/.exec(html)?.[1];
    expect(JSON.parse(config ?? "null")).toEqual({ repoId, accessUrl: `${base}/comment-access`, convexUrl: process.env.CONVEX_URL });
    expect(html).toContain(`src="/commentor-parent.js?v=${COMMENTOR_PARENT_VERSION}"`);
  });

  it("allows the widget's one stylesheet in frames by hash, never 'unsafe-inline'", async () => {
    const { createHash } = await import("node:crypto");
    expect(COMMENTOR_STYLE_HASH).toBe(`'sha256-${createHash("sha256").update(COMMENTOR_STYLES).digest("base64")}'`);
    const frame = await request(`${pub}/@${fixture.commits.public}/files/docs/index.md`);
    expect(frame.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
    expect(frame.headers.get("Content-Security-Policy")).not.toContain("connect-src");
  });

  it("gives a page ingest could not render no widget", async () => {
    const frame = await request(`${pub}/@${fixture.commits.public}/files/docs/huge.md`);
    expect(await frame.text()).not.toContain("commentor.js");
  });
});

describe("comment access mirrors read access", () => {
  it("grants anyone a public repository's comments, once per isolate while the grant is fresh", async () => {
    const before = Date.now();
    const response = await access(pub);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = await response.json() as { repoId: number; private: boolean; expiresAt: number };
    expect(body).toEqual({ repoId: publicRepo.id, private: false, expiresAt: expect.any(Number) });
    expect(body.expiresAt - before).toBeLessThanOrEqual(60_000 + 50);
    expect(grants).toEqual([{ repoId: publicRepo.id, userId: null, epoch: 0, expiresAt: body.expiresAt }]);
    // A signed-in reader of a public repository holds the same public grant.
    expect((await access(pub, { cookie: sessionCookies.reader })).status).toBe(200);
    expect(grants).toHaveLength(1);
  });

  it("grants a private repository's comments to its reader only, at the epoch the read path checked", async () => {
    fixture.access.epochs.set(users.reader, 42);
    for (const headers of [{}, { cookie: sessionCookies.outsider }] as Array<Record<string, string>>) expectPlainNotFound(await access(priv, headers));
    expect(grants).toEqual([]);
    const granted = await access(priv, { cookie: sessionCookies.reader });
    expect(granted.status).toBe(200);
    const body = await granted.json() as { expiresAt: number };
    expect(body).toEqual({ repoId: privateRepo.id, private: true, expiresAt: expect.any(Number) });
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(CAPABILITY_TTL_SECONDS * 1000);
    expect(grants).toEqual([{ repoId: privateRepo.id, userId: users.reader, epoch: 42, expiresAt: body.expiresAt }]);
    // The capability cookie answers the next request: no session lookup, no permission source, no second write.
    const cookie = `${sessionCookies.reader}; ${capability(granted)}`;
    const calls = fixture.access.calls.authorize.length;
    expect((await access(priv, { cookie })).status).toBe(200);
    expect(fixture.access.calls.authorize.length).toBe(calls);
    expect(grants).toHaveLength(1);
  });

  it("never grants past the capability cookie it rests on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const granted = await access(priv, { cookie: sessionCookies.reader });
    const cookie = `${sessionCookies.reader}; ${capability(granted)}`;
    const cookieExpiry = Math.floor(Date.now() / 1000) * 1000 + CAPABILITY_TTL_SECONDS * 1000;
    vi.setSystemTime(Date.now() + 2 * 60_000);
    clearCommentGrantMemory();
    await access(priv, { cookie });
    expect(grants.at(-1)?.expiresAt).toBeLessThanOrEqual(cookieExpiry);
  });

  it("decides again when the memory or cookie behind a grant would end before the shell's next renewal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await access(pub)).status).toBe(200);
    const asked = () => fixture.access.calls.authorize.length;
    const before = asked();
    // 40 s into the isolate's one-minute public memory: a page view would still use it; comment access asks again.
    vi.setSystemTime(Date.now() + 40_000);
    clearCommentGrantMemory();
    const renewed = await access(pub);
    expect(asked()).toBe(before + 1);
    expect((await renewed.json() as { expiresAt: number }).expiresAt - Date.now()).toBeGreaterThan(55_000);

    const granted = await access(priv, { cookie: sessionCookies.reader });
    const cookie = `${sessionCookies.reader}; ${capability(granted)}`;
    // 24 s left on the capability cookie: decided again (session, epoch, source), with a fresh cookie and a full grant.
    vi.setSystemTime(Date.now() + CAPABILITY_TTL_SECONDS * 1000 - 24_000);
    const calls = asked();
    const fresh = await access(priv, { cookie });
    expect(asked()).toBe(calls + 1);
    expect(fresh.headers.getSetCookie().some(value => /^__Host-rendro-repo\.502=v1\./.test(value))).toBe(true);
    expect((await fresh.json() as { expiresAt: number }).expiresAt - Date.now()).toBeGreaterThan(CAPABILITY_TTL_SECONDS * 1000 - 1_000);
  });

  it("stops at once when the reader's epoch moves: the next request is decided again and denied", async () => {
    const granted = await access(priv, { cookie: sessionCookies.reader });
    const cookie = `${sessionCookies.reader}; ${capability(granted)}`;
    fixture.access.revoke(users.reader, privateRepo.id);
    expectPlainNotFound(await access(priv, { cookie }));
    expect(grants).toHaveLength(1);
  });

  it("answers like a missing repository when Convex refuses the grant (revoked or removed meanwhile)", async () => {
    convex.answer = () => Response.json({ status: "success", value: { granted: false } });
    expectPlainNotFound(await access(pub));
  });

  it("is a retryable 503 when Convex or the permission source cannot answer", async () => {
    convex.answer = () => new Response("down", { status: 503 });
    const response = await access(pub);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    fixture.access.unavailable = true;
    const unknown = await access(priv, { cookie: sessionCookies.reader });
    expect(unknown.status).toBe(503);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("answers only a same-origin POST, and only at the repository's own URL", async () => {
    for (const response of [
      await request(`${pub}/comment-access`),
      await access(pub, { Origin: "https://evil.test" }),
      await access(pub, { "Sec-Fetch-Site": "cross-site" }),
      await request(`${pub}/comment-access`, { method: "POST" }),
      await request(`${pub}/@${fixture.commits.public}/comment-access`, { method: "POST", headers: { Origin: ORIGIN } }),
      await request(`${pub}/~main/comment-access`, { method: "POST", headers: { Origin: ORIGIN } }),
      await request(`${pub}/files/docs/index.md`, { method: "POST", headers: { Origin: ORIGIN } }),
      await request(`/r/not a name/x/comment-access`, { method: "POST", headers: { Origin: ORIGIN } }),
    ]) expectPlainNotFound(response);
    expect(grants).toEqual([]);
    expect(parseRepoPath(`${pub}/comment-access`)?.target).toEqual({ kind: "comment-access" });
  });

  it("pins same-origin to the request's own origin when no canonical site is configured", async () => {
    vi.stubEnv("SITE_URL", undefined);
    expect((await access(pub)).status).toBe(200);
    expectPlainNotFound(await access(pub, { Origin: "https://evil.test" }));
  });

  it("is a 404 where the read path is not configured", async () => {
    const response = await app.request(`${ORIGIN}${pub}/comment-access`, { method: "POST", headers: { Origin: ORIGIN } }, {}, fixture.ctx);
    expectPlainNotFound(response);
  });
});

describe("commentAccess", () => {
  const recorder = (answer: number | null) => {
    const calls: unknown[] = [];
    const grants: CommentGrants = { record: input => { calls.push(input); return Promise.resolve(answer ?? null); } };
    return { calls, grants };
  };

  it("records nothing for an authorization that has already lapsed", async () => {
    const { calls, grants } = recorder(1);
    expect(await commentAccess(grants, issueGrant(publicRepo, null, 0, 1_000), 1_000)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("records again past half the grant, per reader and epoch, and forgets refusals", async () => {
    clearCommentGrantMemory();
    const { calls, grants } = recorder(61_000);
    const grant = issueGrant(privateRepo, "u", 3, 61_000);
    expect(await commentAccess(grants, grant, 1_000)).toEqual({ expiresAt: 61_000 });
    expect(await commentAccess(grants, grant, 30_000)).toEqual({ expiresAt: 61_000 });
    expect(calls).toHaveLength(1);
    expect(await commentAccess(grants, grant, 31_001)).toEqual({ expiresAt: 61_000 });
    expect(calls).toHaveLength(2);
    await commentAccess(grants, issueGrant(privateRepo, "u", 4, 61_000), 1_000);
    expect(calls).toHaveLength(3);
    const refusing = recorder(null);
    expect(await commentAccess(refusing.grants, issueGrant(privateRepo, "v", 0, 61_000), 1_000)).toBeNull();
    expect(await commentAccess(refusing.grants, issueGrant(privateRepo, "v", 0, 61_000), 1_000)).toBeNull();
    expect(refusing.calls).toHaveLength(2);
  });

  it("keeps a bounded memory", async () => {
    clearCommentGrantMemory();
    const { calls, grants } = recorder(100_000);
    for (let index = 0; index <= 1_024; index += 1) await commentAccess(grants, issueGrant({ ...publicRepo, id: index + 1 }, null, 0, 100_000), 0);
    // The oldest entry was evicted, so it is recorded again; the newest is still remembered.
    await commentAccess(grants, issueGrant({ ...publicRepo, id: 1 }, null, 0, 100_000), 0);
    await commentAccess(grants, issueGrant({ ...publicRepo, id: 1_025 }, null, 0, 100_000), 0);
    expect(calls).toHaveLength(1_026);
  });

  it("reads Convex's answer strictly", async () => {
    const stub = (value: unknown) => {
      globalThis.fetch = vi.fn(() => Promise.resolve(Response.json({ status: "success", value }))) as typeof fetch;
    };
    const input = { repoId: 1, userId: null, epoch: 0, expiresAt: 5 };
    stub({ granted: true, expiresAt: 5 });
    expect(await convexCommentGrants.record(input)).toBe(5);
    stub({ granted: true });
    expect(await convexCommentGrants.record(input)).toBeNull();
    stub({ granted: false });
    expect(await convexCommentGrants.record(input)).toBeNull();
    stub(null);
    await expect(convexCommentGrants.record(input)).resolves.toBeNull();
  });
});
