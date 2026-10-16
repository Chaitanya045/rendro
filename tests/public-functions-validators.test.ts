import { ConvexError, v } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import { mutation, query } from "../convex/publicFunctions";

type Invokable = { _handler: (ctx: unknown, args: unknown) => unknown };
const invoke = (fn: unknown, args: unknown) => (fn as Invokable)._handler({}, args);

describe("public RPC argument validation", () => {
  const handler = vi.fn((_ctx: unknown, args: { name: string }) => args.name);

  it("passes validated arguments through to the handler for queries and mutations", () => {
    expect(invoke(query({ args: { name: v.string() }, handler }), { name: "ok" })).toBe("ok");
    expect(invoke(mutation({ args: { name: v.string() }, handler }), { name: "ok" })).toBe("ok");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid input with the sanitized public error before running the handler", () => {
    handler.mockClear();
    for (const fn of [query, mutation]) {
      const registered = fn({ args: { name: v.string() }, handler });
      for (const bad of [{ name: 1 }, {}, { name: "x", extra: true }]) {
        let thrown: unknown;
        try { invoke(registered, bad); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(ConvexError);
        expect((thrown as ConvexError<{ code: string }>).data.code).toBe("invalid_input");
      }
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts and rejects each supported validator kind exactly", () => {
    const registered = query({
      args: {
        text: v.string(), count: v.number(), flag: v.boolean(), nothing: v.null(), kind: v.literal("doc"),
        tags: v.array(v.string()), either: v.union(v.string(), v.number()),
        nested: v.object({ inner: v.string(), maybe: v.optional(v.number()) }), optional: v.optional(v.string()),
      },
      handler: () => "accepted",
    });
    const valid = { text: "t", count: 1, flag: false, nothing: null, kind: "doc", tags: ["a"], either: 2, nested: { inner: "i" } };
    expect(invoke(registered, valid)).toBe("accepted");
    expect(invoke(registered, { ...valid, optional: "o", either: "s", nested: { inner: "i", maybe: 3 }, tags: [] })).toBe("accepted");
    expect(invoke(registered, { ...valid, optional: undefined })).toBe("accepted");
    const rejected: Array<Record<string, unknown>> = [
      { ...valid, text: 1 }, { ...valid, count: "1" }, { ...valid, flag: "no" }, { ...valid, nothing: undefined },
      { ...valid, kind: "other" }, { ...valid, tags: "a" }, { ...valid, tags: ["a", 1] }, { ...valid, either: true },
      { ...valid, nested: null }, { ...valid, nested: [] }, { ...valid, nested: {} }, { ...valid, nested: { inner: "i", extra: 1 } },
      { ...valid, nested: { inner: "i", maybe: "x" } }, { ...valid, optional: 1 },
    ];
    for (const bad of rejected) expect(() => invoke(registered, bad), JSON.stringify(bad)).toThrow(ConvexError);
  });

  it.each([
    ["int64", v.int64()],
    ["bytes", v.bytes()],
    ["any", v.any()],
    ["id", v.id("projects")],
    ["record", v.record(v.string(), v.string())],
  ])("treats an unsupported %s validator as a programming error, not a client failure", (_kind, unsupported) => {
    const registered = query({ args: { value: unsupported }, handler: () => "unreachable" });
    let thrown: unknown;
    try { invoke(registered, { value: "anything" }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ConvexError);
    expect((thrown as Error).message).toBe("Unsupported public argument validator");
  });
});
