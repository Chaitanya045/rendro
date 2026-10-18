import { imageProxyRewriter } from "../../src/image-proxy";
import type { RenderOptions } from "../../src/ingest/render";

/** The image proxy secret every ingest test signs with (tests/setup.ts sets the Worker's to the same value). */
export const TEST_IMAGE_PROXY_SECRET = process.env.IMAGE_PROXY_SECRET as string;
/** Render options as the ingest Worker sets them: external images through the image proxy hook. */
export const TEST_RENDER_OPTIONS: RenderOptions = { rewriteImageUrl: imageProxyRewriter(TEST_IMAGE_PROXY_SECRET) };
