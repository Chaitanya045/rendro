import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import { failOnce } from "./org-fixtures";
import { api, desktop, holdFirst } from "./shell-helpers";
import { frameFile, html, provisionDeployment, test as viewer, trackActivation, type Deployment } from "./viewer-fixtures";

/**
 * A multi-folder deployment pushed through the real CLI, browsed from its
 * sharded path/directory index (#90). More than 256 files gives the index
 * several shards; more than 200 siblings gives a folder a second page.
 * One deployment per worker serves every journey in this file.
 */
const WIDE = 260;
const page = (name: number) => `page-${String(name).padStart(3, "0")}.html`;

function treeRequests(tab: Page) {
  const seen: string[] = [];
  tab.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/tree")) seen.push(`${url.searchParams.get("dir")}|${url.searchParams.get("cursor") ?? ""}`);
  });
  return seen;
}
const active = (tab: Page) => tab.locator("#tree-container .tree-item.active");
const rows = (tab: Page, folder: string) => tab.locator(`.tree-folder[data-path$="/${folder}"] > .tree-folder-content > .tree-item`);
/** Every direct child of a folder: its documents and its subfolders' rows. */
const children = (tab: Page, folder: string) => tab.locator(`.tree-folder[data-path$="/${folder}"] > .tree-folder-content > :is(.tree-item, .tree-folder)`);
const folderRow = (tab: Page, folder: string) => tab.locator(`.tree-folder[data-path$="/${folder}/"] > .tree-item`);
const fileRow = (tab: Page, path: string) => tab.locator(`.tree-item[data-path$="/${path}"]`);
const rootLabels = (tab: Page) => tab.locator("#tree-container > .tree-folder > .tree-item .tree-label, #tree-container > .tree-item .tree-label");
const heading = (tab: Page, name: string) => tab.frameLocator("#content-frame").getByRole("heading", { name });
// The first page of the root and of a folder, and its later pages, as the tree endpoint receives them.
const rootPage = /\/docs\/tree\?dir=$/;
const wideFirst = /\/docs\/tree\?dir=wide%2F$/;
const wideLater = /\/docs\/tree\?dir=wide%2F&cursor=1$/;

