/**
 * Repo paths are POSIX paths relative to the repository root: no leading or
 * trailing slash, no empty, "." or ".." segments, no backslashes or control
 * characters. Every path the ingest modules emit satisfies this.
 */
export function isRepoPath(path: string): boolean {
  return path.split("/").every(isPathSegment);
}

function isPathSegment(segment: string): boolean {
  // eslint-disable-next-line no-control-regex
  return segment !== "" && segment !== "." && segment !== ".." && !/[\\\u0000-\u001f\u007f]/.test(segment);
}

export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Lower-cased extension including the dot, or "" when the basename has none. */
export function extensionOf(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** Code-unit order: the same in every runtime, unlike localeCompare. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function joinRepoPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** True when `path` is `dir` itself or inside it ("" is the repo root). */
export function isWithin(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

/**
 * Resolve a relative reference against a directory. Returns null if the result
 * would leave the repository; GitHub would then point outside the repo's tree.
 */
export function resolveRepoPath(baseDir: string, reference: string): string | null {
  const segments = baseDir ? baseDir.split("/") : [];
  for (const segment of reference.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

/** Config files name directories ("docs", "./src/", "docs/"); normalize or reject. */
export function resolveConfigDir(configDir: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\") || /^[a-z]+:/i.test(trimmed)) return null;
  const resolved = resolveRepoPath(configDir, trimmed);
  return resolved !== null && (resolved === "" || isRepoPath(resolved)) ? resolved : null;
}

export const USER_CONTENT_PREFIX = "user-content-";

export type UrlContext = "href" | "src";

/**
 * Normalize one author URL from a document at `docPath`, the way GitHub
 * resolves README links, or return null to drop the attribute.
 *
 * - http(s) URLs are parsed and re-serialized; protocol-relative URLs become https.
 * - `mailto:` is kept for links. Every other scheme is dropped.
 * - Fragments gain the `user-content-` prefix that sanitized ids carry.
 * - Relative and root-relative references are resolved against the document
 *   and emitted as `/<repo path>`. The serving layer maps that namespace to
 *   the commit being viewed. A reference that leaves the repo is dropped.
 */
export function rewriteUrl(raw: string, docPath: string, context: UrlContext): string | null {
  // WHATWG URL parsing strips leading/trailing C0 controls and spaces, and
  // removes tabs and newlines anywhere. Normalize the same way before checking.
  // eslint-disable-next-line no-control-regex
  const value = raw.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");
  if (!value) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === "http" || scheme === "https") return parseAbsolute(value);
    if (scheme === "mailto" && context === "href") return value;
    return null;
  }
  const slashed = value.replace(/\\/g, "/");
  if (slashed.startsWith("//")) return parseAbsolute(`https:${slashed}`);
  if (slashed.startsWith("#")) {
    const hash = context === "href" ? prefixFragment(slashed.slice(1)) : null;
    return hash === null ? null : `#${hash}`;
  }

  const hashAt = slashed.indexOf("#");
  const beforeHash = hashAt < 0 ? slashed : slashed.slice(0, hashAt);
  const fragment = hashAt < 0 ? null : slashed.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf("?");
  // Queries carry no meaning for files in a commit (GitHub's ?plain=1 and the like).
  const pathPart = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const decoded: string[] = [];
  for (const segment of pathPart.split("/")) {
    const literal = safeDecode(segment);
    // An encoded separator or control character cannot name a file in the tree.
    // eslint-disable-next-line no-control-regex
    if (/[/\\\u0000-\u001f\u007f]/.test(literal)) return null;
    decoded.push(literal);
  }
  // "?q" alone points at the document itself. Dropping it keeps the output
  // dependent on the document's directory only, not on its file name.
  if (pathPart === "") return null;
  const target = resolveRepoPath(pathPart.startsWith("/") ? "" : dirnameOf(docPath), decoded.join("/"));
  if (target === null) return null;
  const directory = target !== "" && pathPart.endsWith("/");
  const encoded = target ? encode(target.split("/")) : "";
  const hash = fragment === null || context === "src" ? "" : prefixFragment(fragment);
  if (encoded === null || hash === null) return null;
  return `/${encoded}${directory ? "/" : ""}${hash ? `#${hash}` : ""}`;
}

function parseAbsolute(value: string): string | null {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Lone surrogates make encodeURIComponent throw; such a URL is dropped. */
function encode(segments: string[]): string | null {
  try {
    return segments.map(encodeURIComponent).join("/");
  } catch {
    return null;
  }
}

/** Sanitized ids carry the user-content- prefix, so in-document links must too. */
export function prefixFragment(fragment: string): string | null {
  const literal = safeDecode(fragment);
  if (literal === "") return "";
  return encode([literal.startsWith(USER_CONTENT_PREFIX) ? literal : USER_CONTENT_PREFIX + literal]);
}
