import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentWriteSignal } from "../src/deployment-lease";

afterEach(() => vi.restoreAllMocks());
describe("storage write lease deadline", () => {
  it.each([0, -1, NaN, Infinity])("rejects an expired or invalid lease %s before storage dispatch", delta => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    expect(() => deploymentWriteSignal(100 + delta)).toThrow("Staging lease expired");
  });
  it("caps storage work at both the lease and five minutes", () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    expect(deploymentWriteSignal(200).aborted).toBe(false);
    expect(timeout).toHaveBeenLastCalledWith(100);
    deploymentWriteSignal(3_600_100);
    expect(timeout).toHaveBeenLastCalledWith(300_000);
  });
});
