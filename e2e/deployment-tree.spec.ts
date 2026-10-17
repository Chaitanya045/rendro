import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { pushDocuments } from "./seed";
import { api, desktop, provision } from "./shell-helpers";

/**
 * A multi-folder deployment pushed through the real CLI, browsed from its
 * sharded path/directory index (#90). More than 256 files gives the index
 * several shards; more than 200 siblings gives a folder a second page.
 */
const WIDE = 260;
const page = (name: number) => `page-${String(name).padStart(3, "0")}.html`;
const html = (title: string, body = "") => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

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

test.describe("deployment index browsing", () => {
  test.use({ viewport: desktop });

  test("a CLI-pushed multi-folder deployment browses by directory page, deep link and keyboard", async ({ page: tab, baseURL }, info) => {
    test.setTimeout(240_000);
    const workspace = await provision(tab, `tree-${info.project.name}-${info.retry}`, { organizations: ["Tree"], project: true });
    const { id: projectId, organizationId } = workspace.projects[0];
    const key = await api<{ rawKey: string }>(tab, "/api/rendro/credentials", { organizationId, projectId, name: "Tree publisher",
      scopes: ["docs:read", "docs:write", "publications:read", "publications:write"] });
    expect(key.status).toBeLessThan(300);
    if (!baseURL || !process.env.RENDRO_E2E_DIRECTORY) throw new Error("Missing local E2E state");
    const source = join(process.env.RENDRO_E2E_DIRECTORY, `tree-${info.project.name}-${info.retry}`);
    await mkdir(join(source, "guide/deep"), { recursive: true });
    await mkdir(join(source, "wide"));
    await mkdir(join(source, "assets"));
    await writeFile(join(source, "index.html"), html("Tree home"));
    await writeFile(join(source, "guide/intro.html"), html("Guide intro", '<img src="../assets/mark.svg" alt="Mark">'));
    await writeFile(join(source, "guide/deep/topic.html"), html("Deep topic"));
    await writeFile(join(source, "assets/mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
    for (let index = 0; index < WIDE; index += 1) await writeFile(join(source, "wide", page(index)), html(`Wide ${index}`));
    await pushDocuments(source, baseURL, organizationId, projectId, key.body.rawKey, 8);
    // A second push copies every unchanged file, validated against the new deployment's index.
    await writeFile(join(source, "index.html"), html("Tree home v2"));
    await pushDocuments(source, baseURL, organizationId, projectId, key.body.rawKey, 8);

    const docs = `/organizations/${organizationId}/projects/${projectId}/docs`;
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
    const published = await tab.request.post("/api/rendro/publications", { headers: { Authorization: `Bearer ${key.body.rawKey}` },
      data: { organizationId, projectId, slug, pathPrefix: "guide", entryFile: "intro.html", trackingMode: "track_active", title: "Guide" } });
    expect(published.ok()).toBe(true);
    requested.length = 0;
    await tab.goto(`/p/${slug}`);
    await expect(frame.getByRole("heading", { name: "Guide intro" })).toBeVisible();
    await expect(tab.locator("#tree-container > .tree-folder > .tree-item .tree-label, #tree-container > .tree-item .tree-label")).toHaveText(["deep", "intro"]);
    expect(requested).toEqual(["|"]);
  });
});
