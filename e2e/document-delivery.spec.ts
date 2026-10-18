import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./org-fixtures";
import { pushDocuments } from "./seed";
import { api } from "./shell-helpers";
import { createKey, html, withKey } from "./project-helpers";

/**
 * Document delivery on the real Worker (#94): strong validators and 304, single byte ranges and 416, HEAD, and the
 * rule that authorization is answered before any of them. The browser's HTTP cache is bypassed by the harness's request
 * interception, so the revalidation flow is driven as manual conditional requests and asserted on headers and bytes.
 */
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const SIZE = 3 * 1024 * 1024 + 123;
/** Deterministic, non-repeating-looking bytes so a mis-sliced range cannot match by accident. */
const blob = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) blob[i] = (i * 31 + (i >> 8) * 7 + (i >> 16)) & 0xff;
const etag = `"sha256-${sha256(blob)}"`;
const pageHtml = html("Delivery home", '<p>Streamed document</p><img src="media/photo.png" alt="Photo">');
const files: Record<string, Buffer | string> = { "index.html": pageHtml, "media/photo.png": blob, "media/clip.bin": blob.subarray(0, 1_000_000) };

type Reply = { status: number; headers: Record<string, string>; body: Buffer };
async function send(request: APIRequestContext, url: string, headers: Record<string, string> = {}, method = "GET"): Promise<Reply> {
  const response = await request.fetch(url, { method, headers, maxRedirects: 0, failOnStatusCode: false });
  return { status: response.status(), headers: response.headers(), body: await response.body() };
}

/** Every route class that serves stored bytes, addressed by the asset URL a reader's frame would use. */
type Target = { name: string; url: string; request: APIRequestContext; cache: string; cors: string | undefined };

