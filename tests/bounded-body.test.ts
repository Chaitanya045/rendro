import { describe, expect, it, vi } from "vitest";
import { readExactBody } from "@/bounded-body";

function chunked(
  chunks: number[][],
  cancel = vi.fn(),
): { stream: ReadableStream<Uint8Array>; cancel: typeof cancel } {
  let index = 0;
  return {
    cancel,
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(Uint8Array.from(chunk));
        else controller.close();
      },
      cancel,
    }),
  };
}

describe("manifest-bounded request body reader", () => {
  it("cancels a chunked body immediately when it exceeds the expected size", async () => {
    const source = chunked([[1, 2], [3, 4], [5], [6]]);
    await expect(readExactBody(source.stream, 4)).resolves.toBeNull();
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.cancel).toHaveBeenCalledWith("Request body exceeds manifest size");
  });

  it("rejects an undersized body after the stream ends", async () => {
    const source = chunked([[1], [2]]);
    await expect(readExactBody(source.stream, 3)).resolves.toBeNull();
    expect(source.cancel).not.toHaveBeenCalled();
  });

  it("combines valid chunks without using Request.arrayBuffer", async () => {
    const source = chunked([[1, 2], [3], [4, 5]]);
    await expect(readExactBody(source.stream, 5)).resolves.toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(source.cancel).not.toHaveBeenCalled();
  });

  it("accepts an absent body only for a zero-byte manifest entry", async () => {
    await expect(readExactBody(null, 0)).resolves.toEqual(new Uint8Array());
    await expect(readExactBody(null, 1)).resolves.toBeNull();
  });

  it("accepts an empty stream for a zero-byte manifest entry and cancels non-empty input", async () => {
    const empty = chunked([]);
    await expect(readExactBody(empty.stream, 0)).resolves.toEqual(new Uint8Array());
    const nonEmpty = chunked([[1]]);
    await expect(readExactBody(nonEmpty.stream, 0)).resolves.toBeNull();
    expect(nonEmpty.cancel).toHaveBeenCalledOnce();
  });
});
