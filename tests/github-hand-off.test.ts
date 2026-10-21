import { afterEach, describe, expect, it, vi } from "vitest";
import { GITHUB_HAND_OFF_HEADER, HAND_OFF_TTL_MS, openHandOff, sealHandOff, type GitHubHandOff } from "../shared/github-hand-off";
import { linkGitHubAccount, repoAccessBinding, unlinkGitHubAccount } from "@/github-hand-off";
import { proxyAuthRequest } from "@/auth-proxy";
import { logger } from "@/logger";

const secret = process.env.CONVEX_INTERNAL_SECRET as string;
const handOff: GitHubHandOff = {
  userId: "user-1", githubId: 42, login: "octo",
  tokens: { accessToken: "ghu_access", accessTokenExpiresAt: 1_900_000_000_000, refreshToken: "ghr_refresh", refreshTokenExpiresAt: null },
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the sealed GitHub hand-off (#338)", () => {
  it("opens under the same secret until it expires, and hides the tokens", async () => {
    const sealed = await sealHandOff(secret, handOff, 1_000);
    expect(sealed).toMatch(/^v1\.[\w-]{16}\.[\w-]+$/);
    expect(sealed).not.toContain("ghu_access");
    expect(await openHandOff(secret, sealed, 1_000)).toEqual(handOff);
    expect(await openHandOff(secret, sealed, 1_000 + HAND_OFF_TTL_MS - 1)).toEqual(handOff);
    expect(await openHandOff(secret, sealed, 1_000 + HAND_OFF_TTL_MS)).toBeNull();
    // A fresh IV every time.
    expect(await sealHandOff(secret, handOff, 1_000)).not.toBe(sealed);
  });

  it("keeps tokens that do not expire and a missing refresh token", async () => {
    const plain = { ...handOff, tokens: { accessToken: "ghu_x", accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null } };
    expect(await openHandOff(secret, await sealHandOff(secret, plain))).toEqual(plain);
  });

  it("refuses another key, tampering and malformed values", async () => {
    const sealed = await sealHandOff(secret, handOff);
    expect(await openHandOff("another-secret-of-thirty-two-chars!!", sealed)).toBeNull();
    const [version, iv, data] = sealed.split(".");
    const flipped = `${data.slice(0, -2)}${data.at(-2) === "A" ? "B" : "A"}${data.at(-1)}`;
    for (const value of [`${version}.${iv}.${flipped}`, `v2.${iv}.${data}`, `${version}.${iv}`, `${version}.${iv.slice(1)}.${data}`, `${version}.${iv}.${data}A`.slice(0, -4) + "*", "", `v1.${"A".repeat(16)}.${"A".repeat(9000)}`, `v1.${iv}.A`]) {
      expect(await openHandOff(secret, value)).toBeNull();
    }
  });

  it("refuses a sealed value whose contents are not a hand-off", async () => {
    const malformed: unknown[] = [
      { ...handOff, userId: "" }, { ...handOff, githubId: 0 }, { ...handOff, githubId: 1.5 }, { ...handOff, login: 7 }, { ...handOff, tokens: null },
      { ...handOff, tokens: { ...handOff.tokens, accessToken: "" } }, { ...handOff, tokens: { ...handOff.tokens, accessTokenExpiresAt: -1 } },
      { ...handOff, tokens: { ...handOff.tokens, refreshToken: 5 } }, { ...handOff, tokens: { ...handOff.tokens, refreshTokenExpiresAt: "soon" } },
    ];
    for (const value of malformed) expect(await openHandOff(secret, await sealHandOff(secret, value as GitHubHandOff))).toBeNull();
  });

  it("is not a hand-off without an expiry", async () => {
    // A value sealed under the same key and purpose but without `exp`: crafted with the module's own sealing, then stripped.
    const original = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementationOnce((value) => original({ ...(value as object), exp: "never" }));
    expect(await openHandOff(secret, await sealHandOff(secret, handOff))).toBeNull();
  });
});

describe("forwarding the hand-off to the control Worker (#338)", () => {
  const binding = (status: number | Error) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    return { calls, fetch: async (request: Request) => {
      calls.push({ url: request.url, body: await request.json() });
      if (status instanceof Error) throw status;
      return new Response(null, { status });
    } };
  };

  it("finds the binding only when it can fetch", () => {
    const fetcher = { fetch: () => Promise.resolve(new Response()) };
    expect(repoAccessBinding({ REPO_ACCESS: fetcher })).toBe(fetcher);
    for (const env of [undefined, {}, { REPO_ACCESS: {} }, { REPO_ACCESS: "x" }]) expect(repoAccessBinding(env)).toBeNull();
  });

  it("links an opened hand-off and logs failures without the tokens", async () => {
    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});
    const ok = binding(204);
    expect(await linkGitHubAccount(ok, await sealHandOff(secret, handOff))).toBe(true);
    expect(ok.calls).toEqual([{ url: "https://repo-access.internal/v1/accounts/link", body: handOff }]);
    expect(await linkGitHubAccount(ok, "v1.forged.value")).toBe(false);
    expect(errors).toHaveBeenLastCalledWith({ category: "GitHubHandOff", outcome: "invalid" }, "GitHub account was not linked");
    expect(ok.calls).toHaveLength(1);
    for (const status of [200, 503, new Error("binding down")]) {
      expect(await linkGitHubAccount(binding(status), await sealHandOff(secret, handOff))).toBe(false);
      expect(errors).toHaveBeenLastCalledWith({ category: "GitHubHandOff", outcome: "unavailable" }, "GitHub account was not linked");
    }
    expect(JSON.stringify(errors.mock.calls)).not.toContain("ghu_");
  });

  it("unlinks, and reports when the control Worker could not", async () => {
    const errors = vi.spyOn(logger, "error").mockImplementation(() => {});
    const ok = binding(204);
    expect(await unlinkGitHubAccount(ok, "user-1")).toBe(true);
    expect(ok.calls).toEqual([{ url: "https://repo-access.internal/v1/accounts/unlink", body: { userId: "user-1" } }]);
    expect(await unlinkGitHubAccount(binding(new Error("down")), "user-1")).toBe(false);
    expect(errors).toHaveBeenLastCalledWith({ category: "GitHubHandOff", outcome: "unlink-unavailable" }, "GitHub account was not unlinked");
  });

  it("strips a hand-off from every proxied response, and acts on the GitHub callback alone", async () => {
    const sealed = await sealHandOff(secret, handOff);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 200, headers: { [GITHUB_HAND_OFF_HEADER]: sealed, "content-type": "application/json" } }))));
    const repoAccess = binding(204);
    for (const [method, path] of [["GET", "/api/auth/get-session"], ["POST", "/api/auth/callback/github"], ["GET", "/api/auth/callback/other"]] as const) {
      const response = await proxyAuthRequest(new Request(`https://rendro.test${path}`, { method, headers: { origin: "https://rendro.test", "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined }), repoAccess);
      expect(response.headers.has(GITHUB_HAND_OFF_HEADER)).toBe(false);
    }
    expect(repoAccess.calls).toEqual([]);
    const callback = await proxyAuthRequest(new Request("https://rendro.test/api/auth/callback/github?code=x&state=y"), repoAccess);
    expect(callback.headers.has(GITHUB_HAND_OFF_HEADER)).toBe(false);
    expect(repoAccess.calls).toHaveLength(1);
  });
});