test.describe("document delivery", () => {
  test("validators, ranges, HEAD and denial on public, share, private and ticket routes", async ({ actor, secondContext, baseURL }) => {
    test.setTimeout(170_000);
    const owner = await actor("delivery", { organizations: ["Delivery Org"], project: true });
    const outsider = await actor("delivery-outsider", { organizations: ["Delivery Elsewhere"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    const { rawKey } = await createKey(page, organization.id, project);
    const source = await mkdtemp(join(process.env.RENDRO_E2E_DIRECTORY ?? "", "delivery-"));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), content);
    }
    await pushDocuments(source, baseURL as string, organization.id, project, rawKey, 4, 120_000);

    const slug = `delivery-${organization.id.slice(-8)}`.toLowerCase();
    const published = await withKey(rawKey, "/api/rendro/publications", { organizationId: organization.id, projectId: project, slug, pathPrefix: "", entryFile: "index.html", trackingMode: "track_active", title: "Delivery" });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    const shared = await api<{ token: string }>(page, "/api/rendro/shares", { organizationId: organization.id, projectId: project, documentPath: "index.html", expiresInSeconds: 3600 });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);

    // A viewer ticket is minted by the shell when it loads a document; read it from the injected base like the shell does.
    const docs = `/organizations/${organization.id}/projects/${project}/docs`;
    const frame = await send(page.request, `${docs}/files/index.html`);
    expect(frame.status).toBe(200);
    const ticketBase = frame.body.toString().match(/<base data-rendro-viewer href="([^"]+)"/)?.[1];
    expect(ticketBase).toContain(`${docs}/view/`);
    const ticketAsset = new URL("media/photo.png", `${baseURL}${ticketBase}`).pathname;

    const targets: Target[] = [
      { name: "public publication", url: `/p/${slug}/files/media/photo.png`, request: secondContext.request, cache: "public, max-age=0, must-revalidate", cors: "null" },
      { name: "private share", url: `/s/${shared.body.token}/files/media/photo.png`, request: secondContext.request, cache: "private, no-store", cors: "null" },
      { name: "private project (session)", url: `${docs}/files/media/photo.png`, request: page.request, cache: "private, no-store", cors: undefined },
      { name: "private project (viewer ticket)", url: ticketAsset, request: secondContext.request, cache: "private, no-store", cors: "null" },
    ];

    for (const target of targets) {
      await test.step(target.name, async () => {
        const { url, request } = target;
        const full = await send(request, url);
        expect(full.status).toBe(200);
        expect(sha256(full.body)).toBe(sha256(blob));
        expect(full.headers).toMatchObject({
          etag, "accept-ranges": "bytes", "content-length": String(SIZE), "content-type": "image/png",
          "cache-control": target.cache, "x-content-type-options": "nosniff", "content-security-policy": expect.stringContaining("sandbox"),
        });
        expect(full.headers["access-control-allow-origin"]).toBe(target.cors);

        // The header set on 206 and 304 matches the 200 for everything that isolates or types the response.
        const same = ["etag", "accept-ranges", "content-type", "cache-control", "x-content-type-options", "content-security-policy", "access-control-allow-origin", "referrer-policy"];
        const pick = (reply: Reply) => same.map(name => reply.headers[name]);

        for (const [range, start, end] of [["bytes=0-1023", 0, 1023], ["bytes=2097152-", 2097152, SIZE - 1], ["bytes=-4096", SIZE - 4096, SIZE - 1], ["bytes=100-99999999999999999999", 100, SIZE - 1]] as const) {
          const part = await send(request, url, { Range: range });
          expect(part.status, range).toBe(206);
          expect(part.headers["content-range"], range).toBe(`bytes ${start}-${end}/${SIZE}`);
          expect(part.headers["content-length"], range).toBe(String(end - start + 1));
          expect(sha256(part.body), range).toBe(sha256(blob.subarray(start, end + 1)));
          expect(pick(part), range).toEqual(pick(full));
        }

        // Unsatisfiable ranges are refused without a body; unusable ones (malformed, multi-range) get the whole file.
        for (const range of [`bytes=${SIZE}-`, `bytes=${SIZE + 10}-${SIZE + 20}`, "bytes=-0"]) {
          const refused = await send(request, url, { Range: range });
          expect(refused.status, range).toBe(416);
          expect(refused.headers["content-range"], range).toBe(`bytes */${SIZE}`);
          expect(refused.body.length, range).toBe(0);
          expect(refused.headers["x-content-type-options"]).toBe("nosniff");
        }
        for (const range of ["bytes=5-2", "items=0-9", "bytes=0-9,20-29", `bytes=${"0-1,".repeat(300)}`]) {
          const whole = await send(request, url, { Range: range });
          expect(whole.status, range).toBe(200);
          expect(whole.body.length, range).toBe(SIZE);
        }

        // A resumed download: sequential ranges reassemble to the exact bytes.
        const chunks: Buffer[] = [];
        for (let start = 0; start < SIZE; start += 1024 * 1024) {
          const part = await send(request, url, { Range: `bytes=${start}-${Math.min(start + 1024 * 1024, SIZE) - 1}` });
          expect(part.status).toBe(206);
          chunks.push(part.body);
        }
        expect(sha256(Buffer.concat(chunks))).toBe(sha256(blob));

        // Revalidation: matching, listed, wildcard and weak validators are 304 with no body; anything else is a full 200.
        for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
          const unchanged = await send(request, url, { "If-None-Match": header });
          expect(unchanged.status, header).toBe(304);
          expect(unchanged.body.length, header).toBe(0);
          expect(pick(unchanged), header).toEqual(pick(full));
        }
        for (const header of ['"sha256-0"', "", `${etag}x`]) expect((await send(request, url, { "If-None-Match": header })).status, header).toBe(200);
        expect((await send(request, url, { "If-None-Match": etag, Range: "bytes=0-9" })).status).toBe(304);

        // If-Range: the current validator keeps the range, a stale one or a date restores the whole representation.
        expect((await send(request, url, { Range: "bytes=0-9", "If-Range": etag })).status).toBe(206);
        for (const stale of ['"sha256-0"', `W/${etag}`, "Wed, 21 Oct 2015 07:28:00 GMT"]) {
          expect((await send(request, url, { Range: "bytes=0-9", "If-Range": stale })).status, stale).toBe(200);
        }

        // HEAD mirrors GET without a body and ignores Range.
        const head = await send(request, url, { Range: "bytes=0-9" }, "HEAD");
        expect(head.status).toBe(200);
        expect(head.body.length).toBe(0);
        expect(head.headers["content-length"]).toBe(String(SIZE));
        expect(pick(head)).toEqual(pick(full));
        expect((await send(request, url, { "If-None-Match": etag }, "HEAD")).status).toBe(304);
      });
    }

    // Authorization precedes validators: nobody who may not read the file learns that their validator matches.
    const sessionUrl = targets[2].url;
    const conditional = { "If-None-Match": etag, Range: "bytes=0-9" };
    for (const request of [secondContext.request, outsider.page.request]) {
      for (const headers of [conditional, { "If-None-Match": "*" }, { "If-None-Match": etag }]) {
        for (const method of ["GET", "HEAD"]) {
          const denied = await send(request, sessionUrl, headers, method);
          expect(denied.status, `${method} ${JSON.stringify(headers)}`).toBe(404);
          expect(denied.headers.etag).toBeUndefined();
          expect(denied.headers["content-range"]).toBeUndefined();
          expect(denied.headers["cache-control"]).toBe("private, no-store");
        }
      }
    }
    // A forged ticket and an unknown path are denied the same way.
    expect((await send(secondContext.request, ticketAsset.replace(/\/view\/[^/]+\//, "/view/forged/"), { "If-None-Match": etag })).status).toBe(404);
    expect((await send(page.request, `${docs}/files/media/missing.png`, { "If-None-Match": etag })).status).toBe(404);
    expect((await send(secondContext.request, `/p/${slug}/files/media/missing.png`, { "If-None-Match": etag })).status).toBe(404);

    // Documents are rewritten per reader, so they never carry a byte-range validator: public HTML has its own tag and
    // private/share HTML none. The injected navigation script is present on all of them.
    const publicDocument = await send(secondContext.request, `/p/${slug}/files/index.html`);
    expect(publicDocument.status).toBe(200);
    expect(publicDocument.headers.etag).toMatch(/^"sha256-[0-9a-f]{64}-i1-[0-9a-f]{24}"$/);
    expect(publicDocument.headers["accept-ranges"]).toBe("none");
    expect(publicDocument.body.toString()).toContain('data-viewer="navigation"');
    expect((await send(secondContext.request, `/p/${slug}/files/index.html`, { "If-None-Match": publicDocument.headers.etag })).status).toBe(304);
    const partialDocument = await send(secondContext.request, `/p/${slug}/files/index.html`, { Range: "bytes=0-9", "If-Range": publicDocument.headers.etag });
    expect(partialDocument.status).toBe(200);
    expect(partialDocument.body.equals(publicDocument.body)).toBe(true);
    for (const url of [`/s/${shared.body.token}/files/index.html`, `${docs}/files/index.html`]) {
      const document = await send(url.startsWith("/s/") ? secondContext.request : page.request, url, { Range: "bytes=0-9" });
      expect(document.status, url).toBe(200);
      expect(document.headers.etag, url).toBeUndefined();
      expect(document.headers["content-range"], url).toBeUndefined();
      expect(document.body.toString(), url).toContain("Streamed document");
    }

    // The browser's manual revalidation of a public file: the page itself sends the validator and gets a bodyless 304.
    await secondContext.newPage().then(async reader => {
      await reader.goto(`/p/${slug}?doc=index.html`);
      await expect(reader.frameLocator("#content-frame").getByRole("heading", { name: "Delivery home" })).toBeVisible();
      const outcome = await reader.evaluate(async ({ url, etag }) => {
        const response = await fetch(url, { headers: { "If-None-Match": etag } });
        return { status: response.status, length: (await response.arrayBuffer()).byteLength, etag: response.headers.get("etag") };
      }, { url: `/p/${slug}/files/media/photo.png`, etag });
      expect(outcome).toEqual({ status: 304, length: 0, etag });
      await reader.close();
    });

    // Every viewer still renders its document.
    await page.goto(`${docs}?doc=index.html`);
    const owned = page.frameLocator("#content-frame");
    await expect(owned.getByRole("heading", { name: "Delivery home" })).toBeVisible();
    const shareReader = await secondContext.newPage();
    await shareReader.goto(`/s/${shared.body.token}`);
    await expect(shareReader.frameLocator("#content-frame").getByRole("heading", { name: "Delivery home" })).toBeVisible();

    // Revoking access ends validators and ranges at once, with the same 404 as an unknown file.
    const grants = await api<{ shares: Array<{ _id: string }> }>(page, `/api/rendro/shares?organizationId=${organization.id}&projectId=${project}`);
    expect((await api(page, "/api/rendro/shares/revoke", { organizationId: organization.id, grantId: grants.body.shares[0]._id })).status).toBe(200);
    for (const headers of [conditional, { "If-None-Match": "*" }, { Range: "bytes=0-9" }]) {
      const gone = await send(secondContext.request, targets[1].url, headers);
      expect(gone.status, JSON.stringify(headers)).toBe(404);
      expect(gone.headers.etag).toBeUndefined();
    }
  });
});
