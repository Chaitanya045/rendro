/*
 * Detection and front matter need a handful of scalar settings (docs_dir,
 * [book] src, root, title). A full YAML/TOML parser would be a large
 * dependency, and real mkdocs.yml files often use custom tags that strict
 * parsers reject. These readers accept only plain one-line scalars. Anything
 * else returns null, and the caller falls back to the documented default.
 */

function unquote(raw: string): string | null {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end > 0 ? value.slice(1, end) : null;
  }
  // Unquoted: a " #" starts a comment. Block scalars, flow collections and anchors are not plain values.
  const plain = value.replace(/\s+#.*$/, "").trim();
  return plain && !/^[|>[{&*!]/.test(plain) ? plain : null;
}

function lines(text: string): string[] {
  return text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
}

/** `key: value` at the top level (no indentation). */
export function readYamlScalar(text: string, key: string): string | null {
  for (const line of lines(text)) {
    const match = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    if (match?.[1] === key) return match[2] === undefined ? null : unquote(match[2]);
  }
  return null;
}

/** `child: value` indented directly under a top-level `parent:` mapping. */
export function readYamlNestedScalar(text: string, parent: string, child: string): string | null {
  let inside = false;
  for (const line of lines(text)) {
    if (/^\S/.test(line)) {
      inside = new RegExp(`^${parent}[ \\t]*:[ \\t]*(?:#.*)?$`).test(line);
      continue;
    }
    const match = inside ? /^[ \t]+([A-Za-z0-9_-]+)[ \t]*:[ \t]+(.*)$/.exec(line) : null;
    if (match?.[1] === child) return unquote(match[2]);
  }
  return null;
}

/** `key = "value"` inside `[table]`, or before any table header when `table` is null. */
export function readTomlString(text: string, table: string | null, key: string): string | null {
  let current: string | null = null;
  for (const line of lines(text)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      current = (header[1]).trim();
      continue;
    }
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (current === table && match?.[1] === key) return /^["']/.test(match[2]) ? unquote(match[2]) : null;
  }
  return null;
}

/** A string-literal property in a JS/TS config object, e.g. `srcDir: "./src"`. */
export function readJsString(text: string, key: string): string | null {
  const match = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*(["'\`])([^"'\`\\n]*)\\1`).exec(text);
  return match ? (match[2]) : null;
}

export interface FrontMatter {
  body: string;
  title: string | null;
}

/**
 * Split YAML (`---`) or TOML (`+++`) front matter from Markdown. GitHub shows
 * front matter as a table; docs generators treat it as metadata, and so does
 * Rendro. Only `title` is read.
 */
export function splitFrontMatter(source: string): FrontMatter {
  const text = source.replace(/^\uFEFF/, "");
  const fence = /^(---|\+\+\+)[ \t]*(?:\r\n|\r|\n)/.exec(text);
  if (!fence) return { body: source, title: null };
  const close = fence[1] === "---" ? /^(?:---|\.\.\.)[ \t]*$/m : /^\+\+\+[ \t]*$/m;
  const rest = text.slice(fence[0].length);
  const end = close.exec(rest);
  if (!end) return { body: source, title: null };
  const matter = rest.slice(0, end.index);
  const body = rest.slice(end.index + end[0].length).replace(/^(?:\r\n|\r|\n)/, "");
  const title = fence[1] === "---" ? readYamlScalar(matter, "title") : readTomlString(matter, null, "title");
  return { body, title: title?.trim() || null };
}

/**
 * MDX allows top-level ESM (`import`/`export`) blocks, which end at a blank
 * line. Remove them so they don't render as prose. JSX elements are left to
 * the HTML sanitizer, which unwraps unknown elements.
 */
export function stripMdxEsm(source: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let inEsm = false;
  for (const line of source.split("\n")) {
    if (inEsm) {
      inEsm = line.trim() !== "";
      // Keep the blank line that ends the block, so blocks around it stay separate.
      if (!inEsm) out.push(line);
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && /^(?:import|export)\s/.test(line)) {
      inEsm = true;
      continue;
    }
    if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence === null ? marker : null;
    out.push(line);
  }
  return out.join("\n");
}
