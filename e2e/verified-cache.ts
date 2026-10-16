import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Return the verified bytes, never a mutable cache path to execute later. */
export async function verifiedArchive(path: string, checksum: string, download: (path: string) => Promise<void>, trackTemporary?: (directory: string) => void) {
  const valid = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex") === checksum;
  try {
    const bytes = await readFile(path);
    if (valid(bytes)) return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  // Each writer owns its staging directory. Readers see only a complete,
  // verified archive, even when multiple cold starts publish concurrently.
  const staging = mkdtempSync(join(dirname(path), "download-"));
  try {
    trackTemporary?.(staging);
    const temporary = join(staging, "backend.zip");
    await download(temporary);
    const bytes = await readFile(temporary);
    if (!valid(bytes)) throw new Error("Convex release checksum mismatch");
    await rename(temporary, path);
    return bytes;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
