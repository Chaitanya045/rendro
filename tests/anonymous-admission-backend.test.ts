import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { get } from "node:http";
import { build } from "esbuild";
import { Hono } from "hono";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { localHttp, startBackend } from "../e2e/backend";
import { anonymousAdmission } from "../src/middleware/anonymous-admission";
import { signAuthClientIp } from "../shared/auth-client-ip";

let backend: Awaited<ReturnType<typeof startBackend>>;
let directory: string;
const path = "/api/rendro/admission/public";
// Read the actual HTTP status, headers and body from the disposable backend.
function request(pathname: string, headers: Headers = new Headers()) {
  return new Promise<Response>((resolve, reject) => {
    const req = get(backend.site + pathname, { headers: Object.fromEntries(headers) }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode, headers: response.headers as Record<string, string>,
      })));
      response.on("error", reject);
    });
    req.setTimeout(15_000, () => req.destroy(new Error("Local admission request timed out")));
    req.on("error", reject);
  });
}
beforeAll(async () => {
  await mkdir("tmp", { recursive: true });
  directory = await mkdtemp(resolve("tmp/anonymous-admission-"));
  backend = await startBackend(directory);
}, 180_000);
afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await backend?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("accepts only the real pre-deploy no-route envelope, then admits concurrent reads on the deployed sharded limiter without OCC errors", async () => {
  // Old Convex has HTTP routes but no legacy admission endpoint.
  const bundle = await build({ stdin: { contents: 'import { httpRouter, httpActionGeneric } from "convex/server"; const http = httpRouter(); http.route({ path: "/existing", method: "GET", handler: httpActionGeneric(() => new Response("ok")) }); export default http;', resolveDir: process.cwd() }, bundle: true, format: "esm", platform: "browser", write: false });
  expect(JSON.parse((await localHttp(`${backend.origin}/api/push_config`, {
    adminKey: backend.adminKey, udfServerVersion: "1.42.0", config: { functions: "convex/", authInfo: [] },
    modules: [{ path: "http.js", environment: "isolate", source: bundle.outputFiles[0].text }],
  })).body)).toEqual({});
  const missing = await request(path);
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(await missing.text()).toBe("No matching routes found");
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => request(path, new Headers(init.headers))));
  const app = new Hono();
  app.use("*", anonymousAdmission);
  app.get("/public/test", c => c.text("authorized capability"));
  expect((await app.request("/public/test")).status).toBe(200);

  await backend.environment({ CONVEX_INTERNAL_SECRET: process.env.CONVEX_INTERNAL_SECRET! });
  await backend.push();
  expect((await app.request("/public/test")).status).toBe(200);
  const unverified = await Promise.all(Array.from({ length: 20 }, () => request(path)));
  expect(unverified.map(response => response.status)).toEqual(Array(20).fill(200));
  const headers = await signAuthClientIp(new Request(backend.site + path), "192.0.2.1", process.env.CONVEX_INTERNAL_SECRET!);
  // Includes first use of the expiry registry, then warm concurrent traffic.
  for (let batch = 0; batch < 3; batch++) {
    const responses = await Promise.all(Array.from({ length: 20 }, () => request(path, headers)));
    expect(responses.map(response => response.status)).toEqual(Array(20).fill(200));
    for (const response of responses) expect(await response.json()).toEqual({ admitted: true });
  }
}, 180_000);
