import { beforeAll, describe, expect, it } from "vitest";
import { useCommentLab, type Lab } from "./helpers/comment-lab";

/** Handshake, composer, rendering, pagination and dock edges of the comment widget that the other browser suites do not assert. */
const commentLab = useCommentLab();
beforeAll(() => commentLab.start());

const heading = { kind: "element", path: ["main", "h1"] };
const parentReady = (lab: Lab, ready: Record<string, unknown>) => lab.host((_lab, ready) => {
  (document.getElementById("content-frame") as HTMLIFrameElement).contentWindow!.postMessage({ type: "commentor-parent-ready", ...ready }, "*");
}, ready);
const alerts = (lab: Lab) => lab.ui.locator('.toast[role="alert"]');

describe("parent handshake and scope", () => {
  it("subscribes with the scope of the document the frame shows, and again for the next document", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    const scope = (documentPath: string) => ({ organizationId: "org-a", projectId: "project-a", documentPath });
    const first = await lab.host(l => l.scopes);
    expect(first.length).toBeGreaterThan(0);
    for (const opened of first) expect(opened).toEqual(scope("index.html"));
    await lab.host(() => { (document.getElementById("content-frame") as HTMLIFrameElement).src = "/organizations/org-a/projects/project-a/docs/files/guide/next.html"; });
    await expect.poll(() => lab.host(l => l.scopes.at(-1))).toEqual(scope("guide/next.html"));
    // Nothing was subscribed with a scope the frame never showed.
    const all = await lab.host(l => l.scopes);
    expect(all.slice(first.length).every(opened => JSON.stringify(opened) === JSON.stringify(scope("guide/next.html")))).toBe(true);
  });

  it("leaves the document readable when the comment script is blocked or the backend fails", async () => {
    const blocked = await commentLab.open({ blockWidget: true });
    const errors: string[] = [];
    blocked.page.on("pageerror", error => errors.push(error.message));
    await blocked.doc(() => { document.getElementById("publisher-button")!.addEventListener("click", () => { document.title = "clicked"; }); });
    await blocked.frame.getByRole("button", { name: "Publisher action" }).click();
    expect(await blocked.doc(() => document.title)).toBe("clicked");
    await blocked.doc(() => window.scrollTo(0, 500));
    expect(await blocked.doc(() => Math.round(window.scrollY))).toBe(500);
    expect(await blocked.doc(() => document.querySelector("h1")?.textContent)).toBe("Quarterly report");
    expect(await blocked.doc(() => document.getElementById("commentor-host"))).toBeNull();
    expect(errors).toEqual([]);

    const failing = await commentLab.open();
    await failing.ready();
    await failing.host(l => l.fail(new Error("private backend detail")));
    await expect.poll(() => alerts(failing).innerText()).toBe("Comments could not be loaded");
    // The reader keeps the document: it scrolls, its own controls work and a selection still works.
    await failing.doc(() => { document.getElementById("publisher-button")!.addEventListener("click", () => { document.title = "clicked"; }); });
    await failing.frame.getByRole("button", { name: "Publisher action" }).click();
    expect(await failing.doc(() => document.title)).toBe("clicked");
    await failing.doc(() => window.scrollTo(0, 500));
    expect(await failing.doc(() => Math.round(window.scrollY))).toBe(500);
  });

  it("reloads the page only when the reader presses the parent Reload button", async () => {
    const lab = await commentLab.open({ viewerShell: true });
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    const loadedAt = await lab.page.evaluate(() => performance.timeOrigin);
    await lab.openDrawer();
    await lab.tid("commentor-comment-btn").click();
    await parentReady(lab, { protocolVersion: 1, canReloadViewer: true });
    const notice = lab.ui.locator(".content-list .empty");
    await expect.poll(() => notice.locator("p").first().innerText()).toBe("Comments were updated. Reload the page to continue.");
    // The widget can only ask: the parent shows its own notice and nothing navigates.
    await notice.getByRole("button", { name: "Show reload notice" }).click();
    const parentNotice = lab.page.locator("#viewer-update-notice");
    await expect.poll(() => parentNotice.isVisible()).toBe(true);
    expect(await lab.page.evaluate(() => performance.timeOrigin)).toBe(loadedAt);
    // A second request does not repeat the announcement.
    await notice.getByRole("button", { name: "Show reload notice" }).click();
    expect(await parentNotice.locator("[role=status]").innerText()).toBe("Reload this document to continue.");
    const reloaded = lab.page.waitForEvent("framenavigated", frame => frame === lab.page.mainFrame());
    await parentNotice.getByRole("button", { name: "Reload" }).click();
    await reloaded;
    await lab.page.waitForLoadState("load");
    expect(await lab.page.evaluate(() => performance.timeOrigin)).not.toBe(loadedAt);
    // The reloaded page has a matching parent again: comments are enabled and the notice is gone.
    await lab.ready([{ _id: "t1", anchor: heading }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    expect(await lab.tid("commentor-comment-btn").isDisabled()).toBe(false);
    expect(await lab.page.locator("#viewer-update-notice").isHidden()).toBe(true);
  });
});

describe("composer", () => {
  const compose = async (lab: Lab, text: string) => {
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("title")!.click());
    await lab.tid("commentor-composer-textarea").fill(text);
  };

  it("sends one write however fast the reader submits again", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await compose(lab, "Only once");
    await lab.host(l => { l.holds = ["thread.create"]; });
    // Two clicks and two Enter presses in the same task, before the host has answered anything.
    await lab.doc(() => {
      const root = document.getElementById("commentor-host")!.shadowRoot!;
      const post = root.querySelector<HTMLButtonElement>('[data-testid="commentor-composer-post"]')!;
      const textarea = root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-composer-textarea"]')!;
      post.click();
      post.click();
      for (let i = 0; i < 2; i++) textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    expect(await lab.tid("commentor-composer-post").getAttribute("aria-busy")).toBe("true");
    await lab.release();
    await expect.poll(() => lab.pins().count()).toBe(1);
    expect((await lab.calls).filter(call => call.method === "thread.create")).toHaveLength(1);
    expect(await lab.host(l => l.threads.length)).toBe(1);
  });
});

describe("rendering", () => {
  it("shows a reply's author and body as text beside the thread's author and age", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.host(l => l.seed([{ _id: "t1", anchor: { kind: "element", path: ["main", "h1"] }, authorName: "Ada", body: "First thought",
      replies: [l.reply({ authorName: "Grace", body: "Second thought" }), l.reply({ authorName: "Linus", body: "Third thought" })] }]));
    await lab.pins().first().click();
    const bubble = lab.tid("commentor-thread-bubble");
    expect(await bubble.locator(".head .who").innerText()).toBe("Ada");
    expect(await bubble.locator(".head .when").innerText()).toMatch(/^\d+[smhd]$/);
    expect(await bubble.locator(".body").innerText()).toBe("First thought");
    const replies = bubble.locator(".replies .reply");
    expect(await replies.count()).toBe(2);
    expect(await replies.locator(".reply-who").allInnerTexts()).toEqual(["Grace", "Linus"]);
    const texts = await replies.allInnerTexts();
    expect(texts[0]).toContain("Second thought");
    expect(texts[1]).toContain("Third thought");
  });

  it.fails("shows when a reply was written, like a thread does (known bug)", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    await lab.host(l => l.seed([{ _id: "t1", anchor: { kind: "element", path: ["main", "h1"] }, replies: [l.reply({ authorName: "Grace", body: "Second thought" })] }]));
    await lab.pins().first().click();
    expect(await lab.tid("commentor-thread-bubble").locator(".replies .reply .when").count()).toBe(1);
  });

  it("renders comment text, names and quotes as text, never as markup", async () => {
    const lab = await commentLab.open();
    await lab.ready();
    const hostile = '<img src=x onerror="window.top.__ran = 1"><script>window.top.__ran = 2</script><b>bold</b>';
    await lab.host((l, hostile) => l.seed([{
      _id: "t1", authorName: hostile, body: hostile, anchor: { kind: "text-range", quote: "lazy dog", path: ["main", "p:nth-of-type(1)"], startOffset: 0, endOffset: 8 },
      replies: [l.reply({ authorName: hostile, body: hostile })],
    }, {
      _id: "t2", body: "Quoted", anchor: { kind: "text-range", quote: hostile, path: ["main", "p:nth-of-type(2)"], startOffset: 0, endOffset: 1 },
    }]), hostile);
    await lab.openDrawer();
    await lab.ui.locator(".drawer-thread").first().locator(".body").click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").count()).toBe(1);
    // Nothing from the comments became an element, so nothing could run.
    expect(await lab.doc(() => {
      const shadow = document.getElementById("commentor-host")!.shadowRoot!;
      return { injected: shadow.querySelectorAll("img, script, b").length, ran: (window.top as unknown as { __ran?: number }).__ran ?? null };
    })).toEqual({ injected: 0, ran: null });
    // The text is shown as written, in the card, the open thread and the reply.
    expect(await lab.ui.locator(".drawer-thread").first().locator(".body").innerText()).toBe(hostile);
    expect(await lab.tid("commentor-thread-bubble").locator(".head .who").innerText()).toBe(hostile);
    expect(await lab.tid("commentor-thread-bubble").locator(".body").innerText()).toBe(hostile);
    expect(await lab.tid("commentor-thread-bubble").locator(".reply").innerText()).toContain(hostile);
    // A quote that is itself markup is labelled as text too.
    expect(await lab.ui.locator(".drawer-thread").nth(1).innerText()).toContain(hostile);
  });

  it("labels a selected quote that looks like markup as text in the composer", async () => {
    const markup = '<img src=x onerror="window.top.__ran = 1">';
    const page = `<!doctype html><html><body><main style="padding:24px"><p id="markup">${markup.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p></main></body></html>`;
    const lab = await commentLab.open({ document: page });
    await lab.ready();
    await lab.select("#markup");
    await lab.selectionSettled();
    await lab.tid("commentor-comment-btn").click();
    const label = lab.tid("commentor-composer").locator(".anchor-label");
    await expect.poll(() => label.innerText()).toBe(`On: “${markup}”`);
    expect(await lab.doc(() => ({
      injected: document.getElementById("commentor-host")!.shadowRoot!.querySelectorAll("img").length,
      ran: (window.top as unknown as { __ran?: number }).__ran ?? null,
    }))).toEqual({ injected: 0, ran: null });
  });
});

