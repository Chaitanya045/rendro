import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { publicPaginate } from "../convex/publicPagination";

const options = { cursor: "opaque-cursor", numItems: 10 };

describe("public pagination errors", () => {
  it.each([
    new Error("Failed to parse cursor"),
    new ConvexError({ isConvexSystemError: true, paginationError: "InvalidCursor" }),
  ])("translates only the runtime's known cursor failures", async error => {
    const paginate = vi.fn().mockRejectedValue(error);
    await expect(publicPaginate({ paginate }, options)).rejects.toMatchObject({
      message: "Invalid input", data: { code: "invalid_input", message: "Invalid input" },
    });
  });

  it.each([
    new Error("Database unavailable"),
    new Error("InvalidCursor mentioned by an unrelated error"),
    new SyntaxError("Unexpected token in JSON"),
    new ConvexError({ code: "transient" }),
    new ConvexError({ paginationError: "InvalidCursor" }),
    new ConvexError({ isConvexSystemError: true, paginationError: "TooManyReads" }),
  ])("preserves unrelated exceptions", async error => {
    await expect(publicPaginate({ paginate: vi.fn().mockRejectedValue(error) }, options)).rejects.toBe(error);
  });

  it.each(["cursor", "endCursor"] as const)("validates %s before executing the query", async field => {
    const paginate = vi.fn();
    await expect(publicPaginate({ paginate }, { ...options, [field]: " " })).rejects.toBeInstanceOf(ConvexError);
    expect(paginate).not.toHaveBeenCalled();
  });
});
