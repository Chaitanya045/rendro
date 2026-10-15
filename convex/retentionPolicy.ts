import type { Doc } from "./_generated/dataModel";

export const STAGING_LEASE_MS = 60 * 60 * 1000;
export const STAGING_DRAIN_MS = 24 * 60 * 60 * 1000;
export const PURGE_CLAIM_MS = 30 * 60 * 1000;
export const FAILED_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SUPERSEDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Existing rows need no backfill; their initial lease starts at creation.
export function stagingExpiry(deployment: Doc<"deployments">): number {
  return deployment.stagingExpiresAt ?? deployment.createdAt + STAGING_LEASE_MS;
}
