import { describe, expect, it } from "vitest";
import { transientStorageFault } from "../src/storage-fault";

const service = (httpStatusCode: number) => Object.assign(new Error("private-diagnostic"), { $metadata: { httpStatusCode } });

describe("transient storage fault classification", () => {
  it.each([500, 502, 503, 504, 408, 429])("treats a storage %i answer as retryable", status => {
    expect(transientStorageFault(service(status))).toEqual({ kind: "service", status });
  });

  it.each([400, 403, 404, 409])("treats a storage %i rejection as final", status => {
    expect(transientStorageFault(service(status))).toBeNull();
  });

  it("recognises timeouts and dropped connections", () => {
    expect(transientStorageFault(new DOMException("signal timed out", "TimeoutError"))).toEqual({ kind: "timeout", status: null });
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(transientStorageFault(Object.assign(new Error("x"), { code }))).toEqual({ kind: "network", status: null });
    }
    for (const message of ["fetch failed", "Network connection lost.", "connection reset by peer", "socket hang up", "terminated"]) {
      expect(transientStorageFault(new TypeError(message))).toEqual({ kind: "network", status: null });
    }
  });

  it("leaves defects and unrecognised failures alone", () => {
    expect(transientStorageFault(new Error("fetch failed"))).toBeNull();
    expect(transientStorageFault(new TypeError("Cannot read properties of undefined"))).toBeNull();
    expect(transientStorageFault(new TypeError())).toBeNull();
    expect(transientStorageFault(Object.assign(new Error("x"), { code: "ENOENT" }))).toBeNull();
    expect(transientStorageFault(Object.assign(new Error("x"), { code: 500 }))).toBeNull();
    expect(transientStorageFault({})).toBeNull();
    for (const value of [null, undefined, "ECONNRESET", 503]) expect(transientStorageFault(value)).toBeNull();
  });
});
