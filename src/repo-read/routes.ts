/**
 * The authorized read path for ingested repository snapshots (#234), mounted
 * before the session middleware. Order on every request: parse the URL,
 * authorize (cookie, ticket or permission source), and only then resolve
 * ref → commit → manifest → object through memory, the edge cache and R2.
 * Denials are a plain 404 with no validators; "could not check" is #225's
 * retryable 503. See docs/TECHNICAL.md, "Repository read path".
 */
import { Hono, type Context } from "hono";
import { contentSealer } from "@/ingest/orchestrator/sealing";
import { r2Store, type R2BucketLike } from "@/ingest/orchestrator/store";
import type { ManifestFile, SnapshotManifest } from "@/ingest/orchestrator/snapshot";
import { CONVEX_URL, IMAGE_PROXY_SECRET, REPO_CAPABILITY_SECRET, REPO_CONTENT_KEY, REPO_CONTENT_KEY_PREVIOUS } from "@/config";
import { verifyImageProxyPath } from "@/image-proxy";
import { nonceAttribute } from "@/middleware/html-nonce";
import { sessionViewer } from "@/middleware/session";
import { renderScopedDocumentShell } from "@/routes/app";
import { assetError } from "@/routes/asset-headers";
import { renderNotFoundPage } from "@/routes/not-found";
import { serveObject } from "@/routes/object-delivery";
import { d1SearchIndex, type SearchD1 } from "@/search/d1";
import type { SearchIndex } from "@/search/index";
import { treePageCursor } from "@/routes/tree-pages";
import { unavailableResponse, viewerErrorCache, viewerErrorResponse } from "@/routes/viewer-unavailable";
import { validTreeDirectory } from "@/deployment-index";
import { isCanonicalStorageKey } from "@/storage-boundary";
import { storageKeyRepoId } from "@/ingest/orchestrator/keys";
import { ViewerBackendError } from "@/viewer-backend";
import { viewerScript, viewerUpdateNotice } from "@/viewer/markup";
import { RUM_VERSION } from "@/viewer/asset-versions";
import { kvRevocationEpochs, kvVisibilityEpochs, serviceRepoPermissions, type Fetcher, type KvReader } from "./access";
import { authorizeRepo, authorizeTicket, mintTicket, type Authorization, type AuthorizeDependencies } from "./authorize";
import {
  COMMENT_GRANT_MIN_MS, commentAccess, commentorScript, commentSnapshot, convexCommentGrants, convexCommentSnapshots, type CommentGrants, type CommentSnapshots,
} from "./comments";
import { durableFirstView, interpretOutcome, prepareRepo, PREPARE_WINDOW_MS, repoIngestTarget, touchRepo, type RepoFirstView } from "./first-view";
import { FRAME_TEMPLATE_TAG, FRAME_VERSION, failureBody, frameBody, frameContentSecurityPolicy, needsRelativeRewrite, renderFrameDocument } from "./frame";
import type { RepoGrant } from "./grant";
import { encodeRepoPath, parseRepoPath, repoBase, type RepoRefSpec, type RepoRequestPath } from "./paths";
import { READINESS_HEADER, renderPreparingPage, type PreparingState } from "./preparing";
import { searchManifest } from "./search";
import { isPagePath, manifestFile, readDeadline, RepoSnapshots, type EdgeCache } from "./snapshot";
import { SHARED_CACHE_PATH, SHARED_CACHE_TTL_SECONDS, sharedCacheReader, verifySharedCachePath, type SharedCacheProbe } from "./shared-cache";
import { REPO_SPECULATION_RULES_PATH, repoSpeculationRules } from "./speculation";
import { ReadTiming } from "./timing";
import { treePage } from "./tree";
import { requireCookieWrite } from "../../shared/request-admission";

/** As on the other delivery routes: a stalled store becomes a retryable 503. */
const READ_TIMEOUT_MS = 10_000;
/** How long a first-view request waits for the ingest before it renders the preparing page (#242). */
const PREPARING_RETRY_SECONDS = 5;
const IMMUTABLE = "max-age=31536000, immutable";
/** Branch URLs: a short freshness window, then revalidation by ETag; stale copies survive an outage. */
const BRANCH = "max-age=10, stale-if-error=86400";

