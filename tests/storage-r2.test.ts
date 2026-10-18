import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindStorage, copyObject, deleteObject, deleteObjects, getObjectStream, getObjectText, headObject, listAllKeys, listImmediate,
  listKeyPage, putObject, STORAGE_READ_TIMEOUT_MS, type StorageBucket,
} from "../src/storage";
import { memoryBucket, r2Error } from "./helpers/memory-bucket";
import { r2Simulation } from "./helpers/r2-simulation";

const text = async (stream: ReadableStream<Uint8Array> | null) => stream ? await new Response(stream).text() : null;

// The behavioural cases run against the in-memory fake and against Miniflare's real R2 simulation,
// so the fake the rest of the suite relies on is held to the real binding's behaviour.
let simulation: Awaited<ReturnType<typeof r2Simulation>>;
beforeAll(async () => { simulation = await r2Simulation(); }, 60_000);
afterAll(async () => { await simulation.dispose(); });

describe.each([["in-memory bucket", () => memoryBucket()], ["Miniflare R2", () => simulation.bucket]] as const)("storage over the %s", (_name, open) => {
  let bucket: StorageBucket;
  beforeEach(async () => {
    bucket = open();
    // Miniflare's bucket is shared by the cases below: start each one empty.
    const everything = await bucket.list();
    if (everything.objects.length) await bucket.delete(everything.objects.map(object => object.key));
    bindStorage(bucket);
  });
  afterEach(() => bindStorage(undefined));

  it("writes with a content type and metadata, and reads them back with an unquoted etag", async () => {
    await putObject("tenants/a/index.html", "<h1>hi</h1>", "text/html; charset=utf-8", { sha256: "abc" });
    await putObject("tenants/a/default.html", new TextEncoder().encode("bytes"));
    const head = await headObject("tenants/a/index.html");
    expect(head).toEqual({ contentType: "text/html; charset=utf-8", etag: expect.stringMatching(/^[0-9a-f]{32}$/), size: 11, metadata: { sha256: "abc" } });
    expect(await headObject("tenants/a/default.html")).toMatchObject({ contentType: "text/html", size: 5, metadata: {} });
    expect(await headObject("tenants/a/missing.html")).toBeNull();
    expect(await getObjectText("tenants/a/index.html")).toBe("<h1>hi</h1>");
    expect(await getObjectText("tenants/a/missing.html")).toBeNull();
    expect(await text(await getObjectStream("tenants/a/index.html"))).toBe("<h1>hi</h1>");
    expect(await getObjectStream("tenants/a/missing.html")).toBeNull();
  });

  it("keeps non-UTF-8 bytes intact through a stream", async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x80, 0x41]);
    await putObject("binary", bytes, "application/octet-stream");
    const stream = await getObjectStream("binary");
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(bytes);
  });

  it("issues ranged reads and fails closed unless storage answers with exactly the requested slice and total", async () => {
    await putObject("doc", "hello world");
    expect(await text(await getObjectStream("doc", { start: 2, end: 4, size: 11 }))).toBe("llo");
    expect(await text(await getObjectStream("doc", { start: 6, end: 10, size: 11 }))).toBe("world");
    // A different total (the object changed size since the manifest was written) or a range running past the end is never relabelled.
    await expect(getObjectStream("doc", { start: 2, end: 4, size: 100 })).rejects.toThrow("unexpected byte range");
    await expect(getObjectStream("doc", { start: 6, end: 20, size: 21 })).rejects.toThrow("unexpected byte range");
    await expect(getObjectStream("doc", { start: 6, end: 20, size: 11 })).rejects.toThrow("unexpected byte range");
    // A start beyond the object is rejected by storage itself (10039) and is a final, not a retried, failure.
    await expect(getObjectStream("doc", { start: 50, end: 59, size: 100 })).rejects.toThrow(/\(10039\)/);
    expect(await getObjectStream("absent", { start: 0, end: 1, size: 2 })).toBeNull();
  });

  it("lists only the immediate .html files and folders, with a continuation boundary", async () => {
    for (const key of ["root/a.html", "root/b.html", "root/skip.txt", "root/dir/x.html", "root/dir/y.html", "root/zeta/z.html", "other/q.html"]) await putObject(key, key);
    const first = await listImmediate("root/");
    expect(first.entries.map(entry => [entry.key, entry.name, entry.size])).toEqual([
      ["root/a.html", "a.html", 11], ["root/b.html", "b.html", 11], ["root/dir/", "dir", 0], ["root/zeta/", "zeta", 0],
    ]);
    expect(first.entries[0]!.lastModified).toBeInstanceOf(Date);
    expect(first.entries[2]!.lastModified.getTime()).toBe(0);
    expect(first).toMatchObject({ isTruncated: false, nextStartAfter: undefined });
    const page = await listImmediate("root/", { maxKeys: 2 });
    expect(page.isTruncated).toBe(true);
    expect(page.nextStartAfter).toBe("root/b.html");
    const rest = await listImmediate("root/", { maxKeys: 10, startAfter: page.nextStartAfter });
    expect(rest.entries.map(entry => entry.key)).toEqual(["root/dir/", "root/zeta/"]);
    expect((await listImmediate("empty/")).entries).toEqual([]);
  });

  it("continues a listing from its cursor, which is the only way past the first page", async () => {
    for (const key of ["c/1", "c/2", "c/3", "c/4", "c/5"]) await putObject(key, "x");
    const first = await bucket.list({ prefix: "c/", limit: 2 });
    expect(first.objects.map(object => object.key)).toEqual(["c/1", "c/2"]);
    expect(first.truncated).toBe(true);
    const second = await bucket.list({ prefix: "c/", limit: 2, cursor: first.cursor });
    expect(second.objects.map(object => object.key)).toEqual(["c/3", "c/4"]);
    const last = await bucket.list({ prefix: "c/", limit: 2, cursor: second.cursor });
    expect(last.truncated).toBe(false);
    expect(last.cursor).toBeUndefined();
    expect(last.objects.map(object => object.key)).toEqual(["c/5"]);
    expect((await listAllKeys("c/", { maxKeys: 5, maxPages: 1 }))).toHaveLength(5);
    await expect(listAllKeys("c/", { maxKeys: 4, maxPages: 1 })).rejects.toThrow("verification budget");
  });

  it("pages a prefix for deletion", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) => putObject(`p/${i}`, "x")));
    expect(await listKeyPage("p/", 3)).toEqual({ keys: ["p/0", "p/1", "p/2"], truncated: true });
    expect(await listKeyPage("p/", 10)).toEqual({ keys: ["p/0", "p/1", "p/2", "p/3", "p/4"], truncated: false });
    expect(await listKeyPage("none/", 10)).toEqual({ keys: [], truncated: false });
  });

  it("copies bytes, content type and metadata, and refuses a missing source", async () => {
    await putObject("from", "payload", "image/svg+xml", { sha256: "digest" });
    await copyObject("from", "to");
    expect(await headObject("to")).toEqual({ ...(await headObject("from")), contentType: "image/svg+xml", metadata: { sha256: "digest" } });
    expect(await getObjectText("to")).toBe("payload");
    await expect(copyObject("absent", "never")).rejects.toThrow("copy source does not exist");
    expect(await headObject("never")).toBeNull();
    await copyObject("from", "to-with-signal", AbortSignal.timeout(10_000));
    expect(await getObjectText("to-with-signal")).toBe("payload");
  });

  it("deletes one key or many, and treats a missing key as already deleted", async () => {
    for (const key of ["d1", "d2", "d3"]) await putObject(key, "x");
    await deleteObject("d1");
    await deleteObject("d1");
    await deleteObjects(["d2", "d3", "never-existed"]);
    expect(await listAllKeys("d")).toEqual([]);
  });
});

