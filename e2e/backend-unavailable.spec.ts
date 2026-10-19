import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./org-fixtures";
import { createKey, html, pushSite, svg, withKey } from "./project-helpers";
import { api } from "./shell-helpers";
import { injectFault } from "./faults";

/**
 * UI-006-E04 on the real Worker. A document or asset whose backend (storage or Convex) cannot be reached is a retryable
 * 503 with `Retry-After` and no caching on every delivery surface (private session and viewer ticket, share, public
 * publication), and the viewer frame offers a recovery page whose "Try again" brings the document back. A path that
 * the manifest does not list, a stranger and an unknown link stay plain 404s with no retry hint, even while the outage
 * lasts: an outage never reveals whether something exists.
 *
 * Outages are injected into the Worker's own storage and Convex requests (`e2e/faults.ts`), scoped to this spec's own
 * organization, project, slug and token so parallel specs never see them.
 */
const site = {
  "index.html": html("Outage home", '<p>Reachable document</p><img src="media/logo.svg" alt="Logo">'),
  "media/logo.svg": svg,
};

type Reply = { status: number; headers: Record<string, string>; text: string };
async function get(request: APIRequestContext, url: string, accept: string): Promise<Reply> {
  // The harness's HTTP front end (workerd) closes an idle keep-alive socket after five seconds and has no setting for
  // it. A request that reuses the socket at that moment gets ECONNRESET before any byte is sent, so use a fresh socket.
  const response = await request.fetch(url, { headers: { Accept: accept, Connection: "close" }, maxRedirects: 0, failOnStatusCode: false });
  return { status: response.status(), headers: response.headers(), text: await response.text() };
}
const IMAGE = "image/avif,image/webp,image/svg+xml,*/*;q=0.8";
const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** What a reader's frame meets while the outage lasts: never cached, retryable, and no validators. */
function expectUnavailable(reply: Reply, label: string) {
  expect(reply.status, label).toBe(503);
  expect(reply.headers["retry-after"], label).toBe("1");
  expect(reply.headers["cache-control"], label).toBe("private, no-store");
  for (const header of ["etag", "content-range", "accept-ranges", "location", "set-cookie"]) expect(reply.headers[header], `${label} ${header}`).toBeUndefined();
}
function expectDefinitelyMissing(reply: Reply, label: string) {
  expect(reply.status, label).toBe(404);
  expect(reply.headers["retry-after"], label).toBeUndefined();
  expect(reply.headers["cache-control"], label).toBe("private, no-store");
}

async function recoveryPage(page: Page, framed: boolean) {
  const scope = framed ? page.frameLocator("#content-frame") : page;
  await expect(scope.getByRole("heading", { name: "We couldn't load this document" })).toBeVisible();
  await expect(scope.getByText("503 · Temporarily unavailable")).toBeVisible();
  // The wordmark leaves the page when a viewer frame already shows the product around it.
  if (framed) await expect(scope.locator(".brand")).toBeHidden();
  else await expect(scope.locator(".brand")).toBeVisible();
  return scope.getByRole("link", { name: "Try again" });
}

