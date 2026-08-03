import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

describe("publication CLI", () => {
  it("publishes, lists, and unpublishes through the management API", async () => {
    const requests: CapturedRequest[] = [];
    const publication = {
      orgSlug: "acme",
      slug: "product",
      sourcePrefix: "acme/repo/product/",
      title: "Product documentation",
      entryFile: "index.html",
      enabled: true,
      url: "http://example.test/public/acme/product",
    };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          body: rawBody ? JSON.parse(rawBody) as unknown : null,
        });
        response.setHeader("Content-Type", "application/json");
        if (request.method === "POST") response.end(JSON.stringify(publication));
        else if (request.method === "GET") response.end(JSON.stringify({ publications: [publication] }));
        else response.end(JSON.stringify({ unpublished: true, slug: "product" }));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

    try {
      const address = server.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${address.port}`;
      const run = (args: string[]) => execFileAsync(
        resolve("node_modules/.bin/tsx"),
        ["cli/src/index.ts", ...args, "--endpoint", endpoint],
        { env: { ...process.env, RENDRO_API_KEY: "rendro_test" } },
      );

      const published = await run([
        "publish",
        "--org", "acme",
        "--repo", "repo",
        "--folder", "product",
        "--slug", "product",
        "--title", "Product documentation",
      ]);
      expect(published.stdout).toContain("http://example.test/public/acme/product");

      const listed = await run(["publications", "--org", "acme"]);
      expect(listed.stdout).toContain("acme/repo/product/ → index.html");

      const unpublished = await run(["unpublish", "--org", "acme", "--slug", "product"]);
      expect(unpublished.stdout).toContain("Unpublished product");

      expect(requests).toEqual([
        {
          method: "POST",
          path: "/api/publications",
          body: {
            sourcePrefix: "acme/repo/product/",
            slug: "product",
            title: "Product documentation",
            entryFile: "index.html",
          },
        },
        { method: "GET", path: "/api/publications", body: null },
        { method: "DELETE", path: "/api/publications/product", body: null },
      ]);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  });
});
