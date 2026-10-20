/**
 * The document frame for one rendered page (#234). Rendered HTML is already
 * sanitized at ingest (#215); the frame adds Rendro's stylesheet, the viewer's
 * navigation bridge and, for private repositories, the asset tickets of its
 * images.
 * The response's own policy is stricter than the publisher frames': the only
 * scripts are Rendro's viewer and comment bundles, the only inline style is the
 * comment widget's stylesheet (by hash), and nothing may load except same-origin
 * resources (external images arrive through the signed image proxy). The widget
 * never connects anywhere: it talks to the trusted shell (#254).
 */
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { IMAGE_PROXY_PREFIX } from "@/image-proxy";
import { escapeHtml } from "@/routes/html";
import { styleManifest } from "@/routes/style-manifest";
import { COMMENTOR_VERSION, PRIVATE_VIEWER_VERSION } from "@/viewer/asset-versions";
import { COMMENTOR_SCRIPT_PATH, COMMENTOR_STYLE_SOURCE } from "./comments";
import { encodeRepoPath } from "./paths";

/** Bump when the frame markup changes: it is part of every frame validator. */
export const FRAME_VERSION = 2;
export const FRAME_TEMPLATE_TAG = `f${FRAME_VERSION}.v${PRIVATE_VIEWER_VERSION}.c${COMMENTOR_VERSION}.${styleManifest["repo-doc"].split(".")[1]}`;

type Node = DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["documentFragment"];

const REASONS: Record<string, string> = {
  "too-large": "This page is too large to display.",
  missing: "This page is missing from the snapshot.",
};

/**
 * Version-3 renders emit links and images already relative to the document
 * (src/ingest/paths.ts), so the read path serves their HTML untouched (#242).
 * Version 4 and later inherit that (the a11y transforms of #270 change other
 * attributes only); older snapshots were written as `/<repo path>` and need
 * `frameBody` below. A commit-pinned URL keeps serving an older renderer's
 * manifest until a rebuild lands, so the shim stays until those are gone.
 */
export function needsRelativeRewrite(rendererVersion: number): boolean {
  return rendererVersion < 3;
}

/**
 * The compatibility shim for pre-v3 renders, which wrote links and images as
 * `/<repo path>` ("the serving layer maps that namespace onto the commit being
 * viewed"). Here they become relative to the page, so they resolve under
 * whatever URL (commit or branch) the frame was loaded from. Dot segments
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
 * The body of a pre-v3 render as the frame serves it (see `needsRelativeRewrite`).
 * Ingest also wrote external images as signed same-origin proxy paths
 * (`/img/<sig>/<url>`, #224); those are already absolute and stay as they are,
 * but only when `isProxied` verifies them, so a repository folder named `img`
 * still resolves as part of the repository.
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

/** Where a private frame's per-request ticket prefix goes. parse5 never keeps a NUL, so the serialized HTML holds none of its own. */
const TICKET_SLOT = "\u0000";
const SLOT_ORIGIN = "https://repository.invalid";

/** The repository path (percent-encoded, with its query and fragment) an image source relative to the document names, else null. */
function repositoryImagePath(src: string, documentPath: string): string | null {
  // Only a relative-path reference: a scheme or a rooted path (the signed image proxy's `/img/…`) is left as it is.
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u0020]*(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[/\\])/.test(src)) return null;
  const url = new URL(src, `${SLOT_ORIGIN}/${encodeRepoPath(documentPath)}`);
  return url.pathname.slice(1) + url.search + url.hash;
}

/**
 * A private frame's body, split where a repository image's URL needs the
 * reader's asset-ticket prefix (#293): `parts.join(prefix)` is the body. The
 * frame has no `<base>`, so links, footnotes and anything else navigable
 * resolve against the frame's own cookie-authorized URL, and only the images,
 * which the opaque frame loads without cookies, carry the ticket. The split
 * depends only on the render, so it is derived once per isolate; joining it
 * with each request's ticket is a string concatenation.
 */
export function ticketImageSlots(html: string, documentPath: string): string[] {
  const fragment = parseFragment(html);
  const visit = (node: Node) => {
    if ("attrs" in node && node.nodeName === "img") {
      for (const attribute of node.attrs) {
        const path = attribute.name === "src" ? repositoryImagePath(attribute.value, documentPath) : null;
        if (path !== null) attribute.value = TICKET_SLOT + path;
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(fragment);
  return serialize(fragment).split(TICKET_SLOT);
}

export function failureBody(reason: string): string {
  return `<p class="rendro-render-failure">${escapeHtml(REASONS[reason] ?? "This page could not be rendered safely.")}</p>`;
}

export function frameContentSecurityPolicy(origin: string): string {
  return [
    "sandbox allow-scripts allow-popups",
    "default-src 'none'",
    `script-src ${origin}/private-viewer.js ${origin}${COMMENTOR_SCRIPT_PATH}`,
    `style-src ${origin}/styles/ ${COMMENTOR_STYLE_SOURCE}`,
    // Same-origin only: since #224 ingest writes every external image as a signed /img/ proxy path or drops it,
    // so an external URL reaching a frame is a bug, and the policy keeps it from the reader.
    `img-src ${origin}`,
    // No frame has a <base> (#293): a document's links always resolve against its own URL.
    "base-uri 'none'",
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
