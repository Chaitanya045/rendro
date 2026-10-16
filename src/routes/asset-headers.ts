import type { Context } from "hono";
import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status";

const fontTypes: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
};

const assetTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

// WHATWG Encoding labels, https://encoding.spec.whatwg.org/encodings.json.
// Keep an explicit allowlist: runtime TextDecoder support differs across hosts.
const encodingLabels = new Map([
  ["utf-8", "unicode-1-1-utf-8 unicode11utf8 unicode20utf8 utf-8 utf8 x-unicode20utf8"],
  ["ibm866", "866 cp866 csibm866 ibm866"],
  ["iso-8859-2", "csisolatin2 iso-8859-2 iso-ir-101 iso8859-2 iso88592 iso_8859-2 iso_8859-2:1987 l2 latin2"],
  ["iso-8859-3", "csisolatin3 iso-8859-3 iso-ir-109 iso8859-3 iso88593 iso_8859-3 iso_8859-3:1988 l3 latin3"],
  ["iso-8859-4", "csisolatin4 iso-8859-4 iso-ir-110 iso8859-4 iso88594 iso_8859-4 iso_8859-4:1988 l4 latin4"],
  ["iso-8859-5", "csisolatincyrillic cyrillic iso-8859-5 iso-ir-144 iso8859-5 iso88595 iso_8859-5 iso_8859-5:1988"],
  ["iso-8859-6", "arabic asmo-708 csiso88596e csiso88596i csisolatinarabic ecma-114 iso-8859-6 iso-8859-6-e iso-8859-6-i iso-ir-127 iso8859-6 iso88596 iso_8859-6 iso_8859-6:1987"],
  ["iso-8859-7", "csisolatingreek ecma-118 elot_928 greek greek8 iso-8859-7 iso-ir-126 iso8859-7 iso88597 iso_8859-7 iso_8859-7:1987 sun_eu_greek"],
  ["iso-8859-8", "csiso88598e csisolatinhebrew hebrew iso-8859-8 iso-8859-8-e iso-ir-138 iso8859-8 iso88598 iso_8859-8 iso_8859-8:1988 visual"],
  ["iso-8859-8-i", "csiso88598i iso-8859-8-i logical"],
  ["iso-8859-10", "csisolatin6 iso-8859-10 iso-ir-157 iso8859-10 iso885910 l6 latin6"],
  ["iso-8859-13", "iso-8859-13 iso8859-13 iso885913"],
  ["iso-8859-14", "iso-8859-14 iso8859-14 iso885914"],
  ["iso-8859-15", "csisolatin9 iso-8859-15 iso8859-15 iso885915 iso_8859-15 l9"],
  ["iso-8859-16", "iso-8859-16"],
  ["koi8-r", "cskoi8r koi koi8 koi8-r koi8_r"],
  ["koi8-u", "koi8-ru koi8-u"],
  ["macintosh", "csmacintosh mac macintosh x-mac-roman"],
  ["windows-874", "dos-874 iso-8859-11 iso8859-11 iso885911 tis-620 windows-874"],
  ["windows-1250", "cp1250 windows-1250 x-cp1250"],
  ["windows-1251", "cp1251 windows-1251 x-cp1251"],
  ["windows-1252", "ansi_x3.4-1968 ascii cp1252 cp819 csisolatin1 ibm819 iso-8859-1 iso-ir-100 iso8859-1 iso88591 iso_8859-1 iso_8859-1:1987 l1 latin1 us-ascii windows-1252 x-cp1252"],
  ["windows-1253", "cp1253 windows-1253 x-cp1253"],
  ["windows-1254", "cp1254 csisolatin5 iso-8859-9 iso-ir-148 iso8859-9 iso88599 iso_8859-9 iso_8859-9:1989 l5 latin5 windows-1254 x-cp1254"],
  ["windows-1255", "cp1255 windows-1255 x-cp1255"],
  ["windows-1256", "cp1256 windows-1256 x-cp1256"],
  ["windows-1257", "cp1257 windows-1257 x-cp1257"],
  ["windows-1258", "cp1258 windows-1258 x-cp1258"],
  ["x-mac-cyrillic", "x-mac-cyrillic x-mac-ukrainian"],
  ["gbk", "chinese csgb2312 csiso58gb231280 gb2312 gb_2312 gb_2312-80 gbk iso-ir-58 x-gbk"],
  ["gb18030", "gb18030"],
  ["big5", "big5 big5-hkscs cn-big5 csbig5 x-x-big5"],
  ["euc-jp", "cseucpkdfmtjapanese euc-jp x-euc-jp"],
  ["iso-2022-jp", "csiso2022jp iso-2022-jp"],
  ["shift_jis", "csshiftjis ms932 ms_kanji shift-jis shift_jis sjis windows-31j x-sjis"],
  ["euc-kr", "cseuckr csksc56011987 euc-kr iso-ir-149 korean ks_c_5601-1987 ks_c_5601-1989 ksc5601 ksc_5601 windows-949"],
  ["replacement", "csiso2022kr hz-gb-2312 iso-2022-cn iso-2022-cn-ext iso-2022-kr replacement"],
  ["utf-16be", "unicodefffe utf-16be"],
  ["utf-16le", "csunicode iso-10646-ucs-2 ucs-2 unicode unicodefeff utf-16 utf-16le"],
  ["x-user-defined", "x-user-defined"],
].flatMap(([encoding, labels]) => labels.split(" ").map(label => [label, encoding] as const)));

