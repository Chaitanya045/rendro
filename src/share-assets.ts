import { MAX_SHARE_ASSET_BYTES, MAX_SHARE_ASSET_PATHS } from "../shared/share-assets";
import { srcsetUrls } from "@/share-srcset";
import { decodeShareSource } from "@/share-encoding";
import { type DefaultTreeAdapterMap } from "parse5";
import { parseShareHtml, ShareAssetError } from "@/share-html";
import { rewriteCssUrls } from "@/viewer/css-urls";
import { decodeStoragePath } from "@/storage-boundary";
import { normalizeMediaType } from "@/routes/asset-headers";
import type { StoredManifest } from "@/stored-manifest";
import { WorkBudget } from "@/share-budget";
import { isCanonicalStorageKey } from "../shared/storage-path";

export { ShareAssetError } from "@/share-html";
type ShareFile = StoredManifest["files"][number] & { mediaType: string };
const origin = "https://share.invalid";
const srcTags = new Set(["img", "source", "video", "audio", "script", "embed", "track", "input"]);
const svgTags = new Set(["image", "use"]);
const srcsetTags = new Set(["img", "source"]);
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
// A synthetic URL origin is only a resolver base, never proof that an absolute
// publisher URL belongs to this deployment. Conservatively strip leading
// whitespace/controls and normalize slashes before detecting absolute URLs.
function absoluteReference(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- URL parsing trims leading C0 controls and space.
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/u, "").replaceAll("\\", "/"));
}

export function isShareDocument(type: string): boolean {
  const normalized = normalizeMediaType(type);
  return normalized === "text/html" || normalized === "application/xhtml+xml";
}

