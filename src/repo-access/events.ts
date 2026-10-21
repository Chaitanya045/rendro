/**
 * GitHub webhook events that change who may read what (#243), turned into a
 * plan the access directory applies. A plan never grants anything by itself.
 * Payloads are signed but carry no timestamp, so a captured body could be
 * replayed under a fresh delivery ID. Restrictive changes therefore apply
 * straight from the payload (a replay can only deny), and permissive ones mark
 * the record for a check against GitHub before it grants again.
 */
import { isOwnerLogin, isRepoName } from "@/ingest/orchestrator/messages";

export interface RepoHint {
  id: number;
  owner: string;
  name: string;
  /** Unknown when the payload does not say. */
  private: boolean | null;
}

export type RepoChange =
  /** Upsert from the hint, then confirm with GitHub before the next grant. */
  | "confirm"
  /** Visibility becomes private at once. */
  | "privatize"
  /** No longer readable by anyone through the app. */
  | "remove";

export interface EventPlan {
  repos?: { change: RepoChange; hints: RepoHint[]; installation: number | null };
  installation?: { id: number; account: string | null; state: "active" | "suspended" | "deleted" };
  renameOwner?: { from: string; to: string };
  /** GitHub users (by ID) whose access may have changed. */
  users?: number[];
  /** Users holding these repositories in their mirror. */
  holders?: number[];
  /** Users who listed this installation. */
  installationUsers?: number;
  /** Tokens of this GitHub user are revoked: forget them. */
  unauthorize?: number;
  /** Bump the affected users' epochs (access may have been lost), not only refresh their mirrors. */
  revoke: boolean;
}

/** The events this module plans for; anything else is acknowledged and ignored. */
export const PERMISSION_EVENTS = new Set(["member", "membership", "organization", "team", "repository", "installation", "installation_repositories", "github_app_authorization"]);

type Payload = Record<string, unknown> & { action?: unknown };

