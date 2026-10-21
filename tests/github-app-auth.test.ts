import { createPrivateKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { appJwtSigner, gitHubAppCredentials, INSTALLATION_TOKEN_MARGIN_MS, mintedInstallationTokens, pkcs8FromPem, type TokenStore } from "../src/ingest/github/app-auth";
import { GitHubError } from "../src/ingest/github/source";
import { FakeGitHub } from "./helpers/fake-github";

const tokenKey = "installation-token-key-0123456789abcdef";

function memoryStore(): TokenStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key, value) => { values.set(key, value); return Promise.resolve(); },
    delete: (keys) => { let deleted = 0; for (const key of keys) deleted += values.delete(key) ? 1 : 0; return Promise.resolve(deleted); },
  };
}

function world(options: { store?: TokenStore; time?: { now: number } } = {}) {
  const github = new FakeGitHub();
  const time = options.time ?? { now: Date.now() };
  github.now = () => time.now;
  const installation = github.install("octo", { id: 81 });
  github.repo("octo", "docs", { id: 1, private: true });
  github.repo("solo", "notes", { id: 2 });
  const app = appJwtSigner({ appId: github.appId, privateKey: github.appPrivateKey }, () => time.now);
  const tokens = mintedInstallationTokens({ app, apiOrigin: github.origin, fetch: github.fetch, now: () => time.now, ...(options.store ? { store: { storage: options.store, secret: tokenKey } } : {}) });
  return { github, installation, app, tokens, time };
}

const authorized = (github: FakeGitHub, token: string) => github.fetch(`${github.origin}/installation/repositories?per_page=1`, { headers: { authorization: `Bearer ${token}` } }).then(response => response.status);

describe("the GitHub App's credentials (#338)", () => {
  it("are configured only with both the ID and the key", () => {
    expect(gitHubAppCredentials(undefined, "key")).toBeNull();
    expect(gitHubAppCredentials("1", "")).toBeNull();
    expect(gitHubAppCredentials("1", "key")).toEqual({ appId: "1", privateKey: "key" });
  });

  it("import GitHub's PKCS#1 key, a PKCS#8 key and a key whose newlines were escaped", async () => {
    const github = new FakeGitHub();
    const pkcs8 = createPrivateKey(github.appPrivateKey).export({ type: "pkcs8", format: "pem" }) as string;
    for (const privateKey of [github.appPrivateKey, pkcs8, github.appPrivateKey.replace(/\n/g, "\\n")]) {
      const jwt = await appJwtSigner({ appId: github.appId, privateKey }).jwt();
      const response = await github.fetch(`${github.origin}/app/hook/deliveries`, { headers: { authorization: `Bearer ${jwt}` } });
      expect(response.status).toBe(200);
    }
    expect(() => pkcs8FromPem("not a key")).toThrow("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
    expect(() => pkcs8FromPem("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----")).toThrow();
  });

  it("sign a JWT issued a minute back, valid nine minutes, reused until a minute before it expires", async () => {
    const time = { now: 1_800_000_000_000 };
    const github = new FakeGitHub();
    const signer = appJwtSigner({ appId: github.appId, privateKey: github.appPrivateKey }, () => time.now);
    const jwt = await signer.jwt();
    const [header, claims] = jwt.split(".").slice(0, 2).map(part => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: github.appId });
    time.now += 8 * 60_000 - 1;
    expect(await signer.jwt()).toBe(jwt);
    time.now += 1;
    expect(await signer.jwt()).not.toBe(jwt);
    const second = await signer.jwt();
    signer.invalidate();
    time.now += 1000;
    expect(await signer.jwt()).not.toBe(second);
  });

  it("fail to sign with a key WebCrypto refuses, and try the import again next time", async () => {
    const broken = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----";
    const signer = appJwtSigner({ appId: "1", privateKey: broken });
    await expect(signer.jwt()).rejects.toThrow();
    await expect(signer.jwt()).rejects.toThrow();
  });
});