test.describe("backend outage", () => {
  test("a storage or database outage is a retryable 503 on every delivery surface, never a false 404", async ({ actor, secondContext, baseURL }) => {
    test.setTimeout(170_000);
    const owner = await actor("outage", { organizations: ["Outage Org"], project: true });
    const outsider = await actor("outage-outsider", { organizations: ["Outage Elsewhere"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    const { rawKey } = await createKey(page, organization.id, project);
    await pushSite(baseURL, organization.id, project, rawKey, site, "outage");

    const slug = `outage-${organization.id.slice(-8)}`.toLowerCase();
    const published = await withKey(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", title: "Outage" });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const shared = await api<{ token: string }>(page, "/api/rendro/shares", { organizationId: organization.id, projectId: project, documentPath: "index.html", expiresInSeconds: 3600 });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);

    const docs = `/organizations/${organization.id}/projects/${project}/docs`;
    // A viewer ticket is minted by the shell when it loads a document; read it from the injected base like the shell does.
    const frame = await get(page.request, `${docs}/files/index.html`, HTML);
    expect(frame.status).toBe(200);
    const ticketBase = frame.text.match(/<base data-rendro-viewer href="([^"]+)"/)?.[1];
    expect(ticketBase).toContain(`${docs}/view/`);
    const ticket = new URL("./", `${baseURL}${ticketBase}`).pathname;

    const surfaces: Array<{ name: string; request: APIRequestContext; base: string }> = [
      { name: "private (session)", request: page.request, base: `${docs}/files/` },
      { name: "private (viewer ticket)", request: secondContext.request, base: ticket },
      { name: "share", request: secondContext.request, base: `/s/${shared.body.token}/files/` },
      { name: "public publication", request: secondContext.request, base: `/p/${slug}/files/` },
    ];

    await test.step("every surface serves before the outage", async () => {
      for (const surface of surfaces) {
        expect((await get(surface.request, `${surface.base}media/logo.svg`, IMAGE)).status, surface.name).toBe(200);
        expect((await get(surface.request, `${surface.base}index.html`, HTML)).status, surface.name).toBe(200);
      }
    });

    await test.step("storage outage: assets and documents answer 503, missing ones and strangers stay 404", async () => {
      const assets = await injectFault({ origin: "storage", includes: [`/projects/${project}/`, "/files/media/"], status: 503 });
      const documents = await injectFault({ origin: "storage", includes: [`/projects/${project}/`, "/files/index.html"], status: 503 });
      try {
        for (const surface of surfaces) {
          const asset = await get(surface.request, `${surface.base}media/logo.svg`, IMAGE);
          expectUnavailable(asset, `${surface.name} asset`);
          // A plain asset error: no body or type for an image loader or ORB to misread.
          expect(asset.text, surface.name).toBe("");
          expect(asset.headers["content-type"], surface.name).toBeUndefined();
          const document = await get(surface.request, `${surface.base}index.html`, HTML);
          expectUnavailable(document, `${surface.name} document`);
          expect(document.headers["content-type"], surface.name).toContain("text/html");
          expect(document.text, surface.name).toContain("Try again");
          // The manifest decides absence, so an unlisted path is a 404 even though storage is failing.
          expectDefinitelyMissing(await get(surface.request, `${surface.base}media/unlisted.svg`, IMAGE), `${surface.name} unlisted`);
        }
        // Denials never turn into 503s: a stranger and an unknown link learn nothing from the outage.
        expectDefinitelyMissing(await get(outsider.page.request, `${docs}/files/media/logo.svg`, IMAGE), "outsider");
        expectDefinitelyMissing(await get(secondContext.request, `${docs}/files/media/logo.svg`, IMAGE), "anonymous");
        expectDefinitelyMissing(await get(secondContext.request, ticket.replace(/\/view\/[^/]+\//, "/view/forged/") + "media/logo.svg", IMAGE), "forged ticket");
        expectDefinitelyMissing(await get(secondContext.request, "/s/unknown-token-0000/files/media/logo.svg", IMAGE), "unknown share");
        expectDefinitelyMissing(await get(secondContext.request, "/p/unknown-slug-0000/files/media/logo.svg", IMAGE), "unknown publication");
      } finally {
        await assets();
        await documents();
      }
      for (const surface of surfaces) expect((await get(surface.request, `${surface.base}media/logo.svg`, IMAGE)).status, surface.name).toBe(200);
    });

    await test.step("the viewer frame offers a recovery page that brings the document back", async () => {
      const readers: Array<{ name: string; page: Page; url: string; framed: boolean }> = [
        { name: "public", page: await secondContext.newPage(), url: `/p/${slug}?doc=index.html`, framed: true },
        { name: "private", page, url: `${docs}?doc=index.html`, framed: true },
        { name: "share", page: await secondContext.newPage(), url: `/s/${shared.body.token}`, framed: true },
      ];
      for (const reader of readers) {
        const end = await injectFault({ origin: "storage", includes: [`/projects/${project}/`, "/files/index.html"], status: 503 });
        try {
          await reader.page.goto(reader.url);
          const retry = await recoveryPage(reader.page, reader.framed);
          await end();
          await retry.click();
          await expect(reader.page.frameLocator("#content-frame").getByRole("heading", { name: "Outage home" }), reader.name).toBeVisible();
        } finally {
          await end();
        }
      }
      await readers[0].page.close();
      await readers[2].page.close();
    });

    await test.step("a standalone document shows the same recovery page with its wordmark", async () => {
      const reader = await secondContext.newPage();
      const end = await injectFault({ origin: "storage", includes: [`/projects/${project}/`, "/files/index.html"], status: 503 });
      try {
        const response = await reader.goto(`/p/${slug}/files/index.html`);
        expect(response?.status()).toBe(503);
        expect(response?.headers()["retry-after"]).toBe("1");
        expect(response?.headers()["cache-control"]).toBe("private, no-store");
        const retry = await recoveryPage(reader, false);
        await end();
        await retry.click();
        await expect(reader.getByRole("heading", { name: "Outage home" })).toBeVisible();
      } finally {
        await end();
        await reader.close();
      }
    });

    await test.step("a database outage answers 503 for pages, trees and assets, and recovers", async () => {
      const outages = [
        { name: "public publication", rule: { origin: "convex" as const, includes: ["/api/rendro/publications/public", `slug=${slug}`] },
          urls: [`/p/${slug}`, `/p/${slug}/tree`, `/p/${slug}/files/media/logo.svg`], request: secondContext.request },
        { name: "share", rule: { origin: "convex" as const, includes: ["/api/rendro/shares/public", shared.body.token] },
          urls: [`/s/${shared.body.token}`, `/s/${shared.body.token}/files/media/logo.svg`], request: secondContext.request },
        { name: "private", rule: { origin: "convex" as const, includes: ["/api/rendro/deployments/active", `projectId=${project}`] },
          urls: [`${docs}/tree`, `${docs}/files/media/logo.svg`, `${docs}/files/index.html`], request: page.request },
      ];
      for (const outage of outages) {
        const end = await injectFault({ ...outage.rule, status: 503 });
        try {
          for (const url of outage.urls) {
            const reply = await get(outage.request, url, url.endsWith(".svg") ? IMAGE : url.endsWith("/tree") ? "application/json" : HTML);
            expectUnavailable(reply, `${outage.name} ${url}`);
            if (url.endsWith("/tree")) expect(JSON.parse(reply.text), url).toEqual({ error: "Document temporarily unavailable", retryable: true });
          }
        } finally {
          await end();
        }
        for (const url of outage.urls) {
          const reply = await get(outage.request, url, url.endsWith(".svg") ? IMAGE : url.endsWith("/tree") ? "application/json" : HTML);
          expect(reply.status, `${outage.name} ${url} after recovery`).toBe(200);
        }
      }
    });
  });
});
