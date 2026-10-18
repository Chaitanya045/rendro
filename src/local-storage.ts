import { fileURLToPath } from "node:url";
import { bindStorage, STORAGE_BINDING } from "@/storage-binding";

/**
 * The local Node server has no Worker environment, so it borrows the R2 simulation that `wrangler dev`
 * uses (Miniflare, persisted under `.wrangler/state`, shared with `wrangler dev`). Nothing here talks to
 * Cloudflare, and there is no access key to configure. `RENDRO_LOCAL_STATE_DIR` keeps the state elsewhere
 * (for example a scratch directory that a test seeds first).
 */
export async function bindLocalStorage(): Promise<() => Promise<void>> {
  const { getPlatformProxy } = await import("wrangler");
  const state = process.env.RENDRO_LOCAL_STATE_DIR;
  const proxy = await getPlatformProxy({
    configPath: fileURLToPath(new URL("../wrangler.toml", import.meta.url)),
    ...(state ? { persist: { path: state } } : {}),
  });
  bindStorage(proxy.env[STORAGE_BINDING]);
  return () => proxy.dispose();
}
