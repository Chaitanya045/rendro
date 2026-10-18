import { readFile } from "node:fs/promises";
import type { Handler } from "hono";
import { styleResponseHeaders } from "@/routes/styles";

/** Serves the committed hashed stylesheets exactly as production does, for browser-test fixture apps. */
export const serveStyles: Handler = async c => {
  const headers = styleResponseHeaders(c.req.path);
  if (!headers) return c.body(null, 404);
  const bytes = await readFile(`public${c.req.path}`).catch(() => undefined);
  return bytes ? c.body(new Uint8Array(bytes), 200, headers) : c.body(null, 404);
};
