import { randomBytes, createHash } from "node:crypto";
import Database from "better-sqlite3";
import { logger } from "@/logger";

const db = new Database("rendro-auth.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS api_key (
    id TEXT PRIMARY KEY NOT NULL,
    orgSlug TEXT NOT NULL UNIQUE,
    keyHash TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )
`);

export function generateApiKey(): { raw: string; hash: string } {
  const raw = `docsk_${randomBytes(24).toString("base64url")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export function createOrgApiKey(orgSlug: string): string {
  // Delete existing key if any
  db.prepare("DELETE FROM api_key WHERE orgSlug = ?").run(orgSlug);
  const { raw, hash } = generateApiKey();
  const id = randomBytes(12).toString("hex");
  db.prepare("INSERT INTO api_key (id, orgSlug, keyHash, createdAt) VALUES (?, ?, ?, ?)")
    .run(id, orgSlug, hash, new Date().toISOString());
  logger.info({ orgSlug }, "API key created");
  return raw;
}

export function validateApiKey(key: string): string | null {
  const hash = createHash("sha256").update(key).digest("hex");
  const row = db.prepare("SELECT orgSlug FROM api_key WHERE keyHash = ?").get(hash) as { orgSlug: string } | undefined;
  return row?.orgSlug ?? null;
}
