import { randomUUID } from "node:crypto";
import { staticTokenProvider, type InstallationTokenProvider } from "../../src/ingest/github/token";
import { RateGovernor } from "../../src/ingest/github/rate-governor";
import { AccessDirectory, type CommentAccessSink, type DirectoryStorage, type EpochStore } from "../../src/repo-access/directory";
import { planEvent, type EventPlan } from "../../src/repo-access/events";
import { GitHubAccessClient } from "../../src/repo-access/github";
import { httpTokenRefresher, type TokenRefresher } from "../../src/repo-access/tokens";
import type { KvReader } from "../../src/repo-read/access";
import { FakeGitHub, type FakeRepo, type FakeUser } from "./fake-github";
import { FakeDurableStorage } from "./fake-storage";
import { FakeClock } from "./ingest-fixture";

export const TOKEN_KEY = "test-github-token-key-0123456789abcdef";

/** Durable Object storage with the alarm API the directory uses. */
export class FakeDirectoryStorage extends FakeDurableStorage implements DirectoryStorage {
  alarm: number | null = null;
  readonly alarms: number[] = [];

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
    this.alarms.push(scheduledTime);
    return Promise.resolve();
  }
}

/** The REPO_EPOCHS namespace, shared by the control Worker (writes) and the serving Worker (reads). */
export class FakeEpochKv implements EpochStore, KvReader {
  readonly data = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string; expirationTtl: number }> = [];
  /** Runs before a write lands (to observe what is already true when the epoch moves). */
  beforePut: ((key: string) => void | Promise<void>) | null = null;
  failPut: ((key: string) => boolean) | null = null;

  async put(key: string, value: string, options: { expirationTtl: number }): Promise<void> {
    await this.beforePut?.(key);
    if (this.failPut?.(key)) throw new Error("KV write failed");
    this.puts.push({ key, value, expirationTtl: options.expirationTtl });
    this.data.set(key, value);
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.data.get(key) ?? null);
  }

  epoch(userId: string): number {
    return Number(this.data.get(`epoch:${userId}`) ?? 0);
  }
}

export interface AccessFixtureOptions {
  installationTokens?: InstallationTokenProvider;
  refresher?: TokenRefresher;
  /** Convex's comment grants (#254). */
  comments?: CommentAccessSink;
}

/**
 * A GitHub world and the access directory over it: organization `octo` with
 * the app installed on every repository, a public and a private docs
 * repository, a team, and three people (a direct collaborator, a team member
 * and an outsider), each linked to a Rendro user.
 */
export function accessFixture(options: AccessFixtureOptions = {}) {
  const clock = new FakeClock();
  const github = new FakeGitHub();
  github.now = clock.now;
  github.rate.reset = Math.floor(clock.time / 1000) + 3600;
  const storage = new FakeDirectoryStorage();
  const kv = new FakeEpochKv();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const client = new GitHubAccessClient({ apiOrigin: github.origin, fetch: github.fetch, clock, governor: () => new RateGovernor({ clock }) });
  const directory = new AccessDirectory({ storage }, {
    github: client,
    installationTokens: options.installationTokens ?? staticTokenProvider(github.token),
    refresher: options.refresher ?? httpTokenRefresher({ clientId: github.clientId, clientSecret: github.clientSecret, webOrigin: github.webOrigin, fetch: github.fetch, now: clock.now }),
    tokenKey: TOKEN_KEY, epochs: kv, comments: options.comments, now: clock.now, log: (event, fields) => logs.push({ event, fields }),
  });
  const installation = github.install("octo", { id: 71 });
  const open = github.repo("octo", "open-docs", { id: 801 });
  const closed = github.repo("octo", "closed-docs", { id: 802, private: true });
  const teamDocs = github.repo("octo", "team-docs", { id: 803, private: true });
  const people = { reader: github.user("reader", 5001), member: github.user("member", 5002), outsider: github.user("outsider", 5003) };
  closed.collaborators.add(people.reader.id);
  const team = github.team("octo", "writers", [people.member], [teamDocs]);
  const userIds = { reader: "user-reader", member: "user-member", outsider: "user-outsider" } as const;

  async function deliver(event: string, payload: Record<string, unknown>, delivery: string = randomUUID()) {
    const plan = planEvent(event, { installation: { id: installation.id, account: { login: "octo" } }, ...payload });
    if (typeof plan === "string") throw new Error(`Unexpected plan: ${plan}`);
    return directory.applyWebhook(delivery, plan);
  }

  function apply(plan: EventPlan, delivery: string = randomUUID()) {
    return directory.applyWebhook(delivery, plan);
  }

  async function link(person: keyof typeof people, tokens = github.signIn(people[person])) {
    await directory.link({ userId: userIds[person], githubId: people[person].id, login: people[person].login, tokens });
    return tokens;
  }

  /** The installation as GitHub announces it, then every person signs in. */
  async function setup() {
    await deliver("installation", { action: "created", repositories: [open, closed, teamDocs].map((repo) => github.repoJson(repo)) });
    for (const person of Object.keys(people) as Array<keyof typeof people>) await link(person);
    // Sign-in bumps epochs (written by the alarm); tests measure from here.
    await directory.alarm();
    kv.puts.length = 0;
    github.resetLog();
  }

  const read = (person: keyof typeof people | null, repo: FakeRepo) => directory.authorize(person === null ? null : userIds[person], repo.owner, repo.name);
  const repoPayload = (repo: FakeRepo) => ({ repository: github.repoJson(repo) });
  const userPayload = (user: FakeUser) => ({ id: user.id, login: user.login });

  return { clock, github, storage, kv, logs, client, directory, installation, open, closed, teamDocs, people, team, userIds, deliver, apply, link, setup, read, repoPayload, userPayload };
}
