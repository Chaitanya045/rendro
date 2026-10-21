import type { DBAdapter, DBTransactionAdapter } from "better-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emailSignInEnabled, githubHandOff, githubSignInConfig, githubUserInfo, handOffCapture, withoutOAuthTokens, type HandOffCapture,
} from "../convex/githubAuth";
import { GITHUB_HAND_OFF_HEADER, openHandOff } from "../shared/github-hand-off";
import { signInMethods } from "@/config";
import { signInErrorMessage } from "@/routes/auth-pages";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("GitHub sign-in configuration (#338)", () => {
  it("is on only with both client credentials", () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
    expect(githubSignInConfig()).toBeNull();
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.client");
    expect(githubSignInConfig()).toBeNull();
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "secret");
    expect(githubSignInConfig()).toEqual({ clientId: "Iv1.client", clientSecret: "secret" });
  });

  it("turns email sign-in off only once GitHub is configured", () => {
    const github = { clientId: "a", clientSecret: "b" };
    expect(emailSignInEnabled(github)).toBe(true);
    vi.stubEnv("AUTH_EMAIL_SIGN_IN", "off");
    expect(emailSignInEnabled(github)).toBe(false);
    expect(emailSignInEnabled(null)).toBe(true);
    vi.stubEnv("AUTH_EMAIL_SIGN_IN", "on");
    expect(emailSignInEnabled(github)).toBe(true);
  });

  it("tells the Worker's pages the same", () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("AUTH_EMAIL_SIGN_IN", "off");
    expect(signInMethods()).toEqual({ github: false, email: true });
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.client");
    expect(signInMethods()).toEqual({ github: true, email: false });
    vi.stubEnv("AUTH_EMAIL_SIGN_IN", "on");
    expect(signInMethods()).toEqual({ github: true, email: true });
  });
});

describe("sign-in error copy (#338)", () => {
  it("drops the email alternative when email sign-in is off", () => {
    expect(signInErrorMessage("access_denied", false)).toBe("Sign-in was canceled. Try again when you are ready.");
    expect(signInErrorMessage("server_error", false)).toBe("We couldn't complete sign-in. Please try again.");
    expect(signInErrorMessage("server_error")).toBe("We couldn't complete sign-in. Please try again or use your email and password.");
    expect(signInErrorMessage("EMAIL_NOT_FOUND")).toBe("Your GitHub account has no verified email address. Verify one on GitHub, then try again.");
  });
});

describe("GitHub user info (#338)", () => {
  function github(profile: unknown, emails: unknown, status = 200) {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith("/emails") ? emails : profile), { status }))));
  }

  it("needs a token and a well-formed profile", async () => {
    const capture = handOffCapture();
    expect(await githubUserInfo(capture)({})).toBeNull();
    for (const profile of [null, { id: 0, login: "a" }, { id: 1.5, login: "a" }, { id: 1, login: "-bad" }, { id: 1 }]) {
      github(profile, []);
      expect(await githubUserInfo(capture)({ accessToken: "t" })).toBeNull();
    }
    github({ id: 1, login: "octo" }, [], 401);
    expect(await githubUserInfo(capture)({ accessToken: "t" })).toBeNull();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("not json"))));
    expect(await githubUserInfo(capture)({ accessToken: "t" })).toBeNull();
    expect(capture.identity).toBeNull();
  });

  it("uses the profile's name and avatar, and only a verified address", async () => {
    const capture = handOffCapture();
    github({ id: 9, login: "octo", name: "Octo Cat", avatar_url: "https://avatars.example/9" }, [{ email: "x@example.test", verified: false, primary: true }, { email: "y@example.test", verified: true, primary: false }, "junk", null]);
    expect(await githubUserInfo(capture)({ accessToken: "t" })).toMatchObject({ user: { id: "9", name: "Octo Cat", email: "y@example.test", image: "https://avatars.example/9", emailVerified: true } });
    expect(capture.identity).toEqual({ githubId: 9, login: "octo" });
    github({ id: 9, login: "octo", name: "  " }, { message: "not a list" });
    expect(await githubUserInfo(capture)({ accessToken: "t" })).toMatchObject({ user: { name: "octo", email: undefined, image: undefined, emailVerified: false } });
  });
});

type Write = { op: string; model: string; fields: Record<string, unknown> };

function recordingAdapter(writes: Write[], transactions = false): DBAdapter {
  const adapter = {
    id: "recording",
    create: ({ model, data }: { model: string; data: Record<string, unknown> }) => { writes.push({ op: "create", model, fields: data }); return Promise.resolve(data); },
    update: ({ model, update }: { model: string; update: Record<string, unknown> }) => { writes.push({ op: "update", model, fields: update }); return Promise.resolve(update); },
    updateMany: ({ model, update }: { model: string; update: Record<string, unknown> }) => { writes.push({ op: "updateMany", model, fields: update }); return Promise.resolve(1); },
  } as unknown as DBAdapter;
  if (transactions) {
    const trx = { ...adapter } as unknown as DBTransactionAdapter;
    (adapter as { transaction: DBAdapter["transaction"] }).transaction = async (callback) => callback(trx);
  } else {
    (adapter as { transaction: DBAdapter["transaction"] }).transaction = async (callback) => callback(adapter);
  }
  return adapter;
}