describe("late responses", () => {
  it("does not clear an unrelated draft when an earlier post is confirmed late", async () => {
    const lab = await commentLab.open();
    await lab.ready([{ _id: "t1", anchor: heading, body: "Existing" }]);
    await expect.poll(() => lab.pins().count()).toBe(1);
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("second")!.click());
    await lab.tid("commentor-composer-textarea").fill("Post that stays pending");
    await lab.host(l => { l.holds = ["thread.create"]; });
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    // Meanwhile the reader starts an unrelated reply on another thread, from the drawer.
    await lab.openDrawer();
    const reply = lab.ui.locator('.drawer-thread[data-thread-id="t1"] [data-testid="commentor-reply-input"]');
    await reply.fill("Unrelated reply draft");
    await lab.release();
    await expect.poll(() => lab.pins().count()).toBe(2);
    await expect.poll(() => lab.tid("commentor-composer").count()).toBe(0);
    expect(await lab.ui.locator('.drawer-thread[data-thread-id="t1"] [data-testid="commentor-reply-input"]').inputValue()).toBe("Unrelated reply draft");
    expect(await lab.page.evaluate(() => JSON.stringify(sessionStorage))).toContain("Unrelated reply draft");
  });
});

describe("identity", () => {
  it("keeps session credentials out of recovery storage and out of every message between the widget and the parent", async () => {
    const secrets = ["secret-session-cookie-value", "secret.jwt.value"];
    const lab = await commentLab.open();
    await lab.page.evaluate(([cookie, jwt]) => {
      // What an authenticated shell really holds: a session cookie value and a Convex JWT in its own storage.
      document.cookie = `better-auth.session_token=${cookie}; path=/`;
      localStorage.setItem("convex-auth-jwt", jwt);
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      addEventListener("message", event => { seen.push(JSON.stringify(event.data)); });
    }, secrets);
    await lab.ready([{ _id: "t1", anchor: heading, body: "Existing" }]);
    await lab.doc(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      addEventListener("message", event => { seen.push(JSON.stringify(event.data)); });
    });
    // Leave a draft, an unconfirmed write and a reply draft behind, so there is recovery state to inspect.
    await lab.host(l => { l.holds = ["thread.create"]; });
    await lab.tid("commentor-comment-btn").click();
    await lab.doc(() => document.getElementById("second")!.click());
    await lab.tid("commentor-composer-textarea").fill("Pending post");
    await lab.tid("commentor-composer-post").click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);
    await lab.openDrawer();
    await lab.ui.locator('.drawer-thread[data-thread-id="t1"] [data-testid="commentor-reply-input"]').fill("Reply draft");
    await lab.release();
    await expect.poll(() => lab.pins().count()).toBe(2);
    await lab.host(l => { l.holds = ["thread.resolve"]; });
    await lab.ui.locator('.drawer-thread[data-thread-id="t1"] [data-testid="commentor-resolve-btn"]').click();
    await expect.poll(() => lab.host(l => l.held.length)).toBe(1);

    const storage = await lab.page.evaluate(() => {
      const dump = (area: Storage) => Object.fromEntries(Array.from({ length: area.length }, (_, index) => [area.key(index)!, area.getItem(area.key(index)!)!]));
      return { session: dump(sessionStorage), local: dump(localStorage) };
    });
    const recovery = Object.entries(storage.session).filter(([key]) => key.startsWith("commentor-"));
    expect(recovery.length).toBeGreaterThan(0);
    // The namespace holds only the non-secret user id and the drafts and operations themselves.
    for (const [key, value] of recovery) {
      expect(key + value).not.toMatch(new RegExp(secrets.join("|")));
      if (key === "commentor-recovery-user") { expect(value).toBe("user-a"); continue; }
      const state = JSON.parse(value) as { userId?: string; operations?: Record<string, object>; drafts?: Record<string, object> };
      expect(Object.keys(state).sort()).toEqual(["drafts", "operations", "userId"]);
      expect(state.userId).toBe("user-a");
      expect(value).not.toMatch(/token|jwt|cookie|authorization|session/i);
    }
    expect(recovery.some(([key]) => key !== "commentor-recovery-user")).toBe(true);
    expect(JSON.stringify(storage.session)).toContain("Reply draft");
    // Every message either side saw (requests, responses, snapshots, handshakes) carries no credential either.
    const parentMessages = await lab.page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    const widgetMessages = await lab.doc(() => (window as unknown as { seen: string[] }).seen);
    expect(widgetMessages.length).toBeGreaterThan(0);
    for (const message of [...parentMessages, ...widgetMessages]) {
      expect(message).not.toMatch(new RegExp(secrets.join("|")));
      expect(message).not.toMatch(/"(?:token|jwt|cookie|authorization|sessionToken|accessToken)"/i);
    }
  });
});