function id(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** `{ id, name, owner: { login }, private }`, or the installation payloads' `{ id, full_name, private }`. */
function repoHint(value: unknown): RepoHint | null {
  const repoId = id(field(value, "id"));
  const fullName = field(value, "full_name");
  const [fullOwner, fullRepo] = typeof fullName === "string" && fullName.split("/").length === 2 ? fullName.split("/") : [undefined, undefined];
  const owner = field(field(value, "owner"), "login") ?? fullOwner;
  const name = field(value, "name") ?? fullRepo;
  const visibility = field(value, "private");
  if (repoId === null || !isOwnerLogin(owner) || !isRepoName(name) || (fullRepo !== undefined && fullRepo !== name)) return null;
  return { id: repoId, owner, name, private: typeof visibility === "boolean" ? visibility : null };
}

function repoHints(value: unknown): RepoHint[] | null {
  if (!Array.isArray(value)) return null;
  const hints = value.map(repoHint);
  return hints.every((hint) => hint !== null) ? hints : null;
}

/**
 * Whoever installed the app, or added repositories to it, is not yet among the users the installation lists, but
 * is about to open their home (#338): their mirror is refreshed too. Reaching a user only makes the next decision
 * ask GitHub, so a forged sender gains nothing.
 */
function withSender(plan: EventPlan, body: Payload): EventPlan {
  const sender = id(field(body.sender, "id"));
  return sender === null ? plan : { ...plan, users: [sender] };
}

/**
 * The plan for one verified delivery: `ignored` for events and actions that
 * change no access, `malformed` when a relevant payload is missing what the
 * plan needs (the delivery fails, and the TTL backstop applies).
 */
export function planEvent(event: string | null, payload: unknown): EventPlan | "ignored" | "malformed" {
  if (!event || !PERMISSION_EVENTS.has(event) || !payload || typeof payload !== "object") return "ignored";
  const body = payload as Payload;
  const action = typeof body.action === "string" ? body.action : "";
  const installation = id(field(body.installation, "id"));
  switch (event) {
    case "member": {
      // A repository collaborator was added, removed, or had their role changed.
      const user = id(field(body.member, "id"));
      if (!["added", "edited", "removed"].includes(action)) return "ignored";
      return user === null ? "malformed" : { users: [user], revoke: action !== "added" };
    }
    case "membership": {
      // A user joined or left a team.
      const user = id(field(body.member, "id"));
      if (!["added", "removed"].includes(action)) return "ignored";
      return user === null ? "malformed" : { users: [user], revoke: action === "removed" };
    }
    case "organization": {
      if (action === "member_added" || action === "member_removed") {
        const user = id(field(field(body.membership, "user"), "id"));
        return user === null ? "malformed" : { users: [user], revoke: action === "member_removed" };
      }
      if (action === "renamed") {
        const from = field(field(body.changes, "login"), "from");
        const to = field(body.organization, "login");
        return isOwnerLogin(from) && isOwnerLogin(to) ? { renameOwner: { from, to }, revoke: false } : "malformed";
      }
      if (action === "deleted") {
        return installation === null ? "malformed" : { installation: { id: installation, account: null, state: "deleted" }, installationUsers: installation, revoke: true };
      }
      return "ignored";
    }
    case "team": {
      // Team membership is not mirrored, so a team change reaches everyone who could hold the repository.
      if (!["created", "deleted", "edited", "added_to_repository", "removed_from_repository"].includes(action)) return "ignored";
      const repo = body.repository === undefined ? null : repoHint(body.repository);
      if (body.repository !== undefined && !repo) return "malformed";
      const revoke = action === "deleted" || action === "edited" || action === "removed_from_repository";
      if (repo && (action === "removed_from_repository" || action === "edited")) return { holders: [repo.id], revoke };
      return installation === null ? "malformed" : { installationUsers: installation, revoke };
    }
    case "repository": {
      const repo = repoHint(body.repository);
      if (!repo) return "malformed";
      if (action === "deleted") return { repos: { change: "remove", hints: [repo], installation }, holders: [repo.id], revoke: true };
      if (action === "privatized") return { repos: { change: "privatize", hints: [repo], installation }, revoke: false };
      // Transfers can move a repository out of an installation and change who may read it.
      if (action === "transferred") return { repos: { change: "confirm", hints: [repo], installation }, holders: [repo.id], revoke: true };
      return { repos: { change: "confirm", hints: [repo], installation }, revoke: false };
    }
    case "installation": {
      const account = field(field(body.installation, "account"), "login");
      if (installation === null) return "malformed";
      const owner = isOwnerLogin(account) ? account : null;
      if (action === "deleted" || action === "suspend") {
        return { installation: { id: installation, account: owner, state: action === "deleted" ? "deleted" : "suspended" }, installationUsers: installation, revoke: true };
      }
      if (action === "created" || action === "unsuspend" || action === "new_permissions_accepted") {
        const hints = body.repositories === undefined ? [] : repoHints(body.repositories);
        if (!hints) return "malformed";
        const plan: EventPlan = { installation: { id: installation, account: owner, state: "active" }, installationUsers: installation, revoke: false };
        if (hints.length) plan.repos = { change: "confirm", hints, installation };
        return withSender(plan, body);
      }
      return "ignored";
    }
    case "installation_repositories": {
      if (action !== "added" && action !== "removed") return "ignored";
      if (installation === null) return "malformed";
      const hints = repoHints(action === "added" ? body.repositories_added : body.repositories_removed);
      if (!hints) return "malformed";
      return action === "added"
        ? withSender({ repos: { change: "confirm", hints, installation }, installationUsers: installation, revoke: false }, body)
        : { repos: { change: "remove", hints, installation }, holders: hints.map((hint) => hint.id), revoke: true };
    }
    default: {
      // github_app_authorization: the user revoked the app's authorization; their tokens no longer work.
      const user = id(field(body.sender, "id"));
      if (action !== "revoked") return "ignored";
      return user === null ? "malformed" : { unauthorize: user, revoke: true };
    }
  }
}
