import type { Browser, Page } from "@playwright/test";
import { guardContext } from "./fixtures";
import { api, desktop, mobile } from "./shell-helpers";
import { test as viewer, expect, content, documentFrame, frameFile, trackActivation, type ViewerSite } from "./viewer-fixtures";

/**
 * The three ways a document is read, each on the real Worker: the private project viewer (signed-in members, with comments),
 * a public publication (anonymous, whole deployment or one folder) and a private share (anonymous, one document). Creating,
 * listing and revoking shares and publications is #113's; this file is what a reader sees and can do in each viewer, how
 * the tree and chrome differ between them, and what an expired, revoked or out-of-scope link shows.
 */
type Link = { token: string; url: string; grantId: string; documentPath: string };
type Surfaces = { makeShare: (documentPath: string, expiresInSeconds?: number) => Promise<Link>; revokeShare: (link: Link) => Promise<number>; anon: Page; briefShare: Link };

async function ownerSession(site: ViewerSite, browser: Browser, label: string) {
  const origin = process.env.RENDRO_E2E_ORIGIN;
  if (!origin) throw new Error("Missing local E2E state");
  const context = await browser.newContext({ baseURL: origin, serviceWorkers: "block" });
  const unexpected = await guardContext(context, origin, label);
  await context.addCookies(site.owner);
  const page = await context.newPage();
  await page.goto("/health");
  const create = async (documentPath: string, expiresInSeconds: number): Promise<Link> => {
    const made = await api<{ token: string; url: string; grant: { _id: string } }>(page, "/api/rendro/shares", { organizationId: site.organizationId, projectId: site.projectId, documentPath, expiresInSeconds });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return { token: made.body.token, url: made.body.url, grantId: made.body.grant._id, documentPath };
  };
  const revoke = async (link: Link) => (await api(page, "/api/rendro/shares/revoke", { organizationId: site.organizationId, grantId: link.grantId })).status;
  return { create, revoke, close: async () => { await context.close(); expect([...unexpected], "Unexpected external requests from the share owner").toEqual([]); } };
}

const test = viewer.extend<Surfaces, { shortLived: { get(): Promise<Link> } }>({
  // A one-minute share is the shortest the product allows. It is made when the worker starts using this file, so the
  // expiry journey (last in the file) has almost always passed its deadline by the time it looks.
  shortLived: [async ({ siteState, browser }, use) => {
    let made: Promise<Link> | undefined;
    await use({ get: () => (made ??= (async () => {
      const owner = await ownerSession(await siteState.get(), browser, "viewer-short-share");
      try { return await owner.create("index.html", 60); } finally { await owner.close(); }
    })()) });
  }, { scope: "worker", timeout: 240_000 }],
  briefShare: [async ({ shortLived }, use) => { await use(await shortLived.get()); }, { auto: true, timeout: 240_000 }],
  makeShare: async ({ browser, site }, use, info) => {
    const owner = await ownerSession(site, browser, `viewer-share-${info.testId}-${info.retry}`);
    try { await use((documentPath, expiresInSeconds = 3600) => owner.create(documentPath, expiresInSeconds)); } finally { await owner.close(); }
  },
  revokeShare: async ({ browser, site }, use, info) => {
    const owner = await ownerSession(site, browser, `viewer-revoke-${info.testId}-${info.retry}`);
    try { await use(owner.revoke); } finally { await owner.close(); }
  },
  // A reader with no account: their own context, so nothing of the owner's session is shared.
  anon: async ({ secondContext }, use) => { await use(await secondContext.newPage()); },
});

