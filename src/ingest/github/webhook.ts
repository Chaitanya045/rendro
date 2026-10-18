import { isGitObjectId } from "./git-objects";
import { readBytes } from "./http-source";
import { GitHubError } from "./source";
import { parseIngestMessage, type IngestMessage, type QueueLike } from "../orchestrator/messages";

/**
 * Webhook ingress for push events. Not routed yet: P1 creates the GitHub App
 * and its secret, and the route then calls acceptPushWebhook. It verifies the
 * signature, turns a branch push into a queue message and answers at once;
 * GitHub fails a delivery that takes over ten seconds and never retries it.
 * The permission events (#243) go through the same `readVerifiedWebhook`.
 */

/** GitHub caps payloads at 25 MB. */
export const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;
const encoder = new TextEncoder();
const DELIVERY = /^[A-Za-z0-9-]{1,64}$/;

/** A well-formed `X-GitHub-Delivery` (a GUID; redeliveries reuse it, so it is the dedupe key). */
export function isDeliveryId(value: unknown): value is string {
  return typeof value === "string" && DELIVERY.test(value);
}

/** Check X-Hub-Signature-256 (HMAC-SHA256 of the raw body). WebCrypto's verify compares in constant time. */
export async function verifyWebhookSignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/.exec(header ?? "");
  if (!secret || !match) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = new Uint8Array((match[1].match(/../g) as RegExpMatchArray).map((byte) => parseInt(byte, 16)));
  return crypto.subtle.verify("HMAC", key, signature, body);
}

export type PushParse =
  | { kind: "ingest"; message: IngestMessage }
  | { kind: "ignored"; reason: string };

interface PushPayload {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: { id?: unknown; name?: unknown; private?: unknown; owner?: { login?: unknown } };
  installation?: { id?: unknown };
}

/** Turn a verified push payload into an ingest message. Tags, branch deletions and other events are ignored. */
export function parsePush(event: string | null, deliveryId: string | null, payload: unknown): PushParse {
  if (event !== "push") return { kind: "ignored", reason: "event" };
  const push = payload as PushPayload | null;
  if (typeof push?.ref !== "string" || !push.ref.startsWith("refs/heads/")) return { kind: "ignored", reason: "not-a-branch" };
  // Branch deletion: the served snapshot stays until P4/P9 decide what a deleted branch shows.
  if (push.deleted === true || !isGitObjectId(push.after) || /^0+$/.test(push.after)) return { kind: "ignored", reason: "deleted" };
  const message = parseIngestMessage({
    v: 1,
    repo: {
      id: push.repository?.id, owner: push.repository?.owner?.login, name: push.repository?.name,
      private: push.repository?.private, installationId: push.installation?.id ?? null,
    },
    branch: push.ref.slice("refs/heads/".length),
    sha: push.after,
    deliveryId: isDeliveryId(deliveryId) ? deliveryId : null,
    reason: "push",
  });
  return message ? { kind: "ingest", message } : { kind: "ignored", reason: "malformed" };
}

export interface VerifiedWebhook {
  event: string | null;
  deliveryId: string | null;
  payload: unknown;
}

/**
 * Read a webhook request without ever holding more than GitHub's 25 MB, check
 * its signature, then parse it. A Response is the answer to send instead:
 * 405, 413, 400, or 401 for a missing or wrong signature (nothing is parsed
 * before the signature matches).
 */
export async function readVerifiedWebhook(request: Request, secret: string): Promise<VerifiedWebhook | Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (Number(request.headers.get("content-length")) > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });
  let body: Uint8Array<ArrayBuffer>;
  try {
    // Counts bytes as they stream and holds only what arrived (no up-front 25 MB buffer).
    body = await readBytes(new Response(request.body), MAX_WEBHOOK_BYTES);
  } catch (error) {
    return new Response(null, { status: error instanceof GitHubError && error.kind === "too-large" ? 413 : 400 });
  }
  if (!await verifyWebhookSignature(secret, body, request.headers.get("x-hub-signature-256"))) {
    return new Response(null, { status: 401 });
  }
  try {
    return { event: request.headers.get("x-github-event"), deliveryId: request.headers.get("x-github-delivery"), payload: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return new Response(null, { status: 400 });
  }
}

/** Verify, enqueue, answer. 202 when queued, 204 when ignored, 401 for a bad signature. */
export async function acceptPushWebhook(request: Request, options: { secret: string; queue: QueueLike<IngestMessage> }): Promise<Response> {
  const webhook = await readVerifiedWebhook(request, options.secret);
  if (webhook instanceof Response) return webhook;
  const parsed = parsePush(webhook.event, webhook.deliveryId, webhook.payload);
  if (parsed.kind === "ignored") return new Response(null, { status: 204 });
  // A failed send surfaces as a 5xx, so GitHub records the delivery as failed and the reconciler redelivers it.
  await options.queue.send(parsed.message);
  return new Response(null, { status: 202 });
}
