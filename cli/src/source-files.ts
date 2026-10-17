import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createIgnoreMatcher } from "./ignore";

const excludedDirectories = new Set([".git", ".aws", ".ssh", "node_modules"]);
const sensitiveFiles = new RegExp("^(?:" + [
  "\\.env(?:\\..*)?", "\\.envrc(?:\\..*)?", "\\.npmrc", "\\.pypirc", "\\.netrc", "\\.git-credentials", "\\.htpasswd", "\\.pgpass", "\\.dockercfg",
  "id_.*", ".*\\.(?:pem|key|p12|pfx|jks|keystore|ppk|tfstate|tfvars)",
  // Credential stores by name; an HTML page called credentials.html stays eligible.
  "credentials(?:\\.(?:json|ya?ml|toml|ini|csv|xml))?", "secrets?\\.(?:json|ya?ml|toml|ini)",
].join("|") + ")$", "i");

/** Filter before reading/hashing file contents. Never follow symbolic links. */
export async function sourceFiles(
  root: string,
  includeSensitive: boolean,
  skipped: (path: string, reason: string) => void,
  includedSensitive: (path: string) => void = () => {},
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
      const dotDirectory = directory && entry.name.startsWith(".");
      let reason: string | undefined;
      if (entry.name === ".rendroignore") reason = "ignore file";
      else if (directory && excludedDirectories.has(entry.name.toLowerCase())) reason = "excluded directory";
      else if (!includeSensitive && sensitiveFiles.test(entry.name)) reason = "sensitive";
      else if (ignored(path, directory, dotDirectory)) reason = dotDirectory ? "excluded directory" : ".rendroignore";
      else if (!directory && !entry.isFile()) reason = "not a regular file";
      if (reason) {
        skipped(path + (directory ? "/" : ""), reason);
        continue;
      }
      if (includeSensitive && !directory && sensitiveFiles.test(entry.name)) includedSensitive(path);
      const full = join(dir, entry.name);
      if (directory) files.push(...await walk(full, path + "/"));
      else files.push(full);
    }
    return files;
  }
  return walk(root, "");
}
