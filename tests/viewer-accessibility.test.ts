import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import worker from "@/worker";
import { privateRepo, publicRepo, repoReadFixture, sessionCookies, stubSessions } from "./helpers/repo-read-fixture";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  ["public", `/r/${publicRepo.owner}/${publicRepo.name}`, false],
  ["private", `/r/${privateRepo.owner}/${privateRepo.name}`, true],
] as const)("renders one main around the %s repository document and preserves script/style nonces", async (_name, path, signedIn) => {
  const fixture = await repoReadFixture();
  stubSessions();
  const response = await worker.fetch(new Request(`https://rendro.test${path}`, {
    headers: signedIn ? { cookie: sessionCookies.reader } : {},
  }), fixture.env, fixture.ctx);
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
    for (const element of win.document.querySelectorAll("script:not([src]), style")) {
      expect(element.getAttribute("nonce")).toBe(nonce);
    }
  } finally { await win.happyDOM.close(); }
});
