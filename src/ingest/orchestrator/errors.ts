import { GitHubError } from "../github/source";

/** Why an ingest attempt stopped. Permanent failures are recorded, not retried, until the head moves. */
export class IngestError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly permanent: boolean,
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

const PERMANENT_GITHUB = new Set(["not-found", "forbidden", "too-large"]);

/** Map any failure to an IngestError. Unknown errors (storage, bugs) are transient: the queue retries, then dead-letters. */
export function toIngestError(error: unknown): IngestError {
  if (error instanceof IngestError) return error;
  if (error instanceof GitHubError) {
    return new IngestError(`github-${error.kind}`, error.message, PERMANENT_GITHUB.has(error.kind), error.retryAt);
  }
  return new IngestError("internal", error instanceof Error ? error.message : "Ingest failed", false);
}
