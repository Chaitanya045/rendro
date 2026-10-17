import type { Locator, Page, Route } from "@playwright/test";
import { test, expect, content, documentFrame } from "./viewer-fixtures";
import { clipboard, desktop, fakeClipboard, mobile } from "./shell-helpers";

/**
 * The private viewer's own chrome around the opaque document: theme, reading mode, sidebar resize, the avatar menu, the
 * mobile tree drawer and More menu, and the document's loading and failure states. Selection, folders and links have
 * their own specs (`deployment-tree`, `viewer-links`). Everything here is the shell page; the document only supplies a
 * heading to wait for and, for the theme, a page that reports what the shell tells it.
 */
const heading = (tab: Page, name: string) => content(tab).getByRole("heading", { name });
const active = (tab: Page) => tab.locator("#tree-container .tree-item.active");
const classes = (tab: Page) => tab.evaluate(() => [...document.documentElement.classList]);
const stored = (tab: Page, key: string) => tab.evaluate(key => localStorage.getItem(key), key);
const folderRow = (tab: Page, folder: string) => tab.locator(`.tree-folder[data-path$="/${folder}/"] > .tree-item`);
const fileLink = (tab: Page, path: string) => tab.locator(`.tree-item[data-path$="/${path}"] a.tree-link`);
const themeButton = (tab: Page) => tab.locator(".rendro-theme-control");
const inert = (locator: Locator) => locator.evaluate(element => (element as HTMLElement & { inert: boolean }).inert);

async function open(tab: Page, docs: string, doc = "index.html", title = "Viewer home") {
  await tab.goto(`${docs}?doc=${encodeURIComponent(doc)}`);
  await expect(heading(tab, title)).toBeVisible();
  await expect(active(tab)).toHaveCount(1);
}
const themeState = (tab: Page) => tab.evaluate(() => {
  const root = document.documentElement;
  const button = document.querySelector<HTMLElement>(".rendro-theme-control");
  return { dark: root.classList.contains("dark"), mode: root.dataset.theme, resolved: root.dataset.resolvedTheme,
    stored: localStorage.getItem("commentor-theme"), label: button?.getAttribute("aria-label") ?? null, title: button?.getAttribute("title") ?? null,
    rippling: root.classList.contains("rendro-theme-rippling") };
});
const topbarBackground = (tab: Page) => tab.locator(".topbar").evaluate(element => getComputedStyle(element).backgroundColor);
const documentTheme = (tab: Page) => documentFrame(tab).evaluate(() => ({
  message: document.documentElement.dataset.themeMessage ?? null, count: Number(document.documentElement.dataset.themeMessages ?? 0),
  background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color,
}));

