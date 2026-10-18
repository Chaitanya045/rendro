import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "@/worker";
import { RENDERER_VERSION } from "@/ingest/limits";
import { blobKey, manifestKey, refKey, sidebarKey } from "@/ingest/orchestrator/keys";
import { mintCapability, sessionBinding } from "@/repo-read/capability";
import { clearSnapshotMemory } from "@/repo-read/snapshot";
import { ingestBranch } from "@/ingest/orchestrator/ingest";
import { imageProxyPath } from "@/image-proxy";
import {
  MemoryEdgeCache, privateRepo, publicRepo, repoReadFixture, sessionCookies, stubSessions, users,
} from "./helpers/repo-read-fixture";

const secret = process.env.REPO_CAPABILITY_SECRET as string;
let fixture: Awaited<ReturnType<typeof repoReadFixture>>;
let sessionLookups: string[];

beforeEach(async () => {
  fixture = await repoReadFixture();
  sessionLookups = stubSessions();
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "caches");
});

function get(path: string, headers: Record<string, string> = {}, origin = "https://rendro.test", method = "GET") {
  return app.request(`${origin}${path}`, { headers, method }, fixture.env, fixture.ctx);
}

const pub = `/r/${publicRepo.owner}/${publicRepo.name}`;
const priv = `/r/${privateRepo.owner}/${privateRepo.name}`;

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

/** The capability cookie a response set, as a request Cookie pair. */
function capability(response: Response): string {
  const cookie = setCookies(response).find(value => /^__Host-rendro-repo\.\d+=v1\./.test(value));
  if (!cookie) throw new Error("No capability cookie");
  return cookie.split(";", 1)[0];
}

async function signIn(): Promise<string> {
  const response = await get(priv, { cookie: sessionCookies.reader });
  expect(response.status).toBe(200);
  return `${sessionCookies.reader}; ${capability(response)}`;
}

function ticketPrefix(html: string): string {
  const match = /<base data-rendro-viewer href="([^"]+\/files\/)/.exec(html);
  if (!match) throw new Error("No ticket base");
  return match[1];
}

function expectPlainNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("ETag")).toBeNull();
  expect(response.headers.get("Retry-After")).toBeNull();
  expect(response.headers.get("Last-Modified")).toBeNull();
}

