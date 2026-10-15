import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createIgnoreMatcher } from "./ignore";

const sensitiveDirectories = new Set([".aws", ".ssh"]);
const sensitiveFiles = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_.*|.*\.(?:pem|key))$/i;

/** Filter before reading/hashing file contents. Never follow symbolic links. */
export async function sourceFiles(
  root: string,
  includeSensitive: boolean,
  skipped: (path: string, reason: string) => void,
): Promise<string[]> {
  let ignoreText = "";
  try {
    ignoreText = await readFile(join(root, ".rendroignore"), "utf8");
  } catch (error) {
    // An unreadable ignore file must not silently broaden the upload set.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const ignored = createIgnoreMatcher(ignoreText);
  async function walk(dir: string, prefix: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      const directory = entry.isDirectory();
      const sensitiveDirectory = directory && sensitiveDirectories.has(entry.name.toLowerCase());
      let reason: string | undefined;
      if (entry.name === ".rendroignore") reason = "ignore file";
      else if (!includeSensitive && (sensitiveDirectory || sensitiveFiles.test(entry.name))) reason = "sensitive";
      else if (ignored(path, directory)) reason = ".rendroignore";
      else if (directory && (entry.name === "node_modules" || (entry.name.startsWith(".") && !sensitiveDirectory))) reason = "excluded directory";
      else if (!directory && !entry.isFile()) reason = "not a regular file";
      if (reason) {
        skipped(path + (directory ? "/" : ""), reason);
        continue;
      }
      const full = join(dir, entry.name);
      if (directory) files.push(...await walk(full, path + "/"));
      else files.push(full);
    }
    return files;
  }
  return walk(root, "");
}