/** Private-repository content is sealed (#263); opened per read, after authorization. */
const sealer = contentSealer(REPO_CONTENT_KEY, REPO_CONTENT_KEY_PREVIOUS);

const IMAGE_TYPES: Record<string, string> = {
  avif: "image/avif", bmp: "image/bmp", gif: "image/gif", ico: "image/x-icon", jpeg: "image/jpeg",
  jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", webp: "image/webp",
};

type Representation = "html" | "json" | "asset";

interface Services {
  authorize: AuthorizeDependencies;
  snapshots: RepoSnapshots;
  waitUntil: (promise: Promise<unknown>) => void;
  /** Set only where the ingest coordinator Durable Object is configured; first views enqueue there. */
  firstView: RepoFirstView | null;
  /** Where comment grants are recorded (#254). */
  comments: CommentGrants;
  /** Where the shell's first page of a document's threads comes from (#284). */
  commentSnapshots: CommentSnapshots;
  /** Set only where the repository search index is bound (#251); the search URL is otherwise the plain 404. */
  search: SearchIndex | null;
  /** The visibility epoch a repository is at now: the shared-cache route re-checks every signed URL against it (#242). */
  visibilityEpoch: (repoId: number) => Promise<number>;
  /** Dev-only (REPO_SHARED_CACHE_DEBUG): what the platform's cache said about the request's last shared-cache subrequest. */
  sharedProbe: { last: string | null } | null;
  /** The request's `Server-Timing` phases (#282). */
  timing: ReadTiming;
}

/**
 * Each request's phases, and whether it was authorized. Only an authorized
 * read reports them: a denial stays byte-for-byte the response for a
 * repository that does not exist, headers included.
 */
type TimingRecord = { timing: ReadTiming; granted: boolean };
const requestTimings = new WeakMap<Request, TimingRecord>();

/** The preparing/retry page a first-view outcome leaves the reader on (#242). */
function readinessResponse(c: Context, state: PreparingState): Response {
  c.header("Cache-Control", "private, no-store");
  c.header(READINESS_HEADER, state);
  c.header("Retry-After", String(PREPARING_RETRY_SECONDS));
  return c.html(renderPreparingPage(state, PREPARING_RETRY_SECONDS), state === "preparing" ? 200 : 503);
}

function hasMethods(value: unknown, names: string[]): boolean {
  return typeof value === "object" && value !== null && names.every(name => typeof (value as Record<string, unknown>)[name] === "function");
}

/** The surface exists only where its bindings are configured; elsewhere every URL under /r/ is a 404. */
function services(c: Context, timing = new ReadTiming()): Services | null {
  const env = (c.env ?? {}) as Record<string, unknown>;
  const bucket = env.REPO_CONTENT, epochs = env.REPO_EPOCHS, access = env.REPO_ACCESS, search = env.REPO_SEARCH;
  if (!hasMethods(bucket, ["get", "head", "put", "list"]) || !hasMethods(epochs, ["get"]) || !hasMethods(access, ["fetch"])) return null;
  const waitUntil = (promise: Promise<unknown>) => {
    try {
      c.executionCtx.waitUntil(promise);
    } catch {
      // No execution context (Node): the work runs unattended. Nothing handed here ever rejects.
    }
  };
  const edge = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;
  const now = () => Date.now();
  const origin = new URL(c.req.url).origin;
  const visibility = kvVisibilityEpochs(epochs as KvReader);
  const visibilityEpoch = (repoId: number) => visibility.visibilityEpoch(repoId);
  // A dev-only diagnostic: surface the subrequest's CF-Cache-Status/Age so a shared-tier hit is provable.
  const sharedProbe = process.env.REPO_SHARED_CACHE_DEBUG === "1" ? { last: null as string | null } : null;
  const probe = sharedProbe && ((info: SharedCacheProbe) => { sharedProbe.last = `cf=${info.cacheStatus ?? "-"}; age=${info.age ?? "-"}`; });
  return {
    authorize: {
      secret: REPO_CAPABILITY_SECRET, permissions: serviceRepoPermissions(access as Fetcher), epochs: kvRevocationEpochs(epochs as KvReader),
      identity: sessionViewer, now, waitUntil,
    },
    snapshots: new RepoSnapshots({
      store: readDeadline(r2Store(bucket as R2BucketLike), READ_TIMEOUT_MS), sealer, edge,
      origin, shared: sharedCacheReader(REPO_CAPABILITY_SECRET, origin, visibilityEpoch, fetch, probe ?? undefined), waitUntil, now, timing,
    }),
    waitUntil,
    firstView: durableFirstView(env.REPO_INGEST),
    comments: convexCommentGrants,
    commentSnapshots: convexCommentSnapshots,
    // The search index is optional: without a D1 binding the search URL is the plain 404.
    search: hasMethods(search, ["prepare", "batch", "exec"]) ? d1SearchIndex(search as SearchD1) : null,
    visibilityEpoch,
    sharedProbe,
    timing,
  };
}

