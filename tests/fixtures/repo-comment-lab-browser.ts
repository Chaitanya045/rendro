import { CommentorParentHost, keepRepoCommentAccess, type DocumentCommentBackend } from "../../src/commentor/parent-host";

/*
 * The repository shell's comments (#284) with the real host, access renewal and widget, and Convex replaced by an
 * in-memory model with latency: one round trip to Convex costs `rtt`, the shell's requests to the Worker cost `edge`
 * on top, and the socket cannot run a query before it has connected and authenticated (`socket` after boot). The
 * Worker's comment-access answer is modelled too: it records the grant (and reads the snapshot) one Convex round trip
 * in. A query computed before the grant exists sees the empty page Convex gives a reader without one, and is pushed
 * again once the grant lands, as a reactive query is.
 *
 * `?mode=before` boots in main's order before #284 (session check first, then access, no snapshot, the live
 * subscription at once); `?mode=after` in the order this change boots (access with the opening page at once, in
 * parallel with the session check, the live subscription held until its answer).
 */
type Thread = { path: string; _id: string; _creationTime: number; authorName: string; authorEmail: string; body: string; anchor: unknown; resolved: boolean; archived: boolean; canDelete: boolean; replies: unknown[]; clientOperationId?: string };

const query = new URLSearchParams(location.search);
const mode = query.get("mode") === "before" ? "before" : "after";
// The socket can run an authenticated query once the session check and the Convex token are back (two Worker
// round trips that each reach Convex); its handshake overlaps them.
const model = { rtt: Number(query.get("rtt") ?? 200), edge: Number(query.get("edge") ?? 30), socket: Number(query.get("socket") ?? 460) };
const boot = Date.now();
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

let sequence = 0;
const thread = (overrides: Partial<Thread>): Thread => ({
  path: "guide.md", _id: `thread-${++sequence}`, _creationTime: 1_000 + sequence, authorName: "Ada", authorEmail: "", body: "", anchor: { kind: "element", path: ["main", "h1"] },
  resolved: false, archived: false, canDelete: false, replies: [], ...overrides,
});

/** Set by the test before the page runs: what Convex holds, and what the snapshot reads if it differs (stale). */
const seed = (window as unknown as { labSeed?: { threads: Partial<Thread>[]; snapshot?: Partial<Thread>[] } }).labSeed;

const lab = {
  mode,
  boot,
  threads: (seed?.threads ?? []).map(thread),
  snapshot: seed?.snapshot ? seed.snapshot.map(thread) : null,
  /** The Worker's answer: "granted", or a denial (404). */
  access: (query.get("access") ?? "granted") as "granted" | "denied",
  grantAt: Number.POSITIVE_INFINITY,
  frameLoadedAt: 0,
  calls: [] as Array<{ method: string; args: Record<string, unknown> }>,
  pushes: [] as Array<() => void>,
  /** While set, the first access answer waits for `answer()`. */
  holdAccess: query.has("holdAccess"),
  answer: null as (() => void) | null,
  /** Every comment toast any frame showed, as the frames report them. */
  toasts: [] as string[],
  /** While set, writes wait for `release` (true: fail it). */
  holdWrites: false,
  release: null as ((fail: boolean) => void) | null,
  subscribers: [] as Array<() => void>,
  page(path: string): Thread[] {
    return Date.now() >= lab.grantAt ? lab.threads.filter(candidate => candidate.path === path) : [];
  },
};

// The Worker's comment access (and, when the shell names a page, its first thread page), behind the shell's fetch.
const accessUrl = "/r/octo/docs/comment-access";
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input), location.origin);
  if (url.pathname === "/api/auth/get-session") {
    await wait(model.edge + model.rtt);
    return Response.json({ user: { id: "user-a" } });
  }
  if (url.pathname !== accessUrl) return realFetch(input, init);
  const path = url.searchParams.get("path");
  await wait(model.edge / 2 + model.rtt / 2);
  if (lab.holdAccess) {
    lab.holdAccess = false;
    await new Promise<void>(resolve => { lab.answer = resolve; });
  }
  if (lab.access === "denied") {
    await wait(model.edge / 2 + model.rtt / 2);
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // The grant and the snapshot are read together at Convex.
  lab.grantAt = Math.min(lab.grantAt, Date.now());
  const page = (lab.snapshot ?? lab.threads).filter(candidate => candidate.path === path);
  for (const push of lab.pushes.splice(0)) setTimeout(push, model.rtt / 2);
  await wait(model.edge / 2 + model.rtt / 2);
  return Response.json({
    repoId: 9001, private: true, expiresAt: Date.now() + 5 * 60_000,
    ...(path ? { threads: { path, page, isDone: true } } : {}),
  });
};

