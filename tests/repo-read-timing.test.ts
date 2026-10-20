import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "@/worker";
import { RENDERER_VERSION } from "@/ingest/limits";
import { manifestKey } from "@/ingest/orchestrator/keys";
import type { SnapshotManifest } from "@/ingest/orchestrator/snapshot";
import { clearSnapshotMemory } from "@/repo-read/snapshot";
import { SHARED_CACHE_PATH } from "@/repo-read/shared-cache";
import { ReadTiming } from "@/repo-read/timing";
import { d1SearchIndex } from "@/search/d1";
import {
  FakeIngestCoordinator, freshRepo, MemoryEdgeCache, privateRepo, publicRepo, repoReadFixture, sessionCookies, stubSessions,
} from "./helpers/repo-read-fixture";
import { SqliteSearchD1 } from "./helpers/search-sqlite";

/*
 * Server-Timing phases on the repository read path (#282): the builder, then the
 * header each /r/ response carries. Only fixed metric names appear, never a
 * repository, path, commit or user, and a denial carries none at all.
 */
let fixture: Awaited<ReturnType<typeof repoReadFixture>>;

beforeEach(async () => {
  fixture = await repoReadFixture();
  stubSessions();
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "caches");
});

const pub = `/r/${publicRepo.owner}/${publicRepo.name}`;
const priv = `/r/${privateRepo.owner}/${privateRepo.name}`;

function get(path: string, headers: Record<string, string> = {}, env: object = fixture.env) {
  return app.request(`https://rendro.test${path}`, { headers }, env, fixture.ctx);
}

/** The header's metrics by name: `{ auth: { dur: "1.0" }, cache: { desc: "r2" }, … }`. */
function phases(response: Response): Record<string, Record<string, string>> | null {
  const header = response.headers.get("Server-Timing");
  if (header === null) return null;
  // Fixed names and enumerated descriptions only: nothing a reader or repository could put there.
  expect(header).toMatch(/^[a-z0-9-]+(?:;(?:dur=\d+\.\d|desc=[a-z0-9]+))?(?:, [a-z0-9-]+(?:;(?:dur=\d+\.\d|desc=[a-z0-9]+))?)*$/);
  return Object.fromEntries(header.split(", ").map(part => {
    const [name, ...params] = part.split(";");
    return [name, Object.fromEntries(params.map(param => param.split("=") as [string, string]))];
  }));
}

describe("the Server-Timing builder", () => {
  it("adds up each phase, keeps the deepest tier and reports only what ran", async () => {
    let clock = 100;
    const timing = new ReadTiming(() => clock);
    await timing.time("auth", () => { clock += 1.25; return Promise.resolve(); });
    await timing.time("r2", () => { clock += 2; return Promise.resolve(); });
    await expect(timing.time("r2", () => { clock += 3; return Promise.reject(new Error("stalled")); })).rejects.toThrow("stalled");
    timing.served("r2");
    timing.served("colo");
    clock += 1;
    expect(timing.header()).toBe("auth;dur=1.3, cache;desc=r2, r2;dur=5.0, total;dur=7.3");
  });

  it("names memory when nothing was read, and orders every phase after the tier", async () => {
    let clock = 0;
    const timing = new ReadTiming(() => clock);
    expect(timing.header()).toBe("cache;desc=memory, total;dur=0.0");
    for (const phase of ["search", "first-view", "r2", "colo", "shared"] as const) await timing.time(phase, () => { clock += 1; return Promise.resolve(); });
    timing.served("shared");
    expect(timing.header()).toBe("cache;desc=shared, shared;dur=1.0, colo;dur=1.0, r2;dur=1.0, first-view;dur=1.0, search;dur=1.0, total;dur=5.0");
  });

  it("defaults to the high-resolution clock", () => {
    expect(new ReadTiming().header()).toMatch(/^cache;desc=memory, total;dur=\d+\.\d$/);
  });
});

