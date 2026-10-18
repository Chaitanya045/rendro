/**
 * The document frame for one rendered page (#234). Rendered HTML is already
 * sanitized at ingest (#215); the frame adds Rendro's stylesheet, the viewer's
 * navigation bridge and, for private repositories, the asset ticket base.
 * The response's own policy is stricter than the publisher frames': the only
 * script is Rendro's viewer bundle, and nothing may load except same-origin
 * resources and external images.
 */
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { IMAGE_PROXY_PREFIX } from "@/image-proxy";
import { escapeHtml } from "@/routes/html";
import { styleManifest } from "@/routes/style-manifest";
import { PRIVATE_VIEWER_VERSION } from "@/viewer/asset-versions";

/** Bump when the frame markup changes: it is part of every frame validator. */
export const FRAME_VERSION = 1;
export const FRAME_TEMPLATE_TAG = `f${FRAME_VERSION}.v${PRIVATE_VIEWER_VERSION}.${styleManifest["repo-doc"].split(".")[1]}`;

type Node = DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["documentFragment"];

const REASONS: Record<string, string> = {
  "too-large": "This page is too large to display.",
  missing: "This page is missing from the snapshot.",
};

/**
 * Ingest emits links and images inside the repository as `/<repo path>`
 * ("the serving layer maps that namespace onto the commit being viewed").
 * Here they become relative to the page, so they resolve under whatever URL
 * (commit, branch or ticket base) the frame was loaded from. Dot segments
 * never come out of ingest; any that do lose their URL.
 */
export function relativeUrl(value: string, documentPath: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return value;
  const end = value.search(/[?#]/);
  const path = end === -1 ? value.slice(1) : value.slice(1, end);
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === "..") return null;
  }
  const relative = "../".repeat(documentPath.split("/").length - 1) + path + (end === -1 ? "" : value.slice(end));
  return relative === "" || relative.startsWith("?") || relative.startsWith("#") ? `./${relative}` : relative;
}

/**
 * The page body as the frame serves it. Ingest also writes external images as
 * signed same-origin proxy paths (`/img/<sig>/<url>`, #224); those are already
 * absolute and stay as they are, but only when `isProxied` verifies them, so a
 * repository folder named `img` still resolves as part of the repository.
 */
export async function frameBody(html: string, documentPath: string, isProxied: (src: string) => Promise<boolean>): Promise<string> {
  const fragment = parseFragment(html);
  const elements: Array<Extract<Node, { attrs: unknown }>> = [];
  const collect = (node: Node) => {
    if ("attrs" in node) elements.push(node);
    if ("childNodes" in node) node.childNodes.forEach(collect);
  };
  collect(fragment);
  const proxied = new Set<string>();
  for (const element of elements) {
    for (const { name, value } of element.attrs) {
      if (element.nodeName === "img" && name === "src" && value.startsWith(IMAGE_PROXY_PREFIX) && !proxied.has(value) && await isProxied(value)) proxied.add(value);
    }
  }
  for (const element of elements) {
    element.attrs = element.attrs.flatMap(attribute => {
      if ((attribute.name !== "href" && attribute.name !== "src") || (attribute.name === "src" && proxied.has(attribute.value))) return [attribute];
      const value = relativeUrl(attribute.value, documentPath);
      return value === null ? [] : [{ ...attribute, value }];
    });
  }
  return serialize(fragment);
}

export function failureBody(reason: string): string {
  return `<p class="rendro-render-failure">${escapeHtml(REASONS[reason] ?? "This page could not be rendered safely.")}</p>`;
}

export function frameContentSecurityPolicy(origin: string): string {
  return [
    "sandbox allow-scripts allow-popups",
    "default-src 'none'",
    `script-src ${origin}/private-viewer.js`,
    `style-src ${origin}/styles/`,
    `img-src ${origin} https:`,
    `base-uri ${origin}`,
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export function renderFrameDocument(options: { title: string; body: string; origin: string; head: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
${options.head}<link rel="stylesheet" href="${options.origin}/styles/${styleManifest["repo-doc"]}">
</head>
<body><article class="markdown-body">${options.body}</article></body>
</html>`;
}
