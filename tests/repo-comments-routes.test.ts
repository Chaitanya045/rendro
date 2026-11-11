import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "@/worker";
import { COMMENTOR_STYLE_HASH } from "@/commentor/style-hash";
import { COMMENTOR_STYLES } from "@/commentor/styles";
import { clearCommentGrantMemory, commentAccess, commentReader, convexCommentGrants, convexCommentSnapshots, type CommentGrants } from "@/repo-read/comments";
import { CAPABILITY_TTL_SECONDS } from "@/repo-read/authorize";
import { issueGrant } from "@/repo-read/grant";
import { parseRepoPath } from "@/repo-read/paths";
import { COMMENTOR_PARENT_VERSION } from "@/viewer/asset-versions";
import { privateRepo, publicRepo, repoReadFixture, sessionCookies, stubSessions, users } from "./helpers/repo-read-fixture";

const ORIGIN = "https://rendro.test";
// The canonical site is HTTPS, so sessions travel under the host-only names (#208).
const sessions = { reader: `__Host-${sessionCookies.reader}`, outsider: `__Host-${sessionCookies.outsider}` } as const;
const pub = `/r/${publicRepo.owner}/${publicRepo.name}`;
const priv = `/r/${privateRepo.owner}/${privateRepo.name}`;

let fixture: Awaited<ReturnType<typeof repoReadFixture>>;
let grants: Array<Record<string, unknown>>;
let moderatorGrants: Array<Record<string, unknown>>;
let snapshots: Array<Record<string, unknown>>;
let convex: { answer: (args: Record<string, unknown>) => Response; moderator: (args: Record<string, unknown>) => Response; snapshot: (args: Record<string, unknown>) => Response };
const page = [{ _id: "t1", body: "First" }];

