/**
 * Conditional and ranged delivery of stored publisher objects (#94).
 *
 * Callers authorize and resolve the manifest entry first; nothing here reads
 * credentials or storage before `serveObject` is reached, so a 304, 206 or 416
 * is only ever produced for a caller that could already read the bytes.
 *
 * Validators: `"sha256-<manifest sha256>"` names the stored bytes and needs no
 * storage read. Bodies that are rewritten on the way out (HTML head injection)
 * are never byte-ranged and carry a validator only when their injected markup
 * is deterministic (see `transformedEtag`).
 *
 * Range: one `bytes` range (`a-b`, `a-`, `-n`). A syntactically invalid header,
 * another unit, or several ranges are ignored and answered with the full 200
 * (RFC 9110 §14.2 allows this and it bounds the work an attacker can request).
 * A valid but unsatisfiable range is 416. Range applies to GET only.
 */
import type { ObjectRange } from "@/minio";

export type ByteRange = { start: number; end: number };

const HEX64 = /^[a-f0-9]{64}$/;
/** A real single-range header is far shorter; longer ones are never parsed. */
const MAX_RANGE_HEADER = 128;
/** Bounds the entity-tag list scan for If-None-Match / If-Range. */
const MAX_VALIDATOR_HEADER = 2048;
/** Larger than any object, so an overflowing position still compares correctly. */
const HUGE = Number.MAX_SAFE_INTEGER;

/** Strong validator for stored bytes, or undefined when the manifest has no usable hash. */
export function contentEtag(sha256: unknown): string | undefined {
  return typeof sha256 === "string" && HEX64.test(sha256) ? `"sha256-${sha256}"` : undefined;
}

/** Stored byte length, or undefined for entries of old manifests that lack one. */
export function contentSize(size: unknown): number | undefined {
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

/** Validator for the head-injected representation: the source hash, the
 * injector version and a hash of the exact injected markup. */
export async function transformedEtag(sha256: unknown, injectorVersion: number, markup: string): Promise<string | undefined> {
  const source = contentEtag(sha256);
  if (!source) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markup));
  const tag = Array.from(new Uint8Array(digest).subarray(0, 12), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${source.slice(0, -1)}-i${injectorVersion}-${tag}"`;
}

/** Entity tags of a header value; malformed members are skipped. `*` is "*". */
function entityTags(value: string): Array<{ weak: boolean; tag: string } | "*"> {
  const tags: Array<{ weak: boolean; tag: string } | "*"> = [];
  const member = /[ \t]*(?:(\*)|(W\/)?("[\x21\x23-\x7e\x80-\xff]*"))[ \t]*(?:,|$)/y;
  let at = 0;
  while (at < value.length) {
    // A failed sticky match resets lastIndex, so the position is tracked here.
    member.lastIndex = at;
    const match = member.exec(value);
    if (match) {
      tags.push(match[1] ? "*" : { weak: Boolean(match[2]), tag: match[3] });
      at = member.lastIndex;
      continue;
    }
    // Resynchronize after a malformed member instead of rejecting the list.
    const comma = value.indexOf(",", at);
    if (comma === -1) break;
    at = comma + 1;
  }
  return tags;
}

/** If-None-Match uses weak comparison (RFC 9110 §13.1.2): `W/"x"` matches `"x"`. */
export function noneMatch(header: string | null, etag: string | undefined): boolean {
  if (header === null || header.length > MAX_VALIDATOR_HEADER) return false;
  return entityTags(header).some(entry => entry === "*" || (etag !== undefined && entry.tag === etag));
}

/** If-Range needs the strong comparison: a weak or date validator never matches. */
function ifRangeAllows(header: string | null, etag: string | undefined): boolean {
  if (header === null) return true;
  return etag !== undefined && header.trim() === etag;
}

function position(digits: string): number {
  // More than 15 digits exceeds any object; clamp rather than lose precision.
  return digits.length > 15 ? HUGE : Number(digits);
}

/** `null` ignores the header (serve everything); "unsatisfiable" is a 416. */
export function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (header === null || header.length > MAX_RANGE_HEADER) return null;
  const match = /^bytes[ \t]*=[ \t]*(\d*)[ \t]*-[ \t]*(\d*)[ \t]*$/i.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = position(match[2]);
    return suffix === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = position(match[1]);
  if (match[2] !== "" && position(match[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: match[2] === "" ? size - 1 : Math.min(position(match[2]), size - 1) };
}

export type Delivery = {
  request: Request;
  /** Every header of the full 200: type, nosniff, CSP, cache policy, … */
  headers: Record<string, string>;
  /** Quoted strong validator of the bytes sent. */
  etag?: string;
  /** Stored byte length; enables Content-Length and Range. */
  size?: number;
  /** Rewrites the body (HTML head injection): sent whole, never ranged. */
  transform?: (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
  /** Opens the stored bytes; `null` when storage has no such object. */
  open: (...range: [ObjectRange?]) => Promise<ReadableStream<Uint8Array> | null>;
  missing: () => Response;
};

/**
 * 304 → 416 → 206 → 200, in RFC 9110 §13.2.2 order, then stream from storage.
 * HEAD answers from metadata alone and never opens storage.
 */
export async function serveObject(delivery: Delivery): Promise<Response> {
  const { request, etag, size, transform } = delivery;
  const headers = new Headers(delivery.headers);
  if (etag) headers.set("ETag", etag);
  const rangeable = !transform && size !== undefined;
  if (rangeable) headers.set("Accept-Ranges", "bytes");
  else if (transform) headers.set("Accept-Ranges", "none");

  if (noneMatch(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  let range: ByteRange | "unsatisfiable" | null = null;
  if (request.method === "GET" && rangeable
    && ifRangeAllows(request.headers.get("If-Range"), etag)) {
    range = parseRange(request.headers.get("Range"), size);
  }
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }

  const length = range ? range.end - range.start + 1 : rangeable ? size : undefined;
  if (length !== undefined) headers.set("Content-Length", String(length));
  if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });

  const stream = await (range ? delivery.open({ ...range, size: size as number }) : delivery.open());
  if (!stream) return delivery.missing();
  return new Response(transform ? transform(stream) : stream, { status: range ? 206 : 200, headers });
}
