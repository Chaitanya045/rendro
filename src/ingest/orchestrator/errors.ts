import { GitHubError } from "../github/source";
import { SealedContentError } from "./sealing";

/** Why an ingest attempt stopped. Permanent failures are recorded, not retried, until the head moves. */
export class IngestError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly permanent: boolean,
    readonly retryAt: number | null = null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "IngestError";
  }
}

const PERMANENT_GITHUB = new Set(["not-found", "forbidden", "too-large"]);

/** Stored content that did not open (#263): the coordinator wipes it before the retry. A missing key is not one of them. */
export const UNREADABLE_CONTENT: ReadonlySet<string> = new Set(["content-unsealed", "content-unknown-key", "content-tampered"]);

/** Map any failure to an IngestError. Unknown errors (storage, bugs) are transient: the queue retries, then dead-letters. */
export function toIngestError(error: unknown): IngestError {
  if (error instanceof IngestError) return error;
  if (error instanceof GitHubError) {
    return new IngestError(`github-${error.kind}`, error.message, PERMANENT_GITHUB.has(error.kind), error.retryAt, error);
  }
  if (error instanceof SealedContentError) return new IngestError(`content-${error.reason}`, error.message, false, null, error);
  // The original error rides along as `cause`: a bare message (an assertion's "false == true") says nothing about where it came from.
  return new IngestError("internal", error instanceof Error ? error.message : "Ingest failed", false, null, error);
}
