import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, choose, confirmDialog, failOnce, join, optionsOf, toasts } from "./org-fixtures";
import { holdRequest } from "./auth-helpers";
import { api, clipboard, fakeClipboard } from "./shell-helpers";
import { createKey, deploymentsOf, failStaged, html, openManagement, pushSite, startDeployment, svg, watch, withKey } from "./project-helpers";

type Publication = { _id: string; slug: string; title: string; pathPrefix: string; entryFile: string; trackingMode: string; pinnedDeploymentId?: string };
const site = (version: string) => ({
  "index.html": html(`Public home ${version}`, '<img src="guide/mark.svg" alt="Mark">'),
  "guide/index.html": html(`Guide home ${version}`),
  "guide/page.html": html(`Guide page ${version}`),
  "guide/mark.svg": svg,
  "secret/notes.html": html("Secret notes"),
});
const listPublications = async (page: Page, organizationId: string, projectId: string) =>
  (await api<{ publications: Publication[] }>(page, `/api/rendro/publications?organizationId=${organizationId}&projectId=${projectId}`)).body.publications;
const row = (page: Page, text: string | RegExp) => page.locator("#publication-list tr", { hasText: text });
const dialog = (page: Page) => page.locator("#publication-dialog");

/** Anonymous statuses for the shell (with an optional document query) and files of a publication. */
async function publicStatuses(context: BrowserContext, slug: string, targets: string[]) {
  const result: Record<string, number> = {};
  for (const target of targets) result[target] = (await context.request.get(`/p/${slug}${target}`)).status();
  return result;
}