/** Discover only literal resources, never navigation links or JavaScript fetches. */
export async function collectShareAssets(
  manifest: StoredManifest,
  documentPath: string,
  read: (path: string) => Promise<ReadableStream<Uint8Array> | null>,
  budget = new WorkBudget(),
): Promise<string[]> {
  const files = new Map<string, ShareFile>();
  for (const file of manifest.files) {
    budget.charge(file.path.length + file.contentType.length + 1);
    files.set(file.path, { path: file.path, contentType: file.contentType, mediaType: normalizeMediaType(file.contentType) });
  }
  budget.charge(documentPath.length + 1);
  const document = files.get(documentPath);
  if (!document || document.mediaType !== "text/html") {
    throw new ShareAssetError("Share requires an HTML document in the deployment manifest");
  }
  let bytes = 0;
  const source = async (file: StoredManifest["files"][number], environment?: string) => {
    const stream = await budget.wait(() => read(file.path));
    if (!stream) throw new ShareAssetError("Share document or stylesheet is unavailable");
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      budget.charge();
      const chunk = await budget.wait(() => reader.read());
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new ShareAssetError("Share source exceeds the 8 MiB parsing limit");
      }
      budget.charge(chunk.value.byteLength);
      chunks.push(chunk.value);
      length += chunk.value.byteLength;
    }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      budget.charge(chunk.byteLength + 1);
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try { return decodeShareSource(buffer, file.path, file.contentType, environment, budget); }
    catch (error) {
      if (error instanceof ShareAssetError) throw error;
      throw new ShareAssetError("Share source uses an unsupported text encoding");
    }
  };
  const fileUrl = (path: string) => {
    budget.charge(path.length * 4 + 1);
    return new URL(path.split("/").map(part => { budget.charge(); return encodeURIComponent(part); }).join("/"), origin + "/");
  };
  const documentUrl = fileUrl(documentPath);
  const documentSource = await source(document);
  const root = parseShareHtml(documentSource.text, budget);
  const nodes: DefaultTreeAdapterMap["node"][] = [root];
  const elements: Array<{ node: DefaultTreeAdapterMap["element"]; attributes: Map<string, string> }> = [];
  let baseHref: string | undefined;
  for (let node = nodes.pop(); node; node = nodes.pop()) {
    budget.charge();
    if ("attrs" in node) {
      const attributes = new Map<string, string>();
      for (const attribute of node.attrs) {
        budget.charge(attribute.name.length + attribute.value.length + 1);
        if (!attributes.has(attribute.name)) attributes.set(attribute.name, attribute.value);
      }
      elements.push({ node, attributes });
      if (node.tagName === "base" && baseHref === undefined) baseHref = attributes.get("href");
    }
    if ("childNodes" in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) { budget.charge(); nodes.push(node.childNodes[i]); }
    }
  }
  const attr = (element: typeof elements[number], name: string) => {
    budget.charge();
    return element.attributes.get(name);
  };
  let base = documentUrl;
  if (baseHref !== undefined) {
    budget.charge(baseHref.length * 16 + 1);
    try {
      base = new URL(baseHref, documentUrl);
      if (absoluteReference(baseHref)) return [];
    } catch { /* Invalid bases are ignored by browsers. */ }
  }
  const assets = new Map<string, ShareFile>();
  let assetBytes = 2; // JSON array brackets; each unique path is encoded once.
  const seen = new Map<URL, Set<string>>();
  const add = (value: string, relativeTo: URL): string => {
    budget.charge(value.length * 16 + relativeTo.href.length + 1);
    let references = seen.get(relativeTo);
    if (!references) { references = new Set(); seen.set(relativeTo, references); }
    if (references.has(value)) return value;
    references.add(value);
    let start = 0;
    let end = value.length;
    while (start < end && /[\t\n\f\r ]/.test(value[start])) { budget.charge(); start++; }
    while (end > start && /[\t\n\f\r ]/.test(value[end - 1])) { budget.charge(); end--; }
    const trimmed = value.slice(start, end);
    if (!trimmed || trimmed.startsWith("#")) return value;
    let url: URL;
    try { url = new URL(value, relativeTo); } catch { return value; }
    if (absoluteReference(value)) return value;
    budget.charge(url.pathname.length * 4 + 1);
    const path = decodeStoragePath(url.pathname.slice(1));
    const file = path ? files.get(path) : undefined;
    if (file && path !== documentPath && file.mediaType !== "text/html" && file.mediaType !== "application/xhtml+xml") {
      if (assets.has(file.path)) return value;
      budget.charge(file.path.length * 4 + 1);
      assetBytes += new TextEncoder().encode(JSON.stringify(file.path)).byteLength + (assets.size ? 1 : 0);
      if (assets.size >= MAX_SHARE_ASSET_PATHS || assetBytes > MAX_SHARE_ASSET_BYTES || !isCanonicalStorageKey(file.path)) {
        throw new ShareAssetError("document references too many assets to share");
      }
      assets.set(file.path, file);
    }
    return value;
  };
  const css = (text: string, relativeTo: URL) => rewriteCssUrls(text, value => add(value, relativeTo), units => budget.charge(units));
  for (const node of elements) {
    budget.charge();
    const tag = node.node.tagName;
    const attributes: string[] = [];
    if (srcTags.has(tag)) attributes.push("src");
    if (tag === "video") attributes.push("poster");
    if (tag === "object") attributes.push("data");
    if (svgTags.has(tag)) attributes.push("href");
    if (tag === "link" && /(?:^|[\t\n\f\r ])(?:stylesheet|icon|preload|modulepreload)(?:[\t\n\f\r ]|$)/i.test(attr(node, "rel") ?? "")) attributes.push("href", "imagesrcset");
    if (srcsetTags.has(tag)) attributes.push("srcset");
    for (const name of attributes) {
      budget.charge();
      const value = attr(node, name);
      if (value === undefined) continue;
      if (name.endsWith("srcset")) {
        for (const url of srcsetUrls(value, budget)) { budget.charge(); add(url, base); }
      } else add(value, base);
    }
    const style = attr(node, "style");
    if (style !== undefined) css(style, base);
    if (tag === "style") {
      const text: string[] = [];
      for (const child of node.node.childNodes) {
        budget.charge();
        if (child.nodeName === "#text") text.push((child as DefaultTreeAdapterMap["textNode"]).value);
      }
      css(text.join(""), base);
    }
  }
  // Snapshot before expansion: imported stylesheets are allowed but not crawled.
  const stylesheets: ShareFile[] = [];
  for (const file of assets.values()) {
    budget.charge(file.path.length + 1);
    if (file.mediaType === "text/css") stylesheets.push(file);
  }
  for (const file of stylesheets) {
    budget.charge();
    css((await source(file, documentSource.encoding)).text, fileUrl(file.path));
  }
  budget.check();
  return [...assets.keys()].sort(); // Bounded path count and serialized bytes.
}
