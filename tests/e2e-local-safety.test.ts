import { describe, expect, it } from "vitest";
import { assertLoopback, localEnvironment } from "../e2e/local-safety";

describe("disposable Convex target guards", () => {
  it.each(["http://127.0.0.1:3210", "http://localhost:3210/"])("allows explicit local target %s", url => {
    expect(() => assertLoopback(url)).not.toThrow();
  });
  it.each([
    "https://127.0.0.1:3210", "http://remote.invalid", "http://127.0.0.1.remote.invalid",
    "http://localhost@remote.invalid", "http://user@127.0.0.1", "http://:pass@127.0.0.1",
    "http://localhost/path", "http://localhost?url=remote", "http://localhost#remote", "invalid",
  ])("refuses unsafe target %s before any push", url => {
    expect(() => assertLoopback(url)).toThrow();
  });
  it("removes deployment selectors, credentials and external proxies without mutating the parent", () => {
    const input = { PATH: "/bin", HOME: "/tmp/fixture", CONVEX_DEPLOYMENT: "shared", CONVEX_URL: "remote",
      CONVEX_DEPLOY_KEY: "secret", CONVEX_SELF_HOSTED_URL: "remote", CONVEX_SELF_HOSTED_ADMIN_KEY: "secret",
      CONVEX_SITE_URL: "remote", RESEND_API_KEY: "secret", AUTH_SECRET: "secret",
      SITE_URL: "remote", HTTPS_PROXY: "remote", HTTP_PROXY: "remote", ALL_PROXY: "remote",
      http_proxy: "remote", https_proxy: "remote", all_proxy: "remote" };
    expect(localEnvironment(input)).toEqual({ PATH: "/bin", HOME: "/tmp/fixture" });
    expect(input.CONVEX_DEPLOYMENT).toBe("shared");
    expect(localEnvironment()).not.toHaveProperty("CONVEX_URL");
  });
});
