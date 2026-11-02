import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./actor-fixtures";
import { anchorOn, card, createThread, journeyDoc, open, openDrawer, pin, repoIds, repos, sessionToken, threadsAs, ui, unique } from "./comment-helpers";
import { desktop } from "./shell-helpers";

/**
 * A click that a live update would have dropped (#350). The widget rebuilds its drawer list, pins and bubble whenever the
 * subscription delivers a change, and a click needs its button to survive from press to release. Here the update is
 * another write of the same person (a second tab, say), delivered through the real shell, Convex and the sandboxed frame,
 * while the pointer is held on a control. Nothing retries: the release must act, and the update must follow.
 */
test.use({ viewport: desktop });

test.beforeEach(({ cspViolations }) => { void cspViolations; });
test.afterEach(({ cspViolations }) => {
  expect(cspViolations.filter(message => !/x-frame-options/i.test(message)), "CSP violations").toEqual([]);
});

/** Run `write`, then resolve once the widget's document has handled the update that carries `body`. */
async function updateThrough(page: Page, body: string, write: () => Promise<unknown>) {
  const frame = (await page.locator("#content-frame").elementHandle().then(handle => handle.contentFrame()))!;
  const delivered = frame.evaluate(needle => new Promise<void>(resolve => {
    addEventListener("message", function seen(event: MessageEvent) {
      const threads = (event.data as { threads?: Array<{ body: string }> } | null)?.threads;
      if (!threads?.some(thread => thread.body === needle)) return;
      removeEventListener("message", seen);
      resolve();
    });
  }), body);
  await write();
  await delivered;
}
/** Hover waits for the control to be stable and in view, then the pointer goes down where it is. */
async function pressOn(page: Page, target: Locator) {
  await target.hover();
  await page.mouse.down();
}

test("a click held while a live update rebuilds the list still acts, and the update follows", async ({ actor }) => {
  test.setTimeout(240_000);
  const { comments } = repos();
  const doc = await journeyDoc("press");
  const scope = { repoId: repoIds.comments, path: doc.path };
  const reader = await actor("press");
  await open(reader.page, comments, doc.path, doc.commit);
  const token = await sessionToken(reader.page);
  const anchor = await anchorOn(reader.page, "quick brown");
  const doomed = unique("Doomed remark");
  const kept = unique("Kept remark");
  const doomedId = await createThread(token, scope, doomed, anchor);
  await createThread(token, scope, kept, anchor);
  await openDrawer(reader.page);
  await expect(ui(reader.page).getByTestId("commentor-drawer")).toHaveAttribute("data-layout", "settled");
  await expect(card(reader.page, doomed)).toBeVisible();
  await expect(card(reader.page, kept)).toBeVisible();

  // Delete, pressed in the drawer: the list is rebuilt under the held pointer.
  await pressOn(reader.page, card(reader.page, doomed).getByTestId("commentor-delete-btn"));
  const late = unique("Late remark");
  await updateThrough(reader.page, late, () => createThread(token, scope, late, anchor));
  await reader.page.mouse.up();
  await expect(ui(reader.page).locator('.toast[role="status"]', { hasText: "Comment deleted." })).toBeVisible();
  await expect(card(reader.page, late)).toBeVisible();
  await expect(card(reader.page, doomed)).toHaveCount(0);
  await expect.poll(async () => (await threadsAs(token, scope)).map(thread => thread._id), { timeout: 20_000 }).not.toContain(doomedId);

  // A pin, pressed while the pins are rebuilt: its bubble opens on release.
  const later = unique("Later remark");
  await pressOn(reader.page, pin(reader.page, kept));
  await updateThrough(reader.page, later, () => createThread(token, scope, later, anchor));
  await reader.page.mouse.up();
  await expect(ui(reader.page).getByTestId("commentor-thread-bubble")).toContainText(kept);
  await expect(pin(reader.page, later)).toBeVisible();
});
