import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minioSettings, seedMinio } from "../scripts/init-minio";
import { subprocessEnv } from "./helpers/subprocess-coverage";

const keys = ["acme-corp/index.html", "acme-corp/onboarding/index.html", "acme-corp/api/index.html", "startup-io/handbook.html"];

afterEach(() => vi.restoreAllMocks());

describe("MinIO settings", () => {
  it("defaults to the loopback development MinIO", () => {
    const { bucket, client } = minioSettings({});
    expect(bucket).toBe("docs");
    expect(client).toEqual({
      endpoint: "http://localhost:9000", region: "us-east-1", forcePathStyle: true,
      credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
    });
    expect(["localhost", "127.0.0.1"]).toContain(new URL(client.endpoint).hostname);
  });

  it("takes every setting from MINIO_* variables", () => {
    expect(minioSettings({
      MINIO_ENDPOINT: "http://127.0.0.1:1", MINIO_REGION: "eu-test-1", MINIO_BUCKET: "other",
      MINIO_ACCESS_KEY: "access", MINIO_SECRET_KEY: "secret",
    })).toEqual({
      bucket: "other",
      client: { endpoint: "http://127.0.0.1:1", region: "eu-test-1", forcePathStyle: true, credentials: { accessKeyId: "access", secretAccessKey: "secret" } },
    });
  });
});

describe("MinIO seeding", () => {
  function fakeClient(headFails: boolean, createFails = false) {
    const commands: unknown[] = [];
    const send = vi.fn((command: unknown) => {
      commands.push(command);
      if (command instanceof HeadBucketCommand && headFails) return Promise.reject(new Error("NotFound"));
      if (command instanceof CreateBucketCommand && createFails) return Promise.reject(new Error("AccessDenied"));
      return Promise.resolve({});
    });
    return { client: { send } as unknown as Parameters<typeof seedMinio>[0], commands };
  }

  it("seeds four legacy pages into an existing bucket without recreating it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { client, commands } = fakeClient(false);
    await seedMinio(client, "docs");
    expect(commands.filter(command => command instanceof CreateBucketCommand)).toHaveLength(0);
    const puts = commands.filter((command): command is PutObjectCommand => command instanceof PutObjectCommand);
    expect(puts.map(put => put.input.Key)).toEqual(keys);
    expect(puts.every(put => put.input.Bucket === "docs" && put.input.ContentType === "text/html")).toBe(true);
    expect(puts[0].input.Body as string).toContain("<title>Acme Corp — Home</title>");
    expect(log.mock.calls.flat().join("\n")).toContain('Bucket "docs" already exists.');
    expect(log.mock.calls.flat().join("\n")).toContain("Done! Seeded 4 documents.");
  });

  it("creates a missing bucket before seeding it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { client, commands } = fakeClient(true);
    await seedMinio(client, "fresh");
    expect(commands.map(command => (command as object).constructor.name).slice(0, 2)).toEqual(["HeadBucketCommand", "CreateBucketCommand"]);
    expect(log.mock.calls.flat().join("\n")).toContain('Created bucket "fresh".');
  });

  it("stops without seeding when the bucket can be neither found nor created", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { client, commands } = fakeClient(true, true);
    await expect(seedMinio(client, "docs")).rejects.toThrow("AccessDenied");
    expect(commands.some(command => command instanceof PutObjectCommand)).toBe(false);
  });
});

describe("init-minio entry point", () => {
  async function run(handler: (method: string, path: string) => number) {
    const requests: Array<{ method: string; path: string; contentType?: string }> = [];
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requests.push({ method: request.method!, path: request.url!, contentType: request.headers["content-type"] });
        response.writeHead(handler(request.method!, request.url!), { "Content-Type": "application/xml" }).end();
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const env = subprocessEnv({ ...process.env, MINIO_ENDPOINT: endpoint, MINIO_BUCKET: "fixture", MINIO_ACCESS_KEY: "fixture", MINIO_SECRET_KEY: "fixture" });
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", resolve("scripts/init-minio.ts")], { env, timeout: 20_000 })
        .then(output => ({ ...output, code: 0 }), (error: { code: number; stdout: string; stderr: string }) => error);
      return { ...result, requests };
    } finally {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
  }

  it("creates the bucket and uploads the pages, talking only to the configured loopback endpoint", async () => {
    const result = await run(method => method === "HEAD" ? 404 : 200);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Created bucket "fixture".');
    expect(result.stdout).toContain("Done! Seeded 4 documents.");
    expect(result.requests.map(({ method, path }) => `${method} ${new URL(path, "http://fixture.invalid").pathname}`)).toEqual([
      "HEAD /fixture/", "PUT /fixture/", ...keys.map(key => `PUT /fixture/${key}`),
    ]);
    expect(result.requests.slice(2).every(request => request.contentType === "text/html")).toBe(true);
  });

  it("exits 1 and reports the error when the endpoint refuses to create the bucket", async () => {
    const result = await run(method => method === "HEAD" ? 404 : 403);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe("");
    expect(result.stdout).not.toContain("Done!");
    expect(result.requests.map(request => request.method)).toEqual(["HEAD", "PUT"]);
  });
});