describe("public repositories", () => {
  it("serves the shell for the default branch without a cookie, pinned to the served commit", async () => {
    const response = await get(pub);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Content-Security-Policy")).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(setCookies(response)).toEqual([]);
    const html = await response.text();
    expect(html).toContain(`data-document-base="${pub}"`);
    expect(html).toContain(`data-frame-base="${pub}/@${fixture.commits.public}"`);
    expect(html).toContain('window.RENDRO_INITIAL_DOC="public-docs/docs/index.md"');
    expect(html).toContain("Copy link");
    expect(html).not.toContain('data-viewer="parent"');
    // Anonymous public reads never reach the session.
    expect(sessionLookups).toEqual([]);
  });

  it("matches owner and repository names case-insensitively and selects ?doc", async () => {
    const response = await get(`/r/octo/PUBLIC-docs?doc=docs/guide/start.md`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('window.RENDRO_INITIAL_DOC="PUBLIC-docs/docs/guide/start.md"');
  });

  it.each([
    ["an unknown document", "docs/missing.md"],
    ["an asset", "docs/img/logo.png"],
    ["a traversal", "docs/../README.md"],
    ["an inherited property", "__proto__"],
  ])("answers a shell for %s with the plain 404 page", async (_case, doc) => {
    const response = await get(`${pub}?doc=${encodeURIComponent(doc)}`);
    expectPlainNotFound(response);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
  });

  it("serves a commit-pinned document frame as immutable public HTML with links relative to the page", async () => {
    const path = `${pub}/@${fixture.commits.public}/files/docs/index.md`;
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "sandbox allow-scripts allow-popups; default-src 'none'; script-src https://rendro.test/private-viewer.js; style-src https://rendro.test/styles/; "
      + "img-src https://rendro.test; base-uri https://rendro.test; form-action 'none'; frame-ancestors 'self'");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBeNull();
    expect(response.headers.get("Accept-Ranges")).toBe("none");
    const etag = response.headers.get("ETag") as string;
    expect(etag).toMatch(/^"page-render\/v\d+\/markdown\/[0-9a-f]{40}\/[0-9a-f]{32}-f\d+\.v\d+\.[0-9a-f]{10}"$/);
    const html = await response.text();
    expect(html).toContain('<h1 id="user-content-home">Home</h1>');
    expect(html).toContain('<a href="../docs/guide/start.md">guide</a>');
    expect(html).toContain('<img src="../docs/img/logo.png" alt="Logo"');
    expect(html).toContain('class="markdown-alert markdown-alert-note"');
    expect(html).toContain('data-viewer="navigation"');
    expect(html).not.toContain("<base");
    expect(html).not.toContain('data-viewer="frame"');

    const reads = fixture.bucket.ops.get;
    const revalidated = await get(path, { "If-None-Match": etag });
    expect(revalidated.status).toBe(304);
    expect(fixture.bucket.ops.get).toBe(reads);
  });

  it("serves branch URLs with a short freshness window, an ETag and stale-if-error", async () => {
    for (const path of [`${pub}/files/docs/index.md`, `${pub}/~main/files/docs/index.md`]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=10, stale-if-error=86400");
      expect(response.headers.get("ETag")).toMatch(/^"page-/);
    }
    expectPlainNotFound(await get(`${pub}/~gone/files/docs/index.md`));
  });

  it("serves a branch whose name holds a slash through one encoded segment", async () => {
    const feature = fixture.repos.public.commit({ "docs/index.md": "# Feature home\n" }, "feature/x");
    await ingestBranch(fixture.ingest.deps, fixture.cache, fixture.repos.public.ref, "feature/x");
    const shell = await get(`${pub}/~feature%2Fx`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain(`data-frame-base="${pub}/@${feature}"`);
    const frame = await get(`${pub}/~feature%2Fx/files/docs/index.md`);
    expect(await frame.text()).toContain("Feature home");
  });

  it("serves an image with a git validator, ranges and HEAD without reading storage", async () => {
    const path = `${pub}/@${fixture.commits.public}/files/docs/img/logo.png`;
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox; frame-ancestors 'self'");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).toMatch(/^"git-[0-9a-f]{40}"$/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]));
    const ranged = await get(path, { Range: "bytes=4-5" });
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    clearSnapshotMemory();
    const reads = fixture.bucket.ops.get;
    const head = await get(path, {}, "https://rendro.test", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("12");
    // Only the manifest: HEAD never opens the object.
    expect(fixture.bucket.ops.get).toBe(reads + 1);
  });

  it("shows a notice for a page ingest could not render", async () => {
    const response = await get(`${pub}/@${fixture.commits.public}/files/docs/huge.md`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<p class="rendro-render-failure">This page is too large to display.</p>');
  });

  it("serves sidebar directory pages with titles, pinned and branch-addressed", async () => {
    const tree = (dir: string, extra = "") => get(`${pub}/@${fixture.commits.public}/tree?dir=${encodeURIComponent(dir)}${extra}`);
    const root = await tree("");
    expect(root.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(root.headers.get("ETag")).toBe(`"tree-${fixture.commits.public}-r${RENDERER_VERSION}"`);
    expect(await root.json()).toEqual({ children: [{ name: "docs", type: "folder", title: "Docs" }], cursor: null });
    expect(await (await tree("docs/")).json()).toEqual({
      children: [
        { name: "index.md", type: "file", title: "Home" },
        { name: "guide", type: "folder", title: "Guide" },
        { name: "huge.md", type: "file", title: "Huge" },
        { name: "reference", type: "folder", title: "Reference" },
      ],
      cursor: null,
    });
    expect(await (await tree("docs/guide/")).json()).toEqual({
      children: [{ name: "README.md", type: "file", title: "Guide" }, { name: "start.md", type: "file", title: "Getting started" }], cursor: null,
    });
    expect(await (await tree("nowhere/")).json()).toEqual({ children: [], cursor: null });
    for (const bad of [tree("docs"), tree("docs/", "&cursor=x"), get(`${pub}/tree`)]) {
      const response = await bad;
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    const branch = await get(`${pub}/tree?dir=`);
    expect(branch.headers.get("Cache-Control")).toBe("public, max-age=10, stale-if-error=86400");
  });

  it("issues no tickets for public repositories", async () => {
    expectPlainNotFound(await get(`${pub}/@${fixture.commits.public}/viewer-ticket?manifestKey=${fixture.commits.public}`));
  });
});

describe("private repositories", () => {
  it("answers anonymous readers with a plain 404 and remembers the denial briefly", async () => {
    for (const path of [priv, `${priv}/@${fixture.commits.private}/files/docs/index.md`, `${priv}/tree?dir=`]) {
      expectPlainNotFound(await get(path));
    }
    expect(fixture.access.calls.authorize).toEqual([{ viewer: null, repo: "octo/secret-docs" }]);
  });

  it("answers a signed-in reader without access with the same 404 as a missing repository", async () => {
    const denied = await get(priv, { cookie: sessionCookies.outsider });
    const missing = await get("/r/octo/no-such-repo", { cookie: sessionCookies.outsider });
    expectPlainNotFound(denied);
    expectPlainNotFound(missing);
    const page = async (response: Response) => (await response.text()).replace(/nonce="[^"]+"/g, "");
    expect(await page(denied)).toBe((await page(missing)).replace("/r/octo/no-such-repo", priv));
  });

  it("grants a reader once, sets a host-only capability cookie and then serves without the session or the source", async () => {
    const response = await get(priv, { cookie: sessionCookies.reader });
    expect(response.status).toBe(200);
    const [cookie] = setCookies(response);
    expect(cookie).toMatch(/^__Host-rendro-repo\.502=v1\.[\w-]+\.[\w-]+; Path=\/; Max-Age=300; HttpOnly; SameSite=Lax; Secure$/);
    const html = await response.text();
    expect(html).toContain('data-viewer="parent"');
    expect(html).toContain('id="viewer-update-notice"');
    expect(sessionLookups).toHaveLength(1);
    expect(fixture.access.calls.authorize).toHaveLength(1);

    const cookies = `${sessionCookies.reader}; ${capability(response)}`;
    const again = await get(`${priv}/@${fixture.commits.private}/files/docs/index.md`, { cookie: cookies });
    expect(again.status).toBe(200);
    expect(setCookies(again)).toEqual([]);
    expect(sessionLookups).toHaveLength(1);
    expect(fixture.access.calls.authorize).toHaveLength(1);
  });

  it("serves a private frame with a ticket base, the renewal client and no validator", async () => {
    const cookie = await signIn();
    const response = await get(`${priv}/@${fixture.commits.private}/files/docs/guide/start.md`, { cookie });
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("ETag")).toBeNull();
    const html = await response.text();
    const prefix = ticketPrefix(html);
    expect(prefix).toMatch(new RegExp(`^${priv}/@${fixture.commits.private}/view/v1\\.[\\w-]+\\.[\\w-]+/files/$`));
    expect(html).toContain(`<base data-rendro-viewer href="${prefix}docs/guide/start.md">`);
    expect(html).toContain('data-viewer="frame"');
    expect(html).toContain("<title>Getting started</title>");
    expect(html).toContain('<a href="../../docs/index.md#user-content-home">home</a>');
    expect(html).toContain('<a href="#user-content-start-here">Top</a>');
  });

  it("serves private images through the ticket alone, privately, and refuses a tampered or foreign ticket before any read", async () => {
    const cookie = await signIn();
    const prefix = ticketPrefix(await (await get(`${priv}/@${fixture.commits.private}/files/docs/index.md`, { cookie })).text());
    const image = await get(`${prefix}docs/img/logo.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get("Cache-Control")).toBe("private, max-age=900");
    expect(image.headers.get("Content-Type")).toBe("image/png");
    const page = await get(`${prefix}docs/index.md`);
    expect(page.status).toBe(200);
    expect(ticketPrefix(await page.text())).toBe(prefix);

    const edge = new MemoryEdgeCache();
    Object.assign(globalThis, { caches: { default: edge } });
    clearSnapshotMemory();
    const reads = fixture.bucket.ops.get;
    const ticket = prefix.split("/view/")[1].slice(0, -"/files/".length);
    const tampered = ticket.slice(0, 20) + (ticket[20] === "A" ? "B" : "A") + ticket.slice(21);
    const other = fixture.repos.private.commit({ "docs/index.md": "# Other\n" });
    for (const path of [
      `${priv}/@${fixture.commits.private}/view/${tampered}/files/docs/img/logo.png`,
      `${priv}/@${other}/view/${ticket}/files/docs/img/logo.png`,
      `${pub}/@${fixture.commits.public}/view/${ticket}/files/docs/img/logo.png`,
    ]) expectPlainNotFound(await get(path));
    // A probe of a private object's edge cache key is an ordinary unknown URL.
    expectPlainNotFound(await get(`/__repo-cache/v1/gh/v1/repo/${privateRepo.id}/snapshot/${fixture.commits.private}/r${RENDERER_VERSION}/manifest.json`));
    expect(edge.ops.match).toEqual([]);
    expect(fixture.bucket.ops.get).toBe(reads);
  });

  it("renews tickets for the trusted shell only, and only for the commit asked about", async () => {
    const cookie = await signIn();
    const renewal = await get(`${priv}/@${fixture.commits.private}/viewer-ticket?manifestKey=${fixture.commits.private}`, { cookie });
    expect(renewal.status).toBe(200);
    expect(renewal.headers.get("Cache-Control")).toBe("private, no-store");
    const { prefix } = await renewal.json() as { prefix: string };
    expect((await get(`${prefix}docs/img/logo.png`)).status).toBe(200);
    expectPlainNotFound(await get(`${priv}/@${fixture.commits.private}/viewer-ticket?manifestKey=other`, { cookie }));
    expectPlainNotFound(await get(`${priv}/@${fixture.commits.private}/viewer-ticket?manifestKey=${fixture.commits.private}`));
  });

  it("ignores a forged, signed-out, other-session or other-repository cookie and clears it", async () => {
    const valid = capability(await get(priv, { cookie: sessionCookies.reader }));
    const [name, value] = [valid.slice(0, valid.indexOf("=")), valid.slice(valid.indexOf("=") + 1)];
    const flip = (text: string, at: number) => `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`;
    const forgedClaims = `${name}=${flip(value, 30)}`;
    const forgedSignature = `${name}=${flip(value, value.length - 20)}`;
    const now = Math.floor(Date.now() / 1000);
    const claims = { u: users.reader, r: privateRepo.id, n: "octo/secret-docs", p: true, b: "main", e: 0, i: now, x: now + 300 };
    const wrongId = `__Host-rendro-repo.999=${await mintCapability(secret, "cookie", { ...claims, s: await sessionBinding(secret, sessionCookies.reader) })}`;
    const cases: Array<[string, string]> = [
      [sessionCookies.outsider, valid], ["", valid], [sessionCookies.reader, forgedClaims], [sessionCookies.outsider, forgedSignature], [sessionCookies.outsider, wrongId],
    ];
    for (const [session, cookie] of cases) {
      const response = await get(priv, { cookie: session ? `${session}; ${cookie}` : cookie });
      if (session === sessionCookies.reader) expect(response.status).toBe(200);
      else expectPlainNotFound(response);
      expect(setCookies(response)).toContain(`${cookie.slice(0, cookie.indexOf("="))}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
    }
    // Cookies for another repository are left alone.
    const elsewhere = await get(`${pub}`, { cookie: `${sessionCookies.reader}; ${valid}` });
    expect(setCookies(elsewhere)).toEqual([]);
    // A junk cookie under a public repository's name is never cleared on a cacheable public response.
    const junk = await get(`${pub}/@${fixture.commits.public}/files/docs/index.md`, { cookie: "__Host-rendro-repo.501=junk" });
    expect(junk.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(setCookies(junk)).toEqual([]);
  });

  it("accepts only host-only cookies over HTTPS and only unprefixed ones over local HTTP", async () => {
    const local = await get(priv, { cookie: sessionCookies.reader }, "http://127.0.0.1:8787");
    const [cookie] = setCookies(local);
    expect(cookie).toMatch(/^rendro-repo\.502=v1\.[^;]+; Path=\/; Max-Age=300; HttpOnly; SameSite=Lax$/);
    const pair = cookie.split(";", 1)[0];
    fixture.access.unavailable = true;
    expect((await get(priv, { cookie: `${sessionCookies.reader}; ${pair}` }, "http://127.0.0.1:8787")).status).toBe(200);
    // The same value under a name the scheme does not allow is never trusted.
    expect((await get(priv, { cookie: `${sessionCookies.reader}; __Host-${pair}` }, "http://127.0.0.1:8787")).status).toBe(503);
    expect((await get(priv, { cookie: `${sessionCookies.reader}; ${pair}` })).status).toBe(503);
  });

  it("re-authorizes an expired cookie", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cookie = await signIn();
    vi.setSystemTime(Date.now() + 301_000);
    const response = await get(priv, { cookie });
    expect(response.status).toBe(200);
    expect(fixture.access.calls.authorize).toHaveLength(2);
    expect(setCookies(response)).toHaveLength(2);
  });

  it("revokes at once when the reader's epoch moves past the cookie", async () => {
    const cookie = await signIn();
    fixture.access.revoke(users.reader, privateRepo.id);
    const response = await get(`${priv}/@${fixture.commits.private}/files/docs/index.md`, { cookie });
    expectPlainNotFound(response);
    expect(setCookies(response)).toContain("__Host-rendro-repo.502=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
  });

  it("re-mints the cookie at the new epoch when access survived the bump", async () => {
    const cookie = await signIn();
    fixture.access.epochs.set(users.reader, 7);
    const response = await get(priv, { cookie });
    expect(response.status).toBe(200);
    const renewed = capability(response);
    expect(JSON.parse(atob(renewed.split(".")[2].replace(/-/g, "+").replace(/_/g, "/"))).e).toBe(7);
  });

  it("revokes tickets with the epoch too", async () => {
    const cookie = await signIn();
    const prefix = ticketPrefix(await (await get(`${priv}/@${fixture.commits.private}/files/docs/index.md`, { cookie })).text());
    fixture.access.revoke(users.reader, privateRepo.id);
    expectPlainNotFound(await get(`${prefix}docs/img/logo.png`));
  });

  it("refreshes a cookie past half its life in the background and renews it on the next request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cookie = await signIn();
    vi.setSystemTime(Date.now() + 200_000);
    const first = await get(priv, { cookie });
    expect(first.status).toBe(200);
    expect(setCookies(first)).toEqual([]);
    // The request did not wait for the refresh.
    expect(fixture.pending).toHaveLength(1);
    // One refresh per reader and repository at a time.
    expect((await get(priv, { cookie })).status).toBe(200);
    expect(fixture.pending).toHaveLength(1);
    await fixture.settle();
    expect(fixture.access.calls.authorize).toHaveLength(2);
    const renewed = await get(priv, { cookie });
    expect(renewed.status).toBe(200);
    expect(capability(renewed)).not.toBe(cookie.split("; ")[1]);
  });

  it("denies on the next request when the background refresh finds access gone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cookie = await signIn();
    fixture.access.readers.get(privateRepo.id)?.delete(users.reader);
    vi.setSystemTime(Date.now() + 200_000);
    expect((await get(priv, { cookie })).status).toBe(200);
    await fixture.settle();
    expectPlainNotFound(await get(priv, { cookie }));
  });

  it("treats a refresh that saw the session end as a denial, and one that could not check as nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cookie = await signIn();
    stubSessions({ "reader-token.sig": "down" });
    vi.setSystemTime(Date.now() + 200_000);
    await get(priv, { cookie });
    await fixture.settle();
    expect((await get(priv, { cookie })).status).toBe(200);
    await fixture.settle();
    stubSessions({});
    vi.setSystemTime(Date.now() + 1_000);
    await get(priv, { cookie });
    await fixture.settle();
    expectPlainNotFound(await get(priv, { cookie }));
  });
});

describe("faults are retryable 503s, never 404s", () => {
  it.each([
    ["the permission source", () => { fixture.access.unavailable = true; }],
    ["the epoch store", () => { fixture.access.epochsUnavailable = true; }],
    ["the session backend", () => { stubSessions({ "reader-token.sig": "down" }); }],
  ])("when %s fails", async (_name, fail) => {
    fail();
    for (const [path, type] of [[priv, /^text\/html/], [`${priv}/tree?dir=`, /^application\/json/]] as const) {
      const response = await get(path, { cookie: sessionCookies.reader });
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Content-Type")).toMatch(type);
    }
    const image = await get(`${priv}/@${fixture.commits.private}/files/docs/img/logo.png`, { cookie: sessionCookies.reader, Accept: "image/*" });
    expect(image.status).toBe(503);
    expect(image.headers.get("Content-Type")).toBeNull();
  });

  it("when a branch points at a snapshot storage no longer has", async () => {
    fixture.bucket.objects.delete(manifestKey(publicRepo.id, fixture.commits.public, RENDERER_VERSION));
    const response = await get(pub);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    const tree = await get(`${pub}/tree?dir=`);
    expect(tree.status).toBe(503);
    expect(await tree.json()).toEqual({ error: "Document temporarily unavailable", retryable: true });
    // A commit nobody pointed at is simply unknown.
    expectPlainNotFound(await get(`${pub}/@${"a".repeat(40)}`));
  });

  it("when a stored object is malformed or storage times out", async () => {
    fixture.bucket.objects.set(refKey(publicRepo.id, "main"), { bytes: new TextEncoder().encode("{"), etag: "x", contentType: undefined });
    expect((await get(pub)).status).toBe(503);
    clearSnapshotMemory();
    vi.spyOn(fixture.bucket, "get").mockRejectedValue(new DOMException("Storage read timed out", "TimeoutError"));
    const response = await get(`${pub}/@${fixture.commits.public}/files/docs/index.md`, { Accept: "text/html" });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Try again");
  });
});

describe("the URL boundary", () => {
  it.each([
    `${pub}/files/docs/%2e%2e/README.md`,
    `${pub}/files/docs%2Findex.md`,
    `${pub}/files/docs//index.md`,
    `${pub}/files/docs%5Cindex.md`,
    `${pub}/files/docs/%00.md`,
    `${pub}/files/__proto__`,
    `${pub}/files/constructor`,
    `${pub}/@${fixture?.commits.public ?? "0".repeat(40)}/files/hasOwnProperty`,
    `/r/oc%74o/public-docs`,
    `/r/octo/..`,
    `/r/octo/public-docs/~`,
    `/r/octo/public-docs/~a..b`,
    `/r/octo/public-docs/~%E0`,
    `/r/octo/public-docs/@ABC`,
    `/r/octo/public-docs/files`,
    `/r/octo/public-docs/`,
    `/r/octo/public-docs/~main/viewer-ticket`,
    `/r/octo/public-docs/view/abc/files/x.png`,
    `/r/octo/public-docs/@${"a".repeat(40)}/view/bad%20ticket/files/x.png`,
    `/r/octo/public-docs/@${"a".repeat(40)}/view/abc/files/%2e%2e`,
    `/r/octo/public-docs/other`,
  ])("refuses %s with a 404", async (path) => {
    expectPlainNotFound(await get(path));
  });

  it("never parses a malformed URL far enough to authorize it", async () => {
    await get(`${pub}/files/docs%2Findex.md`);
    await get(`/r/oc%74o/public-docs`);
    expect(fixture.access.calls.authorize).toEqual([]);
  });

  it("is a 404 everywhere when the read path is not configured", async () => {
    const response = await app.request(`https://rendro.test${pub}`, {}, {}, fixture.ctx);
    expectPlainNotFound(response);
    expect(fixture.access.calls.authorize).toEqual([]);
  });
});

describe("unusual snapshots", () => {
  const commit = "e".repeat(40);
  const base = `${pub}/@${commit}`;
  async function snapshot(files: Record<string, unknown>, sidebar: unknown) {
    const write = (key: string, value: unknown) => fixture.bucket.put(key, new TextEncoder().encode(JSON.stringify(value)));
    if (sidebar) await write(sidebarKey(publicRepo.id, commit, RENDERER_VERSION), sidebar);
    await write(manifestKey(publicRepo.id, commit, RENDERER_VERSION), {
      schema: 1, repoId: publicRepo.id, commit, tree: "t", rendererVersion: RENDERER_VERSION, createdAt: "", docSets: [],
      docs: { entry: "index.md" }, files, sidebar: sidebar ? sidebarKey(publicRepo.id, commit, RENDERER_VERSION) : null, assetsTruncated: false,
    });
  }

  it("pages a large directory and answers an empty tree without a sidebar", async () => {
    const pages = Array.from({ length: 201 }, (_, index) => `p${index}.md`);
    await snapshot(Object.fromEntries(pages.map(path => [path, { sha: "a".repeat(40), size: 1, error: "missing" }])),
      { rendererVersion: 1, root: "", entry: "p0.md", truncated: false, nodes: pages.map(path => ({ type: "page", path, title: path })) });
    const first = await (await get(`${base}/tree?dir=`)).json() as { children: unknown[]; cursor: string | null };
    expect(first.children).toHaveLength(200);
    expect(first.cursor).toBe("1");
    expect(await (await get(`${base}/tree?dir=&cursor=1`)).json()).toEqual({ children: [{ name: "p200.md", type: "file", title: "p200.md" }], cursor: null });
    clearSnapshotMemory();
    await snapshot({}, null);
    expect(await (await get(`${base}/tree?dir=`)).json()).toEqual({ children: [], cursor: null });
  });

  it("explains a listed page without output, and 404s an unservable asset", async () => {
    await snapshot({
      "index.md": { sha: "a".repeat(40), size: 1 },
      "big.png": { sha: "b".repeat(40), size: 20_000_000, error: "too-large" },
      "data.weird": { sha: "c".repeat(40), size: 2 },
      "lost.png": { sha: "d".repeat(40), size: 2 },
    }, null);
    expect(await (await get(`${base}/files/index.md`)).text()).toContain("missing from the snapshot");
    expectPlainNotFound(await get(`${base}/files/big.png`));
    await fixture.bucket.put(blobKey(publicRepo.id, "c".repeat(40)), new Uint8Array([1, 2]));
    expect((await get(`${base}/files/data.weird`)).headers.get("Content-Type")).toBe("application/octet-stream");
    // Listed, but storage lost it: the ordinary 404 of the other delivery routes; HEAD still answers from the manifest.
    expectPlainNotFound(await get(`${base}/files/lost.png`));
    expect((await get(`${base}/files/lost.png`, {}, "https://rendro.test", "HEAD")).status).toBe(200);
    // A render failure ingest cached at the render key.
    const render = `render/v${RENDERER_VERSION}/markdown/${"9".repeat(40)}/${"1".repeat(32)}`;
    await fixture.bucket.put(`gh/v1/repo/${publicRepo.id}/${render}`, new TextEncoder().encode(JSON.stringify({ error: "too-complex" })));
    clearSnapshotMemory();
    await snapshot({ "hostile.md": { sha: "9".repeat(40), size: 1, render, error: "too-complex" } }, null);
    expect(await (await get(`${base}/files/hostile.md`)).text()).toContain("could not be rendered safely");
  });

  it("keeps external images on the signed image proxy while repository images follow the page", async () => {
    const proxied = await imageProxyPath(process.env.IMAGE_PROXY_SECRET as string, "https://example.com/badge.svg") as string;
    const render = `render/v${RENDERER_VERSION}/markdown/${"f".repeat(40)}/${"0".repeat(32)}`;
    await fixture.bucket.put(`gh/v1/repo/${publicRepo.id}/${render}`, new TextEncoder().encode(JSON.stringify({
      html: `<p><img src="${proxied}" alt="Badge"> <img src="/docs/img/logo.png" alt="Logo"></p>`, title: "Badges", headings: [],
    })));
    await snapshot({ "docs/badges.md": { sha: "f".repeat(40), size: 1, render } }, null);
    const html = await (await get(`${base}/files/docs/badges.md`)).text();
    expect(html).toContain(`<img src="${proxied}" alt="Badge">`);
    expect(html).toContain('<img src="../docs/img/logo.png" alt="Logo">');
  });

  it("is a 404 when the Worker has no bindings at all (the Node server)", async () => {
    expectPlainNotFound(await app.request(`https://rendro.test${pub}`));
  });
});

describe("the read order", () => {
  it("fills the colo cache from R2 and serves the next isolate from it", async () => {
    const edge = new MemoryEdgeCache();
    Object.assign(globalThis, { caches: { default: edge } });
    clearSnapshotMemory();
    const path = `${pub}/@${fixture.commits.public}/files/docs/index.md`;
    expect((await get(path)).status).toBe(200);
    await fixture.settle();
    expect(edge.ops.put.length).toBe(2);
    expect(edge.ops.put.every(key => key.startsWith("https://rendro.test/__repo-cache/v1/gh/v1/repo/501/"))).toBe(true);
    clearSnapshotMemory();
    const reads = fixture.bucket.ops.get;
    expect((await get(path)).status).toBe(200);
    expect(fixture.bucket.ops.get).toBe(reads);
    // Warm isolate: memory answers before the colo cache.
    const matches = edge.ops.match.length;
    expect((await get(path)).status).toBe(200);
    expect(edge.ops.match.length).toBe(matches);
  });

  it("survives a failed colo cache fill", async () => {
    const edge = new MemoryEdgeCache();
    edge.put = () => Promise.reject(new Error("cache full"));
    Object.assign(globalThis, { caches: { default: edge } });
    clearSnapshotMemory();
    expect((await get(`${pub}/@${fixture.commits.public}/files/docs/index.md`)).status).toBe(200);
    await fixture.settle();
  });
});