describe("listing beyond one page", () => {
  it("lists every key across pages and enforces the commit verification budget", async () => {
    const bucket = memoryBucket();
    bindStorage(bucket);
    for (let i = 0; i < 1005; i++) await putObject(`many/${String(i).padStart(4, "0")}`, "x");
    await putObject("manyother", "x");
    const list = vi.spyOn(bucket, "list");
    const keys = await listAllKeys("many/");
    expect(keys).toHaveLength(1005);
    expect(keys[0]).toBe("many/0000");
    expect(keys.at(-1)).toBe("many/1004");
    expect(list).toHaveBeenCalledTimes(2);
    expect(await listAllKeys("many/", { maxKeys: 1005, maxPages: 2 })).toHaveLength(1005);
    await expect(listAllKeys("many/", { maxKeys: 1004, maxPages: 8 })).rejects.toThrow("verification budget");
    await expect(listAllKeys("many/", { maxKeys: 5000, maxPages: 1 })).rejects.toThrow("verification budget");
    expect(await listAllKeys("nothing/", { maxKeys: 1, maxPages: 1 })).toEqual([]);
    bindStorage(undefined);
  });
});

describe("storage failure handling", () => {
  afterEach(() => { bindStorage(undefined); vi.useRealTimers(); vi.restoreAllMocks(); });

  const seed = (bucket: ReturnType<typeof memoryBucket>, key: string, body: string) =>
    bucket.objects.set(key, { bytes: new TextEncoder().encode(body), uploaded: new Date(0) });

  /** A bucket whose `operation` fails with the queued errors, then behaves normally. */
  function failing(operation: "get" | "head" | "put" | "list" | "delete", ...errors: unknown[]) {
    const bucket = memoryBucket();
    const real = bucket[operation].bind(bucket) as (...args: unknown[]) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the queue deliberately holds non-Error rejections too
    const calls = vi.fn((...args: unknown[]) => errors.length ? Promise.reject(errors.shift()) : real(...args));
    (bucket as unknown as Record<string, unknown>)[operation] = calls;
    bindStorage(bucket);
    return { bucket, calls };
  }
  async function settle<T>(promise: Promise<T>): Promise<T> {
    const result = promise.then(value => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await result;
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }
  beforeEach(() => { vi.useFakeTimers(); });

  it("fails closed when no bucket is bound, or the binding is not a bucket", async () => {
    bindStorage(undefined);
    await expect(headObject("a")).rejects.toThrow("Storage binding STORAGE is not configured");
    for (const candidate of [null, "bucket", {}, { get: () => null, head: () => null, put: () => null, list: () => null }]) {
      bindStorage(memoryBucket());
      bindStorage(candidate);
      await expect(headObject("a")).rejects.toThrow("not configured");
    }
  });

  it.each([
    ["head", () => headObject("k")],
    ["get", () => getObjectText("k")],
    ["put", () => putObject("k", "v")],
    ["list", () => listAllKeys("k")],
    ["delete", () => deleteObject("k")],
  ] as Array<readonly ["head" | "get" | "put" | "list" | "delete", () => Promise<unknown>]>)("replays %s after a transient fault, up to three attempts in all", async (operation, run) => {
    const transient = failing(operation, r2Error(10001, operation), r2Error(10043, operation));
    await settle(run());
    expect(transient.calls).toHaveBeenCalledTimes(3);
    const exhausted = failing(operation, r2Error(10001, operation), r2Error(10058, operation), r2Error(10043, operation), r2Error(10001, operation));
    await expect(settle(run())).rejects.toThrow(/\(10043\)$/);
    expect(exhausted.calls).toHaveBeenCalledTimes(3);
  });

  it("does not replay a final rejection such as a bad key, a missing permission or an unsatisfiable range", async () => {
    for (const code of [10020, 10003, 10039, 10012]) {
      const { calls } = failing("put", r2Error(code, "put"));
      await expect(settle(putObject("k", "v"))).rejects.toThrow(`(${code})`);
      expect(calls).toHaveBeenCalledOnce();
    }
    const odd = failing("head", undefined);
    await expect(settle(headObject("k"))).rejects.toBeUndefined();
    expect(odd.calls).toHaveBeenCalledOnce();
  });

  it("replays a ranged read and a listing, but never a stream already handed to the caller", async () => {
    const { bucket, calls } = failing("get", r2Error(10043));
    seed(bucket, "doc", "hello world");
    expect(await text(await settle(getObjectStream("doc", { start: 0, end: 4, size: 11 })))).toBe("hello");
    expect(calls).toHaveBeenCalledTimes(2);
    const listing = failing("list", r2Error(10001));
    seed(listing.bucket, "root/a.html", "x");
    expect((await settle(listImmediate("root/"))).entries).toHaveLength(1);
    expect(listing.calls).toHaveBeenCalledTimes(2);
    expect((await settle(listKeyPage("root/", 5))).keys).toEqual(["root/a.html"]);
  });

  it("cancels the stream of a mismatched ranged read and ignores a failing cancel", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("closed")));
    const bucket = memoryBucket();
    bindStorage(bucket);
    vi.spyOn(bucket, "get").mockResolvedValueOnce({
      key: "k", size: 11, etag: "e", uploaded: new Date(0), range: { offset: 0, length: 5 }, body: new ReadableStream({ cancel }),
    });
    await expect(getObjectStream("k", { start: 2, end: 4, size: 11 })).rejects.toThrow("unexpected byte range");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("copies by re-reading the source after a transient fault in either half, and cancels the unused stream", async () => {
    const read = failing("get", r2Error(10043));
    seed(read.bucket, "a", "bytes");
    await settle(copyObject("a", "b"));
    expect(await getObjectText("b")).toBe("bytes");
    const write = failing("put", r2Error(10001));
    seed(write.bucket, "a", "bytes");
    const cancel = vi.fn(() => Promise.reject(new Error("closed")));
    vi.spyOn(write.bucket, "get").mockResolvedValueOnce({
      key: "a", size: 5, etag: "e", uploaded: new Date(0), body: new ReadableStream({ cancel }),
    });
    await settle(copyObject("a", "c"));
    expect(cancel).toHaveBeenCalledOnce();
    expect(write.calls).toHaveBeenCalledTimes(2);
    expect(await getObjectText("c")).toBe("bytes");
    // A final rejection while writing the destination is not replayed.
    const denied = failing("put", r2Error(10003, "put"));
    seed(denied.bucket, "a", "bytes");
    await expect(settle(copyObject("a", "d"))).rejects.toThrow("(10003)");
    expect(denied.calls).toHaveBeenCalledOnce();
  });

  it.each([["stream", () => getObjectStream("k")], ["text", () => getObjectText("k")]] as const)(
    "ends a stalled %s read as a TimeoutError at the read deadline, once, without replaying it", async (_name, read) => {
      const { calls } = failing("get");
      calls.mockImplementation(() => new Promise(() => {}));
      const outcome = expect(read()).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(STORAGE_READ_TIMEOUT_MS - 1);
      expect(calls).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

  it("leaves no timer behind once reads have answered", async () => {
    const { bucket } = failing("get");
    seed(bucket, "k", "x");
    expect(await text(await getObjectStream("k"))).toBe("x");
    expect(await getObjectText("k")).toBe("x");
    expect(await getObjectText("absent")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the caller's abort signal end a write at once, without replaying it", async () => {
    const expired = AbortSignal.abort(new DOMException("lease over", "TimeoutError"));
    const { calls } = failing("put");
    await expect(putObject("k", "v", "text/html", undefined, expired)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).not.toHaveBeenCalled();

    const controller = new AbortController();
    let release!: () => void;
    const stalled = failing("put");
    stalled.calls.mockImplementationOnce(() => new Promise((resolve, reject) => { release = () => reject(r2Error(10001, "put")); void resolve; }));
    const pending = putObject("k", "v", "text/html", undefined, controller.signal);
    controller.abort(new DOMException("lease over", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stalled.calls).toHaveBeenCalledOnce();

    const finishing = new AbortController();
    await putObject("done", "v", "text/html", undefined, finishing.signal);
    finishing.abort();
    expect(await getObjectText("done")).toBe("v");
    // A fault after the signal fired is final: the caller has already moved on.
    const late = new AbortController();
    const fault = failing("put", r2Error(10001, "put"));
    fault.calls.mockImplementationOnce(() => { late.abort(new Error("late")); return Promise.reject(r2Error(10001, "put")); });
    await expect(settle(putObject("k", "v", "text/html", undefined, late.signal))).rejects.toThrow("late");
  });
});