/** A signed image proxy path (#224) that ingest wrote for an external image. */
async function isProxiedImage(src: string): Promise<boolean> {
  return await verifyImageProxyPath(IMAGE_PROXY_SECRET, src) !== null;
}

/** Unparsed URLs are answered like files: a page for navigations, an empty body for subresources. */
function representation(target: RepoRequestPath["target"]["kind"] | undefined): Representation {
  if (target === "shell") return "html";
  return target === "tree" || target === "viewer-ticket" || target === "comment-access" || target === "search" ? "json" : "asset";
}

/** Plain 404: no validators, no retry hint, never cached; capability URLs are never echoed. */
function notFound(c: Context, kind: Representation): Response {
  c.header("Cache-Control", "private, no-store");
  if (kind === "json") return c.json({ error: "Not found" }, 404);
  if (kind === "html") return c.html(renderNotFoundPage({ path: c.req.path }), 404);
  return assetError(c, () => renderNotFoundPage({ path: "Document unavailable" }));
}

function cachePolicy(grant: RepoGrant, ref: RepoRefSpec): string {
  return `${grant.repo.private ? "private" : "public"}, ${ref.kind === "commit" ? IMMUTABLE : BRANCH}`;
}

/** The snapshot a ref serves. A pointer to a missing snapshot is a broken store (503), never "not found".
 * A fresh pointer read skips the memoized "never ingested" miss the same request may have just cached. */
async function resolveSnapshot(
  snapshots: RepoSnapshots, grant: RepoGrant, ref: RepoRefSpec, freshPointer = false,
): Promise<SnapshotManifest | null> {
  if (ref.kind === "commit") return snapshots.manifest(grant, ref.commit);
  const pointer = await snapshots.pointer(grant, ref.kind === "branch" ? ref.branch : grant.repo.defaultBranch, freshPointer);
  if (!pointer) return null;
  const manifest = await snapshots.manifest(grant, pointer.commit, pointer.rendererVersion);
  if (!manifest) throw new ViewerBackendError();
  return manifest;
}

/** Dev-only (REPO_SHARED_CACHE_DEBUG): a diagnostic header on an otherwise final response. */
function withDebugHeader(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  headers.delete("Content-Length");
  return new Response(response.body, { status: response.status, headers });
}

function isPage(manifest: SnapshotManifest) {
  return (path: string) => isPagePath(path) && manifestFile(manifest, path) !== null;
}

function shell(c: Context, grant: RepoGrant, request: RepoRequestPath, manifest: SnapshotManifest): Response {
  const selected = c.req.query("doc") ?? manifest.docs?.entry;
  if (!selected || !isCanonicalStorageKey(selected) || !isPage(manifest)(selected)) return notFound(c, "html");
  const pinned = repoBase(request.owner, request.name, { kind: "commit", commit: manifest.commit });
  // The shell holds the one comments connection (#254); frames only talk to it. Without a Convex URL the shell loads no client.
  // It names the document the shell opens with, so its first access request can bring that page's first comments (#284).
  const repoCommentConfig = {
    repoId: grant.repo.id, accessUrl: `${repoBase(request.owner, request.name, { kind: "default" })}/comment-access`, convexUrl: CONVEX_URL, documentPath: selected,
  };
  const html = renderScopedDocumentShell({
    user: null, namespace: request.name, title: `${request.owner}/${request.name}`,
    basePath: repoBase(request.owner, request.name, request.ref), frameBase: pinned, selectedPath: selected, copyLink: true, repoCommentConfig, repoSearch: true,
  });
  // Private frames load their images through tickets, which only the trusted shell may renew.
  const ticketRenewal = grant.repo.private ? viewerUpdateNotice() + viewerScript("parent", { base: pinned }) : "";
  // Real-user monitoring (#282): async, so it never holds up parsing or the first document.
  const monitoring = `<script${nonceAttribute()} async src="/rum.js?v=${RUM_VERSION}"></script>\n`;
  const body = html.replace("</body>", ticketRenewal + monitoring + "</body>");
  // Revalidated on every navigation (each response has its own nonce), but never no-store: back/forward cache stays usable.
  // The shell points at same-origin speculation rules so Chromium prefetches the frames the sidebar links to (#245).
  return c.html(body, 200, { "Cache-Control": "private, no-cache", "Speculation-Rules": `"${REPO_SPECULATION_RULES_PATH}"` });
}

