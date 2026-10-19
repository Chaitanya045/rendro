/**
 * A benchmark Worker for tests/repo-lifecycle-workerd.test.ts (#263): runs the
 * content sealer `n` times inside workerd, so the test can time seal and open
 * per object from outside (workerd's clocks do not advance during compute).
 * TESTS ONLY: never deployed.
 */
import { blobKey } from "../../src/ingest/orchestrator/keys";
import { envelopeSealer } from "../../src/ingest/orchestrator/sealing";

export default {
  async fetch(request: Request, env: { REPO_CONTENT_KEY: string }): Promise<Response> {
    const url = new URL(request.url);
    const n = Number(url.searchParams.get("n"));
    const size = Number(url.searchParams.get("size"));
    const sealer = envelopeSealer(env.REPO_CONTENT_KEY);
    const scope = { repoId: 1, key: blobKey(1, "a".repeat(40)) };
    const plaintext = new Uint8Array(size).fill(7);
    // Sealing once also derives and caches the repository's key: the loop measures the per-object work only.
    const sealed = await sealer.seal(scope, plaintext);
    let bytes = 0;
    for (let index = 0; index < n; index += 1) {
      bytes += (url.searchParams.get("op") === "seal" ? await sealer.seal(scope, plaintext) : await sealer.open(scope, sealed)).byteLength;
    }
    return Response.json({ n, bytes });
  },
};
