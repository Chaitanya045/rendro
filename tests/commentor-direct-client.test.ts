// @vitest-environment happy-dom
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const convex = vi.hoisted(() => ({ clients: [] as Array<{ url: string; setAuth: ReturnType<typeof vi.fn>; onUpdate: ReturnType<typeof vi.fn>; mutation: ReturnType<typeof vi.fn> }> }));
vi.mock("convex/browser", () => ({
  ConvexClient: class {
    setAuth = vi.fn();
    onUpdate = vi.fn();
    mutation = vi.fn(() => Promise.resolve(null));
    constructor(readonly url: string) { convex.clients.push(this); }
  },
}));

const legacy = { convexUrl: "https://convex.test", orgSlug: "example", filePath: "example/guide.html", author: { name: "Ada", email: "ada@example.test" } };
const thread = (overrides: Record<string, unknown> = {}) => ({
  _id: "thread-1", _creationTime: Date.now(), authorName: "Ada", authorEmail: "ada@example.test", body: "Existing",
  anchor: { kind: "element", path: ["main"] }, resolved: false, replies: [], ...overrides,
});

async function start(config: Record<string, unknown>) {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.body.innerHTML = "<p id='target'>Publisher text</p>";
  Object.assign(window, { COMMENTOR: config });
  await import("../src/commentor/commentor");
  const host = document.getElementById("commentor-host")!;
  const root = host.shadowRoot!;
  const client = convex.clients.at(-1);
  const test = (id: string) => root.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  const publish = (threads: unknown[]) => (client!.onUpdate.mock.calls[0][2] as (threads: unknown[]) => void)(threads);
  return { root, client: client!, test, publish, toast: () => root.querySelector(".toast")?.textContent ?? null };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  convex.clients.length = 0;
  document.getElementById("commentor-host")?.remove();
  Reflect.deleteProperty(window, "COMMENTOR");
});

