import { logger } from "@/logger";

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return slugPattern.test(slug);
}

export function logOrgAccess(org: string, email: string, action: "view" | "create"): void {
  logger.info({ org, email, action }, "org access");
}
