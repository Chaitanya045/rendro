import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { StorageBucket } from "../../src/storage";

/** The same R2 simulation `wrangler dev` and the E2E suite use (Miniflare, in memory), via the production wrangler.toml. */
export async function r2Simulation(persistDirectory?: string): Promise<{ bucket: StorageBucket; dispose(): Promise<void> }> {
  const proxy = await getPlatformProxy<{ STORAGE: StorageBucket }>({
    configPath: fileURLToPath(new URL("../../wrangler.toml", import.meta.url)), persist: persistDirectory ? { path: persistDirectory } : false,
  });
  return { bucket: proxy.env.STORAGE, dispose: () => proxy.dispose() };
}