async function tree(c: Context, grant: RepoGrant, request: RepoRequestPath, manifest: SnapshotManifest, services: Services): Promise<Response> {
  const directory = c.req.query("dir");
  const page = treePageCursor(c.req.query("cursor"));
  if (directory === undefined || !validTreeDirectory(directory) || page === null) {
    c.header("Cache-Control", "private, no-store");
    return c.json({ error: "Invalid tree page" }, 400);
  }
  const sidebar = await services.snapshots.sidebar(grant, manifest);
  const result = sidebar ? treePage(sidebar, isPage(manifest), directory, page) : null;
  return c.json({ children: result?.children ?? [], cursor: result?.more ? String(page + 1) : null }, 200, {
    "Cache-Control": cachePolicy(grant, request.ref),
    ETag: `"tree-${manifest.commit}-r${manifest.rendererVersion}"`,
  });
}

async function search(c: Context, manifest: SnapshotManifest, services: Services): Promise<Response> {
  c.header("Cache-Control", "private, no-store");
  // No index bound (production, until P-deploy provisions one): the URL does not exist.
  if (!services.search) return notFound(c, "json");
  const limit = c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit"));
  const index = services.search;
  const outcome = await services.timing.time("search", () => searchManifest(index, manifest, c.req.query("q") ?? "", limit));
  if (outcome.status === "invalid") return c.json({ error: "Invalid search query" }, 400);
  return c.json(outcome);
}

interface Delivery {
  grant: RepoGrant;
  request: RepoRequestPath;
  file: ManifestFile;
  path: string;
  services: Services;
  ticket: string | null;
  /** A listed object storage no longer has: the ordinary 404, as on the other delivery routes (#94). */
  missing: () => Response;
}

async function frame(c: Context, manifest: SnapshotManifest, { grant, request, file, path, services, ticket, missing }: Delivery): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const base = repoBase(request.owner, request.name, request.ref);
  const pinned = repoBase(request.owner, request.name, { kind: "commit", commit: manifest.commit });
  // Version-3 renders already carry document-relative URLs (#242); only older
  // snapshots need the rewrite, and the variant key keeps both derived forms
  // apart in memory. The body depends only on the render key (which names the
  // page's directory), so it is derived once per isolate.
  const variant = `${needsRelativeRewrite(manifest.rendererVersion) ? "legacy-" : ""}frame-v${FRAME_VERSION}`;
  const page = file.render === undefined ? { title: null, body: failureBody(file.error ?? "missing") }
    : await services.snapshots.page(grant, file, variant, async rendered => ("html" in rendered
      ? {
        title: rendered.title,
        body: needsRelativeRewrite(manifest.rendererVersion) ? await frameBody(rendered.html, path, isProxiedImage) : rendered.html,
      }
      : { title: null, body: failureBody(rendered.error) }));
  // Every reader gets the same frame (it may be cached publicly); the shell decides what the widget may do.
  const widget = file.render === undefined ? "" : commentorScript(origin, grant.repo.id, path, file);
  let head = viewerScript("navigation", { prefix: `${base}/files/`, documentPath: path }, c.req.url);
  if (grant.repo.private) {
    // Requests from the opaque frame carry no cookies: images inherit the ticket through the base URL.
    const prefix = `${pinned}/view/${ticket ?? await mintTicket(services.authorize, grant, manifest.commit)}/files/`;
    head = `<base data-rendro-viewer href="${prefix}${encodeRepoPath(path)}">\n`
      + viewerScript("frame", { base: pinned, prefix, manifestKey: manifest.commit, deploymentId: manifest.commit }, c.req.url)
      + viewerScript("navigation", { prefix: `${base}/files/`, ticketBase: `${pinned}/view/`, documentPath: path }, c.req.url);
  }
  const title = page.title ?? path.slice(path.lastIndexOf("/") + 1);
  const bytes = new TextEncoder().encode(renderFrameDocument({ title, body: page.body, origin, head: `${head}\n${widget}` }));
  return serveObject({
    request: c.req.raw,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": frameContentSecurityPolicy(origin),
      "Cache-Control": ticket ? "private, max-age=900" : cachePolicy(grant, request.ref),
    },
    // A public frame is fixed by its URL and render key; a private one embeds a per-reader ticket and has no validator.
    // Generated documents are never ranged.
    etag: grant.repo.private ? undefined : `"page-${file.render ?? `${file.sha}-${file.error}`}-${FRAME_TEMPLATE_TAG}"`,
    transform: stream => stream,
    open: () => Promise.resolve(new Blob([bytes]).stream()),
    missing,
  });
}