describe("widget with a direct Convex client", () => {
  it("authenticates the client from the token endpoint and subscribes to the file's threads", async () => {
    const { client } = await start(legacy);
    expect(client.url).toBe("https://convex.test");
    const [reference, args] = client.onUpdate.mock.calls[0] as unknown as [never, unknown];
    expect(getFunctionName(reference)).toBe("threads:list");
    expect(args).toEqual({ orgSlug: "example", filePath: "example/guide.html" });
    const authenticate = client.setAuth.mock.calls[0][0] as () => Promise<string | null>;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ token: "jwt" }))
      .mockResolvedValueOnce(Response.json({ token: 7 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 })));
    expect(await authenticate()).toBe("jwt");
    expect(await authenticate()).toBeNull();
    expect(await authenticate()).toBeNull();
  });

  it("holds a scheduled token refresh while the tab is hidden", async () => {
    const { client } = await start(legacy);
    const authenticate = client.setAuth.mock.calls[0][0] as (args?: { forceRefreshToken: boolean }) => Promise<string | null>;
    const fetcher = vi.fn(() => Promise.resolve(Response.json({ token: "jwt" })));
    vi.stubGlobal("fetch", fetcher);
    const show = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      show("hidden");
      expect(await authenticate({ forceRefreshToken: false })).toBe("jwt");
      fetcher.mockClear();
      const refresh = authenticate({ forceRefreshToken: true });
      await flush();
      expect(fetcher).not.toHaveBeenCalled();
      show("visible");
      expect(await refresh).toBe("jwt");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("lists threads without pagination and explains subscription failures in plain words", async () => {
    const { client, root, publish, toast } = await start(legacy);
    publish([thread(), thread({ _id: "thread-2", repliesHasMore: true, replies: [{ _id: "r1", _creationTime: Date.now(), authorName: "Grace", authorEmail: "g@example.test", body: "Reply" }] })]);
    // Their anchor element is absent from this page, so both pins are present but hidden.
    expect([...root.querySelectorAll<HTMLElement>('[data-testid="commentor-pin"]')].map(pin => pin.style.display)).toEqual(["none", "none"]);
    root.querySelector<HTMLButtonElement>('[data-testid="commentor-panel-btn"]')!.click();
    expect(root.querySelectorAll(".drawer-thread")).toHaveLength(2);
    // Older replies are a parent-transport feature; the control does nothing here.
    root.querySelector<HTMLButtonElement>('[data-testid="commentor-load-older-replies"]')!.click();
    await flush();
    expect(root.querySelector('[data-testid="commentor-load-older-replies"]')).not.toBeNull();
    const fail = client.onUpdate.mock.calls[0][3] as (error: Error) => void;
    fail(new ConvexError({ code: "forbidden", message: "private" }));
    expect(toast()).toBe("You do not have permission to change this comment.");
    fail(new Error("private detail"));
    expect(root.querySelectorAll(".toast")[1].textContent).toBe("Comments could not be loaded");
  });

  it("posts, resolves, archives, replies and deletes through the client, and reports a failed post", async () => {
    vi.useFakeTimers();
    const { client, root, test, publish, toast } = await start(legacy);
    publish([thread()]);
    test("commentor-comment-btn").click();
    document.getElementById("target")!.click();
    const textarea = root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-composer-textarea"]')!;
    textarea.value = "Direct comment";
    client.mutation.mockRejectedValueOnce(new Error("private"));
    test("commentor-composer-post").click();
    await flush();
    expect(toast()).toBe("Could not post comment. Try again.");
    test("commentor-composer-post").click();
    await flush();
    const created = client.mutation.mock.calls.at(-1) as unknown as [never, Record<string, unknown>];
    expect(getFunctionName(created[0])).toBe("threads:create");
    expect(created[1]).toEqual({ orgSlug: "example", filePath: "example/guide.html", body: "Direct comment", anchor: { kind: "element", path: ["p"] } });
    expect(root.querySelector('[data-testid="commentor-composer"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(root.querySelector('[data-testid="commentor-composer"]')).toBeNull();

    test("commentor-panel-btn").click();
    const card = () => root.querySelector<HTMLElement>(".drawer-thread")!;
    const run = async (id: string, name: string, args: Record<string, unknown>) => {
      card().querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click();
      await flush();
      const [reference, sent] = client.mutation.mock.calls.at(-1) as unknown as [never, Record<string, unknown>];
      expect(getFunctionName(reference)).toBe(name);
      expect(sent).toEqual(args);
    };
    await run("commentor-resolve-btn", "threads:resolve", { threadId: "thread-1" });
    await run("commentor-archive-btn", "threads:archive", { threadId: "thread-1" });
    const input = card().querySelector<HTMLTextAreaElement>('[data-testid="commentor-reply-input"]')!;
    input.value = "A reply";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await run("commentor-reply-send", "replies:add", { threadId: "thread-1", body: "A reply" });
    card().querySelector<HTMLButtonElement>('[data-testid="commentor-delete-btn"]')!.click();
    await vi.advanceTimersByTimeAsync(5_000);
    const removed = client.mutation.mock.calls.at(-1) as unknown as [never, Record<string, unknown>];
    expect(getFunctionName(removed[0])).toBe("threads:remove");
    expect(removed[1]).toEqual({ threadId: "thread-1" });
  });

  it("is read-only without an author", async () => {
    const { test, publish, root } = await start({ ...legacy, author: undefined });
    expect(test("commentor-comment-btn").disabled).toBe(true);
    publish([thread()]);
    root.querySelector<HTMLButtonElement>('[data-testid="commentor-panel-btn"]')!.click();
    expect(root.querySelector('[data-testid="commentor-reply-input"]')).toBeNull();
    expect(root.querySelector('[data-testid="commentor-resolve-btn"]')).toBeNull();
  });
});

describe("widget in a top-level legacy parent page", () => {
  it("accepts a file-scoped parent configuration and does not ask itself for a theme", async () => {
    const post = vi.spyOn(window, "postMessage");
    const { test, root } = await start({ transport: "parent", orgSlug: "example", filePath: "example/guide.html", documentPath: "guide.html", canWrite: true });
    expect(convex.clients).toHaveLength(0);
    expect(post.mock.calls.some(([message]) => (message as { type?: string })?.type === "commentor-theme-ready")).toBe(false);
    // No parent has announced itself yet, so writing stays off.
    expect(test("commentor-comment-btn").disabled).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-testid="commentor-panel-btn"]')!.click();
    expect(root.querySelector(".content-list")!.textContent).toContain("No active comments");
  });
});
