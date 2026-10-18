import { describe, expect, it, vi } from "vitest";
import { httpTokenRefresher, openTokens, parseUserTokens, sealTokens, TokenVaultError, unconfiguredRefresher, type UserTokens } from "../src/repo-access/tokens";
import { FakeGitHub } from "./helpers/fake-github";
import { FakeClock } from "./helpers/ingest-fixture";

/** User-to-server tokens at rest (#243): sealed per user with AES-GCM, renewed with GitHub's refresh grant. */

const KEY = "test-github-token-key-0123456789abcdef";
const tokens: UserTokens = { accessToken: "ghu_access", accessTokenExpiresAt: 1_800_000_000_000, refreshToken: "ghr_refresh", refreshTokenExpiresAt: 1_900_000_000_000 };

async function vaultError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a failure");
}

describe("token vault", () => {
  it("seals tokens so that only the same key and user open them", async () => {
    const sealed = await sealTokens(KEY, "user-1", tokens);
    expect(sealed).toMatch(/^v1\.[\w-]{16}\.[\w-]+$/);
    expect(sealed).not.toContain("ghu_access");
    // A fresh IV every time.
    expect(await sealTokens(KEY, "user-1", tokens)).not.toBe(sealed);
    expect(await openTokens(KEY, "user-1", sealed)).toEqual(tokens);
    expect(await vaultError(openTokens(KEY, "user-2", sealed))).toBeInstanceOf(TokenVaultError);
    expect(await vaultError(openTokens("another-key-0123456789abcdef0123456789", "user-1", sealed))).toBeInstanceOf(TokenVaultError);
    const [version, iv, data] = sealed.split(".");
    const flipped = `${data.slice(0, 10)}${data[10] === "A" ? "B" : "A"}${data.slice(11)}`;
    for (const bad of [`${version}.${iv}.${flipped}`, `v2.${iv}.${data}`, `${version}.${iv}`, `${version}.AAAA.${data}`, `${version}.${iv}.!!`, `v1.${iv}.${data}.${"A".repeat(9000)}`]) {
      expect(await vaultError(openTokens(KEY, "user-1", bad)), bad.slice(0, 20)).toBeInstanceOf(TokenVaultError);
    }
    // Sealed content that is not a token set never opens as one.
    expect(await vaultError(openTokens(KEY, "user-1", await sealTokens(KEY, "user-1", { accessToken: "" } as UserTokens)))).toBeInstanceOf(TokenVaultError);
  });

  it("accepts only well-formed token sets", () => {
    expect(parseUserTokens(tokens)).toEqual(tokens);
    expect(parseUserTokens({ ...tokens, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null })).toMatchObject({ refreshToken: null });
    for (const bad of [null, "x", { ...tokens, accessToken: "has space" }, { ...tokens, accessToken: "a".repeat(1025) }, { ...tokens, refreshToken: 5 },
      { ...tokens, accessTokenExpiresAt: -1 }, { ...tokens, refreshTokenExpiresAt: 1.5 }]) {
      expect(parseUserTokens(bad)).toBeNull();
    }
  });
});

describe("httpTokenRefresher", () => {
  function setup() {
    const clock = new FakeClock();
    const github = new FakeGitHub();
    github.now = clock.now;
    const user = github.user("reader");
    const refresher = httpTokenRefresher({ clientId: github.clientId, clientSecret: github.clientSecret, webOrigin: github.webOrigin, fetch: github.fetch, now: clock.now });
    return { clock, github, user, refresher };
  }

  it("exchanges a refresh token for a new pair; the used one stops working", async () => {
    const { clock, github, user, refresher } = setup();
    const issued = github.signIn(user);
    const result = await refresher.refresh(issued.refreshToken);
    expect(result).toEqual({ kind: "refreshed", tokens: {
      accessToken: expect.stringMatching(/^ghu_/) as string, accessTokenExpiresAt: clock.time + 8 * 60 * 60 * 1000,
      refreshToken: expect.stringMatching(/^ghr_/) as string, refreshTokenExpiresAt: clock.time + 184 * 24 * 60 * 60 * 1000,
    } });
    expect(await refresher.refresh(issued.refreshToken)).toEqual({ kind: "rejected" });
    const request = github.requests.find((entry) => entry.endpoint === "oauth");
    expect(request).toMatchObject({ method: "POST", path: "/login/oauth/access_token" });
  });

  it("treats only a bad refresh token as final", async () => {
    const { github, user, refresher } = setup();
    const issued = github.signIn(user);
    const wrongClient = httpTokenRefresher({ clientId: "other", clientSecret: "x", webOrigin: github.webOrigin, fetch: github.fetch, now: () => 0 });
    await expect(wrongClient.refresh(issued.refreshToken)).rejects.toThrow("without usable tokens");
    github.fault(/oauth/, () => new Response("down", { status: 502 }));
    await expect(refresher.refresh(issued.refreshToken)).rejects.toThrow("(502)");
    github.fault(/oauth/, () => new Response("x".repeat(20_000)));
    await expect(refresher.refresh(issued.refreshToken)).rejects.toThrow("(200)");
    github.fault(/oauth/, () => new Response("<html>"));
    await expect(refresher.refresh(issued.refreshToken)).rejects.toThrow(SyntaxError);
    // Tokens that never expire come without lifetimes.
    github.fault(/oauth/, () => Response.json({ access_token: "ghu_forever", token_type: "bearer" }));
    expect(await refresher.refresh(issued.refreshToken)).toEqual({ kind: "refreshed", tokens: { accessToken: "ghu_forever", accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null } });
  });

  it("defaults to github.com and the global fetch; unconfigured renewal is unknown", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "bad_refresh_token" }));
    try {
      expect(await httpTokenRefresher({ clientId: "a", clientSecret: "b", now: () => 0 }).refresh("ghr_x")).toEqual({ kind: "rejected" });
      expect(fetch.mock.calls[0][0] as string).toBe("https://github.com/login/oauth/access_token");
      expect((fetch.mock.calls[0][1]?.body as URLSearchParams).toString()).toBe("client_id=a&client_secret=b&grant_type=refresh_token&refresh_token=ghr_x");
    } finally {
      fetch.mockRestore();
    }
    await expect(unconfiguredRefresher.refresh("ghr_x")).rejects.toThrow("not configured");
  });
});