test.describe("desktop chrome", () => {
  test.use({ viewport: desktop });

  test("the theme control cycles system, dark and light, persists, and tells the document without restyling it", async ({ asOwner: tab, site }) => {
    test.slow();
    await tab.emulateMedia({ colorScheme: "light" });
    await open(tab, site.docs, "probe.html", "Theme probe");
    await expect(tab.locator("#theme-toggle .rendro-theme-control, .topbar .rendro-theme-control")).toHaveCount(1);
    expect(await themeState(tab)).toMatchObject({ dark: false, mode: "system", resolved: "light", stored: null, label: "Switch to dark theme", title: "Theme: system" });
    const lightBar = await topbarBackground(tab);
    // The document announced itself and was told the resolved intent; its own colors are the publisher's.
    await expect.poll(async () => (await documentTheme(tab)).message).toBe("system");
    const publisher = { background: "rgb(250, 240, 230)", color: "rgb(20, 30, 40)" };
    expect(await documentTheme(tab)).toMatchObject(publisher);

    const steps = [
      { mode: "dark", dark: true, label: "Switch to light theme", title: "Theme: dark" },
      { mode: "light", dark: false, label: "Switch to system theme", title: "Theme: light" },
      { mode: "system", dark: false, label: "Switch to dark theme", title: "Theme: system" },
    ];
    for (const step of steps) {
      await themeButton(tab).click();
      await expect.poll(async () => (await themeState(tab)).mode).toBe(step.mode);
      await expect.poll(async () => (await themeState(tab)).rippling).toBe(false);
      expect(await themeState(tab)).toMatchObject({ ...step, stored: step.mode });
      await expect.poll(async () => (await documentTheme(tab)).message).toBe(step.mode);
      // Dark chrome around an untouched publisher page.
      expect(await documentTheme(tab)).toMatchObject(publisher);
      expect(await topbarBackground(tab) === lightBar).toBe(!step.dark);
    }

    // In system mode the operating system decides; an explicit choice ignores it.
    await tab.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => (await themeState(tab)).dark).toBe(true);
    await expect.poll(async () => (await themeState(tab)).resolved).toBe("dark");
    await themeButton(tab).click();
    await themeButton(tab).click();
    await expect.poll(async () => (await themeState(tab)).mode).toBe("light");
    expect((await themeState(tab)).dark).toBe(false);

    // A saved choice survives a reload and reaches the document again once it announces itself.
    await themeButton(tab).click();
    await themeButton(tab).click();
    await expect.poll(async () => (await themeState(tab)).mode).toBe("dark");
    await tab.reload();
    await expect(heading(tab, "Theme probe")).toBeVisible();
    expect(await themeState(tab)).toMatchObject({ dark: true, mode: "dark", stored: "dark" });
    await expect.poll(async () => (await documentTheme(tab)).message).toBe("dark");
    expect(await documentTheme(tab)).toMatchObject(publisher);
  });

  test("the avatar menu opens and closes by click, outside click and Escape, and leads to the account", async ({ asOwner: tab, site }) => {
    await open(tab, site.docs);
    const avatar = tab.locator("#avatar-btn");
    const menu = tab.locator("#avatar-menu");
    await expect(avatar).toHaveAttribute("aria-label", "Open account menu");
    await expect(avatar).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();

    await avatar.click();
    await expect(avatar).toHaveAttribute("aria-expanded", "true");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".avatar-menu-email")).toHaveText(await avatar.getAttribute("title") ?? "");
    await expect(menu.getByRole("link", { name: "Account security" })).toHaveAttribute("href", "/account/security");
    await expect(menu.getByRole("button", { name: "Sign out" })).toBeVisible();

    // The button toggles, and a click anywhere else in the shell closes it.
    await avatar.click();
    await expect(menu).toBeHidden();
    await expect(avatar).toHaveAttribute("aria-expanded", "false");
    await avatar.click();
    await expect(menu).toBeVisible();
    await tab.locator("#doc-sidebar-title").click();
    await expect(menu).toBeHidden();
    await expect(avatar).toHaveAttribute("aria-expanded", "false");

    // Escape closes it from the keyboard; the reader keeps their place.
    await avatar.focus();
    await tab.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await tab.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(avatar).toHaveAttribute("aria-expanded", "false");
    await expect(avatar).toBeFocused();

    await avatar.click();
    await menu.getByRole("link", { name: "Account security" }).click();
    await expect(tab).toHaveURL(/\/account\/security$/);
  });

  test("reading mode hides the shell, is remembered, and the hot zones, Escape and the shortcut bring it back", async ({ asOwner: tab, site }) => {
    test.slow();
    await open(tab, site.docs);
    const toggle = tab.locator("#shell-toggle");
    const topbar = tab.locator(".topbar");
    const sidebar = tab.locator("#doc-sidebar");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toHaveAttribute("aria-label", /^Hide app shell, keyboard shortcut (Ctrl|⌘) Shift H$/);
    await expect(toggle).toHaveAttribute("aria-describedby", "shell-shortcut-tooltip");
    await expect(tab.locator("#shell-shortcut-tooltip")).toHaveAttribute("role", "tooltip");
    await expect(topbar).toHaveCSS("opacity", "1");
    await expect(sidebar).toHaveCSS("opacity", "1");

    await toggle.click();
    expect(await classes(tab)).toContain("shell-hidden");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveAttribute("aria-label", /^Show app shell, keyboard shortcut/);
    await expect(topbar).toHaveCSS("opacity", "0");
    await expect(sidebar).toHaveCSS("opacity", "0");
    expect(await stored(tab, "rendro-shell-hidden")).toBe("1");
    // Hiding the shell takes focus off the control that was just used, so it is not left on something invisible.
    await expect(toggle).not.toBeFocused();
    // The document now has the whole window.
    await expect.poll(async () => {
      const box = await tab.locator("#content-frame").boundingBox();
      return box && [Math.round(box.x), Math.round(box.y)];
    }).toEqual([0, 0]);

    // The choice, but not the temporary reveal, is remembered across a reload.
    await tab.reload();
    await expect(heading(tab, "Viewer home")).toBeVisible();
    expect(await classes(tab)).toContain("shell-hidden");
    await expect(topbar).toHaveCSS("opacity", "0");

    // The left edge reveals the tree and the top edge the toolbar, each only while the pointer is there.
    await tab.mouse.move(400, 500);
    await tab.mouse.move(5, 500);
    await expect(sidebar).toHaveCSS("opacity", "1");
    expect(await classes(tab)).toContain("shell-sidebar-revealed");
    await tab.mouse.move(700, 500);
    await expect.poll(async () => classes(tab)).not.toContain("shell-sidebar-revealed");
    await expect(sidebar).toHaveCSS("opacity", "0");
    await tab.mouse.move(700, 4);
    await expect(topbar).toHaveCSS("opacity", "1");
    expect(await classes(tab)).toContain("shell-header-revealed");
    await tab.mouse.move(700, 500);
    await expect.poll(async () => classes(tab)).not.toContain("shell-header-revealed");

    // Escape brings everything back and puts focus on the control that undoes it.
    await tab.locator("body").focus();
    await tab.keyboard.press("Escape");
    expect(await classes(tab)).not.toContain("shell-hidden");
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(await stored(tab, "rendro-shell-hidden")).toBe("0");
    await expect(topbar).toHaveCSS("opacity", "1");

    // The shortcut works from the shell, and from inside the document too (no field focused).
    await tab.keyboard.press("Control+Shift+H");
    expect(await classes(tab)).toContain("shell-hidden");
    await tab.keyboard.press("Control+Shift+H");
    expect(await classes(tab)).not.toContain("shell-hidden");
    await expect(toggle).toBeFocused();
    await content(tab).locator("body").click({ position: { x: 600, y: 600 } });
    await tab.keyboard.press("Control+Shift+H");
    await expect.poll(async () => classes(tab)).toContain("shell-hidden");
    await tab.keyboard.press("Escape");
    // Escape reaches the shell only from the shell; from the document it is the document's key. Use the control again.
    await tab.mouse.move(700, 4);
    await toggle.click();
    expect(await classes(tab)).not.toContain("shell-hidden");
    // The shortcut is the reader's own: typing it into a field of the document is typing, not a command.
    await content(tab).getByLabel("Draft").focus();
    await tab.keyboard.press("Control+Shift+H");
    expect(await classes(tab)).not.toContain("shell-hidden");
  });

  test("the sidebar resizes by keyboard and by dragging within its limits, remembers the width, and never collapses the tree", async ({ asOwner: tab, site }) => {
    test.slow();
    await open(tab, site.docs);
    const resizer = tab.locator("#sidebar-resizer");
    const sidebar = tab.locator("#doc-sidebar");
    const width = async () => Math.round((await sidebar.boundingBox())?.width ?? 0);
    await expect(resizer).toHaveAttribute("role", "separator");
    await expect(resizer).toHaveAttribute("aria-orientation", "vertical");
    await expect(resizer).toHaveAttribute("aria-controls", "doc-sidebar");
    await expect(resizer).toHaveAttribute("aria-label", "Resize document tree");
    await expect(resizer).toHaveAttribute("aria-valuemin", "220");
    await expect(resizer).toHaveAttribute("aria-valuemax", "420");
    await expect(resizer).toHaveAttribute("aria-valuenow", "280");
    await expect(resizer).toHaveAttribute("aria-valuetext", "Document tree 280 pixels wide");
    await expect(resizer).toHaveAttribute("tabindex", "0");
    expect(await width()).toBe(280);

    await resizer.focus();
    const press = async (key: string, expected: number) => {
      await tab.keyboard.press(key);
      await expect(resizer).toHaveAttribute("aria-valuenow", String(expected));
      await expect(resizer).toHaveAttribute("aria-valuetext", `Document tree ${expected} pixels wide`);
      await expect.poll(width).toBe(expected);
      expect(await stored(tab, "rendro-sidebar-width")).toBe(String(expected));
    };
    await press("ArrowLeft", 256);
    await press("ArrowRight", 280);
    await press("ArrowRight", 304);
    await press("Home", 220);
    await press("ArrowLeft", 220); // The minimum holds.
    await press("End", 420);
    await press("ArrowRight", 420); // So does the maximum.
    // The tree is still there at the smallest size.
    await press("Home", 220);
    await expect(sidebar).toBeVisible();
    await expect(tab.locator("#tree-container")).toBeVisible();
    await expect(resizer).toBeFocused();

    // A pointer drag follows the pointer without animation, and the width is saved when it ends.
    const handle = await resizer.boundingBox();
    if (!handle) throw new Error("Missing resize handle");
    const y = handle.y + handle.height / 2;
    await tab.mouse.move(handle.x + handle.width / 2, y);
    await tab.mouse.down();
    await tab.mouse.move(340, y, { steps: 4 });
    expect(await classes(tab)).toContain("sidebar-resizing");
    await expect(sidebar).toHaveCSS("transition-duration", "0s");
    await expect.poll(width).toBe(340);
    await tab.mouse.up();
    expect(await classes(tab)).not.toContain("sidebar-resizing");
    await expect(resizer).toHaveAttribute("aria-valuenow", "340");
    expect(await stored(tab, "rendro-sidebar-width")).toBe("340");
    // A drag past either limit clamps to it.
    const handleAgain = await resizer.boundingBox();
    if (!handleAgain) throw new Error("Missing resize handle");
    await tab.mouse.move(handleAgain.x + handleAgain.width / 2, y);
    await tab.mouse.down();
    await tab.mouse.move(900, y, { steps: 4 });
    await expect.poll(width).toBe(420);
    await tab.mouse.move(10, y, { steps: 4 });
    await expect.poll(width).toBe(220);
    await tab.mouse.up();
    await expect(sidebar).toBeVisible();
    expect(await stored(tab, "rendro-sidebar-width")).toBe("220");

    // A drag that the browser cancels ends like a drop: no stuck drag state, and the width it reached is kept.
    const grip = await resizer.boundingBox();
    if (!grip) throw new Error("Missing resize handle");
    await tab.mouse.move(grip.x + grip.width / 2, y);
    await tab.mouse.down();
    await tab.mouse.move(300, y, { steps: 4 });
    await expect.poll(width).toBe(300);
    expect(await classes(tab)).toContain("sidebar-resizing");
    await resizer.dispatchEvent("pointercancel");
    expect(await classes(tab)).not.toContain("sidebar-resizing");
    await expect(resizer).toHaveAttribute("aria-valuenow", "300");
    expect(await stored(tab, "rendro-sidebar-width")).toBe("300");
    await tab.mouse.up();
    await tab.mouse.move(700, y);
    expect(await width()).toBe(300);

    // The saved width is restored on the next visit.
    await resizer.focus();
    await press("Home", 220);
    await tab.reload();
    await expect(heading(tab, "Viewer home")).toBeVisible();
    await expect(resizer).toHaveAttribute("aria-valuenow", "220");
    expect(await width()).toBe(220);

    // The widest the tree may be depends on the window: the document keeps at least 360px, so the limit and the width follow it.
    await resizer.focus();
    await press("End", 420);
    await tab.setViewportSize({ width: 770, height: 900 });
    await expect(resizer).toHaveAttribute("aria-valuemax", "410");
    await expect(resizer).toHaveAttribute("aria-valuenow", "410");
    await expect.poll(width).toBe(410);
    await tab.setViewportSize(desktop);
    await expect(resizer).toHaveAttribute("aria-valuemax", "420");
  });
});

