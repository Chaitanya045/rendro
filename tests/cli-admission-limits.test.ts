import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCliPush } from "./helpers/cli-push";
import { MAX_FILE_BYTES } from "../shared/deployment-limits";
const roots: string[] = [];
async function root() { const dir = await mkdtemp(join(tmpdir(), "rendro-limit-")); roots.push(dir); return dir; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it("fails before network access for file count, per-file bytes, total bytes and path length", async () => {
  const count = await root();
  await Promise.all(Array.from({ length: 1001 }, (_, i) => writeFile(join(count, `${i}.txt`), "")));
  const large = await root();
  await writeFile(join(large, "large.bin"), ""); await truncate(join(large, "large.bin"), MAX_FILE_BYTES + 1);
  const total = await root();
  for (let i = 0; i < 17; i++) { const path = join(total, `${i}.bin`); await writeFile(path, ""); await truncate(path, MAX_FILE_BYTES); }
  const long = await root();
  const nested = join(long, ...Array.from({ length: 6 }, () => "x".repeat(180)));
  await mkdir(nested, { recursive: true }); await writeFile(join(nested, "a.txt"), "a");
  for (const [dir, message] of [[count, "1,000-file"], [large, "8 MiB"], [total, "128 MiB"], [long, "1024 characters"]]) {
    const result = await captureCliPush(dir).catch((e: unknown) => e) as { requests: string[]; stderr: string };
    expect(result.requests).toEqual([]);
    expect(result.stderr).toContain(message);
  }
}, 30_000);
it.each([MAX_FILE_BYTES - 1, MAX_FILE_BYTES])("accepts a %s-byte file through the actual CLI", async size => {
  const dir = await root(); await writeFile(join(dir, "file.bin"), ""); await truncate(join(dir, "file.bin"), size);
  const result = await captureCliPush(dir);
  expect(result.manifest.files[0].size).toBe(size);
  expect(result.commits).toBe(1);
}, 30_000);
