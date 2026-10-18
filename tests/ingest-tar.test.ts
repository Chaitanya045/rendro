import { describe, expect, it } from "vitest";
import { readTar, TarError, type TarEntry, type TarReadOptions } from "../src/ingest/github/tar";
import { githubArchive, paxRecord, streamOf, tarBytes, type TarItem } from "./helpers/tar-writer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const all: TarReadOptions = { want: () => true, maxEntryBytes: 1024 * 1024 };

async function read(data: Uint8Array, options: TarReadOptions = all, chunkSize?: number): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  for await (const entry of readTar(streamOf(data, chunkSize), options)) entries.push(entry);
  return entries;
}

function text(entry: TarEntry | undefined): string | null {
  return entry?.content ? decoder.decode(entry.content) : null;
}

describe("readTar", () => {
  it("reads a GitHub-style archive: global commit header, directories, files, symlinks", async () => {
    const commit = "c".repeat(40);
    const files = new Map<string, Uint8Array | { symlink: string }>([
      ["README.md", encoder.encode("# Hi\n")],
      ["docs/index.md", encoder.encode("x".repeat(1500))],
      ["docs/link.md", { symlink: "index.md" }],
    ]);
    let globals: ReadonlyMap<string, string> | null = null;
    const entries = await read(githubArchive("octo", "docs", commit, files), { ...all, onGlobalHeader: (attributes) => { globals = attributes; } }, 100);
    expect(globals).toEqual(new Map([["comment", commit]]));
    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["octo-docs-ccccccc/", "directory"],
      ["octo-docs-ccccccc/README.md", "file"],
      ["octo-docs-ccccccc/docs/", "directory"],
      ["octo-docs-ccccccc/docs/index.md", "file"],
      ["octo-docs-ccccccc/docs/link.md", "symlink"],
    ]);
    expect(text(entries[1])).toBe("# Hi\n");
    expect(entries[3].content?.length).toBe(1500);
    expect(entries[4].content).toBeNull();
  });

  it("applies pax paths and sizes, GNU long names and the ustar prefix", async () => {
    const long = `${"dir/".repeat(40)}file.md`;
    const pax = encoder.encode(paxRecord("path", "pax/renamed.md") + paxRecord("size", "3"));
    const archive = tarBytes([
      { path: long, content: "pax" },
      { path: `${"pre/".repeat(30)}prefixed.md`, content: "pre", usePrefix: true },
      { path: "././@LongLink", type: "L", content: `${long}-gnu\0` },
      { path: "short", content: "gnu" },
      { path: "././@LongLink", type: "K", content: "target\0" },
      { path: "link", type: "1", linkname: "short" },
      { path: "PaxHeader", type: "x", content: pax },
      { path: "ignored-name", content: "abc", sizeField: "00000000003\0" },
      { path: "contiguous", type: "7", content: "c" },
      { path: "fifo", type: "3" },
    ]);
    const entries = await read(archive);
    expect(entries.map((entry) => [entry.path, entry.type, text(entry)])).toEqual([
      [long, "file", "pax"],
      [`${"pre/".repeat(30)}prefixed.md`, "file", "pre"],
      [`${long}-gnu`, "file", "gnu"],
      ["link", "other", null],
      ["pax/renamed.md", "file", "abc"],
      ["contiguous", "file", "c"],
      ["fifo", "other", null],
    ]);
  });

  it("buffers only wanted entries within the size limit", async () => {
    const archive = tarBytes([{ path: "a", content: "1234" }, { path: "b", content: "12" }, { path: "c", content: "123456" }]);
    const seen: Array<[string, number]> = [];
    const entries = await read(archive, { maxEntryBytes: 5, want: (path, size) => { seen.push([path, size]); return path !== "b"; } });
    expect(entries.map(text)).toEqual(["1234", null, null]);
    // Oversized entries are skipped without asking.
    expect(seen).toEqual([["a", 4], ["b", 2]]);
  });

  it("reads names that fill their field and blank size fields", async () => {
    const name = "n".repeat(100);
    const entries = await read(tarBytes([{ path: name, content: "full" }, { path: "blank", sizeField: "           \0" }]));
    expect(entries.map((entry) => [entry.path, entry.size])).toEqual([[name, 4], ["blank", 0]]);
  });

  it("reads base-256 sizes, tolerates a missing end marker and old-style headers", async () => {
    const archive = tarBytes([{ path: "big", content: "xyz", base256Size: true }, { path: "old", content: "o", magic: "\0\0\0\0\0\0" }], { end: false });
    expect((await read(archive)).map(text)).toEqual(["xyz", "o"]);
  });

  it("stops at the end-of-archive block and cancels the rest of the stream", async () => {
    const archive = new Uint8Array([...tarBytes([{ path: "a", content: "1" }]), ...new Uint8Array(4096).fill(7)]);
    expect((await read(archive)).map((entry) => entry.path)).toEqual(["a"]);
  });

  it("ignores global headers nobody asked for, and a stream that fails to cancel", async () => {
    const data = tarBytes([{ path: "pax_global_header", type: "g", content: paxRecord("comment", "x") }, { path: "a", content: "1" }, { path: "b", content: "2" }]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(data); },
      cancel() { throw new Error("cannot cancel"); },
    });
    for await (const entry of readTar(stream, all)) {
      expect(entry.path).toBe("a");
      break;
    }
  });

  it("releases the stream when the caller stops early", async () => {
    let cancelled = false;
    const data = tarBytes([{ path: "a", content: "1" }, { path: "b", content: "2" }]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array()); controller.enqueue(data); },
      cancel() { cancelled = true; },
    });
    for await (const entry of readTar(stream, all)) {
      expect(entry.path).toBe("a");
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("rejects truncated and corrupt archives", async () => {
    const good = tarBytes([{ path: "a", content: "x".repeat(2000) }], { end: false });
    const cases: Array<[string, Uint8Array, TarReadOptions?]> = [
      ["body cut (buffered)", good.slice(0, 1000)],
      ["body cut (skipped)", good.slice(0, 1000), { want: () => false, maxEntryBytes: 10 }],
      ["meta cut", tarBytes([{ path: "PaxHeader", type: "x", content: paxRecord("path", "x".repeat(600)) }], { end: false }).slice(0, 700)],
      ["checksum", tarBytes([{ path: "a", content: "1", badChecksum: true }])],
      ["number", tarBytes([{ path: "a", content: "1", sizeField: "12z\0" }])],
      ["base-256 overflow", (() => { const bytes = tarBytes([{ path: "a", content: "1" }]); bytes.set(new Uint8Array(12).fill(0xff), 124); return fixChecksum(bytes); })()],
      ["oversized meta", tarBytes([{ path: "PaxHeader", type: "x", content: "1", sizeField: "77777777777\0" }])],
      ["pax size", paxThen(paxRecord("size", "-1"))],
      ["pax size empty", paxThen("9 size=\n")],
      ["pax size unsafe", paxThen(paxRecord("size", "9".repeat(20)))],
      ["pax length", paxThen("99 path=x\n")],
      ["pax no space", paxThen("12345678")],
      ["pax no newline", paxThen("10 path=xy")],
      ["pax no key", paxThen("7 =abc\n")],
      ["pax tiny length", paxThen("1 path=x\n")],
    ];
    for (const [name, data, options] of cases) {
      await expect(read(data, options), name).rejects.toBeInstanceOf(TarError);
    }
  });
});

function fixChecksum(archive: Uint8Array): Uint8Array {
  const block = archive.subarray(0, 512);
  for (let index = 148; index < 156; index += 1) block[index] = 0x20;
  let sum = 0;
  for (const byte of block) sum += byte;
  block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return archive;
}

function paxThen(record: string): Uint8Array {
  const items: TarItem[] = [{ path: "PaxHeader", type: "x", content: record }, { path: "a", content: "1" }];
  return tarBytes(items);
}