async function asset(c: Context, { grant, request, file, path, services, ticket, missing }: Delivery): Promise<Response> {
  if (file.error !== undefined) return missing();
  const type = IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
  const headers = {
    "Content-Type": type,
    // Bytes from a repository never run as a document, even when navigated to (SVG).
    "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'self'",
    "Cache-Control": ticket ? "private, max-age=900" : cachePolicy(grant, request.ref),
  };
  return serveObject({
    request: c.req.raw, headers, etag: `"git-${file.sha}"`, size: file.size,
    open: async range => {
      const bytes = await services.snapshots.asset(grant, file);
      return bytes && new Blob([(range ? bytes.subarray(range.start, range.end + 1) : bytes) as Uint8Array<ArrayBuffer>]).stream();
    },
    missing,
  });
}

async function renewal(c: Context, grant: RepoGrant, request: RepoRequestPath, manifest: SnapshotManifest, services: Services): Promise<Response> {
  c.header("Cache-Control", "private, no-store");
  // Only a cookie-authorized reader of a private repository renews, and only for this commit.
  if (!grant.repo.private || grant.viewer === null || c.req.query("manifestKey") !== manifest.commit) return notFound(c, "json");
  const pinned = repoBase(request.owner, request.name, { kind: "commit", commit: manifest.commit });
  return c.json({ prefix: `${pinned}/view/${await mintTicket(services.authorize, grant, manifest.commit)}/files/` });
}

/** A repository page the shell may ask the first comments of: a canonical repository path, as Convex accepts it. */
const MAX_SNAPSHOT_PATH_LENGTH = 1_024;

/**
 * Record the reader's comment access in Convex (#254). Only the trusted shell asks: a same-origin POST. The shell's
 * first request names the document it shows (`?path=`), and the answer then carries that document's first thread
 * page too (#284), read for this reader in parallel with the grant and returned only when the grant was recorded,
 * so the drawer and highlights need not wait for the Convex socket. A page that could not be read is left out: the
 * live subscription still delivers it.
 */
async function commentAccessResponse(c: Context, grant: RepoGrant, services: Services): Promise<Response> {
  c.header("Cache-Control", "private, no-store");
  const path = c.req.query("path");
  const wanted = path !== undefined && path.length <= MAX_SNAPSHOT_PATH_LENGTH && isCanonicalStorageKey(path) ? path : null;
  const [access, threads] = await Promise.all([
    commentAccess(services.comments, grant, services.authorize.now()),
    wanted === null ? null : commentSnapshot(services.commentSnapshots, grant, wanted).catch(() => null),
  ]);
  if (!access) return notFound(c, "json");
  return c.json({
    repoId: grant.repo.id, private: grant.repo.private, expiresAt: access.expiresAt,
    ...(threads ? { threads: { path: wanted, page: threads.page, isDone: threads.isDone } } : {}),
  });
}

