import { gzipSync } from "node:zlib";

/** Builds tar archives the way `git archive` (and so GitHub's tarball endpoint) does. */
export interface TarItem {
  path: string;
  type?: "0" | "2" | "5" | "1" | "x" | "g" | "L" | "K" | "7" | "3";
  content?: Uint8Array | string;
  linkname?: string;
  /** Write the path in the ustar prefix field instead of a pax header when it is too long. */
  usePrefix?: boolean;
  /** Override the header's size field (to build broken archives). */
  sizeField?: string;
  base256Size?: boolean;
  badChecksum?: boolean;
  magic?: string;
}

const encoder = new TextEncoder();

function bytes(content: Uint8Array | string | undefined): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content ?? new Uint8Array();
}

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  block.set(encoder.encode(value).subarray(0, length), offset);
}

export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

export function header(item: TarItem, size: number): Uint8Array {
  const block = new Uint8Array(512);
  let name = item.path;
  let prefix = "";
  if (item.usePrefix && encoder.encode(name).length > 100) {
    const cut = name.lastIndexOf("/", name.length - 1);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  writeString(block, 0, 100, name);
  writeString(block, 100, 8, "0000644\0");
  writeString(block, 108, 8, "0000000\0");
  writeString(block, 116, 8, "0000000\0");
  if (item.base256Size) {
    block[124] = 0x80;
    let value = size;
    for (let index = 135; index > 124; index -= 1) {
      block[index] = value % 256;
      value = Math.floor(value / 256);
    }
  } else {
    writeString(block, 124, 12, item.sizeField ?? `${size.toString(8).padStart(11, "0")}\0`);
  }
  writeString(block, 136, 12, "00000000000\0");
  block[156] = (item.type ?? "0").charCodeAt(0);
  writeString(block, 157, 100, item.linkname ?? "");
  writeString(block, 257, 6, item.magic ?? "ustar\0");
  writeString(block, 263, 2, "00");
  writeString(block, 345, 155, prefix);
  for (let index = 148; index < 156; index += 1) block[index] = 0x20;
  let sum = 0;
  for (const byte of block) sum += byte;
  if (item.badChecksum) sum += 1;
  writeString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padded(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(content.length / 512) * 512);
  out.set(content);
  return out;
}

/** Raw tar bytes. Long paths get pax headers unless the item asks for the ustar prefix. */
export function tarBytes(items: readonly TarItem[], { end = true }: { end?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const item of items) {
    const content = bytes(item.content);
    if (!item.usePrefix && encoder.encode(item.path).length > 100 && !["x", "g", "L", "K"].includes(item.type ?? "0")) {
      const pax = encoder.encode(paxRecord("path", item.path));
      parts.push(header({ path: "PaxHeader", type: "x" }, pax.length), padded(pax));
    }
    parts.push(header(item, content.length), padded(content));
  }
  if (end) parts.push(new Uint8Array(1024));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A GitHub-style commit archive: pax global header with the commit ID, then "<owner>-<repo>-<sha7>/" entries. */
export function githubArchive(owner: string, repo: string, commit: string, files: ReadonlyMap<string, Uint8Array | { symlink: string }>): Uint8Array {
  const top = `${owner}-${repo}-${commit.slice(0, 7)}`;
  const items: TarItem[] = [
    { path: "pax_global_header", type: "g", content: paxRecord("comment", commit) },
    { path: `${top}/`, type: "5" },
  ];
  const directories = new Set<string>();
  for (const path of [...files.keys()].sort()) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join("/");
      if (!directories.has(directory)) {
        directories.add(directory);
        items.push({ path: `${top}/${directory}/`, type: "5" });
      }
    }
    const file = files.get(path) as Uint8Array | { symlink: string };
    items.push(file instanceof Uint8Array ? { path: `${top}/${path}`, content: file } : { path: `${top}/${path}`, type: "2", linkname: file.symlink });
  }
  return tarBytes(items);
}

export function gzip(data: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(data));
}

export function streamOf(data: Uint8Array, chunkSize = 777): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}
