import { afterEach, describe, expect, it } from "vitest";

import { RENDERER_VERSION } from "@/ingest/limits";
import { manifestKey } from "@/ingest/orchestrator/keys";
import type { SnapshotManifest } from "@/ingest/orchestrator/snapshot";
import { MAX_SEARCH_QUERY_LENGTH } from "@/repo-read/search";
import app from "@/worker";
import { d1SearchIndex } from "@/search/d1";
import { privateRepo, publicRepo, repoReadFixture, sessionCookies, stubSessions } from "./helpers/repo-read-fixture";
import { SqliteSearchD1 } from "./helpers/search-sqlite";

afterEach(() => Reflect.deleteProperty(globalThis, "caches"));

/** The fixture with a populated search index: every rendered page indexed the way ingest would. */
async function searchFixture() {
  stubSessions();
  const fixture = await repoReadFixture();
  const database = new SqliteSearchD1();
  const index = d1SearchIndex(database);
  await index.migrate();
  const snapshot = fixture.bucket.json<SnapshotManifest>(manifestKey(publicRepo.id, fixture.commits.public, RENDERER_VERSION));
  expect(snapshot).toBeTruthy();
  const pages = Object.entries(snapshot!.files).filter(([, file]) => file.render !== undefined && file.error === undefined);
  expect(pages.length).toBeGreaterThan(2);
  for (const [path, file] of pages) {
    await index.putBlob(publicRepo.id, file.sha, [{ slug: "user-content-intro", title: `Title of ${path}`, text: `Welcome to ${path} with searchable prose` }]);
  }
  // The same page content indexed for the private repository stays out of the public one's results.
  await index.putBlob(privateRepo.id, pages[0][1].sha, [{ slug: "user-content-intro", title: "other repo", text: "Welcome elsewhere" }]);
  return { ...fixture, snapshot: snapshot!, pages, env: { ...fixture.env, REPO_SEARCH: database } };
}

const get = (
  path: string,
  env: Parameters<typeof app.request>[2],
  ctx: Parameters<typeof app.request>[3],
  headers: Record<string, string> = {},
) => app.request(`https://rendro.test${path}`, { headers }, env, ctx);

function expectPlainNotFound(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("ETag")).toBeNull();
  expect(response.headers.get("Retry-After")).toBeNull();
}

describe("repository search endpoint (GET /r/:owner/:repo/search)", () => {
  it("answers 404 without a search binding, like every other configured-in-tests-only surface", async () => {
    const fixture = await repoReadFixture();
    expectPlainNotFound(await get("/r/octo/public-docs/search?q=welcome", fixture.env, fixture.ctx));
  });

  it("returns results scoped to the requested repository and served commit", async () => {
    const fixture = await searchFixture();
    const response = await get(`/r/octo/public-docs/search?q=welcome&limit=2`, fixture.env, fixture.ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await response.json() as { status: string; results: Array<{ path: string; slug: string; title: string; snippet: string }>; more: boolean };
    expect(payload.status).toBe("ok");
    expect(payload.results).toHaveLength(2);
    expect(payload.results.every(result => result.path.startsWith("docs/") && result.slug === "user-content-intro")).toBe(true);
    expect(payload.results[0].snippet).toContain("\u0002Welcome\u0003");
    expect(payload.results.some(result => result.title === "other repo")).toBe(false);
  });

  it("answers bounds: a missing q is an empty search, long queries and bad limits are rejected or clamped", async () => {
    const fixture = await searchFixture();
    const empty = await get("/r/octo/public-docs/search", fixture.env, fixture.ctx);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ status: "ok", results: [], more: false });

    const tooLong = await get(`/r/octo/public-docs/search?q=${"x".repeat(MAX_SEARCH_QUERY_LENGTH + 1)}`, fixture.env, fixture.ctx);
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "Invalid search query" });
    expect(tooLong.headers.get("Cache-Control")).toBe("private, no-store");

    // limit=51 clamps to the maximum; the fixture has fewer results than either.
    const clamped = await get("/r/octo/public-docs/search?q=welcome&limit=51", fixture.env, fixture.ctx);
    expect((await clamped.json() as { results: unknown[] }).results.length).toBeLessThanOrEqual(50);
  });

  it("sits behind the read path's authorization: a signed-out reader of a private repository gets the plain 404", async () => {
    const fixture = await searchFixture();
    // Search targets are script-read JSON, so their denial is a JSON 404 like a tree page's.
    const response = await get(`/r/octo/secret-docs/search?q=welcome`, fixture.env, fixture.ctx);
    expectPlainNotFound(response);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    // And with a session the private repository searches normally.
    const signedIn = await get(`/r/octo/secret-docs/search?q=welcome`, fixture.env, fixture.ctx, { cookie: sessionCookies.reader });
    expect(signedIn.status).toBe(200);
    const payload = await signedIn.json() as { results: unknown[] };
    expect(Array.isArray(payload.results)).toBe(true);
  });

  it("renders the search box in the shell only where the shell mounts it", async () => {
    const fixture = await searchFixture();
    const shell = await get("/r/octo/public-docs", fixture.env, fixture.ctx);
    const html = await shell.text();
    expect(html).toContain('data-repo-search');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('id="repo-search-results"');
    expect(html).toContain('maxlength="200"');
  });
});