const heading = (tab: Page, name: string) => content(tab).getByRole("heading", { name });
const active = (tab: Page) => tab.locator("#tree-container .tree-item.active");
const rootLabels = (tab: Page) => tab.locator("#tree-container > .tree-folder > .tree-item .tree-label, #tree-container > .tree-item .tree-label");
const folderRow = (tab: Page, folder: string) => tab.locator(`.tree-folder[data-path$="/${folder}/"] > .tree-item`);
const fileLink = (tab: Page, path: string) => tab.locator(`.tree-item[data-path$="/${path}"] a.tree-link`);
const notice = (tab: Page) => tab.locator("#document-navigation-notice");
const historyLength = (tab: Page) => tab.evaluate(() => history.length);
const hash = (tab: Page) => tab.evaluate(() => location.hash);
/** Distance of an element's top edge from the top of the document's viewport. */
const offset = (tab: Page, id: string) => documentFrame(tab).evaluate(id => Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? 9999), id);
const scrolledTo = (tab: Page, id: string) => expect.poll(async () => Math.abs(await offset(tab, id)), { message: `#${id} at the top` }).toBeLessThanOrEqual(2);
/** Requests the page makes to the application itself, by path, for as long as the returned list is kept. */
function appRequests(tab: Page) {
  const seen: string[] = [];
  tab.on("request", request => { const url = new URL(request.url()); if (url.origin === process.env.RENDRO_E2E_ORIGIN) seen.push(url.pathname); });
  return seen;
}
const notFound = async (tab: Page) => {
  await expect(tab.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(tab.locator("#content-frame, #tree-container")).toHaveCount(0);
};
const errorFrame = (tab: Page) => content(tab).getByRole("heading", { name: "Page not found" });

test.describe("what each viewer offers", () => {
  test.use({ viewport: desktop });

  test("a private project viewer has the account and comments; a publication and a share have neither, and neither looks up a session", async ({ asOwner: tab, anon, site, makeShare }) => {
    test.slow();
    // Private: signed-in chrome around the tree and the document.
    const privateRequests = appRequests(tab);
    await tab.goto(`${site.docs}?doc=index.html`);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await expect(tab.locator("#avatar-btn")).toHaveCount(1);
    await expect(tab.locator("#share-btn")).toHaveAttribute("aria-label", "Share document");
    await expect(tab.locator("#tree-container")).toBeVisible();
    await expect(tab.locator(".rendro-theme-control")).toHaveCount(1);
    await expect(tab.locator("#shell-toggle")).toHaveCount(1);
    await expect(tab).toHaveTitle(/.+/);
    expect(privateRequests).toContain("/api/auth/get-session");

    // Publication: anonymous reading chrome, the tree of the whole deployment, no account and no comment surface.
    const publicRequests = appRequests(anon);
    await anon.goto(`/p/${site.whole}`);
    await expect(heading(anon, "Viewer home")).toBeVisible();
    await expect(active(anon)).toHaveAttribute("data-path", /\/index\.html$/);
    await expect(anon.locator("#avatar-btn")).toHaveCount(0);
    await expect(anon.locator("#share-btn")).toHaveAttribute("aria-label", "Copy public URL");
    await expect(anon.locator(".rendro-theme-control")).toHaveCount(1);
    await expect(anon.locator("#shell-toggle")).toHaveCount(1);
    await expect(rootLabels(anon)).toHaveText(["guide", "other", "flood", "forged", "index", "late", "probe"]);
    await expect(anon.locator("#commentor-host, [data-comment-toolbar]")).toHaveCount(0);
    await expect(content(anon).locator("#commentor-host")).toHaveCount(0);
    expect(publicRequests.filter(path => path.startsWith("/api/auth/"))).toEqual([]);
    expect(publicRequests).toContain(`/p/${site.whole}/tree`);

    // Share: one document, the sender's name for the project, the expiry, nothing to browse.
    const share = await makeShare("guide/intro.html");
    const sharedRequests = appRequests(anon);
    await anon.goto(`/s/${share.token}`);
    await expect(heading(anon, "Guide intro")).toBeVisible();
    await expect(anon.locator(".brand")).toHaveText("Rendro. secure share");
    await expect(anon.locator(".expiry")).toHaveText(/^Expires \d{4}-\d{2}-\d{2}$/);
    await expect(anon.locator("#tree-container, #doc-sidebar, #mobile-tree-toggle, #avatar-btn, #share-btn, .rendro-theme-control")).toHaveCount(0);
    await expect(anon.locator("#content-frame")).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-downloads");
    await expect(anon.locator("#content-frame")).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(content(anon).locator("#commentor-host")).toHaveCount(0);
    expect(sharedRequests.filter(path => path.startsWith("/api/auth/"))).toEqual([]);
    expect(sharedRequests.some(path => path.endsWith("/tree"))).toBe(false);
  });

  test("an outsider and a signed-out visitor never get the private viewer", async ({ browser, baseURL, site, anon }) => {
    const outsider = await browser.newContext({ baseURL, serviceWorkers: "block" });
    try {
      await outsider.addCookies(site.outsider);
      const tab = await outsider.newPage();
      const response = await tab.goto(`${site.docs}?doc=index.html`);
      // Signed in, but not a member of the project: it looks exactly like a project that does not exist.
      expect(response?.status()).toBe(404);
      await notFound(tab);
      expect((await tab.request.get(`${site.docs}/tree?dir=`)).status()).toBe(404);
      expect((await tab.request.get(`${site.docs}/files/index.html`)).status()).toBe(404);
    } finally { await outsider.close(); }

    // Signed out: the page is the sign-in form, and the tree and files are refused.
    await anon.goto(`${site.docs}?doc=index.html`);
    await expect(anon).toHaveURL(/\/sign-in\?returnTo=/);
    expect(new URL(anon.url()).searchParams.get("returnTo")).toBe(site.docs);
    await expect(anon.locator("#tree-container, #content-frame")).toHaveCount(0);
    expect((await anon.request.get(`${site.docs}/tree?dir=`, { maxRedirects: 0 })).status()).toBe(401);
    expect((await anon.request.get(`${site.docs}/files/index.html`, { maxRedirects: 0 })).status()).toBe(404);
  });

  test.fail("signing in returns to the document the reader asked for (known bug)", async ({ anon, site }) => {
    // The sign-in redirect keeps only the path, so a deep link to one document comes back as the project's default one.
    await anon.goto(`${site.docs}?doc=guide%2Fintro.html`);
    await expect(anon).toHaveURL(/\/sign-in\?returnTo=/);
    expect(new URL(anon.url()).searchParams.get("returnTo")).toBe(`${site.docs}?doc=guide%2Fintro.html`);
  });
});

test.describe("publication viewer", () => {
  test.use({ viewport: desktop });

  test("a publication opens by deep link and fragment, selects, browses by keyboard, and Back and Forward step through its documents", async ({ anon, site }) => {
    test.slow();
    const gate = await trackActivation(anon);
    const slug = site.whole;
    await anon.goto(`/p/${slug}?doc=guide%2Fintro.html#details`);
    await expect(heading(anon, "Guide intro")).toBeVisible();
    await scrolledTo(anon, "details");
    await expect(active(anon)).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
    await expect(folderRow(anon, "guide")).toHaveAttribute("aria-expanded", "true");
    expect(await hash(anon)).toBe("#details");
    // The document's own path is the publication's file path, never the project's.
    expect(frameFile(anon)).toBe("guide/intro.html");
    expect(documentFrame(anon).url()).toContain(`/p/${slug}/files/guide/intro.html`);

    // No document named: the publication's entry file.
    await anon.goto(`/p/${slug}`);
    await expect(heading(anon, "Viewer home")).toBeVisible();
    await expect(active(anon)).toHaveAttribute("data-path", /\/index\.html$/);

    // A folder opens from the keyboard; choosing a document from it is a history entry, and Back and Forward restore both
    // the document and its selection.
    const entries = await historyLength(anon);
    await folderRow(anon, "guide").focus();
    await anon.keyboard.press("Enter");
    await expect(folderRow(anon, "guide")).toHaveAttribute("aria-expanded", "true");
    await fileLink(anon, "guide/intro.html").focus();
    await anon.keyboard.press("Enter");
    await expect(heading(anon, "Guide intro")).toBeVisible();
    await expect(anon).toHaveURL(new RegExp(`/p/${slug}\\?doc=guide%2Fintro\\.html$`));
    expect(await historyLength(anon)).toBe(entries + 1);
    await expect(active(anon)).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
    await anon.goBack();
    await expect(heading(anon, "Viewer home")).toBeVisible();
    await expect(active(anon)).toHaveAttribute("data-path", /\/index\.html$/);
    await expect(anon).toHaveURL(new RegExp(`/p/${slug}$`));
    await anon.goForward();
    await expect(heading(anon, "Guide intro")).toBeVisible();
    await expect(active(anon)).toHaveAttribute("data-path", /\/guide\/intro\.html$/);

    // A link the reader follows inside the document goes to its target at once, with its fragment, and is a history entry.
    await gate.untilInactive();
    await content(anon).locator("#to-home-section").click();
    await expect(heading(anon, "Viewer home")).toBeVisible();
    await scrolledTo(anon, "section-two");
    await expect(anon).toHaveURL(new RegExp(`/p/${slug}\\?doc=index\\.html#section-two$`));
    await expect(active(anon)).toHaveAttribute("data-path", /\/index\.html$/);
    await expect(notice(anon)).toHaveCount(0);
    await anon.goBack();
    await expect(heading(anon, "Guide intro")).toBeVisible();
    // A reload keeps the publication, the document and the selection.
    await anon.reload();
    await expect(heading(anon, "Guide intro")).toBeVisible();
    await expect(active(anon)).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
  });

  test("a document in a publication that is not there, or is not a page, is not found", async ({ anon, site }) => {
    for (const doc of ["missing.html", "guide/missing.html", "../index.html"]) {
      const response = await anon.goto(`/p/${site.whole}?doc=${encodeURIComponent(doc)}`);
      expect(response?.status(), doc).toBe(404);
      await notFound(anon);
    }
    expect((await anon.goto(`/p/viewer-no-such-publication`))?.status()).toBe(404);
    await notFound(anon);
  });

  test("a publication of one folder shows only that folder and cannot be used to read outside it", async ({ anon, site }) => {
    test.slow();
    const slug = site.scoped;
    const requests = appRequests(anon);
    await anon.goto(`/p/${slug}`);
    await expect(heading(anon, "Guide intro")).toBeVisible();
    // Names are relative to the folder: the tree starts at its contents and has nothing from outside.
    await expect(rootLabels(anon)).toHaveText(["deep", "intro"]);
    await expect(active(anon)).toHaveAttribute("data-path", /\/intro\.html$/);
    await expect(anon.locator("#avatar-btn")).toHaveCount(0);
    await expect(anon.locator("#commentor-host, [data-comment-toolbar]")).toHaveCount(0);
    await expect(content(anon).locator("#commentor-host")).toHaveCount(0);

    // Documents outside the folder, whether asked for by the shell or by file, are not found.
    for (const doc of ["index.html", "other/elsewhere.html", "guide/intro.html"]) {
      expect((await anon.request.get(`/p/${slug}?doc=${encodeURIComponent(doc)}`)).status(), doc).toBe(404);
    }
    for (const path of ["index.html", "../index.html", "other/elsewhere.html", "guide/intro.html"]) {
      expect((await anon.request.get(`/p/${slug}/files/${path}`)).status(), path).toBe(404);
    }
    expect((await anon.request.get(`/p/${slug}/tree?dir=..%2F`)).status()).toBe(400);
    expect((await anon.request.get(`/p/${slug}/files/intro.html`)).status()).toBe(200);

    // A link in the document to a page outside the folder does not show that page: the frame is not allowed to,
    // whatever each engine puts there instead, and the shell stays on the document it had.
    await anon.goto(`/p/${slug}`);
    await expect(heading(anon, "Guide intro")).toBeVisible();
    requests.length = 0;
    const answers: number[] = [];
    anon.on("response", response => { if (new URL(response.url()).pathname.endsWith("/index.html")) answers.push(response.status()); });
    await content(anon).locator("#to-home").click();
    await expect.poll(() => answers.length).toBeGreaterThan(0);
    // The server answered with not-found; the document is not in the frame whatever the engine shows instead.
    expect(answers.every(status => status === 404)).toBe(true);
    await expect(anon).toHaveURL(new RegExp(`/p/${slug}$`));
    expect(requests.some(path => path.startsWith(`/p/${slug}/files/`) && path.endsWith("/index.html"))).toBe(false);
    await anon.reload();
    await expect(heading(anon, "Guide intro")).toBeVisible();
  });

  test("the publication viewer has a chrome of its own: theme, reading mode and, on a phone, the tree drawer and More without an account", async ({ anon, site }) => {
    test.slow();
    await anon.goto(`/p/${site.whole}?doc=guide%2Fintro.html`);
    await expect(heading(anon, "Guide intro")).toBeVisible();
    // Theme.
    await anon.emulateMedia({ colorScheme: "light" });
    await anon.locator(".rendro-theme-control").click();
    await expect(anon.locator("html")).toHaveClass(/dark/);
    expect(await anon.evaluate(() => localStorage.getItem("commentor-theme"))).toBe("dark");
    await anon.locator(".rendro-theme-control").click();
    await anon.locator(".rendro-theme-control").click();
    await expect(anon.locator("html")).not.toHaveClass(/dark/);
    // Reading mode from the shell, restored by Escape with focus on the control.
    await anon.locator("#shell-toggle").click();
    await expect(anon.locator("html")).toHaveClass(/shell-hidden/);
    await expect(anon.locator("#shell-toggle")).toHaveAttribute("aria-pressed", "true");
    await anon.locator("body").focus();
    await anon.keyboard.press("Escape");
    await expect(anon.locator("html")).not.toHaveClass(/shell-hidden/);
    await expect(anon.locator("#shell-toggle")).toBeFocused();
    // The shortcut typed in the document does nothing here: the publication's frame has no such bridge (current behavior).
    await content(anon).locator("body").click({ position: { x: 600, y: 600 } });
    await anon.keyboard.press("Control+Shift+H");
    await expect(anon.locator("html")).not.toHaveClass(/shell-hidden/);

    await anon.setViewportSize(mobile);
    const toggle = anon.locator("#mobile-tree-toggle");
    const more = anon.locator("#mobile-more-btn");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(anon.locator("#doc-sidebar")).not.toBeInViewport();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(anon.locator("#doc-sidebar")).toBeInViewport({ ratio: 0.99 });
    await fileLink(anon, "index.html").click();
    await expect(heading(anon, "Viewer home")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(anon).toHaveURL(new RegExp(`/p/${site.whole}\\?doc=index\\.html$`));
    // More holds the theme and reading mode, and no account.
    await more.click();
    const menu = anon.locator("#mobile-more-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".rendro-theme-control")).toHaveCount(1);
    await expect(menu.locator("#shell-toggle")).toHaveCount(1);
    await expect(menu.locator("#avatar-btn")).toHaveCount(0);
    await anon.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
  });
});

test.describe("share viewer", () => {
  test.use({ viewport: desktop });

  test("a shared document scrolls to its fragments and keeps the bar; a link to any other file shows it is unavailable inside the frame", async ({ anon, makeShare }) => {
    test.slow();
    const share = await makeShare("guide/intro.html");
    await anon.goto(`/s/${share.token}`);
    await expect(heading(anon, "Guide intro")).toBeVisible();
    // The shell names the one document in its URL.
    await expect(anon).toHaveURL(new RegExp(`/s/${share.token}\\?doc=guide%2Fintro\\.html$`));

    // A fragment link scrolls inside the frame and is reflected in the shell URL.
    await content(anon).locator("#to-details").click();
    await scrolledTo(anon, "details");
    await expect.poll(() => hash(anon)).toBe("#details");
    expect(frameFile(anon)).toBe("guide/intro.html");
    await expect(anon.locator(".brand")).toHaveText("Rendro. secure share");

    // A deep link with a fragment scrolls on load, and so does a reload of it.
    await anon.goto(`/s/${share.token}?doc=guide%2Fintro.html#details`);
    await expect(heading(anon, "Guide intro")).toBeVisible();
    await scrolledTo(anon, "details");
    await anon.reload();
    await expect(heading(anon, "Guide intro")).toBeVisible();
    await scrolledTo(anon, "details");

    // The share grants this one document: links to its siblings and to the rest of the deployment go nowhere. The frame
    // says so itself; the shell keeps its bar and offers nothing else to open.
    await content(anon).locator("#to-home").click();
    await expect(errorFrame(anon)).toBeVisible();
    await expect(heading(anon, "Home")).toHaveCount(0);
    await expect(anon.locator(".brand")).toHaveText("Rendro. secure share");
    await expect(anon.locator("#tree-container")).toHaveCount(0);
    await expect(notice(anon)).toHaveCount(0);
    // Back in the frame returns to the shared document.
    await anon.evaluate(() => history.back());
    await expect(heading(anon, "Guide intro")).toBeVisible();
    await content(anon).locator("#to-topic").click();
    await expect(errorFrame(anon)).toBeVisible();
    await anon.reload();
    await expect(heading(anon, "Guide intro")).toBeVisible();

    // The shell URL cannot name any other document, and a malformed query is refused.
    expect((await anon.goto(`/s/${share.token}?doc=guide%2Fdeep%2Ftopic.html`))?.status()).toBe(404);
    await notFound(anon);
    expect((await anon.goto(`/s/${share.token}?doc=guide%2Fintro.html&docQuery=nope`))?.status()).toBe(400);
  });

  test("a revoked share is not found, in the shell, in the document and in a viewer that was already open", async ({ anon, makeShare, revokeShare }) => {
    const share = await makeShare("index.html");
    const tab = anon;
    await tab.goto(`/s/${share.token}`);
    await expect(heading(tab, "Viewer home")).toBeVisible();
    // The share works until it is revoked; the open viewer keeps what it already shows.
    expect(await revokeShare(share)).toBe(200);
    await expect(heading(tab, "Viewer home")).toBeVisible();

    // Anything the viewer asks for next is refused, from the same URL: a navigation inside the document and a reload.
    const nextFile = await tab.request.get(`/s/${share.token}/files/index.html`);
    expect(nextFile.status()).toBe(404);
    await content(tab).locator("#to-section-two").click();
    await scrolledTo(tab, "section-two"); // Same-document scrolling needs no request, so it still works.
    const response = await tab.reload();
    expect(response?.status()).toBe(404);
    await notFound(tab);
    await expect(tab).toHaveURL(new RegExp(`/s/${share.token}\\?doc=index\\.html#section-two$`));
    for (const url of [`/s/${share.token}`, `/s/${share.token}?doc=index.html`]) {
      expect((await tab.goto(url))?.status(), url).toBe(404);
      await notFound(tab);
    }
    // The not-found page is a full page that leads back to Rendro, not a document inside a frame.
    await expect(tab.getByRole("link", { name: "Go to Rendro" })).toHaveAttribute("href", "/");
    // Revoking twice is harmless and the link stays dead.
    expect(await revokeShare(share)).toBeLessThan(500);
    expect((await tab.request.get(`/s/${share.token}`)).status()).toBe(404);
  });

  test("an expired share is not found, and the viewer that was open when it lapsed cannot reload it", async ({ anon, shortLived }) => {
    test.setTimeout(240_000);
    const share = await shortLived.get();
    const tab = anon;
    // It may already have lapsed on a slow host; if it has not, the open viewer shows its document until the deadline.
    const opened = await tab.goto(`/s/${share.token}`);
    if (opened?.status() === 200) {
      await expect(heading(tab, "Viewer home")).toBeVisible();
      await expect(tab.locator(".expiry")).toHaveText(/^Expires \d{4}-\d{2}-\d{2}$/);
    }
    // The deadline is the only thing waited for: poll the resolver rather than sleeping.
    await expect.poll(async () => (await tab.request.get(`/s/${share.token}`)).status(), { timeout: 150_000, intervals: [1000, 2000, 5000] }).toBe(404);
    for (const path of ["", "/files/index.html"]) expect((await tab.request.get(`/s/${share.token}${path}`)).status(), path || "shell").toBe(404);
    const response = await tab.goto(`/s/${share.token}`);
    expect(response?.status()).toBe(404);
    await notFound(tab);
    await expect(tab.getByRole("link", { name: "Go to Rendro" })).toHaveAttribute("href", "/");
    // The one-page 404 carries nothing of the document and does not say why (expired or revoked look the same).
    expect(await tab.locator("body").innerText()).not.toMatch(/expired|revoked/i);
  });

  test("on a phone the share bar and its document fit the screen", async ({ anon, makeShare }) => {
    const share = await makeShare("guide/intro.html");
    for (const width of [320, 375, 430]) {
      await anon.setViewportSize({ width, height: 800 });
      await anon.goto(`/s/${share.token}`);
      await expect(heading(anon, "Guide intro")).toBeVisible();
      expect(await anon.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${width}px`).toBe(0);
      const bar = await anon.locator(".bar").boundingBox();
      expect(bar?.width).toBe(width);
      const frame = await anon.locator("#content-frame").boundingBox();
      expect(frame?.x).toBe(0);
      expect(Math.round(frame?.width ?? 0)).toBe(width);
      // The expiry stays on the bar; the long "secure share" label gives way on a narrow screen.
      await expect(anon.locator(".expiry")).toBeVisible();
      await expect(anon.locator(".share-label")).toBeHidden();
    }
  });
});
