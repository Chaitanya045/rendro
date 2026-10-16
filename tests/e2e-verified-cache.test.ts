import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { verifiedArchive } from "../e2e/verified-cache";

const directories: string[] = [];
const valid = Buffer.from("pinned archive fixture");
const checksum = createHash("sha256").update(valid).digest("hex");
async function cache() {
  const directory = await mkdtemp(join(tmpdir(), "rendro-cache-test-"));
  directories.push(directory);
  return { directory, path: join(directory, "backend.zip") };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
it.each(["missing", "tampered", "partial"])("repairs a %s cache without executing it", async state => {
  const { directory, path } = await cache();
  if (state !== "missing") await writeFile(path, state === "tampered" ? "arbitrary bytes" : valid.subarray(0, 5));
  const download = vi.fn(async (temporary: string) => { await writeFile(temporary, valid); });
  expect(await verifiedArchive(path, checksum, download)).toEqual(valid);
  expect(download).toHaveBeenCalledOnce();
  expect(await readFile(path)).toEqual(valid);
  expect(await readdir(directory)).toEqual(["backend.zip"]);
  expect(await verifiedArchive(path, checksum, download)).toEqual(valid);
  expect(download).toHaveBeenCalledOnce();
  // Revalidate even after a successful hit in this process.
  await writeFile(path, "later corruption");
  expect(await verifiedArchive(path, checksum, download)).toEqual(valid);
  expect(download).toHaveBeenCalledTimes(2);
});
it.each(["invalid", "interrupted"])("rejects an %s download and removes staging", async state => {
  const { directory, path } = await cache();
  await expect(verifiedArchive(path, checksum, async temporary => {
    await writeFile(temporary, "partial");
    if (state === "interrupted") throw new Error("connection interrupted");
  })).rejects.toThrow(state === "invalid" ? "checksum mismatch" : "connection interrupted");
  expect(await readdir(directory)).toEqual([]);
});
it("does not treat unreadable cache entries as a miss", async () => {
  const { directory } = await cache();
  await expect(verifiedArchive(directory, checksum, vi.fn())).rejects.toMatchObject({ code: "EISDIR" });
});
it("publishes concurrent downloads atomically and keeps readers on verified bytes", async () => {
  const { directory, path } = await cache();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = verifiedArchive(path, checksum, async temporary => {
    await writeFile(temporary, valid.subarray(0, 5));
    entered();
    await gate;
    await writeFile(temporary, valid);
  });
  await started;
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  const second = await verifiedArchive(path, checksum, async temporary => { await writeFile(temporary, valid); });
  expect(second).toEqual(valid);
  const hit = await verifiedArchive(path, checksum, () => Promise.reject(new Error("unexpected download")));
  release();
  expect(await first).toEqual(valid);
  await writeFile(path, "tampered after read");
  expect(hit).toEqual(valid);
  expect(await readdir(directory)).toEqual(["backend.zip"]);
});

it("registers staging for interrupted-run recovery before downloading", async () => {
  const { directory, path } = await cache();
  const tracked: string[] = [];
  await verifiedArchive(path, checksum, async temporary => {
    expect(temporary.startsWith(`${tracked[0]}/`)).toBe(true);
    await writeFile(temporary, valid);
  }, temporary => { tracked.push(temporary); });
  expect(tracked).toHaveLength(1);
  expect(await readdir(directory)).toEqual(["backend.zip"]);
  await rm(path);
  await expect(verifiedArchive(path, checksum, vi.fn(), () => { throw new Error("already torn down"); })).rejects.toThrow("already torn down");
  expect(await readdir(directory)).toEqual([]);
});
