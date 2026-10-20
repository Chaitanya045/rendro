/**
 * The control Worker's main module (wrangler.control.toml). workerd accepts
 * only handlers and classes as a main module's exports, so the helpers in
 * worker.ts stay behind this re-export. `RepoAccessService` is the named
 * entrypoint the serving Worker's `REPO_ACCESS` binding names.
 */
export { default, RepoAccessDirectory, RepoAccessService } from "./worker";