describe("drawer list", () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ _id: `t${String(index).padStart(2, "0")}`, body: `Comment ${index}`, anchor: heading }));
  const listTop = (lab: Lab, id: string) => lab.tid("commentor-drawer-list").evaluate((list, id) =>
    Math.round((list.querySelector(`.drawer-thread[data-thread-id="${id}"]`)!.getBoundingClientRect().top - list.getBoundingClientRect().top)), id);

  it("keeps a half-written reply when older comments load and when new ones arrive, and offers a prompt rather than moving the reader", async () => {
    const lab = await commentLab.open({ height: 600 });
    await lab.ready(many(14));
    await lab.openDrawer();
    const draft = lab.ui.locator('.drawer-thread[data-thread-id="t05"] [data-testid="commentor-reply-input"]');
    await draft.fill("Half-written reply");
    await lab.host(l => {
      l.olderThreads = [l.thread({ _id: "a-old", body: "Older comment", _creationTime: 1, anchor: { kind: "element", path: ["main", "h1"] } })];
      l.pagination = { canLoadMore: true, loading: false };
      l.publish();
    });
    await lab.tid("commentor-load-older-threads").evaluate(button => (button as HTMLButtonElement).click());
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(15);
    expect(await draft.inputValue()).toBe("Half-written reply");
    expect(await lab.page.evaluate(() => JSON.stringify(sessionStorage))).toContain("Half-written reply");

    // A comment arriving while the reader is away from the end only offers a prompt.
    const banner = lab.ui.locator(".new-comments");
    await lab.host(l => { l.threads.push(l.thread({ _id: "z-new", body: "Newest comment", anchor: { kind: "element", path: ["main", "h1"] } })); l.publish(); });
    await expect.poll(() => banner.innerText()).toBe("1 new comment");
    expect(await draft.inputValue()).toBe("Half-written reply");
    expect(await lab.ui.locator(".drawer-thread").count()).toBe(16);
    // Revealing them goes to the newest and still keeps the draft.
    await banner.click();
    await expect.poll(() => banner.isHidden()).toBe(true);
    expect(await draft.inputValue()).toBe("Half-written reply");
  });

  it.fails("keeps the reader's place in the list when older comments load or new ones arrive (known bug)", async () => {
    const lab = await commentLab.open({ height: 600 });
    await lab.ready(many(14));
    await lab.openDrawer();
    const list = lab.tid("commentor-drawer-list");
    await list.evaluate(el => { el.scrollTop = 220; });
    const place = await listTop(lab, "t05");
    expect(await list.evaluate(el => Math.round(el.scrollTop))).toBe(220);
    await lab.host(l => { l.threads.push(l.thread({ _id: "z-new", body: "Newest comment", anchor: { kind: "element", path: ["main", "h1"] } })); l.publish(); });
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(15);
    // The same card stays where the reader left it.
    expect(await listTop(lab, "t05")).toBe(place);
  });

  it("animates only the comments and replies that are new", async () => {
    const lab = await commentLab.open({ motion: "no-preference" });
    await lab.ready();
    await lab.host((l) => l.seed([
      { _id: "t1", anchor: { kind: "element", path: ["main", "h1"] }, replies: [l.reply({ _id: "r1", body: "Old reply" })] },
      { _id: "t2", anchor: { kind: "element", path: ["main", "#second"] } },
    ]));
    await lab.openDrawer();
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(2);
    await lab.pins().first().click();
    const animating = () => lab.ui.locator(".is-new").evaluateAll(elements => elements.map(element => `${element.className.split(" ")[0]}:${element.getAttribute("data-thread-id") ?? ""}`).sort());
    // What was there when the widget started is not new.
    expect(await animating()).toEqual([]);

    // One new comment and one new reply: only they animate, and they stop being "new" at the next update.
    await lab.host((l) => {
      l.threads[0].replies = [...l.threads[0].replies, l.reply({ _id: "r2", body: "New reply" })];
      l.threads.push(l.thread({ _id: "t3", anchor: { kind: "element", path: ["main", "#list"] } }));
      l.publish();
    });
    await expect.poll(() => lab.ui.locator(".drawer-thread").count()).toBe(3);
    // The new reply is drawn in the drawer card and in the open thread, the old one in neither as new.
    expect(await animating()).toEqual(["drawer-thread:t3", "pin:t3", "reply:", "reply:"]);
    expect(await lab.ui.locator(".reply.is-new").allInnerTexts()).toEqual([expect.stringContaining("New reply"), expect.stringContaining("New reply")]);
    expect(await lab.ui.locator(".drawer-thread.is-new").evaluate(el => getComputedStyle(el).animationName)).toBe("new-card");
    expect(await lab.ui.locator(".drawer-thread:not(.is-new)").first().evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    await lab.host(l => { l.threads[1].resolved = true; l.publish(); });
    await expect.poll(() => lab.ui.locator(".drawer-thread[data-thread-id=\"t2\"]").count()).toBe(0);
    expect(await animating()).toEqual([]);
  });
});

