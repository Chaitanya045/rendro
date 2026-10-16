import { assetContentType, encodingLabel } from "@/routes/asset-headers";

/** Extract the first charset assignment; malformed quotes cannot reveal a later one. */
function contentEncoding(value: string): string | undefined {
  const assignment = /charset[\t\n\f\r ]*=[\t\n\f\r ]*/i.exec(value);
  if (!assignment) return undefined;
  const start = assignment.index + assignment[0].length;
  const quote = value[start];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, start + 1);
    return end === -1 ? undefined : encodingLabel(value.slice(start + 1, end));
  }
  return encodingLabel(value.slice(start).split(/[\t\n\f\r ;]/, 1)[0]);
}

/** HTML's byte-prescan attribute tokenizer (no entity decoding). */
function nextAttribute(input: string, start: number): { position: number; name: string; value: string } {
  let position = start;
  while (position < input.length && /[\t\n\f\r /]/.test(input[position])) position++;
  let name = "";
  while (position < input.length && !/[\t\n\f\r />]/.test(input[position])) {
    if (input[position] === "=" && name) break;
    name += input[position++];
  }
  while (position < input.length && /[\t\n\f\r ]/.test(input[position])) position++;
  if (!name || input[position] !== "=") return { position, name: name.toLowerCase(), value: "" };
  position++;
  while (position < input.length && /[\t\n\f\r ]/.test(input[position])) position++;
  const quote = input[position];
  let value = "";
  if (quote === '"' || quote === "'") {
    position++;
    while (position < input.length && input[position] !== quote) value += input[position++];
    if (position < input.length) position++;
  } else {
    while (position < input.length && !/[\t\n\f\r >]/.test(input[position])) value += input[position++];
  }
  return { position, name: name.toLowerCase(), value: value.toLowerCase() };
}

// The prescan operates on bytes, not decoded HTML/entities or a DOM tree.
// https://html.spec.whatwg.org/multipage/parsing.html#prescan-a-byte-stream-to-determine-its-encoding
function htmlEncoding(input: string): string | undefined {
  if (input.startsWith("<\0?\0x\0")) return "utf-16le";
  if (input.startsWith("\0<\0?\0x")) return "utf-16be";
  let position = 0;
  while (position < input.length) {
    if (input.startsWith("<!--", position)) {
      const end = input.indexOf("-->", position + 2);
      position = end === -1 ? input.length : end + 3;
      continue;
    }
    const tag = /^<\/?([a-z][^\t\n\f\r >]*)/i.exec(input.slice(position));
    if (tag) {
      const meta = /^<meta[\t\n\f\r /]/i.test(input.slice(position));
      position += meta ? 5 : tag[0].length;
      const seen = new Set<string>();
      // null means absent; undefined is the Encoding Standard's failure.
      let charset: string | null | undefined = null;
      let gotPragma = false;
      let needPragma: boolean | null = null;
      while (position < input.length) {
        const attribute = nextAttribute(input, position);
        position = attribute.position;
        // Reaching the prescan byte limit aborts even a partially read attribute.
        if (position === input.length) return xmlEncoding(input);
        const { name, value } = attribute;
        if (!name) break;
        if (seen.has(name)) continue;
        seen.add(name);
        if (name === "http-equiv" && value === "content-type") gotPragma = true;
        if (name === "content" && charset === null) {
          const encoding = contentEncoding(value);
          if (encoding !== undefined) {
            charset = encoding;
            needPragma = true;
          }
        }
        if (name === "charset") {
          charset = encodingLabel(value);
          needPragma = false;
        }
      }
      // An absent charset also means needPragma is still null.
      if (meta && charset !== null && charset !== undefined && (!needPragma || gotPragma)) {
        if (charset === "utf-16le" || charset === "utf-16be") return "utf-8";
        return charset === "x-user-defined" ? "windows-1252" : charset;
      }
    } else if (/^<[!/?]/.test(input.slice(position))) {
      const end = input.indexOf(">", position + 2);
      position = end === -1 ? input.length : end;
    }
    position++;
  }
  return xmlEncoding(input);
}

/** HTML prescan fallback for a leading XML declaration (still text/html). */
function xmlEncoding(input: string): string | undefined {
  if (!input.startsWith("<?xml")) return undefined;
  const end = input.indexOf(">");
  if (end === -1) return undefined;
  const start = input.indexOf("encoding");
  if (start === -1 || start >= end) return undefined;
  // eslint-disable-next-line no-control-regex -- XML prescan specifies bytes <= 0x20.
  const value = /^[\x00-\x20]*=[\x00-\x20]*(["'])([^"']*)/.exec(input.slice(start + 8));
  if (!value || input[start + 8 + value[0].length] !== value[1]) return undefined;
  // eslint-disable-next-line no-control-regex -- XML prescan rejects space/control bytes in labels.
  if (/[\x00-\x20]/.test(value[2])) return undefined;
  const encoding = encodingLabel(value[2]);
  return encoding === "utf-16le" || encoding === "utf-16be" ? "utf-8" : encoding;
}

/** BOM > transport > in-band > CSS environment > UTF-8. Source is already bounded. */
export function decodeShareSource(bytes: Uint8Array, path: string, contentType: string, environment?: string): { text: string; encoding: string } {
  let encoding: string | undefined;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = "utf-8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  encoding ??= /; charset=(.*)$/.exec(assetContentType(path, contentType))?.[1];
  if (encoding === undefined) {
    // Latin-1 byte-to-code-point mapping preserves ASCII and does not interpret BOMs.
    const prefix = Array.from(bytes.subarray(0, 1024), byte => String.fromCharCode(byte)).join("");
    if (environment === undefined) encoding = htmlEncoding(prefix);
    else {
      // CSS Syntax's byte pattern is deliberately stricter than an at-rule.
      // eslint-disable-next-line no-control-regex -- CSS specifies this exact ASCII byte range.
      const declaration = /^@charset "([\x00-\x21\x23-\x7f]*)";/.exec(prefix);
      if (declaration) encoding = encodingLabel(declaration[1]);
      if (encoding === "utf-16le" || encoding === "utf-16be") encoding = "utf-8";
      encoding ??= environment;
    }
  }
  encoding ??= "utf-8";
  // WHATWG labels unsupported by this runtime must fail creation, never silently
  // discover paths in a different encoding from the browser's delivery decoder.
  const decoder = new TextDecoder(encoding);
  return { text: decoder.decode(bytes), encoding };
}
