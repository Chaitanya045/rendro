/**
 * Fixture control Worker for the repository read path (#234), used by the E2E
 * suite and tests/repo-read-workerd.test.ts. It speaks the real protocol
 * through `repoAccessHandler`, the handler P5's control Worker mounts, with
 * grants read from KV that the test writes: `{ repos: [{ ...record, readers }] }`.
 */
import { repoAccessHandler, repoKey, type RepoRecord } from "../../src/repo-read/access";

type Grants = { repos: Array<RepoRecord & { readers: string[] }> };
interface Env { GRANTS: { get(key: string, type: "json"): Promise<Grants | null> } }

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return repoAccessHandler({
      async authorize(viewer, owner, name) {
        const grants = await env.GRANTS.get("grants", "json");
        const repo = grants?.repos.find(candidate => repoKey(candidate.owner, candidate.name) === repoKey(owner, name));
        if (!repo || (repo.private && (viewer === null || !repo.readers.includes(viewer)))) return null;
        const { readers: _readers, ...record } = repo;
        return record;
      },
    })(request);
  },
};