describe("locating and the dock", () => {
  it("scrolls only the publisher's document when a thread is located, never the page around the frame", async () => {
    const lab = await commentLab.open({ motion: "no-preference" });
    await lab.ready([{ _id: "far", anchor: { kind: "element", path: ["main", "#footer"] }, body: "Far" }]);
    // Put the frame inside a scrollable page, fully in view, so an ancestor scroll would be possible and visible.
    await lab.host(() => {
      const frame = document.getElementById("content-frame") as HTMLElement;
      Object.assign(frame.style, { position: "absolute", inset: "auto", top: "1500px", left: "0", width: "100%", height: "800px" });
      document.body.style.height = "3600px";
      window.scrollTo(0, 1500);
    });
    await expect.poll(() => lab.page.evaluate(() => Math.round(window.scrollY))).toBe(1500);
    await lab.openDrawer();
    await lab.ui.locator(".drawer-thread").first().locator(".body").click();
    await expect.poll(() => lab.tid("commentor-thread-bubble").getAttribute("data-thread-id")).toBe("far");
    await expect.poll(() => lab.doc(() => Math.round(window.scrollY))).toBeGreaterThan(500);
    // The document moved to its anchor; the page around it did not.
    expect(await lab.page.evaluate(() => Math.round(window.scrollY))).toBe(1500);
    // The same through a pin, once the document is back at the top.
    await lab.doc(() => window.scrollTo(0, 0));
    await lab.tid("commentor-thread-bubble").locator(".thread-close").click();
    await lab.ui.locator(".drawer-thread").first().getByRole("button", { name: "Locate commented text on page" }).click();
    await expect.poll(() => lab.doc(() => Math.round(window.scrollY))).toBeGreaterThan(500);
    expect(await lab.page.evaluate(() => Math.round(window.scrollY))).toBe(1500);
  });

  it("caps the list at the screen and scrolls it", async () => {
    for (const { width, height } of [{ width: 1024, height: 700 }, { width: 360, height: 600 }]) {
      const lab = await commentLab.open({ width, height });
      await lab.ready(Array.from({ length: 40 }, (_, index) => ({ _id: `t${index}`, body: `Comment ${index}`, anchor: heading })));
      await lab.openDrawer();
      const measures = () => lab.tid("commentor-drawer-list").evaluate(list => {
        const drawer = document.querySelector("body")!;
        void drawer;
        const box = list.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, client: list.clientHeight, scroll: list.scrollHeight, overflow: getComputedStyle(list).overflowY };
      });
      await expect.poll(async () => (await measures()).scroll).toBeGreaterThan(height);
      const measured = await measures();
      expect(measured.overflow).toBe("auto");
      expect(measured.client).toBeLessThan(height);
      expect(measured.top).toBeGreaterThanOrEqual(0);
      expect(measured.bottom).toBeLessThanOrEqual(height);
      expect(measured.scroll).toBeGreaterThan(measured.client);
      // Scrolling the list moves its cards, not the page behind it.
      await lab.tid("commentor-drawer-list").evaluate(list => { list.scrollTop = list.scrollHeight; });
      await expect.poll(() => lab.tid("commentor-drawer-list").evaluate(list => list.scrollTop + list.clientHeight >= list.scrollHeight - 1)).toBe(true);
      expect(await lab.doc(() => Math.round(window.scrollY))).toBe(0);
      await lab.page.close();
    }
  });

  it("lets the reader move the widget off text it covers, keeping the selection", async () => {
    const quote = "Covered words";
    const page = `<!doctype html><html><body style="margin:0"><p id="covered" style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);margin:0;font:16px sans-serif">${quote}</p></body></html>`;
    const lab = await commentLab.open({ document: page });
    await lab.ready();
    await lab.select("#covered");
    await lab.selectionSettled();
    const topElement = () => lab.doc(() => {
      const box = document.getElementById("covered")!.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { id: hit?.id ?? null, selection: String(getSelection()) };
    });
    // At first the dock sits on top of the text.
    expect(await topElement()).toEqual({ id: "commentor-host", selection: quote });
    // The grip moves it along its edge with the keyboard; the text is reachable again and still selected.
    await lab.tid("commentor-toolbar-grip").focus();
    await lab.page.keyboard.press("Home");
    await expect.poll(topElement).toEqual({ id: "covered", selection: quote });
    // Moved to the other end of the edge, the text stays uncovered as well.
    await lab.page.keyboard.press("End");
    await expect.poll(topElement).toEqual({ id: "covered", selection: quote });
  });
});
