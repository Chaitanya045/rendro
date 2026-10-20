import { fontManifest } from "./font-manifest";

// Content-hashed, so a changed font always gets a new URL and the old one never changes.
export const fontCacheControl = "public, max-age=31536000, immutable";
const licenseCacheControl = "public, max-age=86400";

const hashedFont = /^\/fonts\/[a-z0-9-]+\.[0-9a-f]{10}\.woff2$/;
const licenseText = /^\/fonts\/LICENSE-[A-Za-z0-9.-]+\.txt$/;

/** Headers for a public font asset, or `undefined` when the path is not one (serve a 404). */
export function fontResponseHeaders(path: string): Record<string, string> | undefined {
  if (hashedFont.test(path)) return { "Content-Type": "font/woff2", "Cache-Control": fontCacheControl };
  if (licenseText.test(path)) return { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": licenseCacheControl };
  return undefined;
}

export const fontUrl = (file: string) => `/fonts/${file}`;
const iconFontFile = fontManifest.icons.file;

// `block` keeps ligature names invisible while the icon font loads; iconBox bounds them if it never does.
const iconFace = `@font-face{font-family:"Material Symbols Outlined";font-style:normal;font-weight:400;font-display:block;src:url(${fontUrl(iconFontFile)}) format("woff2")}`;

// The class rule Google Fonts appended to its Material Symbols stylesheet (pages relied on it for the
// family, 24px default size and inline-block box), plus the layout guarantee: one em wide, clipped, never
// wrapped. If the icon font is slow, blocked or filtered, a ligature name cannot widen or wrap its box.
// Same specificity as before, emitted ahead of page CSS, so component rules still size their own icons.
const iconBox = '.material-symbols-outlined{font-family:"Material Symbols Outlined";font-weight:normal;font-style:normal;font-size:24px;line-height:1;letter-spacing:normal;text-transform:none;display:inline-block;flex:none;width:1em;overflow:hidden;white-space:nowrap;word-wrap:normal;direction:ltr;font-feature-settings:"liga";-webkit-font-smoothing:antialiased}';

function interFaces(weights: readonly number[]): string {
  // The more specific subset is declared last so it wins the few overlapping code points.
  return [...fontManifest.inter.faces].reverse().flatMap(face => weights.map(weight =>
    `@font-face{font-family:Inter;font-style:normal;font-weight:${weight};font-display:swap;src:url(${fontUrl(face.file)}) format("woff2");unicode-range:${face.unicodeRange}}`)).join("");
}

export interface FontOptions {
  /** Pages that render Material Symbols preload and declare the icon font. */
  icons?: boolean;
  /** Inter weights to declare; defaults to every served weight. */
  weights?: readonly number[];
}

/** The fonts a page preloads: the Latin Inter file, and the icon font when the page renders icons. */
export function fontPreloads({ icons = false }: FontOptions = {}): string[] {
  return icons ? [fontManifest.inter.faces[0].file, iconFontFile] : [fontManifest.inter.faces[0].file];
}

/** The page's @font-face rules (and the icon box), the body of its nonce'd `data-rendro-fonts` style. */
export function fontFaceStyles({ icons = false, weights = fontManifest.inter.weights }: FontOptions = {}): string {
  return `${interFaces(weights)}${icons ? iconFace + iconBox : ""}`;
}

// The head markup that uses them is FontHead (head.tsx).
export { renderFontHead } from "./head";