/** WHATWG labels ignore only leading/trailing ASCII whitespace. */
export function encodingLabel(value: string): string | undefined {
  return encodingLabels.get(value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").toLowerCase());
}

/** Copy only one allowlisted charset; never forward arbitrary stored parameters. */
function storedCharset(value: string): string | undefined {
  const start = value.indexOf(";");
  if (start === -1) return undefined;
  // Parse whole parameters so a quoted value cannot smuggle a second charset.
  // Reject malformed tails and duplicate charsets rather than choosing ambiguously.
  const parameter = /;[ \t]*([a-z0-9!#$%&'*+.^_`|~-]+)[ \t]*=[ \t]*(?:"([^"\\\r\n]*)"|([a-z0-9!#$%&'*+.^_`|~-]+))[ \t]*/giy;
  parameter.lastIndex = start;
  let charset: string | undefined;
  while (parameter.lastIndex < value.length) {
    const match = parameter.exec(value);
    if (!match) return undefined;
    if (match[1].toLowerCase() !== "charset") continue;
    if (charset !== undefined) return undefined;
    charset = encodingLabels.get((match[2] ?? match[3]).toLowerCase());
    if (charset === undefined) return undefined;
  }
  return charset;
}

/** Classify untrusted media types using only a validated, canonical MIME essence. */
export function normalizeMediaType(value: string): string {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(type)
    ? type : "application/octet-stream";
}

export function assetContentType(path: string, storedType?: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  // Older manifests can store fonts as application/octet-stream. Preserve
  // valid publisher MIME essences for other files, never arbitrary parameters.
  const type = fontTypes[extension] ?? (storedType === undefined
    ? assetTypes[extension] ?? "application/octet-stream"
    : normalizeMediaType(storedType));
  // Streamed text (including the byte-preserving HTML injector) retains its
  // encoding, including the absence of a charset for in-band declarations.
  // Routes that fully decode HTML explicitly pass text/html; charset=utf-8.
  if (storedType !== undefined && /^(?:text\/|application\/(?:javascript|ecmascript|json|xml)$)|\+(?:json|xml)$/.test(type)) {
    const charset = storedCharset(storedType);
    if (charset !== undefined) return `${type}; charset=${charset}`;
  }
  return type;
}

export function isHtmlAsset(path: string, storedType?: string): boolean {
  return normalizeMediaType(assetContentType(path, storedType)) === "text/html";
}

/** A response sandbox also isolates direct navigation, regardless of MIME type. */
function publisherContentPolicy(contentType: string, restrictResources: boolean): string {
  return normalizeMediaType(contentType) === "text/html"
    ? "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'"
    : `${restrictResources ? "default-src 'none'; " : ""}sandbox; frame-ancestors 'self'`;
}

/** Call only after access checks. Retain resource restrictions where already used;
 * adding default-src to public SVGs would also suppress their image styling. */
export function assetHeaders(path: string, allowOpaqueOrigin: boolean, storedType?: string, restrictResources = false): Record<string, string> {
  const contentType = assetContentType(path, storedType);
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": publisherContentPolicy(contentType, restrictResources),
    "X-Content-Type-Options": "nosniff",
    // Fixed opaque origin, never reflected and never credentialed. Canonical
    // cookie-authenticated private URLs must not opt into this allowance.
    ...(allowOpaqueOrigin ? { "Access-Control-Allow-Origin": "null" } : {}),
  };
}

/** Classify failures without reading storage or revealing whether an asset exists. */
export function assetError(c: Context, html: () => string, status: ClientErrorStatusCode | ServerErrorStatusCode = 404): Response {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const accept = c.req.header("Accept") ?? "";
  let path = c.req.path;
  try { path = decodeURIComponent(path); } catch { /* Invalid paths still fail closed. */ }
  // Browser document Accept headers also advertise image formats.
  const htmlRequest = /(?:^|,)\s*(?:text\/html|application\/xhtml\+xml)(?:\s*[;,]|$)/i.test(accept);
  const resource = (!htmlRequest && /(?:^|,)\s*(?:image\/|font\/|text\/css|(?:application|text)\/(?:javascript|ecmascript)|application\/(?:json|[\w.+-]+\+json|font-|x-font-|vnd.ms-fontobject))/i.test(accept))
    || /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf|eot|css|m?js|json)$/i.test(path);
  if (resource) {
    // An empty untyped response avoids Chromium ORB for opaque no-cors loads.
    // Keep the denial status and never grant error-response CORS access.
    c.set("emptyAssetError", true);
    c.header("Content-Type", undefined);
    c.header("X-Content-Type-Options", undefined);
    c.header("Content-Length", "0");
    return c.body(null, status);
  }
  return c.html(html(), status);
}