const socketReady = boot + model.socket;
const backend: DocumentCommentBackend = {
  subscribe(scope, update) {
    let open = true;
    const publish = () => { if (open) update(lab.page(scope.documentPath), { canLoadMore: false, loading: false }); };
    // Convex's paginated client first reports an empty page that is still loading.
    queueMicrotask(() => { if (open) update([], { canLoadMore: false, loading: true }); });
    const computedAt = Math.max(Date.now(), socketReady) + model.rtt / 2;
    setTimeout(() => {
      // Computed before the grant existed: the empty page now, the real one when the grant's write re-runs it.
      if (computedAt < lab.grantAt) lab.pushes.push(publish);
      setTimeout(publish, model.rtt / 2);
    }, computedAt - Date.now());
    lab.subscribers.push(publish);
    return { unsubscribe() { open = false; }, loadMore: () => false };
  },
  subscribeReplies() {
    return { unsubscribe() {}, loadMore: () => false };
  },
  async mutate(method, scope, args) {
    const values = args as Record<string, unknown>;
    lab.calls.push({ method, args: values });
    if (lab.holdWrites && !await new Promise<boolean>(resolve => { lab.release = fail => resolve(!fail); })) throw new Error("private backend detail");
    await wait(model.rtt / 2);
    if (method === "thread.create") lab.threads.push(thread({ path: scope.documentPath, body: values.body as string, anchor: values.anchor, authorName: "Me", canDelete: true, clientOperationId: values.clientOperationId as string }));
    // Convex pushes the subscriptions' new results before it acknowledges the write.
    await wait(model.rtt / 2);
    for (const publish of lab.subscribers) publish();
    return null;
  },
};

// The frames report every toast they show (a lab-only message the host ignores).
addEventListener("message", event => {
  const data = event.data as { type?: unknown; text?: unknown } | null;
  if (data?.type === "lab-toast" && typeof data.text === "string") lab.toasts.push(data.text);
});

const frame = document.querySelector<HTMLIFrameElement>("#content-frame")!;
// The lab's shell names the frame's document in its own HTML: that document is the shell's (#296). Its later loads are
// not tracked, as the lab's tests reload and move the frame themselves.
Object.assign(frame.dataset, { navigation: "1", document: "1" });
frame.addEventListener("load", () => { lab.frameLoadedAt = Date.now(); }, { once: true });
const config = { repoId: 9001, accessUrl, convexUrl: "http://unused.test", documentPath: "guide.md" };

async function start() {
  if (mode === "after") {
    // As bootCommentorParentHost: access at once, with the opening page; the host holds live until its answer.
    let answer: { snapshot: Parameters<CommentorParentHost["accessAnswered"]>[0] } | null = null;
    let host: CommentorParentHost | null = null;
    let writable: boolean | null = null;
    keepRepoCommentAccess(accessUrl, value => { writable = value; host?.setWritable(value); }, {
      documentPath: config.documentPath,
      onAnswer: snapshot => { answer = { snapshot }; host?.accessAnswered(snapshot); },
    });
    await (await window.fetch("/api/auth/get-session")).json();
    host = new CommentorParentHost(frame, location.origin, config, backend, "user-a");
    if (writable !== null) host.setWritable(writable);
    if (answer) host.accessAnswered((answer as { snapshot: Parameters<CommentorParentHost["accessAnswered"]>[0] }).snapshot);
    else host.holdLive();
    host.start(lab.frameLoadedAt > 0);
    Object.assign(lab, { host });
    return;
  }
  // Main before #284: the session check, then the host and its live subscription, then access.
  await (await window.fetch("/api/auth/get-session")).json();
  const host = new CommentorParentHost(frame, location.origin, config, backend, "user-a");
  host.start(lab.frameLoadedAt > 0);
  keepRepoCommentAccess(accessUrl, writable => host.setWritable(writable));
  Object.assign(lab, { host });
}

Object.assign(window, { lab });
void start();
export type RepoCommentLab = typeof lab;
