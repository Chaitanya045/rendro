import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { failure } from "../convex/httpErrors";

const secret = "private-session-token-do-not-log";

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("HTTP fault injection", () => {
  it("keeps unexpected failures private as 500 and explicitly classified errors as 4xx", async () => {
    const fault = failure(new Error(`Infrastructure failure containing ${secret}`), 400, "setInitialPassword");
    expect(fault.status).toBe(500);
    expect(await fault.json()).toEqual({ error: "Request failed" });
    expect(console.error).toHaveBeenCalledWith("HTTP request failed", { operation: "setInitialPassword", category: "Error", status: 500 });
    const error = new ConvexError("Controlled application failure");
    error.message = secret;
    const controlled = failure(error, 403);
    expect(controlled.status).toBe(403);
    expect(await controlled.json()).toEqual({ error: "Controlled application failure" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
  });

  it.each([400, 403, 404, 409])("does not classify arbitrary strings or message matches as %s", async status => {
    for (const error of [secret, new Error(`Authentication required: ${secret}`), new Error(`A project with this slug already exists: ${secret}`)]) {
      const response = failure(error, status);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Request failed" });
    }
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
  });
});
