import { Window } from "happy-dom";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootCommentorParentHost } from "../src/commentor/parent-host";
import { publicErrorMessages } from "../src/shared/public-errors";

const client = vi.hoisted(() => ({
  onUpdate: vi.fn(), setAuth: vi.fn(), close: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("convex/browser", () => ({ ConvexClient: class {
  onUpdate = client.onUpdate;
  setAuth = client.setAuth;
  close = client.close;
} }));
const windows: Window[] = [];
const disposers: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  for (const win of windows.splice(0)) await win.happyDOM.close();
});
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function fixture(initialSession: Response = Response.json({ user: { id: "member" } })) {
  const win = new Window({ url: "https://rendro.test/docs", settings: { disableIframePageLoading: true } });
  windows.push(win);
  win.document.body.innerHTML = '<iframe id="content-frame" src="/organizations/org/projects/project/docs/files/guide.html"></iframe>';
  const frame = win.document.querySelector("iframe")!;
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: vi.fn() } });
  Object.assign(win, { RENDRO_SHARE_CONFIG: { organizationId: "org", projectId: "project", convexUrl: "https://convex.test" } });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", win.document);
  vi.stubGlobal("HTMLIFrameElement", win.HTMLIFrameElement);
  vi.stubGlobal("location", win.location);
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(initialSession.clone()));
  vi.stubGlobal("fetch", fetch);
  const unsubscribe = vi.fn();
  client.onUpdate.mockReturnValue(unsubscribe);
  const dispose = bootCommentorParentHost()!;
  disposers.push(dispose);
  const update = (id: string) => (client.onUpdate.mock.lastCall![2] as (id: string) => void)(id);
  const error = (error: Error) => (client.onUpdate.mock.lastCall![3] as (error: Error) => void)(error);
  const focus = async () => { win.dispatchEvent(new win.Event("focus")); await flush(); };
  return { win, frame, fetch, unsubscribe, update, error, focus };
}

describe("active deployment subscription lifecycle", () => {
  it.each(["not_found", "unauthenticated", "forbidden"] as const)("unsubscribes on %s without restarting on focus or accepting queued updates", async code => {
    const f = fixture();
    await flush();
    f.update("old");
    expect(f.frame.dataset.activeDeployment).toBe("old");
    f.error(new ConvexError({ code, message: publicErrorMessages[code] }));
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.frame.dataset.activeDeployment).toBeUndefined();
    f.update("queued");
    await f.focus();
    await f.focus();
    expect(f.frame.dataset.activeDeployment).toBeUndefined();
    expect(client.onUpdate).toHaveBeenCalledOnce();
  });

  it.each([200, 401, 403])("tears down on live session loss (%s)", async status => {
    const f = fixture();
    await flush();
    f.update("old");
    f.fetch.mockImplementation(() => Promise.resolve(Response.json(null, { status })));
    await f.focus();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.frame.dataset.activeDeployment).toBeUndefined();
    f.fetch.mockImplementation(() => Promise.resolve(Response.json({ user: { id: "member" } })));
    await f.focus();
    expect(client.onUpdate).toHaveBeenCalledOnce();
  });

  it("cleans up even when denial arrives during subscription registration", async () => {
    const f = fixture();
    client.onUpdate.mockImplementation((_query, _args, _update, onError: (error: Error) => void) => {
      onError(new ConvexError({ code: "not_found", message: publicErrorMessages.not_found }));
      return f.unsubscribe;
    });
    await flush();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    await f.focus();
    expect(client.onUpdate).toHaveBeenCalledOnce();
  });

  it("never subscribes when initially signed out", async () => {
    fixture(Response.json(null));
    await flush();
    expect(client.onUpdate).not.toHaveBeenCalled();
  });

  it.each(["commentor-sign-out", "dispose"])("cleans up on %s, including queued updates", async event => {
    const f = fixture();
    await flush();
    f.update("old");
    if (event === "dispose") disposers.pop()!();
    else f.win.dispatchEvent(new f.win.Event(event));
    f.update("queued");
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.frame.dataset.activeDeployment).toBeUndefined();
    // A new host can own this same DOM after BFCache restoration.
    f.frame.dataset.activeDeployment = "new-host";
    f.error(new Error("Late transport failure"));
    expect(f.frame.dataset.activeDeployment).toBe("new-host");
  });

  it("does not subscribe after sign-out during the initial session check", async () => {
    const f = fixture();
    f.win.dispatchEvent(new f.win.Event("commentor-sign-out"));
    await flush();
    expect(client.onUpdate).not.toHaveBeenCalled();
  });

  it("unsubscribes on a definitive token refresh denial", async () => {
    const f = fixture();
    await flush();
    f.fetch.mockImplementation((url: string) => Promise.resolve(url.includes("/token")
      ? new Response(null, { status: 401 }) : Response.json({ user: { id: "member" } })));
    const token = await (client.setAuth.mock.lastCall![0] as () => Promise<string | null>)();
    expect(token).toBeNull();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps one subscription through transient query/session failures and accepts recovery", async () => {
    const f = fixture();
    await flush();
    f.update("old");
    f.error(new Error("Network disconnected"));
    expect(f.frame.dataset.activeDeployment).toBeUndefined();
    f.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await f.focus();
    f.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    await f.focus();
    expect(f.unsubscribe).not.toHaveBeenCalled();
    expect(client.onUpdate).toHaveBeenCalledOnce();
    f.update("recovered");
    expect(f.frame.dataset.activeDeployment).toBe("recovered");
  });
});
