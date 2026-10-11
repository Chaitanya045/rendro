// @vitest-environment happy-dom
import type { ParentCommentTransport } from "../src/commentor/parent-transport";
import { beforeAll, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  publish: (_threads: unknown[], _canLoadMore: boolean, _loading: boolean) => {},
  mutate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/commentor/parent-transport", () => ({
  ParentCommentTransport: class {
    subscribe(...args: Parameters<ParentCommentTransport["subscribe"]>) {
      transport.publish = args[0];
      args[6]?.(true, true);
    }
    mutate = transport.mutate;
    isMutationPending() { return false; }
  },
}));

beforeAll(async () => {
  Object.assign(window, { COMMENTOR: {
    transport: "parent", organizationId: "org", projectId: "project", documentPath: "guide.html", canWrite: true,
  } });
  await import("../src/commentor/commentor");
  document.dispatchEvent(new Event("DOMContentLoaded"));
});

function render(canDelete?: boolean, replyCanDelete?: boolean) {
  transport.publish([{
    _id: "thread", _creationTime: Date.now(), authorName: "Author", authorEmail: "author@example.test",
    body: "Comment", anchor: { kind: "element", path: ["main"] }, resolved: false, canDelete,
    replies: [{ _id: "reply", _creationTime: Date.now(), authorName: "Reply author", body: "Reply", canDelete: replyCanDelete }],
  }], false, false);
  return document.querySelector("#commentor-host")!.shadowRoot!;
}

describe("comment permission rendering", () => {
  it.each([false, undefined])("hides Delete and Archive without server permission (%s), preserving Resolve", (permission) => {
    const root = render(permission, permission);
    expect(root.querySelector('[data-testid="commentor-delete-btn"]')).toBeNull();
    expect(root.querySelector('[data-testid="commentor-delete-reply-btn"]')).toBeNull();
    expect(root.querySelector('[data-testid="commentor-archive-btn"]')).toBeNull();
    expect(root.querySelector('[data-testid="commentor-resolve-btn"]')).not.toBeNull();
  });

  it("renders author/admin Delete and Archive controls and scopes reply deletion", async () => {
    const root = render(true, true);
    expect(root.querySelector('[data-testid="commentor-delete-btn"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="commentor-archive-btn"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-testid="commentor-delete-reply-btn"]')!.click();
    await Promise.resolve();
    expect(transport.mutate).toHaveBeenCalledWith("reply.remove", { threadId: "thread", replyId: "reply" });
  });

  it("uses each reply's permission independently of the thread author", () => {
    const root = render(false, true);
    expect(root.querySelector('[data-testid="commentor-delete-btn"]')).toBeNull();
    expect(root.querySelector('[data-testid="commentor-delete-reply-btn"]')).not.toBeNull();
    render(true, false);
    expect(root.querySelector('[data-testid="commentor-delete-btn"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="commentor-delete-reply-btn"]')).toBeNull();
  });
});
