import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { localHttp, startBackend } from "../e2e/backend";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicErrorMessages } from "../src/shared/public-errors";

// Always executes against its own pinned disposable backend; no opt-in or credentials.
describe("isolated Convex RPC envelopes", () => {
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  let directory: string;
  let url: string;
  let legacy: { threadId: string; foreignThreadId: string; missingThreadId: string; foreignReplyId: string; missingReplyId: string };
  const localRequest = (path: string, body?: unknown) => localHttp(`${url}${path}`, body);
  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return JSON.parse((await localRequest(`/api/${path}`, body)).body) as Record<string, unknown>;
  }
  const rpc = (kind: string, name: string, args: unknown) => post(kind, { path: `probe:${name}`, args, format: "json" });
  const normalized = (envelope: unknown) => JSON.stringify(envelope).replace(/\[Request ID: [a-f0-9]+\]/g, "[Request ID: omitted]");
  function safeFailure(envelope: Record<string, unknown>, code: keyof typeof publicErrorMessages) {
    expect(envelope).toMatchObject({ status: "error", errorData: { code, message: publicErrorMessages[code] } });
    expect(envelope.errorMessage).toBe(`[Request ID: ${(envelope.errorMessage as string).match(/Request ID: ([a-f0-9]+)/)?.[1]}] Server Error\nUncaught ConvexError: ${publicErrorMessages[code]}\n`);
    expect(normalized(envelope)).not.toMatch(/\.ts:\d|\.js:\d| at |__frameData|stack|trace/);
  }

  beforeAll(async () => {
    await mkdir("tmp", { recursive: true });
    directory = await mkdtemp(resolve("tmp/public-rpc-"));
    backend = await startBackend(directory);
    url = backend.origin;
    const adminKey = backend.adminKey;
    const bundle = await build({
      entryPoints: ["tests/helpers/public-rpc-fixture.ts"], bundle: true, format: "esm", platform: "browser",
      write: false, outfile: "probe.js", sourcemap: "external",
    });
    // Load only this fixture into the disposable backend, with no app schema/data.
    const pushed = await post("push_config", {
      adminKey, udfServerVersion: "1.42.0", config: { functions: "convex/", authInfo: [] },
      modules: [{ path: "probe.js", environment: "isolate",
        source: bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text,
        sourceMap: bundle.outputFiles.find(file => file.path.endsWith(".map"))!.text }],
    });
    expect(pushed).toEqual({});
    const seeded = await rpc("mutation", "seed", {});
    expect(seeded).toMatchObject({ status: "success" });
    legacy = seeded.value as typeof legacy;
  }, 180_000);

  afterAll(async () => {
    await backend?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(["query", "mutation"])("%s envelopes are identical across reasons and call stacks for every expected code", async kind => {
    for (const code of Object.keys(publicErrorMessages) as (keyof typeof publicErrorMessages)[]) {
      const missing = await rpc(kind, `${kind}Failure`, { missing: true, code });
      const inaccessible = await rpc(kind, `${kind}Failure`, { missing: false, code });
      safeFailure(missing, code);
      safeFailure(inaccessible, code);
      expect(normalized(missing)).toBe(normalized(inaccessible));
    }
  });


  it.each(["threads:list", "threads:create", "threads:resolve", "threads:archive", "threads:remove", "replies:add", "replies:remove"])("%s actual legacy envelopes hide missing versus inaccessible records and server frames", async method => {
    const envelopes = [];
    for (const missing of [true, false]) {
      // List/create compare denied scopes. Unmapped legacy scopes use the same
      // opaque not_found contract as inaccessible records.
      const orgSlug = missing ? "missing-org" : "other";
      const result = method === "threads:list"
        ? await rpc("query", "legacyList", { orgSlug })
        : await rpc("mutation", "legacyMutation", {
          method, orgSlug,
          threadId: method === "replies:remove" ? legacy.threadId : missing ? legacy.missingThreadId : legacy.foreignThreadId,
          replyId: missing ? legacy.missingReplyId : legacy.foreignReplyId,
        });
      safeFailure(result, "not_found");
      envelopes.push(normalized(result));
    }
    expect(envelopes[0]).toBe(envelopes[1]);
  });

  it("retains diagnostic frames for unexpected errors after an expected error", async () => {
    const result = await rpc("query", "diagnostics", {});
    expect(result.errorMessage).toContain("Unexpected failure still has frames");
    expect(result.errorMessage).toMatch(/at handler .*public-rpc-fixture\.ts:\d/);
    expect(result).not.toHaveProperty("errorData");
  });

  it.each(["documentThreads", "documentReplies"])("%s rejects malformed and foreign cursor/endCursor values", async table => {
    const foreign = table === "documentThreads" ? "documentReplies" : "documentThreads";
    const first = await rpc("query", "page", { table, cursor: null });
    const other = await rpc("query", "page", { table: foreign, cursor: null });
    const validCursor = (first.value as { continueCursor: string }).continueCursor;
    expect(await rpc("query", "page", { table, cursor: validCursor })).toMatchObject({ status: "success" });
    for (const field of ["cursor", "endCursor"]) {
      for (const cursor of ["", " ", "malformed-cursor", "00", (other.value as { continueCursor: string }).continueCursor]) {
        const result = await rpc("query", "page", { table, cursor: null, [field]: cursor });
        safeFailure(result, "invalid_input");
      }
    }
  });
});
