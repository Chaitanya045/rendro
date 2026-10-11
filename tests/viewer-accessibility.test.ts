import { Window } from "happy-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "@/worker";
import { docsBase, mockSecurityBackend } from "./fixtures/security-headers";

beforeEach(() => { mockSecurityBackend(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  ["share", "/s/test", false],
  ["public", "/p/product", false],
  ["legacy public", "/public/example/product", false],
  ["legacy private", "/docs/example/index.html", true],
  ["private", `${docsBase}?doc=index.html`, true],
] as const)("renders one main around the %s document and preserves script/style nonces", async (_name, path, signedIn) => {
  const response = await worker.fetch(new Request(`https://rendro.test${path}`, {
    headers: signedIn ? { cookie: "better-auth.session_token=test-session" } : {},
  }), {});
  expect(response.status).toBe(200);
  const nonce = response.headers.get("Content-Security-Policy")?.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  const win = new Window();
  try {
    win.document.write(await response.text());
    const main = win.document.querySelector("main")!;
    expect(win.document.querySelectorAll('main, [role="main"]')).toHaveLength(1);
    expect(main.querySelector("#content-frame")).not.toBeNull();
    expect(main.querySelector("header")).toBeNull();
    if (_name === "share") expect(win.document.querySelector("[style]")).toBeNull();
    for (const element of win.document.querySelectorAll("script:not([src]), style")) {
      expect(element.getAttribute("nonce")).toBe(nonce);
    }
  } finally { await win.happyDOM.close(); }
});
