import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { ingestBranch } from "../src/ingest/orchestrator/ingest";
import { r2Store, type R2BucketLike } from "../src/ingest/orchestrator/store";
import { controlWorker, controlWorkerConfig, workerConfigWithRepoRead } from "../e2e/repo-read-config";
import { ingestFixture } from "./helpers/ingest-fixture";
import { repoFiles } from "./helpers/repo-read-fixture";

/**
 * The permission mirror on real workerd (#243): the production Worker reads
 * through the real control Worker (service binding, Durable Object directory,
 * shared KV epochs), which reads a fake GitHub. A membership webhook revokes a
 * reader, and the time from delivery to the first denied view is measured.
 */

interface ProductEnv { REPO_CONTENT: R2BucketLike; REPO_ACCESS: { fetch(url: string, init?: RequestInit): Promise<Response> } }

const root = fileURLToPath(new URL("..", import.meta.url));
const originalFetch = globalThis.fetch;
const convexSite = "http://convex.test:3211";
const WEBHOOK_SECRET = "workerd-webhook-secret-0123456789abcdef";
const sessions: Record<string, string> = { "member-token.sig": "user-member" };
const ingest = ingestFixture();
const { github } = ingest;
github.now = () => Date.now();
const installation = github.install("octo", { id: 71 });
const teamDocs = github.repo("octo", "team-docs", { id: 803, private: true });
const member = github.user("member", 5002);
const team = github.team("octo", "writers", [member], [teamDocs]);
const iterations = 25;
let server: ReturnType<typeof createTestHarness>;
let origin: string;
let directory: string;
let service: ProductEnv["REPO_ACCESS"];

function sessionResponse(request: Request): Response {
  const token = /session_token=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "";
  const user = sessions[token];
  if (!user) return Response.json(null);
  const now = new Date().toISOString();
  return Response.json({
    user: { id: user, email: `${user}@example.test`, name: user, emailVerified: true, image: null, createdAt: now, updatedAt: now },
    session: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
}

const control = () => server.getWorker(controlWorker.name);

async function deliver(event: string, payload: Record<string, unknown>): Promise<number> {
  const { body, headers } = github.webhook(WEBHOOK_SECRET, event, { installation: { id: installation.id, account: { login: "octo" } }, ...payload });
  const response = await control().fetch("https://control.rendro.test/v1/github/webhook", { method: "POST", body, headers });
  await response.arrayBuffer();
  return response.status;
}

const agent = new Agent({ keepAlive: true, maxSockets: 1 });

/** One request straight to workerd's socket, timed to the last body byte. */
function timed(path: string, headers: Record<string, string>): Promise<{ status: number; ms: number; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = httpRequest(new URL(path, origin), { agent, headers }, response => {
      response.on("data", () => {});
      response.on("end", () => resolve({ status: response.statusCode as number, ms: performance.now() - started, cookies: response.headers["set-cookie"] ?? [] }));
    });
    request.on("error", reject);
    request.end();
  });
}

function percentiles(times: number[]): { p50: number; p90: number } {
  const sorted = [...times].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * 0.5)], p90: sorted[Math.floor(sorted.length * 0.9)] };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rendro-repo-access-"));
  teamDocs.commit(repoFiles("Team home"));
  // Wrangler's harness hands every outbound Worker fetch to globalThis.fetch: the session lookup and the fake GitHub.
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.url.startsWith(`${convexSite}/api/auth/get-session`)) return Promise.resolve(sessionResponse(request));
    if (url.origin === github.origin || url.origin === github.webOrigin) return github.fetch(request);
    return Promise.reject(new Error(`Blocked outbound fetch to ${url.origin}`));
  };
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  const configPath = join(directory, "wrangler.toml");
  const controlPath = join(directory, "wrangler.control.toml");
  await writeFile(configPath, await workerConfigWithRepoRead(root, controlWorker.name));
  await writeFile(controlPath, await controlWorkerConfig(root));
  const vars = {
    NODE_ENV: "production", LOG_LEVEL: "error", CONVEX_URL: "http://convex.test:3210", CONVEX_SITE_URL: convexSite,
    CONVEX_INTERNAL_SECRET: "workerd-convex-internal-secret-0123456789", AUTH_SECRET: "workerd-auth-secret-0123456789",
    REPO_CONTENT_SECRET: "unused", REPO_CAPABILITY_SECRET: "workerd-repo-capability-secret-0123456789", IMAGE_PROXY_SECRET: "workerd-image-proxy-secret-0123456789",
    REPO_CONTENT_KEY: process.env.REPO_CONTENT_KEY as string,
  };
  const controlVars = { GITHUB_API_ORIGIN: github.origin, GITHUB_WEB_ORIGIN: github.webOrigin, GITHUB_APP_CLIENT_ID: github.clientId };
  const controlSecrets = { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, GITHUB_TOKEN_KEY: "workerd-github-token-key-0123456789abcdef", GITHUB_APP_CLIENT_SECRET: github.clientSecret, GITHUB_DEV_TOKEN: github.token };
  server = createTestHarness({ root, workers: [{ configPath, vars, secrets: vars }, { configPath: controlPath, vars: controlVars, secrets: controlSecrets }] });
  origin = (await server.listen()).url.origin;
  const env = await server.getWorker<ProductEnv>().getEnv();
  const etags = { get: () => Promise.resolve(null), set: () => Promise.resolve() };
  await ingestBranch({ ...ingest.deps, store: r2Store(env.REPO_CONTENT) }, etags, teamDocs.ref, "main");
  expect(await deliver("installation", { action: "created", repositories: [github.repoJson(teamDocs)] })).toBe(202);
  // Account hand-overs go through the serving Worker's binding, which names the internal entrypoint (#295).
  service = env.REPO_ACCESS;
  const linked = await service.fetch("https://repo-access.internal/v1/accounts/link", { method: "POST", body: JSON.stringify({ userId: "user-member", githubId: member.id, login: member.login, tokens: github.signIn(member) }) });
  expect(linked.status).toBe(204);
}, 180_000);

