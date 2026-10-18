import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The fixture control Worker some test configurations add beside the production Worker (#234). */
export const repoReadWorker = { access: "rendro-repo-access-fixture", accessConfig: join(import.meta.dirname, "repo-access/wrangler.toml") };

/** The real control Worker (#243, wrangler.control.toml) and the KV namespace both Workers share for epochs. */
export const controlWorker = { name: "rendro-control-dev", epochs: "rendro-repo-epochs-test" };

/**
 * Adds the repository read path's bindings to a Worker configuration: snapshots in R2, revocation
 * epochs in KV and a control Worker as the permission source (the #234 fixture unless `service` names
 * another). Production configures none of them yet, so there every /r/ URL is a 404.
 */
export function withRepoReadBindings(config: string, service = repoReadWorker.access): string {
  return `${config}
[[r2_buckets]]
binding = "REPO_CONTENT"
bucket_name = "rendro-repo-content-test"

[[kv_namespaces]]
binding = "REPO_EPOCHS"
id = "${controlWorker.epochs}"

[[services]]
binding = "REPO_ACCESS"
service = "${service}"
`;
}

/** The production wrangler.toml with paths relocated to `root`, plus the read-path bindings. */
export async function workerConfigWithRepoRead(root: string, service?: string): Promise<string> {
  const production = await readFile(join(root, "wrangler.toml"), "utf8");
  return withRepoReadBindings(production
    .replace('main = "src/worker.ts"', `main = ${JSON.stringify(join(root, "src/worker.ts"))}`)
    .replace('directory = "./public"', `directory = ${JSON.stringify(join(root, "public"))}`), service);
}

/** wrangler.control.toml with its entry relocated to `root` and its epoch namespace shared with the serving Worker. */
export async function controlWorkerConfig(root: string): Promise<string> {
  const control = await readFile(join(root, "wrangler.control.toml"), "utf8");
  const relocated = control
    .replace('main = "src/repo-access/entry.ts"', `main = ${JSON.stringify(join(root, "src/repo-access/entry.ts"))}`)
    .replace(/^id = "rendro-repo-epochs-dev"$/m, `id = "${controlWorker.epochs}"`);
  if (relocated === control || !relocated.includes(controlWorker.epochs)) throw new Error("wrangler.control.toml changed shape: update controlWorkerConfig");
  return relocated;
}