function setAuthorizationCookies(c: Context, authorization: Authorization): void {
  // Cookie changes ride on denials and private responses only: a public response may be cached by anyone.
  if (authorization.kind === "denied" || (authorization.kind === "granted" && authorization.grant.repo.private)) {
    for (const cookie of authorization.cookies) c.header("Set-Cookie", cookie, { append: true });
  }
}

const app = new Hono();
app.use("/r/*", viewerErrorCache);
// Wraps every read, so the total spans the handler and the error mapping (#282).
app.use("/r/*", async (c, next) => {
  const record: TimingRecord = { timing: new ReadTiming(), granted: false };
  requestTimings.set(c.req.raw, record);
  await next();
  if (record.granted) c.header("Server-Timing", record.timing.header(), { append: true });
});
// Chromium reads this from the shell's `Speculation-Rules` header. Same-origin JSON, never under /r/
// so a reader's capability cookie cannot reach it. The rules are constant and tiny; the Worker serves
// every route private by default, so this one is too rather than holding a cacheable public copy.
app.get(REPO_SPECULATION_RULES_PATH, (c) => c.body(repoSpeculationRules(), 200, {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
}));
// Storage faults and broken snapshots surface here; tree pages and renewals are read by scripts and get JSON.
app.onError((error, c) => viewerErrorResponse(error, c, representation(parseRepoPath(new URL(c.req.url).pathname)?.target.kind) === "json"));