beforeEach(async () => {
  // Cookie writes are pinned to the canonical site, which these fixtures serve.
  vi.stubEnv("SITE_URL", ORIGIN);
  fixture = await repoReadFixture();
  clearCommentGrantMemory();
  stubSessions({ "reader-token.sig": users.reader, "outsider-token.sig": users.outsider, "down-token.sig": "down" });
  grants = [];
  moderatorGrants = [];
  snapshots = [];
  convex = {
    answer: args => Response.json({ status: "success", value: { granted: true, expiresAt: args.expiresAt } }),
    moderator: args => Response.json({ status: "success", value: { granted: true, expiresAt: args.expiresAt } }),
    snapshot: () => Response.json({ status: "success", value: { page, isDone: false, continueCursor: "c" } }),
  };
  const sessions = globalThis.fetch;
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${process.env.CONVEX_URL}/api/query`) {
      const { path, args: [args] } = JSON.parse(init?.body as string) as { path: string; args: [Record<string, unknown>] };
      expect(path).toBe("repoComments:threadSnapshot");
      expect(args.internalSecret).toBe(process.env.CONVEX_INTERNAL_SECRET);
      const { internalSecret: _secret, ...asked } = args;
      snapshots.push(asked);
      return Promise.resolve(convex.snapshot(args));
    }
    if (url === `${process.env.CONVEX_URL}/api/mutation`) {
      const { path, args: [args] } = JSON.parse(init?.body as string) as { path: string; args: [Record<string, unknown>] };
      expect(["repoCommentAccess:grant", "repoCommentAccess:grantModerator"]).toContain(path);
      expect(args.internalSecret).toBe(process.env.CONVEX_INTERNAL_SECRET);
      const { internalSecret: _secret, ...recorded } = args;
      (path === "repoCommentAccess:grant" ? grants : moderatorGrants).push(recorded);
      return Promise.resolve(path === "repoCommentAccess:grant" ? convex.answer(args) : convex.moderator(args));
    }
    return sessions(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Every read needs a signed-in reader (#354): without a cookie of its own a request is the outsider's. */
function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return app.request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers: { cookie: sessions.outsider, ...init.headers } }, fixture.env, fixture.ctx);
}

function access(base: string, headers: Record<string, string> = {}, query = "") {
  return request(`${base}/comment-access${query}`, { method: "POST", headers: { Origin: ORIGIN, ...headers } });
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

describe("the repository shell carries the one comments connection, for private repositories only (#353)", () => {
  it("configures comments in a private shell", async () => {
    const response = await request(priv, { headers: { cookie: sessions.reader } });
    const html = await response.text();
    const config = /window\.RENDRO_REPO_COMMENT_CONFIG=(\{[^;]+\});/.exec(html)?.[1];
    expect(JSON.parse(config ?? "null")).toEqual({ repoId: privateRepo.id, accessUrl: `${priv}/comment-access`, convexUrl: process.env.CONVEX_URL, documentPath: "docs/index.md" });
    expect(html).toContain(`src="/commentor-parent.js?v=${COMMENTOR_PARENT_VERSION}"`);
  });

  it("gives a public shell no comment configuration and no comments script", async () => {
    const response = await request(pub, { headers: { cookie: sessions.reader } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("RENDRO_REPO_COMMENT_CONFIG");
    expect(html).not.toContain("commentor-parent.js");
    expect(html).not.toContain("comment-access");
  });

  it("allows the widget's one stylesheet in frames by hash, never 'unsafe-inline'", async () => {
    const { createHash } = await import("node:crypto");
    expect(COMMENTOR_STYLE_HASH).toBe(`'sha256-${createHash("sha256").update(COMMENTOR_STYLES).digest("base64")}'`);
    const frame = await request(`${priv}/@${fixture.commits.private}/files/docs/index.md`, { headers: { cookie: sessions.reader } });
    expect(frame.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
    expect(frame.headers.get("Content-Security-Policy")).not.toContain("connect-src");
  });

  it("puts the widget in a private frame, with the repository and page it shows", async () => {
    const frame = await request(`${priv}/@${fixture.commits.private}/files/docs/index.md`, { headers: { cookie: sessions.reader } });
    const html = await frame.text();
    expect(html).toContain("commentor.js");
    expect(html).toContain(`&quot;repoId&quot;:${privateRepo.id}`);
  });

  it("gives a public frame no widget and no configuration", async () => {
    const frame = await request(`${pub}/@${fixture.commits.public}/files/docs/index.md`);
    expect(frame.status).toBe(200);
    const html = await frame.text();
    expect(html).not.toContain("commentor.js");
    expect(html).not.toContain("data-commentor-config");
  });

  it("gives a page ingest could not render no widget", async () => {
    const frame = await request(`${priv}/@${fixture.commits.private}/files/docs/huge.md`, { headers: { cookie: sessions.reader } });
    expect(await frame.text()).not.toContain("commentor.js");
  });
});

describe("comment access mirrors read access", () => {
  it("is the read path's plain 404 for a public repository, and records or asks nothing of comments", async () => {
    // Both are signed in (every read needs a reader, #354) and may read the repository, so the read path may issue
    // their read cookie; what must not happen is any comment grant, snapshot or moderation lookup.
    for (const headers of [{ cookie: sessions.reader }, { cookie: sessions.outsider }]) {
      for (const query of ["", "?path=docs%2Fguide.md"]) {
        const response = await access(pub, headers, query);
        expectPlainNotFound(response);
        expect(await response.json()).toEqual({ error: "Not found" });
      }
    }
    fixture.access.moderate(users.reader, publicRepo.id, "admin");
    expectPlainNotFound(await access(pub, { cookie: sessions.reader }, "?path=docs%2Fguide.md"));
    expect(grants).toEqual([]);
    expect(moderatorGrants).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(fixture.access.calls.moderation).toEqual([]);
  });

  it("grants a private repository's comments to its reader only, at the epoch the read path checked", async () => {
    fixture.access.epochs.set(users.reader, 42);
    for (const headers of [{}, { cookie: sessions.outsider }] as Array<Record<string, string>>) expectPlainNotFound(await access(priv, headers));
    expect(grants).toEqual([]);
    const granted = await access(priv, { cookie: sessions.reader });
    expect(granted.status).toBe(200);
    const body = await granted.json() as { expiresAt: number };
    expect(body).toEqual({ repoId: privateRepo.id, expiresAt: expect.any(Number) });
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(CAPABILITY_TTL_SECONDS * 1000);
    expect(grants).toEqual([{ repoId: privateRepo.id, userId: users.reader, epoch: 42, expiresAt: body.expiresAt }]);
    // The capability cookie answers the next request: no session lookup, no permission source, no second write.
    const cookie = `${sessions.reader}; ${capability(granted)}`;
    const calls = fixture.access.calls.authorize.length;
    expect((await access(priv, { cookie })).status).toBe(200);
    expect(fixture.access.calls.authorize.length).toBe(calls);
    expect(grants).toHaveLength(1);
  });

  it("never grants past the capability cookie it rests on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const granted = await access(priv, { cookie: sessions.reader });
    const cookie = `${sessions.reader}; ${capability(granted)}`;
    const cookieExpiry = Math.floor(Date.now() / 1000) * 1000 + CAPABILITY_TTL_SECONDS * 1000;
    vi.setSystemTime(Date.now() + 2 * 60_000);
    clearCommentGrantMemory();
    await access(priv, { cookie });
    expect(grants.at(-1)?.expiresAt).toBeLessThanOrEqual(cookieExpiry);
  });

  it("decides again when the cookie behind a grant would end before the shell's next renewal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const asked = () => fixture.access.calls.authorize.length;
    const granted = await access(priv, { cookie: sessions.reader });
    const cookie = `${sessions.reader}; ${capability(granted)}`;
    // 24 s left on the capability cookie: decided again (session, epoch, source), with a fresh cookie and a full grant.
    vi.setSystemTime(Date.now() + CAPABILITY_TTL_SECONDS * 1000 - 24_000);
    const calls = asked();
    const fresh = await access(priv, { cookie });
    expect(asked()).toBe(calls + 1);
    expect(fresh.headers.getSetCookie().some(value => /^__Host-rendro-repo\.502=v1\./.test(value))).toBe(true);
    expect((await fresh.json() as { expiresAt: number }).expiresAt - Date.now()).toBeGreaterThan(CAPABILITY_TTL_SECONDS * 1000 - 1_000);
  });

  it("stops at once when the reader's epoch moves: the next request is decided again and denied", async () => {
    const granted = await access(priv, { cookie: sessions.reader });
    const cookie = `${sessions.reader}; ${capability(granted)}`;
    fixture.access.revoke(users.reader, privateRepo.id);
    expectPlainNotFound(await access(priv, { cookie }));
    expect(grants).toHaveLength(1);
  });

  it("answers like a missing repository when Convex refuses the grant (revoked or removed meanwhile)", async () => {
    convex.answer = () => Response.json({ status: "success", value: { granted: false } });
    expectPlainNotFound(await access(priv, { cookie: sessions.reader }));
  });

  it("is a retryable 503 when Convex or the permission source cannot answer", async () => {
    convex.answer = () => new Response("down", { status: 503 });
    const response = await access(priv, { cookie: sessions.reader });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    fixture.access.unavailable = true;
    const unknown = await access(priv, { cookie: sessions.reader });
    expect(unknown.status).toBe(503);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("answers only a same-origin POST, and only at the repository's own URL", async () => {
    const reader = { cookie: sessions.reader };
    for (const response of [
      await request(`${priv}/comment-access`, { headers: reader }),
      await access(priv, { ...reader, Origin: "https://evil.test" }),
      await access(priv, { ...reader, "Sec-Fetch-Site": "cross-site" }),
      await request(`${priv}/comment-access`, { method: "POST", headers: reader }),
      await request(`${priv}/@${fixture.commits.private}/comment-access`, { method: "POST", headers: { Origin: ORIGIN, ...reader } }),
      await request(`${priv}/~main/comment-access`, { method: "POST", headers: { Origin: ORIGIN, ...reader } }),
      await request(`${priv}/files/docs/index.md`, { method: "POST", headers: { Origin: ORIGIN, ...reader } }),
      await request(`/r/not a name/x/comment-access`, { method: "POST", headers: { Origin: ORIGIN, ...reader } }),
    ]) expectPlainNotFound(response);
    expect(grants).toEqual([]);
    expect(parseRepoPath(`${priv}/comment-access`)?.target).toEqual({ kind: "comment-access" });
  });

  it("pins same-origin to the request's own origin when no canonical site is configured", async () => {
    vi.stubEnv("SITE_URL", undefined);
    expect((await access(priv, { cookie: sessions.reader })).status).toBe(200);
    expectPlainNotFound(await access(priv, { cookie: sessions.reader, Origin: "https://evil.test" }));
  });

  it("is a 404 where the read path is not configured", async () => {
    const response = await app.request(`${ORIGIN}${priv}/comment-access`, { method: "POST", headers: { Origin: ORIGIN } }, {}, fixture.ctx);
    expectPlainNotFound(response);
  });
});

describe("the first comments come with the first access answer (#284)", () => {
  const first = "?path=docs%2Fguide.md";

  it("hands a private repository's first page to its reader only, at the epoch the read path checked", async () => {
    fixture.access.epochs.set(users.reader, 7);
    for (const headers of [{}, { cookie: sessions.outsider }] as Array<Record<string, string>>) {
      const denied = await access(priv, headers, first);
      expectPlainNotFound(denied);
      expect(await denied.json()).toEqual({ error: "Not found" });
    }
    // A reader without access never reaches Convex: no grant and no page is asked for.
    expect(snapshots).toEqual([]);
    const granted = await access(priv, { cookie: sessions.reader }, first);
    expect(granted.headers.get("Cache-Control")).toBe("private, no-store");
    expect(granted.headers.get("ETag")).toBeNull();
    expect(await granted.json()).toEqual({ repoId: privateRepo.id, expiresAt: expect.any(Number), threads: { path: "docs/guide.md", page, isDone: false } });
    expect(snapshots).toEqual([{ repoId: privateRepo.id, path: "docs/guide.md", userId: users.reader, epoch: 7 }]);
  });

  it("drops the page when Convex refuses the grant: the answer is the plain 404", async () => {
    convex.answer = () => Response.json({ status: "success", value: { granted: false } });
    const response = await access(priv, { cookie: sessions.reader }, first);
    expectPlainNotFound(response);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("still grants when the page cannot be read, or is not a repository path; the live subscription delivers it", async () => {
    const reader = { cookie: sessions.reader };
    convex.snapshot = () => new Response("down", { status: 503 });
    expect(await (await access(priv, reader, first)).json()).not.toHaveProperty("threads");
    convex.snapshot = () => Response.json({ status: "success", value: { page: "nope" } });
    clearCommentGrantMemory();
    expect(await (await access(priv, reader, first)).json()).not.toHaveProperty("threads");
    const asked = snapshots.length;
    for (const query of ["?path=", "?path=..%2Fx.md", "?path=a%2F%2Fb.md", `?path=${"a".repeat(1_025)}`]) {
      const response = await access(priv, reader, query);
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("threads");
    }
    expect(snapshots).toHaveLength(asked);
  });

  it("reads Convex's page strictly", async () => {
    const stub = (value: unknown) => {
      globalThis.fetch = vi.fn(() => Promise.resolve(Response.json({ status: "success", value }))) as typeof fetch;
    };
    const input = { repoId: 1, path: "a.md", userId: "u", epoch: 0 };
    stub({ page: [1], isDone: true });
    expect(await convexCommentSnapshots.threads(input)).toEqual({ page: [1], isDone: true });
    stub({ page: [1] });
    expect(await convexCommentSnapshots.threads(input)).toBeNull();
    stub(null);
    expect(await convexCommentSnapshots.threads(input)).toBeNull();
  });
});

describe("commentAccess", () => {
  const recorder = (answer: number | null) => {
    const calls: unknown[] = [];
    const grants: CommentGrants = {
      record: input => { calls.push(input); return Promise.resolve(answer ?? null); },
      recordModerator: input => { calls.push(input); return Promise.resolve(answer ?? null); },
    };
    return { calls, grants };
  };

  it("records nothing for an authorization that has already lapsed", async () => {
    const { calls, grants } = recorder(1);
    expect(await commentAccess(grants, issueGrant(privateRepo, "u", 0, 1_000), "u", 1_000)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("records again past half the grant, per reader and epoch, and forgets refusals", async () => {
    clearCommentGrantMemory();
    const { calls, grants } = recorder(61_000);
    const grant = issueGrant(privateRepo, "u", 3, 61_000);
    expect(await commentAccess(grants, grant, "u", 1_000)).toEqual({ expiresAt: 61_000 });
    expect(await commentAccess(grants, grant, "u", 30_000)).toEqual({ expiresAt: 61_000 });
    expect(calls).toHaveLength(1);
    expect(await commentAccess(grants, grant, "u", 31_001)).toEqual({ expiresAt: 61_000 });
    expect(calls).toHaveLength(2);
    await commentAccess(grants, issueGrant(privateRepo, "u", 4, 61_000), "u", 1_000);
    expect(calls).toHaveLength(3);
    const refusing = recorder(null);
    expect(await commentAccess(refusing.grants, issueGrant(privateRepo, "v", 0, 61_000), "v", 1_000)).toBeNull();
    expect(await commentAccess(refusing.grants, issueGrant(privateRepo, "v", 0, 61_000), "v", 1_000)).toBeNull();
    expect(refusing.calls).toHaveLength(2);
  });

  it("keeps a bounded memory", async () => {
    clearCommentGrantMemory();
    const { calls, grants } = recorder(100_000);
    for (let index = 0; index <= 1_024; index += 1) await commentAccess(grants, issueGrant({ ...privateRepo, id: index + 1 }, "u", 0, 100_000), "u", 0);
    // The oldest entry was evicted, so it is recorded again; the newest is still remembered.
    await commentAccess(grants, issueGrant({ ...privateRepo, id: 1 }, "u", 0, 100_000), "u", 0);
    await commentAccess(grants, issueGrant({ ...privateRepo, id: 1_025 }, "u", 0, 100_000), "u", 0);
    expect(calls).toHaveLength(1_026);
  });

  it("reads Convex's answer strictly", async () => {
    const stub = (value: unknown) => {
      globalThis.fetch = vi.fn(() => Promise.resolve(Response.json({ status: "success", value }))) as typeof fetch;
    };
    const input = { repoId: 1, userId: "u", epoch: 0, expiresAt: 5 };
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

describe("commentReader", () => {
  it("is a private repository's own reader, and nobody for a public repository", () => {
    expect(commentReader(issueGrant(privateRepo, "u", 0, 1))).toBe("u");
    expect(commentReader(issueGrant(privateRepo, null, 0, 1))).toBeNull();
    expect(commentReader(issueGrant(publicRepo, null, 0, 1))).toBeNull();
    expect(commentReader(issueGrant(publicRepo, "u", 0, 1))).toBeNull();
  });
});

describe("moderators of a repository's comments (#259)", () => {
  const first = "?path=docs%2Fguide.md";

  it("records a maintainer's role for a private repository once the read grant is, and reads their page as a moderator's", async () => {
    fixture.access.epochs.set(users.reader, 42);
    fixture.access.moderate(users.reader, privateRepo.id, "maintain");
    const granted = await access(priv, { cookie: sessions.reader }, first);
    expect(granted.status).toBe(200);
    const { expiresAt } = await granted.json() as { expiresAt: number };
    // The private grant's own epoch (the one the read path checked) orders the role, and it expires with the read grant.
    expect(moderatorGrants).toEqual([{ repoId: privateRepo.id, userId: users.reader, role: "maintain", epoch: 42, expiresAt }]);
    expect(grants).toEqual([{ repoId: privateRepo.id, userId: users.reader, epoch: 42, expiresAt }]);
    expect(snapshots).toEqual([{ repoId: privateRepo.id, path: "docs/guide.md", userId: users.reader, epoch: 42, moderator: true }]);
    expect(fixture.access.calls.moderation).toEqual([{ viewer: users.reader, repo: "octo/secret-docs" }]);
    // The shell's next renewal within the grant's first half asks nobody and writes nothing.
    const cookie = `${sessions.reader}; ${capability(granted)}`;
    expect((await access(priv, { cookie }, first)).status).toBe(200);
    expect(fixture.access.calls.moderation).toHaveLength(1);
    expect(moderatorGrants).toHaveLength(1);
  });

  it("gives no role to a reader who is not a moderator, and remembers it", async () => {
    // Writers, triagers and readers are not moderators: the control Worker says null for them.
    expect((await access(priv, { cookie: sessions.reader }, first)).status).toBe(200);
    expect((await access(priv, { cookie: sessions.reader }, first)).status).toBe(200);
    expect(fixture.access.calls.moderation).toHaveLength(1);
    expect(moderatorGrants).toEqual([]);
    expect(snapshots.every(asked => !("moderator" in asked))).toBe(true);
  });

  it("asks the control Worker about no one for a public repository", async () => {
    fixture.access.moderate(users.reader, publicRepo.id, "admin");
    expectPlainNotFound(await access(pub, { cookie: sessions.reader }, first));
    expect(fixture.access.calls.moderation).toEqual([]);
    expect(moderatorGrants).toEqual([]);
  });

  it("ignores every role a request claims: only the control Worker's word counts", async () => {
    const forged = { cookie: sessions.reader, "X-Rendro-Role": "admin", "X-Moderator": "true", Authorization: "Bearer admin" };
    const response = await access(priv, forged, `${first}&role=admin&moderator=true&userId=${users.outsider}`);
    expect(response.status).toBe(200);
    expect(moderatorGrants).toEqual([]);
    expect(snapshots).toEqual([{ repoId: privateRepo.id, path: "docs/guide.md", userId: users.reader, epoch: 0 }]);
    // Even a body is never read for a role.
    const body = await app.request(`${ORIGIN}${priv}/comment-access`, {
      method: "POST", headers: { Origin: ORIGIN, cookie: sessions.reader, "Content-Type": "application/json" }, body: JSON.stringify({ role: "admin", moderator: true }),
    }, fixture.env, fixture.ctx);
    expect(body.status).toBe(200);
    expect(moderatorGrants).toEqual([]);
  });

  it("still grants reading and writing when the role cannot be asked", async () => {
    fixture.access.moderate(users.reader, privateRepo.id, "admin");
    fixture.access.moderationUnavailable = true;
    const response = await access(priv, { cookie: sessions.reader }, first);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ threads: { path: "docs/guide.md" } });
    expect(moderatorGrants).toEqual([]);
    expect(snapshots).toEqual([{ repoId: privateRepo.id, path: "docs/guide.md", userId: users.reader, epoch: 0 }]);
    // An outage is not remembered as "no role": the next renewal asks again, and the role arrives.
    fixture.access.moderationUnavailable = false;
    await access(priv, { cookie: sessions.reader }, first);
    expect(moderatorGrants).toHaveLength(1);
  });

  it("never records a role without a read grant, and never remembers one Convex refused or could not take", async () => {
    const reader = { cookie: sessions.reader };
    fixture.access.moderate(users.reader, privateRepo.id, "maintain");
    convex.answer = () => Response.json({ status: "success", value: { granted: false } });
    expectPlainNotFound(await access(priv, reader));
    expect(moderatorGrants).toEqual([]);
    convex.answer = args => Response.json({ status: "success", value: { granted: true, expiresAt: args.expiresAt } });
    convex.moderator = () => Response.json({ status: "success", value: { granted: false } });
    expect((await access(priv, reader)).status).toBe(200);
    convex.moderator = () => new Response("down", { status: 503 });
    expect((await access(priv, reader)).status).toBe(200);
    // Both refusals left nothing in memory: the role is recorded again at the next request.
    convex.moderator = args => Response.json({ status: "success", value: { granted: true, expiresAt: args.expiresAt } });
    expect((await access(priv, reader)).status).toBe(200);
    expect(moderatorGrants).toHaveLength(3);
  });
});
