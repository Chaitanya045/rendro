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
  it("creates, lists, and removes project publications through the management API", async () => {
    const requests: CapturedRequest[] = [];
    const publication = {
      _id: "publication-a",
      slug: "product",
      title: "Product documentation",
      trackingMode: "track_active",
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
        if (request.url === "/api/rendro/publications" && request.method === "POST") {
          response.end(JSON.stringify({ publication, url: "/p/product" }));
        } else if (request.method === "GET") {
          response.end(JSON.stringify({ publications: [publication] }));
        } else {
          response.end(JSON.stringify({ removed: true }));
        }
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

      const created = await run([
        "publication", "create",
        "--organization", "org-a",
        "--project", "project-a",
        "--path", "product",
        "--slug", "product",
        "--title", "Product documentation",
      ]);
      expect(created.stdout).toContain("/p/product");

      const listed = await run([
        "publication", "list",
        "--organization", "org-a",
        "--project", "project-a",
      ]);
      expect(listed.stdout).toContain("publication-a  product  track_active");

      const removed = await run([
        "publication", "remove",
        "--organization", "org-a",
        "--project", "project-a",
        "--id", "publication-a",
      ]);
      expect(removed.stdout).toContain("Removed publication publication-a");

      expect(requests).toEqual([
        {
          method: "POST",
          path: "/api/rendro/publications",
          body: {
            organizationId: "org-a",
            projectId: "project-a",
            slug: "product",
            pathPrefix: "product",
            entryFile: "index.html",
            title: "Product documentation",
            trackingMode: "track_active",
          },
        },
        {
          method: "GET",
          path: "/api/rendro/publications?organizationId=org-a&projectId=project-a",
          body: null,
        },
        {
          method: "POST",
          path: "/api/rendro/publications/remove",
          body: { organizationId: "org-a", projectId: "project-a", publicationId: "publication-a" },
        },
      ]);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  });
});
