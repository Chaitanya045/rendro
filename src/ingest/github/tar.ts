/**
 * Streaming reader for the tar archives GitHub serves (`git archive` output:
 * ustar headers, a pax global header carrying the commit ID, and pax extended
 * headers for long paths). Content is buffered only for entries the caller
 * asks for; everything else is skipped as it streams past, so memory stays
 * bounded by the largest wanted entry rather than the archive.
 */

export interface TarEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  /** The entry's bytes when `want` accepted it, otherwise null. */
  content: Uint8Array | null;
}

export interface TarReadOptions {
  /** Whether to buffer this entry's content. Entries larger than maxEntryBytes are never buffered. */
  want(path: string, size: number): boolean;
  maxEntryBytes: number;
  /** Receives pax global attributes; for GitHub archives `comment` is the commit ID. */
  onGlobalHeader?(attributes: ReadonlyMap<string, string>): void;
}

export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TarError";
  }
}

const BLOCK = 512;
/** pax and GNU long-name records are metadata; anything this large is not a git archive. */
const MAX_META_BYTES = 1024 * 1024;
const decoder = new TextDecoder();

export async function* readTar(stream: ReadableStream<Uint8Array>, options: TarReadOptions): AsyncGenerator<TarEntry> {
  const input = new ByteQueue(stream.getReader());
  let pax = new Map<string, string>();
  let longName: string | null = null;
  try {
    for (;;) {
      const header = await input.read(BLOCK);
      if (!header) return; // Some writers omit the end-of-archive blocks.
      if (header.every((byte) => byte === 0)) return;
      verifyChecksum(header);
      const typeflag = String.fromCharCode(header[156]);
      const headerSize = parseNumber(header.subarray(124, 136));

      if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
        if (headerSize > MAX_META_BYTES) throw new TarError("Oversized tar metadata entry");
        const body = await input.read(Math.ceil(headerSize / BLOCK) * BLOCK);
        if (!body) throw new TarError("Truncated tar archive");
        const data = body.subarray(0, headerSize);
        if (typeflag === "x") pax = parsePax(data);
        else if (typeflag === "g") options.onGlobalHeader?.(parsePax(data));
        else if (typeflag === "L") longName = cString(data);
        // "K" (GNU long link name) only matters for links, which ingest never follows.
        continue;
      }

      const size = pax.has("size") ? paxSize(pax.get("size")) : headerSize;
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      const path = pax.get("path") ?? longName ?? headerPath(header);
      pax = new Map();
      longName = null;
      const type = typeflag === "0" || typeflag === "\0" || typeflag === "7" ? "file"
        : typeflag === "5" ? "directory" : typeflag === "2" ? "symlink" : "other";
      let content: Uint8Array | null = null;
      if (type === "file" && size <= options.maxEntryBytes && options.want(path, size)) {
        const body = await input.read(padded);
        if (!body) throw new TarError("Truncated tar archive");
        content = body.slice(0, size);
      } else if (!await input.skip(padded)) {
        throw new TarError("Truncated tar archive");
      }
      yield { path, type, size, content };
    }
  } finally {
    await input.close();
  }
}

function verifyChecksum(header: Uint8Array): void {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  if (parseNumber(header.subarray(148, 156)) !== sum) throw new TarError("Bad tar header checksum");
}

/** Octal ASCII, or the GNU base-256 form (high bit set) used for sizes over 8 GiB. */
function parseNumber(field: Uint8Array): number {
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) throw new TarError("Tar number out of range");
    return value;
  }
  const text = cString(field).trim();
  if (!/^[0-7]*$/.test(text)) throw new TarError("Bad tar number");
  return text === "" ? 0 : parseInt(text, 8);
}

function paxSize(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new TarError("Bad pax size");
  return Number(value);
}

function headerPath(header: Uint8Array): string {
  const name = cString(header.subarray(0, 100));
  const ustar = cString(header.subarray(257, 263)) === "ustar";
  const prefix = ustar ? cString(header.subarray(345, 500)) : "";
  return prefix ? `${prefix}/${name}` : name;
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** pax records are "<length> <key>=<value>\n", where length counts the whole record in bytes. */
function parsePax(data: Uint8Array): Map<string, string> {
  const attributes = new Map<string, string>();
  let offset = 0;
  while (offset < data.byteLength) {
    const space = data.indexOf(0x20, offset);
    const length = space === -1 ? NaN : Number(decoder.decode(data.subarray(offset, space)));
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > data.byteLength || data[offset + length - 1] !== 0x0a) {
      throw new TarError("Bad pax record");
    }
    const record = decoder.decode(data.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals <= 0) throw new TarError("Bad pax record");
    attributes.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return attributes;
}

/** A pull-based byte buffer over a stream reader. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** Exactly `length` bytes, or null at a clean or premature end of input. */
  async read(length: number): Promise<Uint8Array | null> {
    while (this.buffered < length && !this.done) await this.pull();
    if (this.buffered < length) return null;
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const chunk = this.chunks[0];
      const take = Math.min(chunk.byteLength, length - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.byteLength) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(take);
    }
    this.buffered -= length;
    return out;
  }

  /** Discard `length` bytes without retaining them. False if the input ended first. */
  async skip(length: number): Promise<boolean> {
    let remaining = length;
    for (;;) {
      while (remaining > 0 && this.chunks.length > 0) {
        const chunk = this.chunks[0];
        const take = Math.min(chunk.byteLength, remaining);
        remaining -= take;
        this.buffered -= take;
        if (take === chunk.byteLength) this.chunks.shift();
        else this.chunks[0] = chunk.subarray(take);
      }
      if (remaining === 0) return true;
      if (this.done) return false;
      await this.pull();
    }
  }

  async close(): Promise<void> {
    if (!this.done) await this.reader.cancel().catch(() => {});
    this.reader.releaseLock();
  }

  private async pull(): Promise<void> {
    const result = await this.reader.read();
    if (result.done) {
      this.done = true;
      return;
    }
    if (result.value.byteLength === 0) return;
    this.chunks.push(result.value);
    this.buffered += result.value.byteLength;
  }
}
