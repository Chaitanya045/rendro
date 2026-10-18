import { isGitObjectId } from "../github/git-objects";
import type { RepoRef } from "../github/source";
import { isBranchName } from "./keys";

/** The producer side of a Workers Queue binding. */
export interface QueueLike<T> {
  send(body: T): Promise<void>;
}

export type IngestReason = "push" | "reconcile" | "install" | "view";

/**
 * One queued unit of work: "bring this branch up to date". It never carries a
 * GitHub URL (archive links expire in minutes); the consumer resolves
 * everything from the repository and branch when it runs.
 */
export interface IngestMessage {
  v: 1;
  repo: RepoRef;
  branch: string;
  /** The commit the sender believes is the head (a push's `after`). A hint only. */
  sha: string | null;
  /** X-GitHub-Delivery of the webhook that caused this, for dedupe. Redeliveries reuse it. */
  deliveryId: string | null;
  reason: IngestReason;
}

const REASONS = new Set<IngestReason>(["push", "reconcile", "install", "view"]);
/** GitHub logins and repository names. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function isOwnerLogin(value: unknown): value is string {
  return typeof value === "string" && OWNER.test(value);
}

export function isRepoName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value) && value !== "." && value !== "..";
}

const DELIVERY = /^[A-Za-z0-9-]{1,64}$/;

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseRepoRef(value: unknown): RepoRef | null {
  const repo = value as Partial<Record<keyof RepoRef, unknown>> | null;
  if (!repo || typeof repo !== "object" || !positiveInteger(repo.id) || !isOwnerLogin(repo.owner) || !isRepoName(repo.name)
    || typeof repo.private !== "boolean" || !(repo.installationId === null || positiveInteger(repo.installationId))) {
    return null;
  }
  return { id: repo.id, owner: repo.owner, name: repo.name, private: repo.private, installationId: repo.installationId };
}

/** Validate a message from the queue. Anything malformed is dropped rather than retried. */
export function parseIngestMessage(value: unknown): IngestMessage | null {
  const message = value as Partial<Record<keyof IngestMessage, unknown>> | null;
  if (!message || typeof message !== "object" || message.v !== 1) return null;
  const repo = parseRepoRef(message.repo);
  if (!repo || !isBranchName(message.branch) || !(message.sha === null || isGitObjectId(message.sha))
    || !(message.deliveryId === null || (typeof message.deliveryId === "string" && DELIVERY.test(message.deliveryId)))
    || !REASONS.has(message.reason as IngestReason)) {
    return null;
  }
  return { v: 1, repo, branch: message.branch, sha: message.sha, deliveryId: message.deliveryId, reason: message.reason as IngestReason };
}