describe("no OAuth token is stored (#338)", () => {
  const tokens = { accessToken: "ghu_a", refreshToken: "ghr_r", idToken: "id", accessTokenExpiresAt: new Date(2_000_000_000_000), refreshTokenExpiresAt: 2_100_000_000_000 };

  it.each([false, true])("drops tokens from every account write and keeps them for the hand-off (transactions: %s)", async (transactions) => {
    const writes: Write[] = [];
    const capture = handOffCapture();
    const adapter = withoutOAuthTokens(recordingAdapter(writes, transactions), capture);
    await adapter.transaction(async (trx) => {
      await trx.create({ model: "account", data: { providerId: "github", ...tokens } });
      await trx.update({ model: "account", where: [], update: { accessToken: "ghu_b", refreshToken: "", accessTokenExpiresAt: "never" } });
      await trx.updateMany({ model: "account", where: [], update: { refreshToken: "ghr_c" } });
      await trx.create({ model: "user", data: { accessToken: "a user field, left alone" } });
      await trx.create({ model: "account", data: { providerId: "credential", password: "hash" } });
      await trx.update({ model: "session", where: [], update: { refreshToken: "a session field" } });
      await trx.updateMany({ model: "session", where: [], update: { idToken: "a session field" } });
    });
    expect(writes).toEqual([
      { op: "create", model: "account", fields: { providerId: "github", accessTokenExpiresAt: tokens.accessTokenExpiresAt, refreshTokenExpiresAt: tokens.refreshTokenExpiresAt } },
      { op: "update", model: "account", fields: { accessTokenExpiresAt: "never" } },
      { op: "updateMany", model: "account", fields: {} },
      { op: "create", model: "user", fields: { accessToken: "a user field, left alone" } },
      { op: "create", model: "account", fields: { providerId: "credential", password: "hash" } },
      { op: "update", model: "session", fields: { refreshToken: "a session field" } },
      { op: "updateMany", model: "session", fields: { idToken: "a session field" } },
    ]);
    // The last write that carried an access token wins; an empty refresh token and an unreadable expiry are none.
    expect(capture.tokens).toEqual({ accessToken: "ghu_b", accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null });
  });

  it("records the expiries of the token it keeps", async () => {
    const capture = handOffCapture();
    await withoutOAuthTokens(recordingAdapter([]), capture).create({ model: "account", data: { ...tokens } });
    expect(capture.tokens).toEqual({ accessToken: "ghu_a", accessTokenExpiresAt: 2_000_000_000_000, refreshToken: "ghr_r", refreshTokenExpiresAt: 2_100_000_000_000 });
  });

  it("wraps an adapter without transactions", async () => {
    const writes: Write[] = [];
    const plain = recordingAdapter(writes) as Partial<DBAdapter>;
    delete plain.transaction;
    const adapter = withoutOAuthTokens(plain as DBTransactionAdapter, handOffCapture());
    expect("transaction" in adapter).toBe(false);
    await adapter.create({ model: "account", data: { ...tokens } });
    expect(writes[0].fields).not.toHaveProperty("accessToken");
  });
});

describe("the hand-off plugin (#338)", () => {
  const secret = process.env.CONVEX_INTERNAL_SECRET as string;
  const ready = (): HandOffCapture => ({ identity: { githubId: 7, login: "octo" }, tokens: { accessToken: "ghu_a", accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null } });
  const context = (account: { userId: string } | null) => ({ internalAdapter: { findAccountByProviderId: vi.fn(() => Promise.resolve(account)) } }) as never;
  const respond = (capture: HandOffCapture, account: { userId: string } | null, key: { secret?: string } = { secret }) =>
    githubHandOff(capture, key.secret).onResponse!(new Response("body", { status: 302, statusText: "Found", headers: { location: "/home" } }), context(account));

  it("seals what the request captured into its response, then forgets it", async () => {
    const capture = ready();
    const result = await respond(capture, { userId: "user-7" });
    const response = (result as { response: Response }).response;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/home");
    expect(await response.text()).toBe("body");
    expect(await openHandOff(secret, response.headers.get(GITHUB_HAND_OFF_HEADER) as string)).toEqual({ userId: "user-7", githubId: 7, login: "octo", tokens: ready().tokens });
    expect(capture).toEqual(handOffCapture());
  });

  it("hands nothing over without tokens, an identity, the account row or the secret", async () => {
    expect(await respond(handOffCapture(), { userId: "u" })).toBeUndefined();
    expect(await respond({ ...ready(), tokens: null }, { userId: "u" })).toBeUndefined();
    expect(await respond({ ...ready(), identity: null }, { userId: "u" })).toBeUndefined();
    expect(await respond(ready(), null)).toBeUndefined();
    const capture = ready();
    expect(await respond(capture, { userId: "u" }, {})).toBeUndefined();
    expect(capture).toEqual(handOffCapture());
  });
});
