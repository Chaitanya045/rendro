import { readFile } from "node:fs/promises";
import type { Handler } from "hono";
import { fontResponseHeaders } from "@/routes/fonts";

/** Serves the committed self-hosted fonts exactly as production does, for browser-test fixture apps. */
export const serveFonts: Handler = async c => {
  const headers = fontResponseHeaders(c.req.path);
  if (!headers) return c.body(null, 404);
  const bytes = await readFile(`public${c.req.path}`).catch(() => undefined);
  return bytes ? c.body(new Uint8Array(bytes), 200, headers) : c.body(null, 404);
};
