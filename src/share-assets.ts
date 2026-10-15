import { parse, type DefaultTreeAdapterMap } from "parse5";
import { rewriteCssUrls } from "@/viewer/css-urls";
import { decodeStoragePath } from "@/storage-boundary";
import { normalizeMediaType, assetContentType } from "@/routes/asset-headers";
import type { StoredManifest } from "@/stored-manifest";
import { validShareAssets } from "../shared/share-assets";

export class ShareAssetError extends Error {}
const origin = "https://share.invalid";
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
// A synthetic URL origin is only a resolver base, never proof that an absolute
// publisher URL belongs to this deployment. Conservatively strip leading
// whitespace/controls and normalize slashes before detecting absolute URLs.
function absoluteReference(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value.replace(/[\t\n\r]/g, "").replace(/^[\s\p{Cc}]+/u, "").replaceAll("\\", "/"));
}

export function isShareDocument(type: string): boolean {
  return ["text/html", "application/xhtml+xml"].includes(normalizeMediaType(type));
}

/** Discover only literal resources, never navigation links or JavaScript fetches. */
export async function collectShareAssets(
  manifest: StoredManifest,
  documentPath: string,
  read: (path: string) => Promise<ReadableStream<Uint8Array> | null>,
): Promise<string[]> {
  const files = new Map(manifest.files.map(file => [file.path, file]));
  const document = files.get(documentPath);
  if (!document || normalizeMediaType(document.contentType) !== "text/html") {
    throw new ShareAssetError("Share requires an HTML document in the deployment manifest");
  }
  let bytes = 0;
  const source = async (file: StoredManifest["files"][number]): Promise<string> => {
    const stream = await read(file.path);
    if (!stream) throw new ShareAssetError("Share document or stylesheet is unavailable");
    const reader = stream.getReader();
    const type = assetContentType(file.path, file.contentType);
    const charset = /; charset=(.*)$/.exec(type)?.[1];
    const decoder = new TextDecoder(charset);
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new ShareAssetError("Share source exceeds the 8 MiB parsing limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  };
  const documentUrl = new URL(documentPath.split("/").map(encodeURIComponent).join("/"), origin + "/");
  const root = parse(await source(document));
  const nodes: DefaultTreeAdapterMap["node"][] = [root];
  const elements: DefaultTreeAdapterMap["element"][] = [];
  for (let node = nodes.pop(); node; node = nodes.pop()) {
    if ("attrs" in node) elements.push(node);
    if ("childNodes" in node) nodes.push(...[...node.childNodes].reverse());
  }
  const attr = (node: DefaultTreeAdapterMap["element"], name: string) => node.attrs.find(a => a.name === name)?.value;
  const baseNode = elements.find(node => node.tagName === "base" && attr(node, "href") !== undefined);
  const baseHref = baseNode && attr(baseNode, "href");
  let base = documentUrl;
  if (baseHref !== undefined) {
    try {
      base = new URL(baseHref, documentUrl);
      if (absoluteReference(baseHref)) return [];
    } catch { /* Invalid bases are ignored by browsers. */ }
  }
  const assets = new Set<string>();
  const add = (value: string, relativeTo: URL): string => {
    if (!value.trim() || value.trimStart().startsWith("#")) return value;
    let url: URL;
    try { url = new URL(value, relativeTo); } catch { return value; }
    if (absoluteReference(value)) return value;
    const path = decodeStoragePath(url.pathname.slice(1));
    const file = path ? files.get(path) : undefined;
    if (file && path !== documentPath && !isShareDocument(file.contentType)) {
      assets.add(file.path);
      if (!validShareAssets([...assets])) throw new ShareAssetError("Share asset limit exceeded (500 paths / 64 KiB)");
    }
    return value;
  };
  const css = (text: string, relativeTo: URL) => rewriteCssUrls(text, value => add(value, relativeTo));
  for (const node of elements) {
    const tag = node.tagName;
    const attributes: string[] = [];
    if (["img", "source", "video", "audio", "script", "embed", "track", "input"].includes(tag)) attributes.push("src");
    if (tag === "video") attributes.push("poster");
    if (tag === "object") attributes.push("data");
    if (["image", "use"].includes(tag)) attributes.push("href");
    if (tag === "link" && /(?:^|\s)(?:stylesheet|icon|preload|modulepreload)(?:\s|$)/i.test(attr(node, "rel") ?? "")) attributes.push("href", "imagesrcset");
    if (["img", "source"].includes(tag)) attributes.push("srcset");
    for (const name of attributes) {
      const value = attr(node, name);
      if (value === undefined) continue;
      if (name.endsWith("srcset")) {
        // URL tokens end at whitespace (commas can occur inside data URLs).
        // Descriptors end at a comma outside parentheses, per HTML's srcset parser.
        let remaining = value;
        while ((remaining = remaining.replace(/^[\s,]+/, ""))) {
          const url = remaining.split(/\s/, 1)[0];
          remaining = remaining.slice(url.length);
          add(url.replace(/,+$/, ""), base);
          if (!url.endsWith(",")) remaining = remaining.replace(/^(?:[^,(]|\([^)]*(?:\)|$))*/, "").slice(1);
        }
      } else add(value, base);
    }
    const style = attr(node, "style");
    if (style !== undefined) css(style, base);
    if (tag === "style") css(node.childNodes.filter(n => n.nodeName === "#text").map(n => (n as DefaultTreeAdapterMap["textNode"]).value).join(""), base);
  }
  // Snapshot before expansion: imported stylesheets are allowed but not crawled.
  const stylesheets = [...files.values()].filter(file => assets.has(file.path) && normalizeMediaType(file.contentType) === "text/css");
  for (const file of stylesheets) {
    css(await source(file), new URL(file.path.split("/").map(encodeURIComponent).join("/"), origin + "/"));
  }
  return [...assets].sort();
}
