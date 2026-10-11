import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentOperationState } from "../src/commentor/operation-state";
import { renderCommentRecoveryLifecycle, syncCommentRecoveryUser } from "../src/commentor/recovery-session";
import { bootCommentorParentHost } from "../src/commentor/parent-host";
import { COMMENTOR_PARENT_READY } from "../src/commentor/parent-protocol";

const clients = vi.hoisted(() => ({ onUpdate: vi.fn(() => () => {}), setAuth: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }));
vi.mock("convex/browser", () => ({ ConvexClient: class {
  onUpdate = clients.onUpdate;
  setAuth = clients.setAuth;
  close = clients.close;
} }));
const windows: Window[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const win of windows.splice(0)) await win.happyDOM.close();
});
function windowFixture() {
  const win = new Window({ url: "https://rendro.test/docs", settings: { enableJavaScriptEvaluation: true, disableIframePageLoading: true } });
  windows.push(win);
  return win;
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe("comment recovery session ownership", () => {
  it("validates the envelope owner and discards mismatched or corrupt entries", () => {
    const win = windowFixture();
    const storage = win.sessionStorage as unknown as Storage;
    for (const value of [JSON.stringify({ userId: "A", drafts: { create: { body: "Secret" } }, operations: {} }), "broken", JSON.stringify({ userId: "B", drafts: [] })]) {
      storage.setItem("key", value);
      expect(new CommentOperationState(storage, "key", "B").value).toEqual({ operations: {}, drafts: {} });
      expect(storage.getItem("key")).toBeNull();
    }
  });

  it.each(["a", "form"])("the rendered %s sign-out control clears all document namespaces without clearing unrelated storage", (tag) => {
    const win = windowFixture();
    const storage = win.sessionStorage as unknown as Storage;
    syncCommentRecoveryUser(storage, "A");
    storage.setItem('commentor-operations:["A","doc1"]', "private");
    storage.setItem('commentor-operations:["A","doc2"]', "private");
    storage.setItem("unrelated", "keep");
    win.eval(renderCommentRecoveryLifecycle("A").replace(/^<script>|<\/script>$/g, ""));
    expect(storage.length).toBe(4);
    const control = win.document.createElement(tag);
    control.setAttribute(tag === "a" ? "href" : "action", "/api/auth/sign-out");
    win.document.body.append(control);
    control.dispatchEvent(new win.Event(tag === "a" ? "click" : "submit", { bubbles: true }));
    expect(storage.length).toBe(1);
    expect(storage.getItem("unrelated")).toBe("keep");
  });

  it("keeps same-user recovery on navigation and clears it on a different server-rendered identity or signed-out page", () => {
    const win = windowFixture();
    for (const userId of ["B", null]) {
      syncCommentRecoveryUser(win.sessionStorage as unknown as Storage, "A");
      win.sessionStorage.setItem("commentor-operations:legacy", "private");
      win.eval(renderCommentRecoveryLifecycle(userId).replace(/^<script>|<\/script>$/g, ""));
      expect(win.sessionStorage.getItem("commentor-operations:legacy")).toBeNull();
    }
  });

  it("checks the live server session before BFCache hydration and handles iframe load while the check is pending", async () => {
    const win = windowFixture();
    const storage = win.sessionStorage as unknown as Storage;
    syncCommentRecoveryUser(storage, "A");
    storage.setItem("commentor-operations:legacy", "private");
    win.document.body.innerHTML = '<iframe id="content-frame"></iframe>';
    const frame = win.document.getElementById("content-frame")!;
    frame.setAttribute("src", "https://rendro.test/organizations/org/projects/project/docs/files/guide.html");
    const source = { postMessage: vi.fn() };
    Object.defineProperty(frame, "contentWindow", { value: source });
    Object.assign(win, { RENDRO_SHARE_CONFIG: { organizationId: "org", projectId: "project", convexUrl: "https://convex.test" } });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", win.document);
    vi.stubGlobal("HTMLIFrameElement", win.HTMLIFrameElement);
    vi.stubGlobal("location", win.location);
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const dispose = bootCommentorParentHost()!;
    frame.dispatchEvent(new win.Event("load"));
    expect(source.postMessage).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("/api/auth/get-session?disableCookieCache=true", expect.objectContaining({ cache: "no-store" }));
    finish(Response.json({ user: { id: "B" } }));
    await flush();
    expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: COMMENTOR_PARENT_READY, userId: "B", recoveryState: { operations: {}, drafts: {} } }), "*");
    expect(storage.getItem("commentor-operations:legacy")).toBeNull();
    // An actual sign-out event clears and invalidates this host immediately.
    storage.setItem("commentor-operations:B", "private");
    win.dispatchEvent(new win.Event("commentor-sign-out"));
    expect(storage.length).toBe(0);
    expect(source.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ userId: null, recoveryState: { operations: {}, drafts: {} } }), "*");
    dispose();
  });
});