test.describe("publications", () => {
  test("publish with validation, a tracked and a pinned publication, view them anonymously, then unpublish", async ({ actor, secondContext, baseURL }) => {
    test.setTimeout(180_000);
    const owner = await actor("publish", { organizations: ["Publish Org"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    const { rawKey } = await createKey(page, organization.id, project);
    const unique = `${organization.id.slice(-8)}`.toLowerCase();
    const tracked = `tracked-${unique}`, pinned = `pinned-${unique}`;
    const base = `/organizations/${organization.id}/projects/${project}`;
    const reads = watch(page, "/api/rendro/deployments?");
    await fakeClipboard(page);

    // Empty list, before anything is deployed.
    await openManagement(page, `${base}/publications`);
    await expect(page.getByRole("heading", { name: "Publications", level: 1 })).toBeVisible();
    await expect(page.locator(".cp-page-description")).toHaveText("Stable public URLs for Publish Org docs. Publication is explicit and independently revocable.");
    await expect(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Publications", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "No public documentation", level: 2 })).toBeVisible();
    await expect(page.getByText("Create a tracked publication for continuously updated docs or pin one immutable release.")).toBeVisible();
    await expect(page.locator("#publication-access-note")).toBeHidden();
    const create = page.locator("#publication-create");
    await expect(create).toBeEnabled();
    // No deployment is requested until a pinned release is asked for.
    expect(reads).toEqual([]);

    const slug = dialog(page).locator("input[name=slug]"), title = dialog(page).locator("input[name=title]");
    const prefix = dialog(page).locator("input[name=pathPrefix]"), entry = dialog(page).locator("input[name=entryFile]");
    const submit = dialog(page).getByRole("button", { name: "Create publication", exact: true });
    const failure = page.locator("#publication-error");
    await create.click();
    await expect(dialog(page)).toBeVisible();
    expect(await dialog(page).evaluate(element => element.matches(":modal"))).toBe(true);
    await expect(entry).toHaveValue("index.html");
    await expect(dialog(page).getByRole("combobox", { name: /Release mode/ })).toHaveText("Track active deployment");
    await expect(page.locator("#pin-field")).toBeHidden();

    // Native validation blocks before any request; then a project with no deployment cannot be published, and the form survives.
    await submit.click();
    await expect(slug).toBeFocused();
    await slug.fill("Not A Slug");
    await title.fill("Public docs");
    await submit.click();
    await expect(slug).toBeFocused();
    await slug.fill(tracked);
    await title.fill("");
    await submit.click();
    await expect(title).toBeFocused();
    await title.fill("Public docs");
    await submit.click();
    await expect(failure).toHaveText("Publication requires an available deployment");
    await expect(failure).toHaveAttribute("role", "alert");
    await expect(submit).toBeEnabled();
    await expect(slug).toHaveValue(tracked);
    await expect(title).toHaveValue("Public docs");
    expect(await listPublications(page, organization.id, project)).toEqual([]);
    // A pinned release has nothing to pin yet. When the choices cannot be loaded the dialog says so and offers a retry;
    // then it explains that there is nothing to pin, and creation is refused locally.
    const choicesOutage = await failOnce(page, "**/api/rendro/deployments?*", "Deployment choices unavailable");
    await choose(page, /Release mode/, "Pin one deployment", dialog(page));
    await expect(page.locator("#pin-field")).toBeVisible();
    await expect(dialog(page).getByRole("combobox", { name: /Deployment/ })).toHaveText("Unable to load deployments");
    await expect(failure).toHaveText("Deployment choices unavailable");
    await dialog(page).getByRole("button", { name: "Retry deployment choices", exact: true }).click();
    expect(choicesOutage.failures()).toBe(1);
    await choicesOutage.close();
    await expect(dialog(page).getByRole("combobox", { name: /Deployment/ })).toHaveText("No published deployments");
    await expect(dialog(page).getByRole("button", { name: "Retry deployment choices" })).toBeHidden();
    await expect(failure).toHaveText("Deploy this project before creating a pinned publication.");
    await submit.click();
    await expect(failure).toHaveText("Choose an available deployment before creating a pinned publication.");
    expect(reads.length).toBe(2);
    await choose(page, /Release mode/, "Track active deployment", dialog(page));
    await expect(page.locator("#pin-field")).toBeHidden();
    await expect(failure).toBeEmpty();
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(create).toBeFocused();

    // First release, then a tracked publication: an unknown entry file is refused with the form retained, the right one publishes.
    await pushSite(baseURL, organization.id, project, rawKey, site("v1"), "publish-v1");
    // Deploying publishes nothing: neither the planned URL nor the project's private document routes answer an anonymous visitor.
    expect((await secondContext.request.get(`/p/${tracked}`)).status()).toBe(404);
    expect([302, 401, 403, 404]).toContain((await secondContext.request.get(`${base}/docs/files/index.html`, { maxRedirects: 0 })).status());
    expect((await secondContext.request.get(`${base}/docs?doc=index.html`, { maxRedirects: 0 })).status()).not.toBe(200);
    await create.click();
    await slug.fill(tracked);
    await title.fill("Public docs");
    await entry.fill("nothing.html");
    await submit.click();
    await expect(failure).toHaveText("Publication entry file is not present in the selected deployment path");
    await expect(entry).toHaveValue("nothing.html");
    await entry.fill("index.html");
    await submit.click();
    await expect(dialog(page)).toBeHidden();
    await expect(toasts(page).filter({ hasText: "Publication created." })).toHaveCount(1);
    const trackedRow = row(page, "Public docs");
    await expect(trackedRow).toHaveCount(1);
    const link = trackedRow.locator("td[data-label=Publication] a");
    await expect(link).toHaveText(`${baseURL}/p/${tracked}`);
    await expect(link).toHaveAttribute("href", `/p/${tracked}`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener");
    await expect(trackedRow.locator("td[data-label=Path]")).toHaveText("Project root");
    await expect(trackedRow.locator("td[data-label='Release mode'] .badge")).toHaveText("Tracks active");
    await expect(trackedRow.locator("td[data-label='Release mode'] .badge")).toHaveClass(/success/);
    const [made] = await listPublications(page, organization.id, project);
    expect(made).toMatchObject({ slug: tracked, title: "Public docs", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" });
    expect(made.pinnedDeploymentId).toBeUndefined();

    // Anonymous visitors read it at its stable URL, with its assets, and nothing else of the deployment.
    const visitor = await secondContext.newPage();
    const opened = await visitor.goto(`/p/${tracked}`);
    expect(opened!.status()).toBe(200);
    // Never served from a shared cache without revalidation: a removed or republished URL changes on the next request.
    expect(opened!.headers()["cache-control"]).toMatch(/no-store|max-age=0/);
    await expect(visitor.frameLocator("#content-frame").getByRole("heading", { name: "Public home v1" })).toBeVisible();
    await expect(visitor.frameLocator("#content-frame").getByRole("img", { name: "Mark" })).toHaveJSProperty("naturalWidth", 8);
    await expect(visitor.getByRole("link", { name: /sign in/i })).toHaveCount(0);
    expect(await publicStatuses(secondContext, tracked, ["", "?doc=guide/page.html", "?doc=nothing.html", "?doc=../x.html", "/files/index.html", "/files/guide/mark.svg", "/files/nothing.html"]))
      .toEqual({ "": 200, "?doc=guide/page.html": 200, "?doc=nothing.html": 404, "?doc=../x.html": 404, "/files/index.html": 200, "/files/guide/mark.svg": 200, "/files/nothing.html": 404 });

    // Copy URL: exact public URL. The pinned dialog offers only the releases that can be served.
    await row(page, "Public docs").getByRole("button", { name: "Copy URL", exact: true }).click();
    await expect.poll(() => clipboard(page)).toEqual([`${baseURL}/p/${tracked}`]);
    const staging = await startDeployment(rawKey, organization.id, project, { "index.html": html("Never published") });
    const failed = await startDeployment(rawKey, organization.id, project, { "index.html": html("Failed attempt") });
    expect((await failStaged(rawKey, organization.id, project, failed, "bad upload")).status).toBe(200);
    expect(staging.deploymentId).not.toBe(failed.deploymentId);
    await pushSite(baseURL, organization.id, project, rawKey, site("v2"), "publish-v2");
    const listed = (await withKey<{ deployments: Array<{ _id: string; status: string }> }>(rawKey, `/api/rendro/deployments?organizationId=${organization.id}&projectId=${project}`)).body.deployments;
    expect(listed.map(entry => entry.status)).toEqual(["active", "failed", "staging", "superseded"]);
    const [active, , , superseded] = listed;

    // Pin the first release under a folder: only active and superseded releases are offered; staging and failed ones are not.
    await page.reload();
    await expect(row(page, "Public docs")).toHaveCount(1);
    await page.locator("#publication-create").click();
    // The created publication cleared the form: nothing carried over to the next one.
    await expect(slug).toHaveValue("");
    await expect(title).toHaveValue("");
    await expect(entry).toHaveValue("index.html");
    await expect(failure).toBeEmpty();
    await slug.fill(pinned);
    await title.fill("Guide v1");
    await prefix.fill("guide");
    await choose(page, /Release mode/, "Pin one deployment", dialog(page));
    await expect(page.locator("#pin-field")).toBeVisible();
    await expect(dialog(page).getByRole("combobox", { name: /Deployment/ })).toBeEnabled();
    const options = await optionsOf(page, /Deployment/, dialog(page));
    expect(options.map(option => option.text.split(" · ")[1])).toEqual(["Active", "Superseded"]);
    expect(options.every(option => !option.disabled)).toBe(true);
    expect(options[0].text).toContain(active._id.slice(0, 12));
    expect(options[1].text).toContain(superseded._id.slice(0, 12));
    await choose(page, /Deployment/, options[1].text, dialog(page));
    await submit.click();
    await expect(dialog(page)).toBeHidden();
    const pinnedRow = row(page, "Guide v1");
    await expect(pinnedRow.locator("td[data-label=Path]")).toHaveText("guide");
    await expect(pinnedRow.locator("td[data-label='Release mode'] .badge")).toHaveText("Pinned");
    await expect(pinnedRow.locator("td[data-label='Release mode'] .badge")).toHaveClass(/warning/);
    const stored = (await listPublications(page, organization.id, project)).find(entry => entry.slug === pinned)!;
    expect(stored).toMatchObject({ pathPrefix: "guide", trackingMode: "pinned", pinnedDeploymentId: superseded._id });

    // The tracked URL follows the new active release; the pinned one keeps the old one and cannot leave its folder.
    await visitor.goto(`/p/${tracked}`);
    await expect(visitor.frameLocator("#content-frame").getByRole("heading", { name: "Public home v2" })).toBeVisible();
    await visitor.goto(`/p/${pinned}`);
    await expect(visitor.frameLocator("#content-frame").getByRole("heading", { name: "Guide home v1" })).toBeVisible();
    expect(await publicStatuses(secondContext, pinned, ["", "?doc=page.html", "?doc=guide/page.html", "?doc=secret/notes.html", "?doc=../secret/notes.html", "/files/page.html", "/files/index.html", "/files/guide/index.html", "/files/..%2Fsecret/notes.html", "/files/secret/notes.html"]))
      .toEqual({ "": 200, "?doc=page.html": 200, "?doc=guide/page.html": 404, "?doc=secret/notes.html": 404, "?doc=../secret/notes.html": 404, "/files/page.html": 200, "/files/index.html": 200, "/files/guide/index.html": 404, "/files/..%2Fsecret/notes.html": 404, "/files/secret/notes.html": 404 });
    const tree = await (await secondContext.request.get(`/p/${pinned}/tree?dir=`)).json() as { children: Array<{ name?: string; path?: string }> };
    expect(JSON.stringify(tree)).toContain("page");
    expect(JSON.stringify(tree)).not.toContain("secret");
    expect((await secondContext.request.get(`/p/${pinned}/tree?dir=..%2Fsecret%2F`)).status()).toBe(400);
    const pageText = await (await secondContext.request.get(`/p/${pinned}/files/page.html`)).text();
    expect(pageText).toContain("Guide page v1");

    // The slug namespace: lowercase on the way in, unique, and not reusable by a second publication while it exists.
    const duplicate = await withKey<{ error?: string }>(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug: tracked.toUpperCase(), pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" });
    expect(duplicate.status).toBe(400);
    expect(JSON.stringify(duplicate.body)).toContain("Publication slug is already in use");
    await page.locator("#publication-create").click();
    await slug.fill(tracked);
    await title.fill("Duplicate");
    await submit.click();
    await expect(failure).toHaveText("Publication slug is already in use");
    await expect(slug).toHaveValue(tracked);
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog(page)).toBeHidden();
    expect(await listPublications(page, organization.id, project)).toHaveLength(2);

    // Unpublish: Escape keeps it; a failed removal keeps the row and the URL; confirming removes it and its URL stops at once.
    const remove = row(page, "Public docs").getByRole("button", { name: "Remove", exact: true });
    await remove.click();
    const confirm = confirmDialog(page);
    await expect(confirm.locator("#cp-confirm-title")).toHaveText("Remove publication?");
    await expect(confirm.locator("#cp-confirm-message")).toHaveText("“Public docs” will stop resolving at its public URL immediately.");
    await page.keyboard.press("Escape");
    await expect(confirm).toBeHidden();
    await expect(remove).toBeFocused();
    expect((await secondContext.request.get(`/p/${tracked}`)).status()).toBe(200);
    const hold = await holdRequest(page, "/api/rendro/publications/remove");
    try {
      await remove.click();
      await confirm.locator("[data-confirm-accept]").click();
      await expect(remove).toHaveAttribute("aria-busy", "true");
      await expect.poll(() => hold.count()).toBe(1);
      hold.release(true);
      await expect(toasts(page).filter({ hasText: "Service unavailable. Please try again." })).toHaveCount(1);
    } finally {
      await hold.close();
    }
    await expect(row(page, "Public docs")).toHaveCount(1);
    await expect(remove).toBeEnabled();
    await expect(remove).not.toHaveAttribute("aria-busy", "true");
    expect((await secondContext.request.get(`/p/${tracked}`)).status()).toBe(200);
    await remove.click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(toasts(page).filter({ hasText: "Publication removed." })).toHaveCount(1);
    await expect(row(page, "Public docs")).toHaveCount(0);
    expect(await publicStatuses(secondContext, tracked, ["", "/files/index.html", "/tree"])).toEqual({ "": 404, "/files/index.html": 404, "/tree": 404 });
    await visitor.goto(`/p/${tracked}`);
    await expect(visitor.getByText("Page not found")).toBeVisible();
    // The pinned publication is unaffected, and so is the deployment it points at.
    expect((await secondContext.request.get(`/p/${pinned}`)).status()).toBe(200);
    expect((await listPublications(page, organization.id, project)).map(entry => [entry.slug, entry.trackingMode, entry.pinnedDeploymentId])).toEqual([[pinned, "pinned", superseded._id]]);
    // A removed slug is free again, and the last removal brings back the empty state.
    const again = await withKey<{ publication: Publication }>(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug: tracked, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", title: "Back again" });
    expect(again.status).toBe(201);
    expect((await secondContext.request.get(`/p/${tracked}`)).status()).toBe(200);
    expect((await api(page, "/api/rendro/publications/remove", { organizationId: organization.id, projectId: project, publicationId: again.body.publication._id })).status).toBe(200);
    await page.reload();
    await row(page, "Guide v1").getByRole("button", { name: "Remove", exact: true }).click();
    await confirm.locator("[data-confirm-accept]").click();
    await expect(page.getByRole("heading", { name: "No public documentation", level: 2 })).toBeVisible();
    expect((await secondContext.request.get(`/p/${pinned}`)).status()).toBe(404);
  });

  test("a failed list read recovers with Try again, and publications from the API appear in the page", async ({ actor, baseURL }) => {
    test.setTimeout(120_000);
    const owner = await actor("publish-api", { organizations: ["Publish API"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    const { rawKey } = await createKey(page, organization.id, project);
    await pushSite(baseURL, organization.id, project, rawKey, site("v1"), "publish-api");
    const slug = `api-${organization.id.slice(-8)}`.toLowerCase();
    const made = await withKey<{ publication: Publication; url: string }>(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug, pathPrefix: "guide", entryFile: "page.html", trackingMode: "track_active", title: "From CI" });
    expect(made.status).toBe(201);
    expect(made.body.url).toBe(`/p/${slug}`);
    // Entry file and path prefix are normalized and validated the same way for every caller.
    const refused: Array<[string, Record<string, string>]> = [["an entry outside the prefix", { pathPrefix: "guide", entryFile: "../index.html" }], ["a prefix with dot segments", { pathPrefix: "guide/../secret", entryFile: "notes.html" }],
      ["a non-HTML entry", { pathPrefix: "guide", entryFile: "mark.svg" }], ["a bad slug", { slug: "Bad_Slug" }], ["an over-long slug", { slug: "a".repeat(81) }]];
    for (const [label, extra] of refused) {
      const response = await withKey(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug: `x-${slug}`, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", ...extra });
      expect(response.status, label).toBeGreaterThanOrEqual(400);
      expect(response.status, label).toBeLessThan(500);
    }
    // Surrounding slashes and whitespace are trimmed from the folder and the entry; the stored values are canonical.
    const normalized = await withKey<{ publication: Publication }>(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug: `Norm-${slug}`, pathPrefix: " /guide/ ", entryFile: " /page.html ", trackingMode: "track_active" });
    expect(normalized.status).toBe(201);
    expect(normalized.body.publication).toMatchObject({ slug: `norm-${slug}`, pathPrefix: "guide", entryFile: "page.html", title: "Publish API docs" });
    expect((await listPublications(page, organization.id, project)).map(entry => entry.slug).sort()).toEqual([slug, `norm-${slug}`].sort());

    // A pinned release must be an available deployment of this very project: another project's, a failed, a staging
    // and an unknown one are all refused, and so is a pin without a deployment.
    const otherProject = (await api<{ project: { _id: string } }>(page, "/api/rendro/projects", { organizationId: organization.id, name: "Elsewhere", slug: "elsewhere" })).body.project._id;
    const otherKey = await createKey(page, organization.id, otherProject);
    await pushSite(baseURL, organization.id, otherProject, otherKey.rawKey, site("other"), "publish-api-other");
    const foreignDeployment = (await deploymentsOf(otherKey.rawKey, organization.id, otherProject)).body.deployments[0]._id;
    const failedStage = await startDeployment(rawKey, organization.id, project, { "index.html": html("Failed") });
    expect((await failStaged(rawKey, organization.id, project, failedStage, "bad upload")).status).toBe(200);
    const stagingStage = await startDeployment(rawKey, organization.id, project, { "index.html": html("Staging") });
    for (const [label, pinnedDeploymentId] of [["another project's deployment", foreignDeployment], ["a failed deployment", failedStage.deploymentId], ["a staging deployment", stagingStage.deploymentId], ["an unknown deployment", "k".repeat(32)], ["no deployment", undefined]] as const) {
      const response = await withKey(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug: `pin-${label.replace(/\W+/g, "-")}-${slug}`.slice(0, 80), pathPrefix: "", entryFile: "index.html", trackingMode: "pinned", pinnedDeploymentId });
      expect(response.status, label).toBeGreaterThanOrEqual(400);
      expect(response.status, label).toBeLessThan(500);
    }
    expect((await listPublications(page, organization.id, project)).map(entry => entry.slug).sort()).toEqual([slug, `norm-${slug}`].sort());

    const outage = await failOnce(page, "**/api/rendro/publications?*", "Publication list unavailable");
    await page.goto(`/organizations/${organization.id}/projects/${project}/publications`);
    await expect(page.getByRole("heading", { name: "Unable to load publications", level: 2 })).toBeVisible();
    await expect(page.locator("#publication-list .empty p")).toHaveText("Publication list unavailable");
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.locator("#publication-list tr")).toHaveCount(2);
    const loaded = row(page, "From CI");
    await expect(loaded).toHaveCount(1);
    await expect(loaded.locator("td[data-label=Path]")).toHaveText("guide");
    await expect(loaded.locator("a")).toHaveText(`${baseURL}/p/${slug}`);
    expect(outage.failures()).toBe(1);
    await outage.close();
  });

  test("owner, admin, member and outsider: who publishes, sees and removes", async ({ actor, secondContext, baseURL }) => {
    test.setTimeout(150_000);
    const owner = await actor("publish-owner", { organizations: ["Publish Roles"], project: true });
    const admin = await actor("publish-admin");
    const member = await actor("publish-member");
    const outsider = await actor("publish-outsider", { organizations: ["Publish Elsewhere"], project: true });
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    await join(owner, organization.id, admin, "admin");
    await join(owner, organization.id, member, "member");
    const { rawKey } = await createKey(owner.page, organization.id, project);
    const elsewhereKey = await createKey(outsider.page, outsider.organizations[0].id, outsider.projects[0].id);
    await pushSite(baseURL, organization.id, project, rawKey, site("v1"), "publish-roles");
    await pushSite(baseURL, outsider.organizations[0].id, outsider.projects[0].id, elsewhereKey.rawKey, site("elsewhere"), "publish-elsewhere");
    const slug = `roles-${organization.id.slice(-8)}`.toLowerCase();
    const owned = await withKey<{ publication: Publication }>(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", title: "Role docs" });
    expect(owned.status).toBe(201);
    const publicationId = owned.body.publication._id;
    const base = `/organizations/${organization.id}/projects/${project}`;

    // A member reads the list and can copy and open the public URL, with every write control absent and the API refusing writes.
    await fakeClipboard(member.page);
    const memberWrites = watch(member.page, "/api/rendro/publications");
    await openManagement(member.page, `${base}/publications`);
    await expect(member.page.locator("#publication-access-note")).toHaveText("You have read-only publication access. Owners and admins create and remove publications.");
    await expect(member.page.locator("#publication-create")).toBeHidden();
    await expect(member.page.locator("#publication-create")).toBeDisabled();
    for (const control of await dialog(member.page).locator("input, select, button[type=submit]").all()) await expect(control).toBeDisabled();
    await expect(row(member.page, "Role docs")).toHaveCount(1);
    await expect(row(member.page, "Role docs").getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(row(member.page, "Role docs").locator("a")).toHaveAttribute("href", `/p/${slug}`);
    await row(member.page, "Role docs").getByRole("button", { name: "Copy URL", exact: true }).click();
    await expect.poll(() => clipboard(member.page)).toEqual([`${baseURL}/p/${slug}`]);
    expect(memberWrites.filter(entry => entry.startsWith("POST"))).toEqual([]);
    expect((await api(member.page, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug: `member-${slug}`, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" })).status).toBeGreaterThanOrEqual(400);
    expect((await api(member.page, "/api/rendro/publications/remove", { organizationId: organization.id, projectId: project, publicationId })).status).toBeGreaterThanOrEqual(400);
    expect((await secondContext.request.get(`/p/${slug}`)).status()).toBe(200);
    expect((await api(member.page, `/api/rendro/publications?organizationId=${organization.id}&projectId=${project}`)).status).toBe(200);

    // An admin has the controls and removes the owner's publication; its URL stops on the next request.
    await openManagement(admin.page, `${base}/publications`);
    await expect(admin.page.locator("#publication-access-note")).toBeHidden();
    await expect(admin.page.locator("#publication-create")).toBeEnabled();
    await row(admin.page, "Role docs").getByRole("button", { name: "Remove", exact: true }).click();
    await confirmDialog(admin.page).locator("[data-confirm-accept]").click();
    await expect(toasts(admin.page).filter({ hasText: "Publication removed." })).toHaveCount(1);
    await expect(admin.page.getByRole("heading", { name: "No public documentation", level: 2 })).toBeVisible();
    expect((await secondContext.request.get(`/p/${slug}`)).status()).toBe(404);
    // An empty list reads differently for a member: nothing to create.
    await openManagement(member.page, `${base}/publications`);
    await expect(member.page.getByText("No publication has been created for this project.")).toBeVisible();
    await expect(member.page.locator("#publication-list").getByRole("button")).toHaveCount(0);

    // The slug namespace is shared by every organization: the outsider cannot take a live slug, and can publish a free one.
    const live = await withKey<{ publication: Publication }>(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", title: "Role docs" });
    expect(live.status).toBe(201);
    const [elsewhere] = [outsider.organizations[0].id, outsider.projects[0].id];
    const clash = await withKey(elsewhereKey.rawKey, "/api/rendro/publications", { organizationId: elsewhere, projectId: outsider.projects[0].id, slug, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" });
    expect(clash.status).toBe(400);
    expect(JSON.stringify(clash.body)).toContain("Publication slug is already in use");
    expect((await secondContext.request.get(`/p/${slug}`)).status()).toBe(200);

    // The outsider has no page, no list and no write on this organization's project, and their own key does not reach it.
    const denied = await outsider.page.goto(`${base}/publications`);
    expect(denied!.status()).toBe(404);
    await expect(outsider.page.getByText("Page not found")).toBeVisible();
    const target = `organizationId=${organization.id}&projectId=${project}`;
    expect((await api(outsider.page, `/api/rendro/publications?${target}`)).status).toBe(403);
    expect((await api(outsider.page, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug: `out-${slug}`, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" })).status).toBeGreaterThanOrEqual(400);
    expect((await api(outsider.page, "/api/rendro/publications/remove", { organizationId: organization.id, projectId: project, publicationId: live.body.publication._id })).status).toBeGreaterThanOrEqual(400);
    expect((await withKey(elsewhereKey.rawKey, `/api/rendro/publications?${target}`)).status).toBeGreaterThanOrEqual(401);
    expect((await withKey(elsewhereKey.rawKey, "/api/rendro/publications/remove", { organizationId: elsewhere, projectId: project, publicationId: live.body.publication._id })).status).toBeGreaterThanOrEqual(400);
    // Naming their own organization with this project's identifiers removes nothing either.
    expect((await api(outsider.page, "/api/rendro/publications/remove", { organizationId: elsewhere, projectId: outsider.projects[0].id, publicationId: live.body.publication._id })).status).toBeGreaterThanOrEqual(400);
    expect((await secondContext.request.get(`/p/${slug}`)).status()).toBe(200);
    expect((await listPublications(owner.page, organization.id, project)).map(entry => entry.slug)).toEqual([slug]);

    // Anonymous visitors: the page needs sign-in, the API refuses them, and the public URL itself needs nothing.
    const visitor = await secondContext.newPage();
    await visitor.goto(`${base}/publications`);
    await expect(visitor).toHaveURL(`/sign-in?returnTo=${encodeURIComponent(`${base}/publications`)}`);
    expect([401, 403]).toContain((await api(visitor, `/api/rendro/publications?${target}`)).status);
    expect((await api(visitor, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug: "anon", pathPrefix: "", entryFile: "index.html", trackingMode: "track_active" })).status).toBeGreaterThanOrEqual(400);
    await visitor.goto(`/p/${slug}`);
    await expect(visitor.frameLocator("#content-frame").getByRole("heading", { name: "Public home v1" })).toBeVisible();
  });

  // Expected failure: the form limits the title to 100 characters, but the API stores any title that fits in the request
  // body, so the title shown on a public list and in the management table is unbounded.
  test.fail("the API enforces the title length the publication form allows (known bug)", async ({ actor, baseURL }) => {
    test.setTimeout(90_000);
    const owner = await actor("publish-title", { organizations: ["Publish Title"], project: true });
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    const { rawKey } = await createKey(owner.page, organization.id, project);
    await pushSite(baseURL, organization.id, project, rawKey, site("v1"), "publish-title");
    const response = await withKey(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug: `title-${organization.id.slice(-8)}`.toLowerCase(), pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", title: "T".repeat(5000) });
    expect(response.status).toBe(400);
  });
});
