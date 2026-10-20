import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as fontkit from "fontkit";

/** Variable Material Symbols Outlined source, pinned through the `material-symbols` devDependency. */
export const iconFontSource = "node_modules/material-symbols/material-symbols-outlined.woff2";

// The files below define the fonts themselves; their strings are CSS keywords, not icon names.
const scanExcluded = new Set(["src/routes/font-manifest.ts", "src/routes/fonts.ts"]);
const iconMarker = /material-symbols-outlined|Material Symbols/;

/**
 * Many ordinary words are also Material Symbols ligatures. Icon names are found by scanning every
 * quoted string and `>text<` node in the icon-rendering files for a valid ligature name, so the words
 * that appear there for other reasons (event names, CSS classes, route sections) are listed here.
 * An unlisted word that is a ligature simply becomes part of the subset: the failure mode of a new
 * entry is a few hundred bytes, never a missing glyph. Only add a word after confirming it is not
 * rendered as an icon; the E2E glyph-presence check catches a wrongly listed icon on visited pages.
 */
export const NON_ICON_LITERALS: ReadonlySet<string> = new Set([
  "badge", "block", "cancel", "checklist", "code", "eyebrow", "function", "history", "input", "label", "light",
  "overview", "pending", "post", "resize", "script", "security", "select", "start", "step", "storage",
  "switch", "title", "toast", "token", "tooltip", "verified", "warning",
]);

export type IconCatalog = ReadonlyMap<string, number>;

// Both inputs are single-font woff2 files, never collections.
const openFont = (data: Uint8Array) => fontkit.create(Buffer.from(data)) as fontkit.Font;

/** Ligature name → private-use code point for every icon in the full font. */
export function loadIconCatalog(root: string): IconCatalog {
  const font = openFont(readFileSync(join(root, iconFontSource)));
  const catalog = new Map<string, number>();
  for (const codePoint of font.characterSet) {
    if (codePoint < 0xe000) continue;
    const name = font.glyphForCodePoint(codePoint).name;
    if (/^[a-z][a-z0-9_]*$/.test(name) && !catalog.has(name)) catalog.set(name, codePoint);
  }
  return catalog;
}

/** Names the font does not turn into one ligature glyph (they would fall back to letters). */
export function missingIcons(font: Uint8Array, names: readonly string[]): string[] {
  const opened = openFont(font);
  return names.filter(name => opened.layout(name).glyphs.length !== 1);
}

function sourceFiles(root: string): string[] {
  const files: string[] = ["scripts/management-pages-source.ts"];
  const visit = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  visit("src");
  return files.filter(file => !scanExcluded.has(file));
}

/** Sorted icon names referenced by source that renders Material Symbols. */
export function scanIconNames(root: string, catalog: IconCatalog): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(root)) {
    const text = readFileSync(join(root, file), "utf8");
    if (!iconMarker.test(text)) continue;
    for (const [, name] of text.matchAll(/["'`>]([a-z][a-z0-9_]*)(?=["'`<])/g)) {
      if (catalog.has(name) && !NON_ICON_LITERALS.has(name)) found.add(name);
    }
  }
  return [...found].sort();
}
