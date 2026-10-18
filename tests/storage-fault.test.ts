import { describe, expect, it } from "vitest";
import { transientStorageFault } from "../src/storage-fault";

const r2 = (code: number, operation = "get") => new Error(`${operation}: private-diagnostic (${code})`);

describe("transient storage fault classification", () => {
  it.each([[10001, 500], [10043, 503], [10058, 429]])("treats R2 error %i as a retryable service fault", (code, status) => {
    for (const operation of ["get", "head", "put", "list", "delete"]) {
      expect(transientStorageFault(r2(code, operation))).toEqual({ kind: "service", status });
    }
  });

  it("treats a client disconnected mid-transfer (10054) as a dropped connection", () => {
    expect(transientStorageFault(r2(10054, "put"))).toEqual({ kind: "network", status: null });
  });

  it.each([10002, 10003, 10006, 10007, 10012, 10020, 10031, 10039, 10069, 100100])("treats R2 rejection %i as final", code => {
    expect(transientStorageFault(r2(code))).toBeNull();
  });

  it("reads the code only from R2-shaped Error messages", () => {
    expect(transientStorageFault(new Error("The value (10001)"))).toBeNull();
    expect(transientStorageFault(new Error("get: no code in this one"))).toBeNull();
    expect(transientStorageFault({ message: "get: spoofed (10001)" })).toBeNull();
    expect(transientStorageFault(new Error("get: line one\nstill the same message (10043)"))).toEqual({ kind: "service", status: 503 });
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