describe("installation tokens (#338)", () => {
  it("are minted with the app JWT, scoped to the installation, and cached until shortly before they expire", async () => {
    const { github, installation, tokens, time } = world();
    const token = await tokens.token(installation.id) as string;
    expect(token).toMatch(/^ghs_81_/);
    expect(await authorized(github, token)).toBe(200);
    expect(await tokens.token(installation.id)).toBe(token);
    expect(github.count("app-token")).toBe(1);
    time.now += github.installationTokenLifetime - INSTALLATION_TOKEN_MARGIN_MS - 1;
    expect(await tokens.token(installation.id)).toBe(token);
    time.now += 1;
    const renewed = await tokens.token(installation.id) as string;
    expect(renewed).not.toBe(token);
    expect(github.count("app-token")).toBe(2);
    // GitHub's own expiry: the old token stops working an hour after it was minted.
    time.now += INSTALLATION_TOKEN_MARGIN_MS;
    expect(await authorized(github, token)).toBe(401);
    expect(await authorized(github, renewed)).toBe(200);
  });

  it("mint once for concurrent callers, and again after GitHub refused one", async () => {
    const { github, installation, tokens } = world();
    const [first, second] = await Promise.all([tokens.token(installation.id), tokens.token(installation.id)]);
    expect(first).toBe(second);
    expect(github.count("app-token")).toBe(1);
    tokens.invalidate(installation.id);
    tokens.invalidate(null);
    expect(await tokens.token(installation.id)).not.toBe(first);
    expect(github.count("app-token")).toBe(2);
    expect(await tokens.token(null)).toBeNull();
  });

  it("report a deleted installation as not found, a suspended one as forbidden, and other failures as unknown", async () => {
    const { github, installation, tokens } = world();
    await expect(tokens.token(999)).rejects.toMatchObject({ kind: "not-found", status: 404 });
    installation.suspended = true;
    await expect(tokens.token(installation.id)).rejects.toMatchObject({ kind: "forbidden" });
    installation.suspended = false;
    github.fault(/access_tokens/, () => new Response("{}", { status: 502 }));
    await expect(tokens.token(installation.id)).rejects.toMatchObject({ kind: "server" });
    github.fault(/access_tokens/, () => new Response("not json", { status: 201 }));
    await expect(tokens.token(installation.id)).rejects.toMatchObject({ kind: "invalid-response" });
    github.fault(/access_tokens/, () => Response.json({ token: "bad token!", expires_at: "2030-01-01T00:00:00Z" }, { status: 201 }));
    await expect(tokens.token(installation.id)).rejects.toMatchObject({ kind: "invalid-response" });
    github.fault(/access_tokens/, () => Response.json({ token: "ghs_ok", expires_at: "soon" }, { status: 201 }));
    await expect(tokens.token(installation.id)).rejects.toMatchObject({ kind: "invalid-response" });
    github.fault(/access_tokens/, () => new Response("x".repeat(70_000), { status: 422 }));
    await expect(tokens.token(installation.id)).rejects.toMatchObject({ kind: "invalid-response", status: 422 });
    github.fault(/access_tokens/, () => Promise.reject(new Error("connection reset")));
    await expect(tokens.token(installation.id)).rejects.toMatchObject({ kind: "network" });
    // Recovered: the next call mints.
    expect(await tokens.token(installation.id)).toMatch(/^ghs_81_/);
  });

  it("drop the app JWT when GitHub refuses it, so the next call signs a new one", async () => {
    const { github, installation, tokens, app, time } = world();
    const jwt = await app.jwt();
    github.fault(/access_tokens/, () => Response.json({ message: "Bad credentials" }, { status: 401 }));
    const error = await tokens.token(installation.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({ kind: "unauthorized" });
    // Still well inside the old JWT's reuse window: only the refusal makes the signer sign again.
    time.now += 1000;
    expect(await app.jwt()).not.toBe(jwt);
  });

  it("default to api.github.com, the global fetch and the clock", async () => {
    const github = new FakeGitHub();
    const installation = github.install("octo", { id: 81 });
    vi.stubGlobal("fetch", github.publicFetch);
    try {
      const tokens = mintedInstallationTokens({ app: appJwtSigner({ appId: github.appId, privateKey: github.appPrivateKey }) });
      expect(await tokens.token(installation.id)).toMatch(/^ghs_81_/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("are kept sealed at rest where a store is given, bound to their installation", async () => {
    const store = memoryStore();
    const time = { now: Date.now() };
    const first = world({ store, time });
    const token = await first.tokens.token(first.installation.id) as string;
    const sealed = store.values.get("installation-token:81") as string;
    expect(sealed).toMatch(/^v1\.[\w-]{16}\.[\w-]+$/);
    expect(sealed).not.toContain(token);
    // A new isolate reuses the stored token instead of minting again.
    const restarted = mintedInstallationTokens({ app: first.app, apiOrigin: first.github.origin, fetch: first.github.fetch, now: () => time.now, store: { storage: store, secret: tokenKey } });
    expect(await restarted.token(81)).toBe(token);
    expect(first.github.count("app-token")).toBe(1);
    // A value moved to another installation, sealed under another key, malformed or expired does not count.
    first.github.install("other", { id: 82 });
    store.values.set("installation-token:82", sealed);
    expect(await restarted.token(82)).not.toBe(token);
    const elsewhere = mintedInstallationTokens({ app: first.app, apiOrigin: first.github.origin, fetch: first.github.fetch, now: () => time.now, store: { storage: store, secret: "another-key-0123456789abcdef0123456789" } });
    expect(await elsewhere.token(81)).not.toBe(token);
    for (const value of [42, "v1.short.x", "v2.AAAAAAAAAAAAAAAA.AAAA"]) {
      store.values.set("installation-token:81", value);
      const fresh = mintedInstallationTokens({ app: first.app, apiOrigin: first.github.origin, fetch: first.github.fetch, now: () => time.now, store: { storage: store, secret: tokenKey } });
      expect(await fresh.token(81)).toMatch(/^ghs_81_/);
    }
    time.now += first.github.installationTokenLifetime;
    const later = mintedInstallationTokens({ app: first.app, apiOrigin: first.github.origin, fetch: first.github.fetch, now: () => time.now, store: { storage: store, secret: tokenKey } });
    const minted = first.github.count("app-token");
    await later.token(81);
    expect(first.github.count("app-token")).toBe(minted + 1);
    // A refused token is dropped at rest too.
    later.invalidate(81);
    await vi.waitFor(() => expect(store.values.has("installation-token:81")).toBe(false));
  });

  it("survive a store that fails to forget", async () => {
    const store = memoryStore();
    store.delete = () => Promise.reject(new Error("storage down"));
    const { tokens, installation } = world({ store });
    await tokens.token(installation.id);
    expect(() => tokens.invalidate(installation.id)).not.toThrow();
  });
});

describe("a repository's installation (#338)", () => {
  it("is asked of GitHub with the app JWT, remembered for ten minutes, and null where the app is not installed", async () => {
    const { github, tokens, time, installation } = world();
    expect(await tokens.installationOf("octo", "docs")).toBe(installation.id);
    expect(await tokens.installationOf("OCTO", "Docs")).toBe(installation.id);
    expect(github.count("repo-installation")).toBe(1);
    expect(await tokens.installationOf("solo", "notes")).toBeNull();
    expect(await tokens.installationOf("nobody", "nothing")).toBeNull();
    time.now += 10 * 60_000;
    expect(await tokens.installationOf("octo", "docs")).toBe(installation.id);
    expect(github.count("repo-installation")).toBe(4);
  });

  it("is asked again after a failure, and refuses a malformed answer", async () => {
    const { github, tokens, installation } = world();
    github.fault(/\/installation$/, () => new Response("{}", { status: 500 }));
    await expect(tokens.installationOf("octo", "docs")).rejects.toMatchObject({ kind: "server" });
    github.fault(/\/installation$/, () => Response.json({ id: "81" }));
    await expect(tokens.installationOf("octo", "docs")).rejects.toMatchObject({ kind: "invalid-response" });
    expect(await tokens.installationOf("octo", "docs")).toBe(installation.id);
  });

  it("keeps at most a thousand answers", async () => {
    const { github, tokens } = world();
    for (let index = 0; index <= 1000; index += 1) await tokens.installationOf("nobody", `repo-${index}`);
    const asked = github.count("repo-installation");
    await tokens.installationOf("nobody", "repo-1000");
    expect(github.count("repo-installation")).toBe(asked);
    await tokens.installationOf("nobody", "repo-0");
    expect(github.count("repo-installation")).toBe(asked + 1);
  });
});
