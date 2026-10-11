import { legacyStoragePrefix } from "@/storage-boundary";
import { listObjects } from "@/minio";
import { logger } from "@/logger";

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return slugPattern.test(slug);
}

export function emailToOrgSlug(email: string): string | null {
  const atIndex = email.indexOf("@");
  if (atIndex < 0) return null;
  const domain = email.slice(atIndex + 1).toLowerCase();
  const dotIndex = domain.lastIndexOf(".");
  if (dotIndex < 0) return null;
  const base = domain.slice(0, dotIndex);
  return isValidSlug(base) ? base : null;
}

export async function orgExists(org: string): Promise<boolean> {
  if (!legacyStoragePrefix(org)) return false;
  const entries = await listObjects(`${org}/`);
  return entries.length > 0;
}

export function logOrgAccess(org: string, email: string, action: "view" | "create"): void {
  logger.info({ org, email, action }, "org access");
}