describe("Server-Timing on /r/ responses", () => {
  it("reports authorization, the R2 tier and the total on a cold public shell, then memory once warm", async () => {
    clearSnapshotMemory();
    const cold = phases(await get(pub));
    // The fixture's cacheable subrequest misses, so the read went on to R2.
    expect(Object.keys(cold ?? {})).toEqual(["auth", "cache", "shared", "r2", "total"]);
    expect(cold?.cache.desc).toBe("r2");
    const warm = phases(await get(pub));
    expect(warm?.cache.desc).toBe("memory");
    expect(warm?.r2).toBeUndefined();
  });

  it("reports the colo tier when caches.default answers", async () => {
    const edge = new MemoryEdgeCache();
    Object.assign(globalThis, { caches: { default: edge } });
    clearSnapshotMemory();
    const frame = `${pub}/@${fixture.commits.public}/files/docs/index.md`;
    expect(phases(await get(frame))?.cache.desc).toBe("r2");
    await fixture.settle();
    clearSnapshotMemory();
    const colo = phases(await get(frame));
    expect(colo?.cache.desc).toBe("colo");
    expect(colo?.colo.dur).toMatch(/^\d+\.\d$/);
    expect(colo?.r2).toBeUndefined();
  });

  it("reports the shared tier when the cacheable subrequest answers", async () => {
    const sessions = globalThis.fetch;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.pathname.startsWith(SHARED_CACHE_PATH)) return sessions(input as never, init);
      const encoded = url.pathname.split("/").pop() as string;
      const storageKey = new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)));
      const object = fixture.bucket.objects.get(storageKey);
      return Promise.resolve(object ? new Response(object.bytes as Uint8Array<ArrayBuffer>) : new Response(null, { status: 404 }));
    }) as typeof fetch;
    clearSnapshotMemory();
    const shared = phases(await get(`${pub}/@${fixture.commits.public}/files/docs/index.md`));
    expect(shared?.cache.desc).toBe("shared");
    expect(shared?.shared.dur).toMatch(/^\d+\.\d$/);
    expect(shared?.r2).toBeUndefined();
  });

  it("is on tree pages, private frames and ticketed assets", async () => {
    expect(phases(await get(`${pub}/@${fixture.commits.public}/tree?dir=`))?.cache).toBeDefined();
    const shell = await get(priv, { cookie: sessionCookies.reader });
    expect(phases(shell)?.auth.dur).toMatch(/^\d+\.\d$/);
    const frame = await get(`${priv}/@${fixture.commits.private}/files/docs/index.md`, { cookie: sessionCookies.reader });
    expect(frame.status).toBe(200);
    expect(phases(frame)?.total).toBeDefined();
    const prefix = /<base data-rendro-viewer href="([^"]+\/files\/)/.exec(await frame.text())?.[1] as string;
    expect(phases(await get(`${prefix}docs/img/logo.png`))?.total).toBeDefined();
  });

  it("times the search index on search responses", async () => {
    const database = new SqliteSearchD1();
    await d1SearchIndex(database).migrate();
    const manifest = fixture.bucket.json<SnapshotManifest>(manifestKey(publicRepo.id, fixture.commits.public, RENDERER_VERSION)) as SnapshotManifest;
    const [, page] = Object.entries(manifest.files).find(([, file]) => file.render !== undefined) as [string, { sha: string }];
    await d1SearchIndex(database).putBlob(publicRepo.id, page.sha, [{ slug: "intro", title: "Intro", text: "searchable prose" }]);
    const response = await get(`${pub}/search?q=searchable`, {}, { ...fixture.env, REPO_SEARCH: database });
    expect(response.status).toBe(200);
    expect(phases(response)?.search.dur).toMatch(/^\d+\.\d$/);
  });

  it("does not count a background pointer refresh against the request", async () => {
    expect((await get(pub)).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_000);
    const stale = phases(await get(pub));
    await fixture.settle();
    expect(stale?.cache.desc).toBe("memory");
    expect(stale?.r2).toBeUndefined();
  });

  it("times the first-view window on the preparing page", async () => {
    fixture.access.addRepo(freshRepo);
    const coordinator = new FakeIngestCoordinator();
    coordinator.autoAnswer = { status: "duplicate" };
    fixture.env.REPO_INGEST = coordinator.namespace;
    const response = await get(`/r/${freshRepo.owner}/${freshRepo.name}`);
    expect(response.status).toBe(200);
    expect(phases(response)?.["first-view"].dur).toMatch(/^\d+\.\d$/);
  });

  it("is never on a denial, an unknown repository, a malformed URL or an unconfigured Worker", async () => {
    for (const response of [
      await get(priv),
      await get(`${priv}/@${fixture.commits.private}/files/docs/index.md`, { cookie: sessionCookies.outsider }),
      await get("/r/octo/missing-docs"),
      await get(`${pub}/files/..%2Fsecret.md`),
      await get(pub, {}, {}),
    ]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("Server-Timing")).toBeNull();
    }
  });

  it("is never on a comment-access post, which reports nothing", async () => {
    const response = await app.request(`https://rendro.test${pub}/comment-access`, { method: "POST", headers: { origin: "https://evil.test" } }, fixture.env, fixture.ctx);
    expect(response.headers.get("Server-Timing")).toBeNull();
  });
});
