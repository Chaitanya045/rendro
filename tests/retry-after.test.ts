import { describe, expect, it } from "vitest";
import { MAX_RETRY_AFTER_MS, retryAfterMs } from "../shared/retry-after";

const now = Date.parse("2026-01-01T00:00:00Z");

const cases: [string, unknown, number][] = [
  ["seconds", "3", 3000],
  ["padded seconds", " 3 ", 3000],
  ["zero", "0", 0],
  ["negative", "-1", 0],
  ["fractional", "1.5", 0],
  ["exponent", "1e3", 0],
  ["empty", "", 0],
  ["blank", "  ", 0],
  ["absent", null, 0],
  ["undefined", undefined, 0],
  ["garbage", "soon", 0],
  ["future date", "Thu, 01 Jan 2026 00:00:03 GMT", 3000],
  ["past date", "Wed, 31 Dec 2025 23:59:00 GMT", 0],
  ["cap at the timer limit", String(2 ** 31), MAX_RETRY_AFTER_MS],
  ["cap an astronomically large value", "9".repeat(400), MAX_RETRY_AFTER_MS],
  ["cap a distant date", "Fri, 01 Jan 2100 00:00:00 GMT", MAX_RETRY_AFTER_MS],
];

describe("Retry-After parsing", () => {
  it.each(cases)("%s", (_name, value, expected) => {
    expect(retryAfterMs(value as string, now)).toBe(expected);
  });
  it("defaults to the current clock", () => {
    expect(retryAfterMs("1")).toBe(1000);
  });
});
