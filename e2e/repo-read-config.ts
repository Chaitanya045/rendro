import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The fixture control Worker the test configurations add beside the production Worker (#234). */
export const repoReadWorker = { access: "rendro-repo-access-fixture", accessConfig: join(import.meta.dirname, "repo-access/wrangler.toml") };

/**
 * Adds the repository read path's bindings to a Worker configuration: snapshots in R2, revocation
 * epochs in KV and the fixture control Worker. Production configures none of them until P5, so
 * there every /r/ URL is a 404.
 */
export function withRepoReadBindings(config: string): string {
  return `${config}
[[r2_buckets]]
binding = "REPO_CONTENT"
bucket_name = "rendro-repo-content-test"

[[kv_namespaces]]
binding = "REPO_EPOCHS"
id = "rendro-repo-epochs-test"

[[services]]
binding = "REPO_ACCESS"
service = "${repoReadWorker.access}"
`;
}

/** The production wrangler.toml with paths relocated to `root`, plus the read-path bindings. */
export async function workerConfigWithRepoRead(root: string): Promise<string> {
  const production = await readFile(join(root, "wrangler.toml"), "utf8");
  return withRepoReadBindings(production
    .replace('main = "src/worker.ts"', `main = ${JSON.stringify(join(root, "src/worker.ts"))}`)
    .replace('directory = "./public"', `directory = ${JSON.stringify(join(root, "public"))}`));
}
