import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentWriteSignal, readDeploymentBody } from "../src/deployment-lease";

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

describe("bounded transfer renewal", () => {
  afterEach(() => vi.useRealTimers());

  it("renews while receiving, then clears every timer on completion", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { stream = c; } });
    const renew = vi.fn().mockResolvedValue({ deployment: {} });
    const result = readDeploymentBody(body, 1, renew);
    await vi.advanceTimersByTimeAsync(70 * 60_000);
    expect(renew).toHaveBeenCalledTimes(7);
    stream.enqueue(new Uint8Array([1])); stream.close();
    expect(await result).toEqual(new Uint8Array([1]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("cancels a stalled reader on renewal failure (network error: %s)", async network => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = Response.json({ error: "Lease expired; run rendro push again" }, { status: 409 });
    const renew = network ? vi.fn().mockRejectedValue(new Error("network")) : vi.fn().mockResolvedValue(response);
    const result = readDeploymentBody(body, 1, renew);
    const assertion = network ? expect(result).rejects.toThrow("network") : expect(result).rejects.toMatchObject({ res: response });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves rate-limit status and retry headers from a renewal denial", async () => {
    vi.useFakeTimers();
    const result = readDeploymentBody(new ReadableStream(), 1, () => Promise.resolve(Response.json({ error: "Rate limited" }, { status: 429, headers: { "Retry-After": "10" } })));
    const assertion = result.catch((error: { getResponse(): Response }) => error.getResponse());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const response = await assertion as Response;
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("10");
    expect(await response.json()).toEqual({ error: "Rate limited" });
  });

  it("caps total transfer time even when every renewal succeeds", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const renew = vi.fn().mockResolvedValue({});
    const result = readDeploymentBody(new ReadableStream({ cancel }), 1, renew);
    const assertion = expect(result).rejects.toThrow("Upload exceeded the two-hour transfer limit");
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    await assertion;
    expect(renew).toHaveBeenCalledTimes(11);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart renewal if the body completes during an in-flight check", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let complete!: (value: unknown) => void;
    const renew = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const result = readDeploymentBody(new ReadableStream({ start(c) { stream = c; } }), 0, renew);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    stream.close();
    await result;
    complete({});
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
