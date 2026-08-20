import { Hono } from "hono";
import { CONVEX_SITE_URL } from "@/config";
import { getObjectStream, getObjectText } from "@/minio";
import { renderScopedDocumentShell } from "@/routes/app";
import { renderNotFoundPage } from "@/routes/not-found";

const app = new Hono();

type PublicResolution = {
  publication: {
    slug: string;
    pathPrefix: string;
    entryFile: string;
    title?: string;
    description?: string;
  };
  project: { name: string; slug: string };
  deployment: { manifestKey: string; manifestSha256: string };
};

type Manifest = {
  version: 1;
  files: Array<{ path: string; sha256: string; size: number; contentType: string }>;
};


function safePath(value: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  const path = decoded.replace(/^\/+/, "");
  if (!path || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return path;
}

async function resolvePublication(slug: string): Promise<PublicResolution | null> {
  const response = await fetch(
    `${CONVEX_SITE_URL}/api/rendro/publications/public?slug=${encodeURIComponent(slug)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  return response.json() as Promise<PublicResolution>;
}

async function manifestFor(result: PublicResolution): Promise<Manifest | null> {
  const text = await getObjectText(result.deployment.manifestKey);
  if (!text) return null;
  try { return JSON.parse(text) as Manifest; } catch { return null; }
}

function publicationPath(result: PublicResolution, path: string): string | null {
  const relative = safePath(path);
  if (!relative) return null;
  const prefix = result.publication.pathPrefix;
  return prefix ? `${prefix}/${relative}` : relative;
}

function objectKey(result: PublicResolution, path: string): string {
  return `${result.deployment.manifestKey.slice(0, -"manifest.json".length)}files/${path}`;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (result.value) output += decoder.decode(result.value, { stream: true });
  }
  return output + decoder.decode();
}

function injectNavigation(html: string, slug: string, path: string): string {
  const basePath = `/p/${encodeURIComponent(slug)}/files/`;
  const script = `<script>(function(){var parentWindow=window.parent;if(parentWindow!==window)parentWindow.postMessage({type:"doc-loaded",path:${JSON.stringify(path)}},location.origin);document.addEventListener("click",function(event){var anchor=event.target.closest("a");if(!anchor||!anchor.href)return;var url=new URL(anchor.href);var prefix=${JSON.stringify(basePath)};if(url.origin!==location.origin||!url.pathname.startsWith(prefix))return;var next=url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");if(!next)return;event.preventDefault();parentWindow.postMessage({type:"doc-navigate",path:next},location.origin);});})();</script>`;
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${script}</body>`) : html + script;
}

app.get("/p/:slug/files/*", async (c) => {
  const result = await resolvePublication(c.req.param("slug"));
  if (!result) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const relativePath = safePath(c.req.path.slice(c.req.path.indexOf("/files/") + 7));
  const fullPath = relativePath ? publicationPath(result, relativePath) : null;
  if (!relativePath || !fullPath) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const manifest = await manifestFor(result);
  const entry = manifest?.files.find((file) => file.path === fullPath);
  if (!entry) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const stream = await getObjectStream(objectKey(result, fullPath));
  if (!stream) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const headers = {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Content-Type": entry.contentType,
    "X-Content-Type-Options": "nosniff",
  };
  if (!entry.contentType.startsWith("text/html")) return new Response(stream, { headers });
  const html = injectNavigation(await readStream(stream), result.publication.slug, relativePath);
  return new Response(html, {
    headers: {
      ...headers,
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
});

app.get("/p/:slug/tree", async (c) => {
  const result = await resolvePublication(c.req.param("slug"));
  if (!result) return c.json({ error: "Not found" }, 404);
  const manifest = await manifestFor(result);
  if (!manifest) return c.json({ error: "Manifest unavailable" }, 404);
  const prefix = result.publication.pathPrefix ? `${result.publication.pathPrefix}/` : "";
  const documents = manifest.files
    .filter((file) => file.contentType.startsWith("text/html") && file.path.startsWith(prefix))
    .map((file) => file.path.slice(prefix.length));
  const offset = Math.max(0, Number.parseInt(c.req.query("cursor") ?? "0", 10) || 0);
  const page = documents.slice(offset, offset + 200);
  const cursor = offset + page.length < documents.length ? String(offset + page.length) : null;
  return c.json({ documents: page, cursor, total: documents.length }, 200, {
    "Cache-Control": "public, max-age=0, must-revalidate",
  });
});

app.get("/p/:slug", async (c) => {
  const result = await resolvePublication(c.req.param("slug"));
  if (!result) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const manifest = await manifestFor(result);
  if (!manifest) return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  const requested = c.req.query("doc");
  const selected = requested ? safePath(requested) : result.publication.entryFile;
  const fullPath = selected ? publicationPath(result, selected) : null;
  if (
    !selected
    || !fullPath
    || !manifest.files.some((file) => file.path === fullPath && file.contentType.startsWith("text/html"))
  ) {
    return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  }
  const slug = result.publication.slug;
  const title = result.publication.title || result.project.name;
  return c.html(renderScopedDocumentShell({
    user: null,
    namespace: slug,
    title,
    basePath: `/p/${encodeURIComponent(slug)}`,
    selectedPath: selected,
    publicDocument: true,
  }), 200, {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  });
});

export default app;
