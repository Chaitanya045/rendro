import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { STORAGE_READ_TIMEOUT_MS, copyObject, deleteObject, getObjectStream, getObjectText, headObject, listAllKeys, listImmediate, listObjects, putObject } from "../src/minio";

const send = vi.fn();
beforeEach(() => { send.mockReset(); vi.spyOn(S3Client.prototype, "send").mockImplementation(send); });
afterEach(() => vi.restoreAllMocks());

describe("storage requests and responses", () => {
  it("passes upload/copy lease abort signals through to the storage SDK", async () => {
    const signal = AbortSignal.timeout(1000);
    await putObject("a", "body", "text/plain", { sha256: "hash" }, signal);
    expect(send.mock.calls[0][0].input).toMatchObject({ Key: "a", Body: "body", ContentType: "text/plain", Metadata: { sha256: "hash" } });
    expect(send.mock.calls[0][1]).toEqual({ abortSignal: signal });
    await copyObject("root/a b%.html", "b", signal);
    expect(send.mock.calls[1][0].input.CopySource).toContain("root/a%20b%25.html");
    expect(send.mock.calls[1][1]).toEqual({ abortSignal: signal });
    await putObject("a", "default");
    expect(send.mock.calls[2][0].input.ContentType).toBe("text/html");
    await deleteObject("a");
    expect(send.mock.calls[3][0].input.Key).toBe("a");
  });

  it("lists HTML recursively and drains storage pages, preserving metadata", async () => {
    const date = new Date(100);
    send.mockResolvedValueOnce({ Contents: [{}, { Key: "root/no.txt" }, { Key: "root/a.html", Size: 5, LastModified: date }], CommonPrefixes: [{}, { Prefix: "root/nested/" }], NextContinuationToken: "next" })
      .mockResolvedValueOnce({ Contents: [{ Key: "root/nested/b.html" }] }).mockResolvedValueOnce({});
    expect(await listObjects("root/")).toEqual([
      { key: "root/a.html", name: "a.html", size: 5, lastModified: date },
      { key: "root/nested/b.html", name: "b.html", size: 0, lastModified: new Date(0) },
    ]);
    expect(send.mock.calls[2][0].input.ContinuationToken).toBe("next");
  });

  it("lists immediate files/folders with a continuation boundary and empty fallbacks", async () => {
    const date = new Date(100);
    send.mockResolvedValueOnce({ Contents: [{}, { Key: "root/" }, { Key: "root/no.txt" }, { Key: "root/a.html", Size: 5, LastModified: date }, { Key: "root/b.html" }], CommonPrefixes: [{}, { Prefix: "root/child/" }], IsTruncated: true });
    const result = await listImmediate("root/", { maxKeys: 20, startAfter: "previous" });
    expect(result).toEqual({ isTruncated: true, nextStartAfter: "root/child/", entries: [
      { key: "root/a.html", name: "a.html", size: 5, lastModified: date },
      { key: "root/b.html", name: "b.html", size: 0, lastModified: new Date(0) },
      { key: "root/child/", name: "child", size: 0, lastModified: new Date(0) },
    ] });
    expect(send.mock.calls[0][0].input).toMatchObject({ MaxKeys: 20, StartAfter: "previous" });
    send.mockResolvedValueOnce({});
    expect(await listImmediate("root/")).toEqual({ entries: [], isTruncated: false, nextStartAfter: undefined });
    send.mockResolvedValueOnce({ IsTruncated: true });
    expect((await listImmediate("root/", {})).nextStartAfter).toBeUndefined();
  });

  it("lists all keys across pages without assuming every object has a key", async () => {
    send.mockResolvedValueOnce({ Contents: [{}, { Key: "root/a" }], NextContinuationToken: "next" }).mockResolvedValueOnce({});
    expect(await listAllKeys("root/")).toEqual(["root/a"]);
    expect(send.mock.calls[1][0].input.ContinuationToken).toBe("next");
  });

  it("reads stream, text, and metadata bodies, including absent body/metadata", async () => {
    const stream = new Response("hello").body;
    send.mockResolvedValueOnce({ Body: { transformToWebStream: () => stream } }).mockResolvedValueOnce({});
    expect(await getObjectStream("a")).toBe(stream);
    expect(await getObjectStream("a")).toBeNull();
    send.mockResolvedValueOnce({ Body: { transformToString: () => Promise.resolve("hello") } }).mockResolvedValueOnce({});
    expect(await getObjectText("a")).toBe("hello");
    expect(await getObjectText("a")).toBeNull();
    send.mockResolvedValueOnce({ ETag: '"abc"', ContentLength: 5, ContentType: "text/plain", Metadata: { sha256: "hash" } }).mockResolvedValueOnce({});
    expect(await headObject("a")).toEqual({ etag: "abc", size: 5, contentType: "text/plain", metadata: { sha256: "hash" } });
    expect(await headObject("a")).toEqual({ etag: undefined, size: undefined, contentType: undefined, metadata: undefined });
  });

  it.each([getObjectStream, getObjectText, headObject])("distinguishes missing objects from storage failure in %s", async read => {
    send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    expect(await read("a")).toBeNull();
    for (const failure of [{ $metadata: { httpStatusCode: 503 } }, new Error("network")]) {
      send.mockRejectedValueOnce(failure);
      await expect(read("a")).rejects.toBe(failure);
    }
  });

  describe("read deadline", () => {
    afterEach(() => vi.useRealTimers());
    const stalls = () => send.mockImplementation((_command: unknown, options: { abortSignal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));

    it.each([getObjectStream, getObjectText])("aborts a stalled storage read as a failure, not as a missing object (%o)", async read => {
      vi.useFakeTimers();
      stalls();
      const outcome = expect(read("a")).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(STORAGE_READ_TIMEOUT_MS - 1);
      expect(send.mock.calls.at(-1)![1].abortSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(send.mock.calls.at(-1)![1].abortSignal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves the timer and signal alone once a read has answered", async () => {
      vi.useFakeTimers();
      send.mockResolvedValueOnce({ Body: { transformToWebStream: () => new Response("x").body } })
        .mockResolvedValueOnce({ Body: { transformToString: () => Promise.resolve("x") } });
      await getObjectStream("a");
      expect(await getObjectText("a")).toBe("x");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(STORAGE_READ_TIMEOUT_MS * 2);
      expect(send.mock.calls.map(call => (call[1] as { abortSignal: AbortSignal }).abortSignal.aborted)).toEqual([false, false]);
    });
  });

  it("issues ranged reads and fails closed on an unexpected slice or total", async () => {
    const range = { start: 10, end: 19, size: 100 };
    const stream = new Response("0123456789").body;
    send.mockResolvedValueOnce({ Body: { transformToWebStream: () => stream }, ContentRange: "bytes 10-19/100" });
    expect(await getObjectStream("a", range)).toBe(stream);
    expect(send.mock.calls[0][0].input).toMatchObject({ Key: "a", Range: "bytes=10-19" });
    // Whole-object reads never send a Range.
    send.mockResolvedValueOnce({ Body: { transformToWebStream: () => new Response("x").body } });
    await getObjectStream("a");
    expect(send.mock.calls[1][0].input).not.toHaveProperty("Range");
    // A store that ignores the range, or reports a different slice/total, is an error.
    for (const ContentRange of [undefined, "bytes 0-99/100", "bytes 10-19/101", "bytes 10-18/100"]) {
      const cancel = vi.fn(() => Promise.reject(new Error("closed")));
      send.mockResolvedValueOnce({ Body: { transformToWebStream: () => new ReadableStream({ cancel }) }, ContentRange });
      await expect(getObjectStream("a", range)).rejects.toThrow("unexpected byte range");
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it("propagates an absent thrown stream error without treating it as a missing key", async () => {
    send.mockRejectedValueOnce(undefined);
    await expect(getObjectStream("a")).rejects.toBeUndefined();
  });
});

it("bounds commit listings by keys and page count, including short/repeated pages", async () => {
  const limits = { maxKeys: 1000, maxPages: 8 };
  for (const count of [999, 1000]) {
    send.mockResolvedValueOnce({ Contents: Array.from({ length: count }, (_, i) => ({ Key: `root/${i}` })) });
    expect((await listAllKeys("root/", limits)).length).toBe(count);
  }
  send.mockResolvedValueOnce({ Contents: Array.from({ length: 1001 }, (_, i) => ({ Key: `root/${i}` })) });
  await expect(listAllKeys("root/", limits)).rejects.toThrow("verification budget");
  send.mockClear();
  send.mockResolvedValue({ Contents: [], NextContinuationToken: "repeated" });
  await expect(listAllKeys("root/", limits)).rejects.toThrow("verification budget");
  expect(send).toHaveBeenCalledTimes(8);
  send.mockReset();
  for (let i = 0; i < 7; i++) send.mockResolvedValueOnce({ NextContinuationToken: String(i) });
  send.mockResolvedValueOnce({ Contents: [{ Key: "root/a" }] });
  expect(await listAllKeys("root/", limits)).toEqual(["root/a"]);
  expect(send).toHaveBeenCalledTimes(8);
});