afterAll(async () => {
  agent.destroy();
  await server?.close();
  globalThis.fetch = originalFetch;
  if (directory) await rm(directory, { recursive: true, force: true });
});

const session = "better-auth.session_token=member-token.sig";

describe("permission mirror on workerd", () => {
  it("grants a team member, then a membership webhook denies their next view; measures the revocation", async () => {
    const webhookTimes: number[] = [];
    const revocationTimes: number[] = [];
    const missTimes: number[] = [];
    const freshMissTimes: number[] = [];
    const floorTimes: number[] = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      team.members.add(member.id);
      expect(await deliver("membership", { action: "added", member: { id: member.id, login: member.login } })).toBe(202);
      // A cookie miss right after an invalidation: session, epoch, control Worker, and a mirror refresh from GitHub.
      const granted = await timed("/r/octo/team-docs", { cookie: session });
      expect(granted.status).toBe(200);
      missTimes.push(granted.ms);
      const capability = granted.cookies.find(value => value.startsWith("rendro-repo.803="));
      expect(capability).toBeDefined();
      const cookie = `${session}; ${(capability as string).split(";", 1)[0]}`;
      expect((await timed("/r/octo/team-docs", { cookie })).status).toBe(200);
      // A cookie miss while the mirror is fresh: no GitHub request at all.
      const fresh = await timed("/r/octo/team-docs", { cookie: session });
      expect(fresh.status).toBe(200);
      freshMissTimes.push(fresh.ms);
      floorTimes.push((await timed("/health", {})).ms);

      team.members.delete(member.id);
      const started = performance.now();
      expect(await deliver("membership", { action: "removed", member: { id: member.id, login: member.login } })).toBe(202);
      webhookTimes.push(performance.now() - started);
      const denied = await timed("/r/octo/team-docs", { cookie });
      expect(denied.status).toBe(404);
      revocationTimes.push(performance.now() - started);
      expect(denied.cookies.some(value => value.startsWith("rendro-repo.803=;"))).toBe(true);
    }
    const rows = {
      "/health (floor)": percentiles(floorTimes),
      "webhook (verify, directory, KV epoch)": percentiles(webhookTimes),
      "delivery to first denied view": percentiles(revocationTimes),
      "cookie miss, fresh mirror": percentiles(freshMissTimes),
      "cookie miss with a mirror refresh": percentiles(missTimes),
    };
    console.log([`workerd, ${iterations} revocations (p50 / p90 ms):`, ...Object.entries(rows).map(([name, { p50, p90 }]) => `  ${name}: ${p50.toFixed(2)} / ${p90.toFixed(2)}`)].join("\n"));
    expect(rows["delivery to first denied view"].p50).toBeGreaterThan(0);
  }, 120_000);

  it("rejects forged deliveries and answers replays without applying them again", async () => {
    const { body, headers } = github.webhook("not-the-secret-0123456789abcdef0123", "installation", { action: "deleted", installation: { id: installation.id } });
    expect((await control().fetch("https://control.rendro.test/v1/github/webhook", { method: "POST", body, headers })).status).toBe(401);
    const replay = github.webhook(WEBHOOK_SECRET, "membership", { action: "added", member: { id: member.id }, installation: { id: installation.id } }, "replayed-delivery");
    for (const status of [202, 200]) {
      expect((await control().fetch("https://control.rendro.test/v1/github/webhook", { method: "POST", body: replay.body, headers: replay.headers })).status).toBe(status);
    }
  });

  it("serves the internal endpoints only through the entrypoint the service binding names, whatever the host", async () => {
    const link = JSON.stringify({ userId: "user-other", githubId: 7001, login: "other", tokens: github.signIn(github.user("other", 7001)) });
    for (const host of ["control.rendro.test", "repo-access.internal"]) {
      for (const path of ["/v1/authorize", "/v1/accounts/link", "/v1/accounts/unlink"]) {
        const response = await control().fetch(`https://${host}${path}`, { method: "POST", body: path === "/v1/accounts/link" ? link : "{}" });
        expect(response.status, `${host}${path}`).toBe(404);
        await response.arrayBuffer();
      }
    }
    // The binding reaches them; the webhook is not served there.
    const unlinked = await service.fetch("https://repo-access.internal/v1/accounts/unlink", { method: "POST", body: JSON.stringify({ userId: "user-nobody" }) });
    expect(unlinked.status).toBe(204);
    const hook = await service.fetch("https://repo-access.internal/v1/github/webhook", { method: "POST", body: "{}" });
    expect(hook.status).toBe(404);
    await hook.arrayBuffer();
  });
});
