import { describe, expect, it, vi } from "vitest";
import { contentEtag, contentSize, noneMatch, parseRange, serveObject, transformedEtag } from "@/routes/object-delivery";

const sha = "a".repeat(64);

describe("validators", () => {
  it("derives a strong quoted tag only from a well-formed sha256", () => {
    expect(contentEtag(sha)).toBe(`"sha256-${sha}"`);
    for (const bad of [undefined, null, 5, "a", "A".repeat(64), `${sha}0`, ""]) expect(contentEtag(bad)).toBeUndefined();
  });

  it("accepts only non-negative safe integers as sizes", () => {
    expect(contentSize(0)).toBe(0);
    expect(contentSize(1_000_000)).toBe(1_000_000);
    for (const bad of [undefined, -1, 1.5, Number.NaN, Infinity, 2 ** 53, "10"]) expect(contentSize(bad)).toBeUndefined();
  });

  it("gives transformed bytes a tag that tracks the source, injector version and markup", async () => {
    const base = await transformedEtag(sha, 1, "<script></script>");
    expect(base).toMatch(/^"sha256-a{64}-i1-[0-9a-f]{24}"$/);
    expect(await transformedEtag(sha, 1, "<script></script>")).toBe(base);
    expect(await transformedEtag(sha, 2, "<script></script>")).not.toBe(base);
    expect(await transformedEtag(sha, 1, "<script>x</script>")).not.toBe(base);
    expect(await transformedEtag("b".repeat(64), 1, "<script></script>")).not.toBe(base);
    expect(await transformedEtag("bad", 1, "<script></script>")).toBeUndefined();
  });
});