type Tree = Deployment & { amended: string };
const test = viewer.extend<{ tree: Tree; owner: Page }, { treeState: { get(): Promise<Tree> } }>({
  treeState: [async ({ browser }, use, info) => {
    const nonce = `${info.workerIndex}-${Date.now().toString(36)}-${info.project.name}`;
    let created: Promise<Tree> | undefined;
    const create = async () => {
      const deployment = await provisionDeployment(browser, `tree-${nonce}`, async source => {
        await mkdir(join(source, "guide/deep"), { recursive: true });
        await mkdir(join(source, "wide"));
        await mkdir(join(source, "assets"));
        await writeFile(join(source, "index.html"), html("Tree home"));
        await writeFile(join(source, "guide/intro.html"), html("Guide intro", '<img src="../assets/mark.svg" alt="Mark">'));
        await writeFile(join(source, "guide/deep/topic.html"), html("Deep topic"));
        await writeFile(join(source, "assets/mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
        for (let index = 0; index < WIDE; index += 1) await writeFile(join(source, "wide", page(index)), html(`Wide ${index}`));
      // A second push copies every unchanged file, validated against the new deployment's index.
      }, async source => { await writeFile(join(source, "index.html"), html("Tree home v2")); });
      await deployment.close();
      return { ...deployment, amended: "Tree home v2" };
    };
    await use({ get: () => (created ??= create()) });
  }, { scope: "worker", timeout: 240_000 }],
  tree: [async ({ treeState }, use) => { await use(await treeState.get()); }, { timeout: 240_000 }],
  owner: async ({ page: tab, context, tree }, use) => {
    await context.addCookies(tree.cookies);
    await use(tab);
  },
});

test.describe("deployment index browsing", () => {
  test.use({ viewport: desktop });

  test("a CLI-pushed multi-folder deployment browses by directory page, deep link and keyboard", async ({ owner: tab, tree }, info) => {
    test.slow();
    const { organizationId, projectId } = tree;
    const docs = tree.docs;
    const requested = treeRequests(tab);
    await tab.goto(`${docs}?doc=guide/deep/topic.html`);
    const frame = tab.frameLocator("#content-frame");
    await expect(frame.getByRole("heading", { name: "Deep topic" })).toBeVisible();
    await expect(active(tab)).toHaveAttribute("data-path", /\/guide\/deep\/topic\.html$/);
    await expect(tab.locator("#active-indicator")).toHaveCSS("opacity", "1");
    // One root page, then only the deep link's ancestors: wide/ is never read.
    expect(requested).toEqual(["|", "guide/|", "guide/deep/|"]);
    await expect(tab.locator("#tree-container > .tree-folder > .tree-item .tree-label, #tree-container > .tree-item .tree-label"))
      .toHaveText(["guide", "wide", "index"]); // assets/ holds no HTML document.

    // A folder pages its 260 documents 200 at a time; the keyboard opens it.
    const wide = tab.locator('.tree-folder[data-path$="/wide/"] > .tree-item');
    await wide.focus();
    await tab.keyboard.press("Enter");
    await expect(rows(tab, "wide/")).toHaveCount(200);
    expect(requested.slice(3)).toEqual(["wide/|"]);
    const more = tab.locator('.tree-folder[data-path$="/wide/"] .load-more-btn');
    await more.click();
    await expect(rows(tab, "wide/")).toHaveCount(WIDE);
    await expect(more).toHaveCount(0);
    expect(requested.slice(3)).toEqual(["wide/|", "wide/|1"]);
    await rows(tab, "wide/").last().locator("a.tree-link").click();
    await expect(frame.getByRole("heading", { name: `Wide ${WIDE - 1}` })).toBeVisible();
    await expect(tab).toHaveURL(new RegExp(`\\?doc=wide%2F${page(WIDE - 1).replace(".", "\\.")}$`));
    await wide.focus();
    await tab.keyboard.press(" ");
    await expect(wide).toHaveAttribute("aria-expanded", "false");

    // A deep link beyond the first page loads only that folder's next page.
    requested.length = 0;
    await tab.goto(`${docs}?doc=wide/${page(WIDE - 2)}`);
    await expect(frame.getByRole("heading", { name: `Wide ${WIDE - 2}` })).toBeVisible();
    await expect(active(tab)).toHaveAttribute("data-path", new RegExp(`/wide/${page(WIDE - 2).replace(".", "\\.")}$`));
    expect(requested).toEqual(["|", "wide/|", "wide/|1"]);

    // Assets resolve through the index; unknown paths stay 404.
    await tab.goto(`${docs}?doc=guide/intro.html`);
    await expect(frame.getByRole("img", { name: "Mark" })).toHaveJSProperty("naturalWidth", 8);
    expect((await tab.request.get(`${docs}/files/guide/missing.html`)).status()).toBe(404);
    expect((await tab.request.get(`${docs}/tree?dir=..%2F`)).status()).toBe(400);

    // A publication's tree is scoped to its prefix.
    const slug = `tree-${info.project.name}-${info.retry}-${organizationId.slice(-6)}`.toLowerCase();
    const published = await tab.request.post("/api/rendro/publications", { headers: { Authorization: `Bearer ${tree.key}` },
      data: { organizationId, projectId, slug, pathPrefix: "guide", entryFile: "intro.html", trackingMode: "track_active", title: "Guide" } });
    expect(published.ok()).toBe(true);
    requested.length = 0;
    await tab.goto(`/p/${slug}`);
    await expect(frame.getByRole("heading", { name: "Guide intro" })).toBeVisible();
    await expect(tab.locator("#tree-container > .tree-folder > .tree-item .tree-label, #tree-container > .tree-item .tree-label")).toHaveText(["deep", "intro"]);
    expect(requested).toEqual(["|"]);
  });

  test("a failed folder page and a failed Load more each leave the tree usable and recover on Retry", async ({ owner: tab, tree }) => {
    const requested = treeRequests(tab);
    await tab.goto(`${tree.docs}?doc=index.html`);
    await expect(heading(tab, tree.amended)).toBeVisible();
    const wide = folderRow(tab, "wide");
    await expect(wide).toHaveAttribute("aria-expanded", "false");

    // First page of a folder fails: an alert with Retry replaces the rows, the folder reports it is open and not busy.
    const first = await failOnce(tab, wideFirst, "Folder unavailable");
    await wide.focus();
    await tab.keyboard.press("Enter");
    const alert = tab.locator('.tree-folder[data-path$="/wide/"] [role="alert"]');
    await expect(alert).toContainText("Failed to load folder.");
    await expect(wide).toHaveAttribute("aria-expanded", "true");
    await expect(tab.locator('.tree-folder[data-path$="/wide/"]')).not.toHaveAttribute("aria-busy", /.*/);
    await expect(rows(tab, "wide/")).toHaveCount(0);
    expect(first.failures()).toBe(1);
    await first.close();

    // Retry loads the same first page; the failed attempt left nothing behind.
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(rows(tab, "wide/")).toHaveCount(200);
    await expect(alert).toHaveCount(0);
    expect(requested.slice(1)).toEqual(["wide/|", "wide/|"]);

    // A later page fails: the 200 loaded rows stay and the button becomes Retry, enabled and not busy.
    const later = await failOnce(tab, wideLater, "Page unavailable");
    const more = tab.locator('.tree-folder[data-path$="/wide/"] .load-more-btn');
    await more.click();
    await expect(more).toHaveText("Retry");
    await expect(more).toBeEnabled();
    await expect(more).not.toHaveAttribute("aria-busy", /.*/);
    await expect(rows(tab, "wide/")).toHaveCount(200);
    await later.close();

    // While the retried page is in flight the button says so and cannot be pressed again.
    const hold = await holdFirst(tab, "**/docs/tree?dir=wide%2F&cursor=1");
    await more.click();
    await expect(more).toHaveText("Loading…");
    await expect(more).toBeDisabled();
    await expect(more).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => hold.held()).toBe(1);
    hold.release();
    await expect(rows(tab, "wide/")).toHaveCount(WIDE);
    await expect(more).toHaveCount(0);
    await hold.close();
    expect(requested.slice(1)).toEqual(["wide/|", "wide/|", "wide/|1", "wide/|1"]);
  });

  test("a failed deep-link reveal leaves the document open and unselected until its page loads", async ({ owner: tab, tree }) => {
    // The page holding the deep-linked row fails: the document still opens, but the tree cannot mark a row it never loaded.
    const failure = await failOnce(tab, wideLater, "Page unavailable");
    await tab.goto(`${tree.docs}?doc=wide/${page(WIDE - 1)}`);
    await expect(heading(tab, `Wide ${WIDE - 1}`)).toBeVisible();
    await expect(rows(tab, "wide/")).toHaveCount(200);
    await expect(active(tab)).toHaveCount(0);
    expect(failure.failures()).toBe(1);
    await failure.close();
    // Loading the page by hand then reveals nothing by itself (selection is applied when a document is selected)…
    await tab.locator('.tree-folder[data-path$="/wide/"] .load-more-btn').click();
    await expect(rows(tab, "wide/")).toHaveCount(WIDE);
    // …and selecting the document marks it.
    await fileRow(tab, `wide/${page(WIDE - 1)}`).locator("a.tree-link").click();
    await expect(active(tab)).toHaveAttribute("data-path", new RegExp(`/wide/${page(WIDE - 1).replace(".", "\\.")}$`));
  });

  test("the root listing fails with Retry and an empty listing explains itself", async ({ owner: tab, tree }) => {
    const failure = await failOnce(tab, rootPage, "Listing unavailable");
    await tab.goto(`${tree.docs}?doc=index.html`);
    await expect(heading(tab, tree.amended)).toBeVisible();
    const alert = tab.locator('#tree-container [role="alert"]');
    await expect(alert).toContainText("Failed to load documents.");
    await expect(tab.locator("#tree-container")).not.toHaveAttribute("aria-busy", /.*/);
    await expect(rootLabels(tab)).toHaveCount(0);
    expect(failure.failures()).toBe(1);
    await failure.close();

    // Retry is disabled while the request is in flight, then the tree replaces the alert.
    const hold = await holdFirst(tab, "**/docs/tree?dir=");
    const retry = alert.getByRole("button", { name: "Retry" });
    await retry.click();
    await expect(retry).toBeDisabled();
    await expect.poll(() => hold.held()).toBe(1);
    hold.release();
    await expect(rootLabels(tab)).toHaveText(["guide", "wide", "index"]);
    await expect(alert).toHaveCount(0);
    await expect(active(tab)).toHaveAttribute("data-path", /\/index\.html$/);
    await hold.close();

    // A listing with nothing in it names the next step and leads back to the project.
    await tab.route(rootPage, route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ children: [], cursor: null }) }));
    await tab.reload();
    await expect(tab.locator("#tree-container .tree-empty")).toHaveText("No documents deployed yet.");
    await expect(rootLabels(tab)).toHaveCount(0);
    const back = tab.locator("#tree-container").getByRole("link", { name: "Return to project" });
    await expect(back).toHaveAttribute("href", `/organizations/${tree.organizationId}/projects/${tree.projectId}`);
    await back.click();
    await expect(tab).toHaveURL(new RegExp(`/organizations/${tree.organizationId}/projects/${tree.projectId}$`));
  });

  test("a project with no deployment has no document viewer", async ({ owner: tab, tree }) => {
    await tab.goto(`/organizations/${tree.organizationId}`);
    const created = await api<{ project: { _id: string } }>(tab, "/api/rendro/projects", { organizationId: tree.organizationId, name: "Nothing yet", slug: "nothing-yet" });
    expect(created.status).toBe(201);
    const response = await tab.goto(`/organizations/${tree.organizationId}/projects/${created.body.project._id}/docs`);
    expect(response?.status()).toBe(404);
    await expect(tab.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(tab.locator("#tree-container")).toHaveCount(0);
  });

  test("folders and documents are reached by Tab; Enter and Space operate them and the arrow, Home, End and typed keys do nothing", async ({ owner: tab, tree }) => {
    await tab.goto(`${tree.docs}?doc=index.html`);
    await expect(heading(tab, tree.amended)).toBeVisible();
    await expect(rootLabels(tab)).toHaveText(["guide", "wide", "index"]);
    const guide = folderRow(tab, "guide");
    const focused = () => tab.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return element ? `${element.tagName.toLowerCase()}:${element.textContent?.replace(/\s+/g, " ").trim()}` : "none";
    });
    // Folders are buttons that report their state; documents are links.
    await expect(guide).toHaveAttribute("role", "button");
    await expect(guide).toHaveAttribute("tabindex", "0");
    await expect(guide).toHaveAttribute("aria-expanded", "false");
    await guide.focus();
    await tab.keyboard.press("Enter");
    await expect(guide).toHaveAttribute("aria-expanded", "true");
    await expect(children(tab, "guide/")).toHaveCount(2);
    expect(await focused()).toContain("guide");

    // The tree has no arrow, Home/End or typeahead model: focus and expansion stay where they were (current behavior).
    for (const key of ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "w", "i"]) {
      await tab.keyboard.press(key);
      expect(await focused(), key).toContain("guide");
    }
    await expect(folderRow(tab, "wide")).toHaveAttribute("aria-expanded", "false");
    await expect(guide).toHaveAttribute("aria-expanded", "true");

    // Tab walks into the open folder in document order: its subfolder, then its document.
    await tab.keyboard.press("Tab");
    expect(await focused()).toContain("deep");
    await tab.keyboard.press("Tab");
    expect(await focused()).toBe("a:intro");
    await tab.keyboard.press("Enter");
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(tab).toHaveURL(/\?doc=guide%2Fintro\.html$/);
    await expect(active(tab)).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
    expect(await focused()).toBe("a:intro");

    // Space closes the folder.
    await guide.focus();
    await tab.keyboard.press(" ");
    await expect(guide).toHaveAttribute("aria-expanded", "false");
    // The selection stays on the document inside the closed folder, with its indicator hidden until the folder reopens.
    await expect(tab.locator("#active-indicator")).toHaveCSS("opacity", "0");
    await guide.focus();
    await tab.keyboard.press("Enter");
    await expect(tab.locator("#active-indicator")).toHaveCSS("opacity", "1");
  });

  test("Back and Forward step through the selected documents; an entry that names no document keeps the last one showing", async ({ owner: tab, tree }) => {
    test.slow();
    const gate = await trackActivation(tab);
    await tab.goto(`${tree.docs}?doc=index.html`);
    await expect(heading(tab, tree.amended)).toBeVisible();
    const entry = async (doc: string, title: string) => {
      await expect(tab).toHaveURL(new RegExp(`\\?doc=${doc.replaceAll("/", "%2F").replace(".", "\\.")}$`));
      await expect(heading(tab, title)).toBeVisible();
      await expect(active(tab)).toHaveCount(1);
      await expect(active(tab)).toHaveAttribute("data-path", new RegExp(`/${doc.replace(".", "\\.")}$`));
      expect(frameFile(tab)).toBe(doc);
    };
    await folderRow(tab, "guide").click();
    await folderRow(tab, "guide/deep").click();
    // Selections inside one activation window share a history entry (docs/TECHNICAL.md, "tree selections while activation
    // remains consumed replace that entry"): the intro is replaced by the topic, so a single Back returns to the start.
    await fileRow(tab, "guide/intro.html").locator("a.tree-link").click();
    await entry("guide/intro.html", "Guide intro");
    await fileRow(tab, "guide/deep/topic.html").locator("a.tree-link").click();
    await entry("guide/deep/topic.html", "Deep topic");
    await tab.goBack();
    await expect(tab).toHaveURL(/\?doc=index\.html$/);
    await expect(heading(tab, tree.amended)).toBeVisible();
    await expect(active(tab)).toHaveAttribute("data-path", /\/index\.html$/);
    expect(frameFile(tab)).toBe("index.html");
    await tab.goForward();
    await entry("guide/deep/topic.html", "Deep topic");

    // Once the shell has seen the activation lapse, the next selection starts a new entry.
    await gate.untilInactive();
    await fileRow(tab, "guide/intro.html").locator("a.tree-link").click();
    await entry("guide/intro.html", "Guide intro");
    await tab.goBack();
    await entry("guide/deep/topic.html", "Deep topic");
    await tab.goBack();
    await expect(tab).toHaveURL(/\?doc=index\.html$/);
    await expect(heading(tab, tree.amended)).toBeVisible();
    await tab.goForward();
    await entry("guide/deep/topic.html", "Deep topic");
    await tab.goForward();
    await entry("guide/intro.html", "Guide intro");

    // An entry that names no document (pushed here the way another script or a bare link would): reaching it changes
    // the URL only. The previous document and its selection stay, because nothing tells the viewer what to show.
    // This is the current behavior; the product decision is open in #169 (part 2).
    await tab.evaluate(() => history.pushState(null, "", location.pathname));
    await expect(tab).toHaveURL(new RegExp(`${tree.docs}$`));
    await tab.goBack();
    await entry("guide/intro.html", "Guide intro");
    await tab.goBack();
    await entry("guide/deep/topic.html", "Deep topic");
    await tab.goForward();
    await entry("guide/intro.html", "Guide intro");
    await tab.goForward();
    await expect(tab).toHaveURL(new RegExp(`${tree.docs}$`));
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(active(tab)).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
    expect(frameFile(tab)).toBe("guide/intro.html");
  });

  test.fail("a closed folder's rows are skipped by Tab (known bug)", async ({ owner: tab, tree }) => {
    // A closed folder hides its rows with max-height/opacity only, so they stay focusable and in the accessibility tree.
    await tab.goto(`${tree.docs}?doc=index.html`);
    await expect(heading(tab, tree.amended)).toBeVisible();
    const guide = folderRow(tab, "guide");
    await guide.focus();
    await tab.keyboard.press("Enter");
    await expect(guide).toHaveAttribute("aria-expanded", "true");
    await tab.keyboard.press(" ");
    await expect(guide).toHaveAttribute("aria-expanded", "false");
    await tab.keyboard.press("Tab");
    await expect(folderRow(tab, "wide")).toBeFocused();
  });

  test.fail("an open folder with a full page of rows pushes the rows after it down instead of overlapping them (known bug)", async ({ owner: tab, tree }) => {
    // The open folder's content is capped at max-height: 2000px with visible overflow: rows past the cap (about 60) are
    // drawn over the siblings that follow the folder.
    await tab.goto(`${tree.docs}?doc=index.html`);
    await expect(heading(tab, tree.amended)).toBeVisible();
    await folderRow(tab, "wide").click();
    await expect(rows(tab, "wide/")).toHaveCount(200);
    const last = await rows(tab, "wide/").last().boundingBox();
    const next = await fileRow(tab, "index.html").boundingBox();
    if (!last || !next) throw new Error("Missing rows");
    expect(next.y).toBeGreaterThanOrEqual(last.y + last.height - 1);
  });
});
