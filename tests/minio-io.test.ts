import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { copyObject, deleteObject, getObjectStream, getObjectText, headObject, listAllKeys, listImmediate, listObjects, putObject } from "../src/minio";

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

  it("propagates an absent thrown stream error without treating it as a missing key", async () => {
    send.mockRejectedValueOnce(undefined);
    await expect(getObjectStream("a")).rejects.toBeUndefined();
  });
});
