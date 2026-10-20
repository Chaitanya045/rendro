import { describe, expect, it } from "vitest";
import { GitHubError } from "../src/ingest/github/source";
import { staticTokenProvider, type InstallationTokenProvider } from "../src/ingest/github/token";
import { RateGovernor } from "../src/ingest/github/rate-governor";
import { GitHubAccessClient } from "../src/repo-access/github";
import { confirmRemoval, type RemovalTarget } from "../src/repo-access/removal";
import { FakeGitHub } from "./helpers/fake-github";
import { FakeClock } from "./helpers/ingest-fixture";
import { mintedInstallationTokens } from "./helpers/repo-access-fixture";

/** An organization with the app installed on every repository, and one docs repository, asked about with P1-style installation tokens. */
function world() {
  const clock = new FakeClock();
  const github = new FakeGitHub();
  github.now = clock.now;
  github.rate.reset = Math.floor(clock.time / 1000) + 3600;
  const installation = github.install("octo", { id: 71 });
  const repo = github.repo("octo", "docs", { id: 801, private: true });
  const client = new GitHubAccessClient({ apiOrigin: github.origin, fetch: github.fetch, clock, governor: () => new RateGovernor({ clock }) });
  const tokens = mintedInstallationTokens(github);
  const target: RemovalTarget = { id: repo.id, owner: "octo", name: "docs", installation: installation.id };
  const confirm = (overrides: Partial<RemovalTarget> = {}, provider: InstallationTokenProvider = tokens) =>
    confirmRemoval({ github: client, installationTokens: provider }, { ...target, ...overrides });
  return { github, installation, repo, tokens, confirm };
}

describe("confirmRemoval (#258)", () => {
  it("finds a repository the installation still sees accessible, under its current name", async () => {
    const { github, repo, confirm } = world();
    expect(await confirm()).toEqual({ kind: "accessible", repo: { id: repo.id, owner: "octo", name: "docs", private: true, defaultBranch: "main", etag: expect.any(String) } });
    github.rename(repo, "octo", "handbook");
    expect(await confirm()).toMatchObject({ kind: "accessible", repo: { id: repo.id, name: "handbook" } });
  });

  it("confirms a removal only with a token GitHub accepts as the installation's", async () => {
    const { github, installation, repo, confirm } = world();
    installation.repositories = new Set();
    github.resetLog();
    expect(await confirm()).toEqual({ kind: "removed" });
    expect(github.requests.map(request => [request.endpoint, request.status])).toEqual([["repository", 404], ["installation", 200]]);
    // A 404 from a token that is not (or no longer) an installation's proves nothing.
    installation.repositories = "all";
    github.repos.delete(`octo/${repo.name}`);
    github.fault(/^\/installation\/repositories/, () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    expect(await confirm()).toEqual({ kind: "unknown", reason: "installation" });
  });

  it("confirms the removal of an installation GitHub no longer has, even with a cached token", async () => {
    const { github, installation, tokens, confirm } = world();
    expect((await confirm()).kind).toBe("accessible");
    github.installations.delete(installation.id);
    // The cached token is refused (401), it is dropped, and minting a fresh one says the installation is gone.
    expect(await confirm()).toEqual({ kind: "removed" });
    expect(tokens.minted).toEqual([installation.id]);
  });

  it("never confirms on doubt", async () => {
    const { github, installation, tokens, confirm } = world();
    expect(await confirm({ installation: null })).toEqual({ kind: "unknown", reason: "no-installation" });
    // Unauthenticated, a private repository is a 404 and a public one a 200 whether or not the app has it.
    expect(await confirm({}, staticTokenProvider(null))).toEqual({ kind: "unknown", reason: "no-token" });
    // Another repository holds the name now: this one may live on elsewhere.
    expect(await confirm({ id: 999 })).toEqual({ kind: "unknown", reason: "renamed" });
    tokens.fail = new GitHubError("server", "Minting failed", 502);
    expect(await confirm()).toEqual({ kind: "unknown", reason: "server" });
    tokens.fail = new Error("Key unavailable");
    expect(await confirm()).toEqual({ kind: "unknown", reason: "error" });
    tokens.fail = null;
    github.fault(/^\/repos\//, () => new Response("down", { status: 502 }), 2);
    expect(await confirm()).toEqual({ kind: "unknown", reason: "server" });
    installation.suspended = true;
    expect(await confirm()).toEqual({ kind: "unknown", reason: "forbidden" });
  });

  it("retries a refused token once with a fresh one", async () => {
    const { github, confirm } = world();
    const invalidated: Array<number | null> = [];
    let issued = 0;
    const flaky: InstallationTokenProvider = {
      token: () => Promise.resolve(issued++ === 0 ? "ghs_expired" : github.token),
      invalidate: (id) => void invalidated.push(id),
    };
    expect((await confirm({}, flaky)).kind).toBe("accessible");
    expect(invalidated).toEqual([71]);
    const refused: InstallationTokenProvider = { token: () => Promise.resolve("ghs_bogus"), invalidate: () => {} };
    expect(await confirm({}, refused)).toEqual({ kind: "unknown", reason: "unauthorized" });
  });
});