test.describe("menus and the document", () => {
  test.fail("the account menu closes when the reader clicks in the document (known bug)", async ({ asOwner: tab, site }) => {
    // The document is another frame: a click inside it never reaches the shell's own click handler, so the menu stays open
    // over the page the reader is now reading. (The same holds for More on a phone.)
    await tab.setViewportSize(desktop);
    await open(tab, site.docs);
    await tab.locator("#avatar-btn").click();
    await expect(tab.locator("#avatar-menu")).toBeVisible();
    await content(tab).locator("body").click({ position: { x: 600, y: 600 } });
    await expect(tab.locator("#avatar-menu")).toBeHidden();
  });
});

test.describe("mobile chrome", () => {
  test.use({ viewport: mobile });

  test("the tree is a drawer: it opens and closes by button, backdrop and Escape, and choosing a document closes it", async ({ asOwner: tab, site }) => {
    await open(tab, site.docs);
    const toggle = tab.locator("#mobile-tree-toggle");
    const sidebar = tab.locator("#doc-sidebar");
    const backdrop = tab.locator("#mobile-tree-backdrop");
    // Closed: the drawer is off screen and out of the accessibility tree and tab order.
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-label", "Open document tree");
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(await inert(sidebar)).toBe(true);
    await expect(sidebar).not.toBeInViewport();
    await expect(tab.locator("#sidebar-resizer")).toBeHidden();
    await expect(backdrop).toHaveCSS("pointer-events", "none");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAttribute("aria-label", "Close document tree");
    expect(await classes(tab)).toContain("tree-mobile-open");
    await expect(sidebar).toHaveAttribute("aria-hidden", "false");
    expect(await inert(sidebar)).toBe(false);
    await expect(sidebar).toBeInViewport({ ratio: 0.99 });
    await expect(backdrop).toHaveCSS("pointer-events", "auto");
    // Rows inside the open drawer can be reached by keyboard.
    await folderRow(tab, "guide").focus();
    await expect(folderRow(tab, "guide")).toBeFocused();

    // Backdrop closes.
    await tab.mouse.click(mobile.width - 10, mobile.height / 2);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(await inert(sidebar)).toBe(true);
    await expect(sidebar).not.toBeInViewport();

    // Escape closes and puts focus back on the button that opened it.
    await toggle.click();
    await expect(sidebar).toBeInViewport({ ratio: 0.99 });
    await folderRow(tab, "guide").focus();
    await tab.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(sidebar).not.toBeInViewport();

    // Opening a folder keeps the drawer open; choosing a document closes it and shows that document.
    await toggle.click();
    await folderRow(tab, "guide").click();
    await expect(folderRow(tab, "guide")).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await fileLink(tab, "guide/intro.html").click();
    await expect(heading(tab, "Guide intro")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar).not.toBeInViewport();
    await expect(tab).toHaveURL(/\?doc=guide%2Fintro\.html$/);
    await expect(active(tab)).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
  });

  test("More holds the secondary actions: it opens and closes, moves focus, runs each action once, and gives them back on desktop", async ({ asOwner: tab, site }) => {
    test.slow();
    await open(tab, site.docs);
    const more = tab.locator("#mobile-more-btn");
    const menu = tab.locator("#mobile-more-menu");
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute("aria-label", "More document actions");
    await expect(more).toHaveAttribute("aria-haspopup", "dialog");
    await expect(more).toHaveAttribute("aria-controls", "mobile-more-menu");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();
    await expect(menu).toHaveAttribute("role", "dialog");
    // The share and tree actions stay on the bar; the rest moved into the menu, once each.
    for (const selector of [".topbar-btn-back", "#shell-toggle", ".rendro-theme-control", "#avatar-btn"]) {
      await expect(menu.locator(selector)).toHaveCount(1);
      await expect(tab.locator(selector)).toHaveCount(1);
    }
    await expect(menu.locator(".topbar-btn-back")).toHaveAttribute("href", `/organizations/${site.organizationId}/projects/${site.projectId}`);
    await expect(tab.locator("#share-btn")).toBeVisible();
    await expect(tab.locator("#mobile-tree-toggle")).toBeVisible();

    // Opening puts focus on the first action; Escape closes and returns it to the button.
    await more.click();
    await expect(menu).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(menu.locator("a, button").first()).toBeFocused();
    await tab.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(more).toBeFocused();
    // The button toggles; a tap on the page outside closes it without taking focus.
    await more.click();
    await expect(menu).toBeVisible();
    await more.click();
    await expect(menu).toBeHidden();
    await more.click();
    await expect(menu).toBeVisible();
    await tab.locator(".topbar-title, .topbar").first().click({ position: { x: 130, y: 28 } });
    await expect(menu).toBeHidden();
    await expect(more).toHaveAttribute("aria-expanded", "false");

    // Theme runs exactly one step per tap (no duplicated handler after the move) and closes the menu.
    await expect.poll(async () => (await themeState(tab)).mode).toBe("system");
    await more.click();
    await menu.locator(".rendro-theme-control").click();
    await expect(menu).toBeHidden();
    await expect.poll(async () => (await themeState(tab)).mode).toBe("dark");
    await more.click();
    await menu.locator(".rendro-theme-control").click();
    await expect.poll(async () => (await themeState(tab)).mode).toBe("light");
    expect((await themeState(tab)).dark).toBe(false);

    // Reading mode: from the menu; leaving it by Escape focuses More, the only shell control on a phone.
    await more.click();
    await menu.locator("#shell-toggle").click();
    await expect(menu).toBeHidden();
    expect(await classes(tab)).toContain("shell-hidden");
    await expect(tab.locator("#shell-toggle")).toHaveAttribute("aria-label", /^Exit reading mode, keyboard shortcut/);
    await tab.locator("#shell-mobile-label").evaluate(label => label.textContent).then(text => expect(text).toBe("Exit reading mode"));
    await tab.locator("body").focus();
    await tab.keyboard.press("Escape");
    expect(await classes(tab)).not.toContain("shell-hidden");
    await expect(more).toBeFocused();
    await expect(tab.locator("#shell-toggle")).toHaveAttribute("aria-label", /^Enter reading mode, keyboard shortcut/);

    // The account menu opens inside More; Escape closes both and returns focus to More.
    await more.click();
    await menu.locator("#avatar-btn").click();
    await expect(tab.locator("#avatar-menu")).toBeVisible();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { name: "Account security" })).toBeVisible();
    await tab.keyboard.press("Escape");
    await expect(tab.locator("#avatar-menu")).toBeHidden();
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();

    // Landscape is a desktop layout: the actions go back to the bar, the drawer button and More disappear, and the
    // tree is a sidebar again, readable and out of the way of the document.
    await tab.setViewportSize({ width: 812, height: 375 });
    await expect(more).toBeHidden();
    await expect(tab.locator("#mobile-tree-toggle")).toBeHidden();
    for (const selector of [".topbar-btn-back", "#shell-toggle", ".rendro-theme-control", "#avatar-btn"]) {
      await expect(menu.locator(selector)).toHaveCount(0);
      await expect(tab.locator(selector)).toBeVisible();
    }
    await expect(tab.locator("#doc-sidebar")).toBeInViewport();
    await expect(tab.locator("#doc-sidebar")).toHaveAttribute("aria-hidden", "false");
    expect(await inert(tab.locator("#doc-sidebar"))).toBe(false);
    await expect(tab.locator("#sidebar-resizer")).toBeVisible();
    await expect(tab.locator("#sidebar-resizer")).toHaveAttribute("tabindex", "0");
    // And back to portrait: moved into More again, still one of each and still one step per tap.
    await tab.setViewportSize(mobile);
    await expect(more).toBeVisible();
    for (const selector of [".topbar-btn-back", "#shell-toggle", ".rendro-theme-control", "#avatar-btn"]) await expect(menu.locator(selector)).toHaveCount(1);
    await expect(tab.locator("#doc-sidebar")).toHaveAttribute("aria-hidden", "true");
    await expect(tab.locator("#sidebar-resizer")).toHaveAttribute("tabindex", "-1");
    await more.click();
    await menu.locator(".rendro-theme-control").click();
    await expect.poll(async () => (await themeState(tab)).mode).toBe("system");
  });

  test("the bar, the drawer and the menu stay inside 320, 375 and 430px screens", async ({ asOwner: tab, site }) => {
    test.slow();
    for (const width of [320, 375, 430]) {
      await tab.setViewportSize({ width, height: 800 });
      await open(tab, site.docs);
      const overflow = () => tab.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, body: document.body.scrollWidth - window.innerWidth }));
      expect(await overflow()).toEqual({ page: 0, body: 0 });
      // The actions that stay on the bar are all fully on screen and large enough to tap.
      for (const selector of ["#mobile-tree-toggle", "#share-btn", "#mobile-more-btn"]) {
        const box = await tab.locator(selector).boundingBox();
        if (!box) throw new Error(`${selector} is not shown`);
        expect(box.x, selector).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, selector).toBeLessThanOrEqual(width);
        expect(box.height, selector).toBeGreaterThanOrEqual(36);
      }
      const frame = await tab.locator("#content-frame").boundingBox();
      expect(frame?.x).toBe(0);
      expect(Math.round(frame?.width ?? 0)).toBe(width);
      // The drawer and the menu fit as well.
      await tab.locator("#mobile-tree-toggle").click();
      // Both slide in over a transition: measure once it has landed.
      await expect.poll(async () => (await tab.locator("#doc-sidebar").boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
      const sidebar = await tab.locator("#doc-sidebar").boundingBox();
      expect(sidebar?.x).toBeGreaterThanOrEqual(0);
      expect((sidebar?.x ?? 0) + (sidebar?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(await overflow()).toEqual({ page: 0, body: 0 });
      await tab.keyboard.press("Escape");
      await expect(tab.locator("#doc-sidebar")).not.toBeInViewport();
      await tab.locator("#mobile-more-btn").click();
      await expect(tab.locator("#mobile-more-menu")).toBeInViewport({ ratio: 0.99 });
      await expect.poll(async () => (await tab.locator("#mobile-more-menu").boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
      const menu = await tab.locator("#mobile-more-menu").boundingBox();
      expect(menu?.x).toBeGreaterThanOrEqual(0);
      expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(await overflow()).toEqual({ page: 0, body: 0 });
    }
  });
});

/**
 * Holds every request for a document file (the shell asks twice per navigation: the frame's `src` and the replacing load) until released, so loading, slow and never-arriving documents are exact. Requests
 * that were held when the test ends are released so nothing is left waiting.
 */
async function holdDocument(tab: Page, file: string) {
  const glob = `**/files/${file}`;
  const pending: Route[] = [];
  let holding = true;
  const handler = async (route: Route) => {
    if (!holding) { await route.continue().catch(() => undefined); return; }
    pending.push(route);
  };
  await tab.route(glob, handler);
  return {
    held: () => pending.length,
    /** Delivers what is waiting and stops holding. */
    async release() { holding = false; for (const route of pending.splice(0)) await route.continue().catch(() => undefined); },
    async close() { await this.release(); await tab.unroute(glob, handler); },
  };
}
/** Pauses the page clock where it is, after everything armed so far has run, so only the test advances time. */
async function pauseClock(tab: Page) {
  const now = await tab.evaluate(() => Date.now());
  await tab.clock.pauseAt(now + 1000);
}
const loadStatus = (tab: Page) => tab.locator("#document-load-status");

test.describe("document loading", () => {
  test.use({ viewport: desktop });

  test("a slow document shows progress and says so; once it arrives the content is shown at once and the progress ends after its minimum", async ({ asOwner: tab, site }) => {
    await tab.clock.install();
    await open(tab, site.docs);
    await pauseClock(tab);
    expect(await classes(tab)).not.toContain("doc-loading");
    await folderRow(tab, "guide").click();
    await expect(folderRow(tab, "guide")).toHaveAttribute("aria-expanded", "true");
    const hold = await holdDocument(tab, "guide/intro.html");
    try {
      await fileLink(tab, "guide/intro.html").click();
      await expect.poll(() => hold.held()).toBeGreaterThan(0);
      // The row is selected and the URL names the document before it has arrived; the old document stays fully opaque.
      expect(await classes(tab)).toContain("doc-loading");
      expect(await classes(tab)).not.toContain("doc-loading-error");
      await expect(active(tab)).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
      await expect(tab).toHaveURL(/\?doc=guide%2Fintro\.html$/);
      await expect(loadStatus(tab)).toHaveText("Loading document");
      await expect(loadStatus(tab)).toHaveAttribute("role", "status");
      await expect(loadStatus(tab)).toHaveAttribute("aria-live", "polite");
      await expect(tab.locator("#content-frame")).toHaveAttribute("aria-busy", "true");
      await expect(tab.locator("#content-frame")).toHaveCSS("opacity", "1");
      await expect(heading(tab, "Viewer home")).toBeVisible();

      await hold.release();
      await expect(heading(tab, "Guide intro")).toBeVisible();
      // The status clears and the frame is no longer busy right away; the row keeps its progress look for the minimum.
      await expect(loadStatus(tab)).toHaveText("");
      await expect(tab.locator("#content-frame")).not.toHaveAttribute("aria-busy", /.*/);
      expect(await classes(tab)).toContain("doc-loading");
      await tab.clock.runFor(519);
      expect(await classes(tab)).toContain("doc-loading");
      await tab.clock.runFor(1);
      expect(await classes(tab)).not.toContain("doc-loading");
      expect(await classes(tab)).not.toContain("doc-loading-error");
    } finally {
      await hold.close();
    }
  });

  test("a document that never arrives fails after fifteen seconds with an assertive announcement, and selecting it again recovers", async ({ asOwner: tab, site }) => {
    await tab.clock.install();
    await open(tab, site.docs);
    await pauseClock(tab);
    await folderRow(tab, "guide").click();
    await expect(folderRow(tab, "guide")).toHaveAttribute("aria-expanded", "true");
    const hold = await holdDocument(tab, "guide/intro.html");
    try {
      await fileLink(tab, "guide/intro.html").click();
      await expect.poll(() => hold.held()).toBeGreaterThan(0);
      await expect(loadStatus(tab)).toHaveText("Loading document");
      await tab.clock.runFor(14_999);
      expect(await classes(tab)).toContain("doc-loading");
      expect(await classes(tab)).not.toContain("doc-loading-error");
      await tab.clock.runFor(1);

      // Failed: the progress is replaced by a static error tint on the selected row and an assertive announcement.
      expect(await classes(tab)).toContain("doc-loading-error");
      expect(await classes(tab)).not.toContain("doc-loading");
      await expect(loadStatus(tab)).toHaveText("Document failed to load. Select it again to retry.");
      await expect(loadStatus(tab)).toHaveAttribute("aria-live", "assertive");
      await expect(tab.locator("#content-frame")).not.toHaveAttribute("aria-busy", /.*/);
      await expect(active(tab)).toHaveAttribute("data-path", /\/guide\/intro\.html$/);
      await expect(tab).toHaveURL(/\?doc=guide%2Fintro\.html$/);
      const tint = await active(tab).evaluate(row => getComputedStyle(row, "::before").backgroundColor);
      expect(tint).toBe("rgba(180, 35, 24, 0.1)");

      // The same row selected again asks again, and this time it arrives.
      await hold.release();
      await fileLink(tab, "guide/intro.html").click();
      await expect(heading(tab, "Guide intro")).toBeVisible();
      await expect(loadStatus(tab)).toHaveText("");
      expect(await classes(tab)).not.toContain("doc-loading-error");
      await tab.clock.runFor(520);
      expect(await classes(tab)).not.toContain("doc-loading");
      // And nothing is left to fire: the earlier timeout did not survive the retry.
      await tab.clock.runFor(30_000);
      expect(await classes(tab)).not.toContain("doc-loading-error");
      await expect(loadStatus(tab)).toHaveText("");
    } finally {
      await hold.close();
    }
  });

  test("a load that was replaced cannot fail or finish the one that replaced it", async ({ asOwner: tab, site }) => {
    await tab.clock.install();
    await open(tab, site.docs);
    await pauseClock(tab);
    await folderRow(tab, "guide").click();
    await expect(folderRow(tab, "guide")).toHaveAttribute("aria-expanded", "true");
    await folderRow(tab, "guide/deep").click();
    await expect(folderRow(tab, "guide/deep")).toHaveAttribute("aria-expanded", "true");
    const first = await holdDocument(tab, "guide/intro.html");
    const second = await holdDocument(tab, "guide/deep/topic.html");
    try {
      await fileLink(tab, "guide/intro.html").click();
      await expect.poll(() => first.held()).toBeGreaterThan(0);
      await tab.clock.runFor(10_000);
      await fileLink(tab, "guide/deep/topic.html").click();
      await expect.poll(() => second.held()).toBeGreaterThan(0);
      await expect(active(tab)).toHaveAttribute("data-path", /\/guide\/deep\/topic\.html$/);
      // Fifteen seconds after the first request, the first one's deadline passes. It no longer applies; only the newer
      // one's would, five seconds later.
      await tab.clock.runFor(5_000);
      expect(await classes(tab)).toContain("doc-loading");
      expect(await classes(tab)).not.toContain("doc-loading-error");
      await expect(loadStatus(tab)).toHaveText("Loading document");
      await tab.clock.runFor(10_000);
      expect(await classes(tab)).toContain("doc-loading-error");
      // The replaced request arriving late changes nothing about the selected document.
      await first.release();
      await expect(active(tab)).toHaveAttribute("data-path", /\/guide\/deep\/topic\.html$/);
      await expect(tab).toHaveURL(/\?doc=guide%2Fdeep%2Ftopic\.html$/);
      await second.release();
      await fileLink(tab, "guide/deep/topic.html").click();
      await expect(heading(tab, "Deep topic")).toBeVisible();
      await expect(loadStatus(tab)).toHaveText("");
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("with reduced motion the loading row is static", async ({ asOwner: tab, site }) => {
    await open(tab, site.docs);
    await folderRow(tab, "guide").click();
    await expect(folderRow(tab, "guide")).toHaveAttribute("aria-expanded", "true");
    const animation = () => active(tab).evaluate(row => ({ row: getComputedStyle(row).animationName, shimmer: getComputedStyle(row, "::before").animationName }));
    for (const [motion, moving] of [["no-preference", true], ["reduce", false]] as const) {
      await tab.emulateMedia({ reducedMotion: motion });
      const hold = await holdDocument(tab, motion === "reduce" ? "guide/intro.html" : "guide/deep/topic.html");
      try {
        await folderRow(tab, "guide/deep").click().catch(() => undefined);
        const target = motion === "reduce" ? "guide/intro.html" : "guide/deep/topic.html";
        await fileLink(tab, target).click();
        await expect.poll(() => hold.held()).toBeGreaterThan(0);
        expect(await classes(tab)).toContain("doc-loading");
        const state = await animation();
        if (moving) expect(state.row).not.toBe("none");
        else expect(state).toEqual({ row: "none", shimmer: "none" });
      } finally {
        await hold.close();
      }
      await expect(loadStatus(tab)).toHaveText("");
    }
  });
});

test.describe("sharing from the viewer", () => {
  test.use({ viewport: desktop });

  test("a failed share says so in the live region, offers Retry and Dismiss, and returns focus to the button", async ({ asOwner: tab, site }) => {
    await fakeClipboard(tab);
    await open(tab, site.docs);
    const share = tab.locator("#share-btn");
    const live = tab.locator("#share-live");
    const alert = tab.locator("#share-error");
    await expect(live).toHaveAttribute("role", "status");
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveText("");
    await expect(alert).toBeHidden();
    let respond = (route: Route) => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "share_busy" }) });
    await tab.route("**/api/rendro/shares", route => respond(route));

    await share.click();
    await expect(alert).toBeVisible();
    await expect(alert.locator("#share-error-text")).toHaveText("Sharing is taking longer than expected right now. Please try again.");
    await expect(live).toHaveText(/^Sharing is taking longer than expected right now\. Please try again\./);
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(share).not.toHaveAttribute("aria-busy", /.*/);

    // Dismiss hides the notice and gives focus back to the share button.
    await alert.getByRole("button", { name: "Dismiss" }).click();
    await expect(alert).toBeHidden();
    await expect(share).toBeFocused();

    // The same notice, closed with Escape from the button.
    await share.click();
    await expect(alert).toBeVisible();
    await share.focus();
    await tab.keyboard.press("Escape");
    await expect(alert).toBeHidden();
    await expect(share).toBeFocused();

    // A permanent refusal offers no Retry; a retryable one that then succeeds clears the notice.
    respond = route => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "share_unavailable" }) });
    await share.click();
    await expect(alert.locator("#share-error-text")).toHaveText("This document cannot be shared because it, or a file it needs, is unavailable.");
    await expect(alert.getByRole("button", { name: "Retry" })).toBeHidden();
    await alert.getByRole("button", { name: "Dismiss" }).click();
    respond = route => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ code: "share_busy" }) });
    await share.click();
    await expect(alert.getByRole("button", { name: "Retry" })).toBeVisible();
    await tab.unroute("**/api/rendro/shares");
    await alert.getByRole("button", { name: "Retry" }).click();
    // The "copied" label is a short-lived confirmation a poll can miss; what stays is the link on the clipboard and no notice.
    await expect.poll(async () => (await clipboard(tab)).length).toBe(1);
    await expect(alert).toBeHidden();
    await expect(share).not.toHaveAttribute("aria-busy", /.*/);
  });
});
