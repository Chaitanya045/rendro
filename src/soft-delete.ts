import Database from "better-sqlite3";

const db = new Database("docsync-auth.db");
db.pragma("journal_mode = WAL");

db.exec(`CREATE TABLE IF NOT EXISTS deleted_file (
  orgSlug TEXT NOT NULL,
  fileKey TEXT NOT NULL,
  deletedAt TEXT NOT NULL,
  PRIMARY KEY (orgSlug, fileKey)
)`);

export function markDeleted(orgSlug: string, fileKey: string): void {
  db.prepare("INSERT OR REPLACE INTO deleted_file (orgSlug, fileKey, deletedAt) VALUES (?, ?, ?)")
    .run(orgSlug, fileKey, new Date().toISOString());
}

export function isDeleted(fileKey: string): boolean {
  const row = db.prepare("SELECT 1 FROM deleted_file WHERE fileKey = ?").get(fileKey);
  return row !== undefined;
}

export function unmarkDeleted(fileKey: string): void {
  db.prepare("DELETE FROM deleted_file WHERE fileKey = ?").run(fileKey);
}

export function filterDeleted(keys: string[]): string[] {
  if (keys.length === 0) return [];
  const placeholders = keys.map(() => "?").join(",");
  const deleted = db.prepare(
    `SELECT fileKey FROM deleted_file WHERE fileKey IN (${placeholders})`
  ).all(...keys) as { fileKey: string }[];
  const deletedSet = new Set(deleted.map((d) => d.fileKey));
  return keys.filter((k) => !deletedSet.has(k));
}