describe("If-None-Match", () => {
  const etag = '"sha256-x"';
  it.each([
    [null, false], ["", false], ['"sha256-x"', true], ['W/"sha256-x"', true], ['"a", "sha256-x"', true], ['"a","sha256-x"', true],
    ['\t"sha256-x"\t', true], ["*", true], ['"a", *', true], ['bad, "sha256-x"', true], ['"a" "sha256-x"', false],
    ['"a", bad "x", "sha256-x"', true], ['"sha256-y"', false], ["sha256-x", false], ['"sha256-x', false], ['"sha256-x"x', false],
    ['W/"sha256-y", W/"z"', false], [",,,", false], ['"a",', false], ['"é"', false],
    [`${'"a",'.repeat(600)}"sha256-x"`, false],
  ])("evaluates %j as %s", (header, expected) => {
    expect(noneMatch(header, etag)).toBe(expected);
  });

  it("matches only the wildcard when the representation has no validator", () => {
    expect(noneMatch('"sha256-x"', undefined)).toBe(false);
    expect(noneMatch("*", undefined)).toBe(true);
  });

  it("terminates on adversarial lists", () => {
    const started = performance.now();
    for (const header of ['"a", bad, bad, bad', ",".repeat(2000), '"'.repeat(2000), `W/${"\"".repeat(1000)}`, "\\".repeat(2000)]) noneMatch(header, etag);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("Range", () => {
  it.each([
    ["bytes=0-0", { start: 0, end: 0 }], ["bytes=0-9", { start: 0, end: 9 }], ["bytes=95-", { start: 95, end: 99 }],
    ["bytes=99-99", { start: 99, end: 99 }], ["bytes=90-1000", { start: 90, end: 99 }], ["bytes=-1", { start: 99, end: 99 }],
    ["bytes=-100", { start: 0, end: 99 }], ["bytes=-101", { start: 0, end: 99 }], ["Bytes=1-2", { start: 1, end: 2 }],
    ["bytes = 1 - 2 ", { start: 1, end: 2 }], ["bytes=007-009", { start: 7, end: 9 }],
    [`bytes=0-${"9".repeat(40)}`, { start: 0, end: 99 }], [`bytes=-${"9".repeat(40)}`, { start: 0, end: 99 }],
    ["bytes=100-", "unsatisfiable"], ["bytes=100-100", "unsatisfiable"], ["bytes=-0", "unsatisfiable"],
    [`bytes=${"9".repeat(40)}-`, "unsatisfiable"], [`bytes=${"9".repeat(40)}-${"9".repeat(41)}`, "unsatisfiable"],
    ["bytes=9007199254740993-", "unsatisfiable"],
    [null, null], ["", null], ["bytes=", null], ["bytes=-", null], ["bytes=5-4", null], ["bytes=a-b", null], ["bytes=1-2-3", null],
    ["bytes=1-2,4-5", null], ["bytes=-1,-2", null], ["items=1-2", null], ["1-2", null], ["bytes=1-2x", null], ["bytes=+1-2", null],
    ["bytes=0x1-2", null], ["bytes=1 2-3", null], [`bytes=${"1,".repeat(100)}`, null], [`bytes=0-${"9".repeat(200)}`, null],
  ])("parses %j against 100 bytes", (header, expected) => {
    expect(parseRange(header, 100)).toEqual(expected);
  });

  it("never satisfies a range of an empty object", () => {
    for (const header of ["bytes=0-", "bytes=0-0", "bytes=-1", "bytes=-0"]) expect(parseRange(header, 0)).toBe("unsatisfiable");
  });
});

describe("serveObject", () => {
  const body = () => new Response("0123456789").body!;
  const base = (init: Partial<Parameters<typeof serveObject>[0]> = {}, headers: Record<string, string> = {}, method = "GET") => ({
    request: new Request("https://rendro.test/f", { method, headers }),
    headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=0, must-revalidate" },
    etag: '"sha256-x"', size: 10, open: vi.fn(() => Promise.resolve(body())), missing: () => new Response("gone", { status: 404 }), ...init,
  });

  it("hands storage the concrete range and labels the slice", async () => {
    const delivery = base({ open: vi.fn(() => Promise.resolve(new Response("234").body)) }, { Range: "bytes=2-4" });
    const response = await serveObject(delivery);
    expect(delivery.open).toHaveBeenCalledWith({ start: 2, end: 4, size: 10 });
    expect(response.status).toBe(206);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-range": "bytes 2-4/10", "content-length": "3", "accept-ranges": "bytes", etag: '"sha256-x"', "content-type": "text/plain",
    });
    expect(await response.text()).toBe("234");
  });

  it("reports a vanished object as missing for both full and ranged reads", async () => {
    for (const headers of [{}, { Range: "bytes=0-1" }] as Array<Record<string, string>>) {
      const response = await serveObject(base({ open: () => Promise.resolve(null) }, headers));
      expect(response.status).toBe(404);
      expect(response.headers.has("content-range")).toBe(false);
    }
  });

  it("serves bytes without size or validator as a plain 200 and never advertises ranges", async () => {
    const delivery = base({ etag: undefined, size: undefined }, { Range: "bytes=0-1", "If-Range": '"x"', "If-None-Match": '"sha256-x"' });
    const response = await serveObject(delivery);
    expect(response.status).toBe(200);
    expect([...response.headers.keys()].sort()).toEqual(["cache-control", "content-type"]);
    expect(delivery.open).toHaveBeenCalledWith();
  });

  it("does not open storage for 304, 416 or HEAD", async () => {
    for (const [headers, method, status] of [
      [{ "If-None-Match": '"sha256-x"' }, "GET", 304], [{ Range: "bytes=10-" }, "GET", 416], [{}, "HEAD", 200], [{ Range: "bytes=0-1" }, "HEAD", 200],
    ] as const) {
      const delivery = base({}, headers, method);
      const response = await serveObject(delivery);
      expect(response.status).toBe(status);
      expect(delivery.open).not.toHaveBeenCalled();
    }
  });

  it("serves an empty object whole and rejects any range of it", async () => {
    const empty = base({ size: 0, open: () => Promise.resolve(new Response("").body) });
    const whole = await serveObject(empty);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe("0");
    expect((await serveObject({ ...empty, request: new Request("https://rendro.test/f", { headers: { Range: "bytes=0-" } }) })).status).toBe(416);
  });
});