// The cacheable read path for public immutable objects (#242), reached only by this Worker's own
// subrequest (see shared-cache.ts). The path is signed over `public\n<epoch>\n<storage key>`, so it
// can only ever hold objects the Worker decided are public, and a private key has no valid signature.
// Before serving, the repository's visibility epoch is re-read: a URL minted before the repository
// was privatized (or left by its installation) no longer matches and is the plain 404 — never a
// stale allow. An epoch store that cannot answer is a retryable 503, also never an allow. Reads
// straight from R2: this route *is* the fill, so it must not recurse into the layered reader.
app.get(`${SHARED_CACHE_PATH}*`, async (c) => {
  const noStore = { "Cache-Control": "private, no-store" };
  const configured = services(c);
  if (!configured) return c.body(null, 404, noStore);
  const verified = await verifySharedCachePath(REPO_CAPABILITY_SECRET, c.req.path);
  if (verified === null) return c.body(null, 404, noStore);
  const repoId = storageKeyRepoId(verified.storageKey);
  if (repoId === null) return c.body(null, 404, noStore);
  let epoch: number;
  try {
    epoch = await configured.visibilityEpoch(repoId);
  } catch {
    return c.body(null, 503, { ...noStore, "Retry-After": String(PREPARING_RETRY_SECONDS) });
  }
  if (epoch !== verified.epoch) return c.body(null, 404, noStore);
  const bytes = await configured.snapshots.raw(verified.storageKey);
  if (!bytes) return c.body(null, 404, noStore);
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "application/octet-stream",
      // Immutable and content-addressed: let the colo cache and every tier above it keep it.
      "Cache-Control": `public, max-age=${SHARED_CACHE_TTL_SECONDS}, immutable`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

app.get("/r/*", async (c) => {
  c.header("Referrer-Policy", "no-referrer");
  const request = parseRepoPath(new URL(c.req.url).pathname);
  // Set by the middleware above for every request under /r/.
  const record = requestTimings.get(c.req.raw) as TimingRecord;
  const configured = services(c, record.timing);
  const kind = representation(request?.target.kind);
  // Comment access changes state, so it is POST only (below).
  if (!request || !configured) return notFound(c, kind);
  const { target } = request;
  if (target.kind === "comment-access") return notFound(c, kind);

  const authorization: Authorization = await configured.timing.time("auth", () => target.kind === "ticket-files"
    ? authorizeTicket(configured.authorize, target.ticket, request.owner, request.name, (request.ref as { commit: string }).commit)
    : authorizeRepo(configured.authorize, c.req.raw, request.owner, request.name));
  setAuthorizationCookies(c, authorization);
  if (authorization.kind === "unavailable") return unavailableResponse(c, { unavailable: true, retryAfter: authorization.retryAfter }, kind);
  if (authorization.kind === "denied") return notFound(c, kind);
  record.granted = true;
  const { grant } = authorization;
  const scope = configured;
  const path = request;

  async function respond(target: Exclude<RepoRequestPath["target"], { kind: "comment-access" }>, manifest: SnapshotManifest): Promise<Response> {
    if (target.kind === "shell") return shell(c, grant, path, manifest);
    if (target.kind === "tree") return tree(c, grant, path, manifest, scope);
    if (target.kind === "search") return search(c, manifest, scope);
    if (target.kind === "viewer-ticket") return renewal(c, grant, path, manifest, scope);
    const file = manifestFile(manifest, target.path);
    if (!file) return notFound(c, kind);
    const delivery: Delivery = {
      grant, request: path, file, path: target.path, services: scope, ticket: target.kind === "ticket-files" ? target.ticket : null,
      missing: () => notFound(c, "asset"),
    };
    return isPagePath(target.path) ? frame(c, manifest, delivery) : asset(c, delivery);
  }

  let manifest = await resolveSnapshot(configured.snapshots, grant, request.ref);
  if (!manifest) {
    // First view of a repository or branch with no snapshot yet (#242): only
    // the shell of a branch URL enqueues; a commit URL or any other target is
    // a plain 404 that neither leaks nor builds, and so is an unauthorized
    // visit above. The outcome may land inside this request's window.
    if (configured.firstView === null || target.kind !== "shell" || request.ref.kind === "commit") return notFound(c, kind);
    const branch = request.ref.kind === "branch" ? request.ref.branch : grant.repo.defaultBranch;
    const { repo } = repoIngestTarget(grant, branch);
    let attempt;
    try {
      const firstView = configured.firstView;
      attempt = await configured.timing.time("first-view", () => prepareRepo(firstView, repo, branch, PREPARE_WINDOW_MS, configured.waitUntil));
    } catch {
      // Only the ensurer's transport raises here: could-not-check is #225's retryable 503.
      return unavailableResponse(c, { unavailable: true, retryAfter: String(PREPARING_RETRY_SECONDS) }, kind);
    }
    if (attempt.outcome) {
      const state = interpretOutcome(attempt.outcome);
      if (state === "ready") {
        // The coordinator promises a pointer; without one here the store is broken (retryable 503).
        manifest = await resolveSnapshot(configured.snapshots, grant, request.ref, true);
        if (!manifest) throw new ViewerBackendError();
      } else if (state === "preparing") {
        return readinessResponse(c, "preparing");
      } else if (state === "failed") {
        return readinessResponse(c, "failed");
      } else {
        return notFound(c, kind);
      }
    }
    if (!manifest) return readinessResponse(c, "preparing");
  }
  // Idle expiry's last access (#263): unattended, at most once an hour per isolate.
  touchRepo(configured.firstView, grant, configured.authorize.now(), configured.waitUntil);
  const response = await respond(target, manifest);
  // The subrequest ran inside this request; only a dev-flagged deployment names it (REPO_SHARED_CACHE_DEBUG).
  const diagnostic = scope.sharedProbe?.last;
  return diagnostic && response.status === 200 ? withDebugHeader(response, "X-Repo-Shared-Cache", diagnostic) : response;
});

app.post("/r/*", async (c) => {
  c.header("Referrer-Policy", "no-referrer");
  const request = parseRepoPath(new URL(c.req.url).pathname);
  const configured = services(c);
  if (!request || !configured || request.target.kind !== "comment-access") return notFound(c, "json");
  // Same-origin only, by the rule every cookie write follows (this route mounts before writeAdmission).
  try {
    requireCookieWrite(c.req.raw, process.env.SITE_URL ?? new URL(c.req.url).origin, false);
  } catch {
    return notFound(c, "json");
  }
  // A grant must outlive the shell's renewal halfway through it, so access never lapses between renewals.
  const authorization = await authorizeRepo(configured.authorize, c.req.raw, request.owner, request.name, COMMENT_GRANT_MIN_MS);
  setAuthorizationCookies(c, authorization);
  if (authorization.kind === "unavailable") return unavailableResponse(c, { unavailable: true, retryAfter: authorization.retryAfter }, "json");
  if (authorization.kind === "denied") return notFound(c, "json");
  return commentAccessResponse(c, authorization.grant, configured);
});

export default app;
