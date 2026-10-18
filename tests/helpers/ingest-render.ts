import type { RenderOptions } from "../../src/ingest/render";

/** The image proxy secret every ingest test signs with (tests/setup.ts sets the Worker's to the same value). */
export const TEST_RENDER_OPTIONS: RenderOptions = { imageProxySecret: process.env.IMAGE_PROXY_SECRET as string };
