import { randomBytes } from "node:crypto";
import { imageProxyPath, imageProxyRewriter } from "../src/image-proxy";
import { renderDocument } from "../src/ingest/render";
import { initNodeMarkdownEngine } from "../tests/helpers/markdown-engine";
import { test, expect } from "./org-fixtures";
import { assertLoopback, localHttp } from "./backend";
import { createKey, html, pushSite } from "./project-helpers";
import { imageHostOrigin, type ImageHostRequest } from "./services";

/**
 * #224 on the real Worker: a rendered repo document with external images makes the reader's browser request only our
 * origin. Its images arrive through the signed same-origin proxy, which the Worker fetches from the (fake, in-process)
 * third-party host with a fixed user agent and nothing of the reader's. The network guard fails the test if the browser
 * contacts any other origin, and the harness fails teardown if the Worker contacts one it should have refused.
 *
 * Ingest is not wired to serving yet (epic #214), so the spec renders the Markdown with the ingest pipeline itself and
 * publishes the result through today's upload path.
 */
const secret = () => {
  const value = process.env.RENDRO_E2E_IMAGE_PROXY_SECRET;
  if (!value) throw new Error("Missing local image proxy secret");
  return value;
};

async function imageHostRequests(): Promise<ImageHostRequest[]> {
  const control = process.env.RENDRO_E2E_IMAGES;
  if (!control) throw new Error("Missing local image host control");
  assertLoopback(control);
  const reply = await localHttp(`${control}/requests`);
  expect(reply.status).toBe(200);
  return JSON.parse(reply.body) as ImageHostRequest[];
}

test.describe("image proxy", () => {
  test("a rendered document's external images load only through our origin", async ({ actor, baseURL }) => {
    test.setTimeout(90_000);
    const owner = await actor("images", { organizations: ["Image Proxy Org"], project: true });
    const { page } = owner;
    const [organization] = owner.organizations;
    const [project] = owner.projects.map(entry => entry.id);
    // A unique query per run keeps the Worker's cache from answering for an earlier run or engine.
    const run = randomBytes(6).toString("hex");
    const pixel = `${imageHostOrigin}/pixel.png?run=${run}`;
    const svg = `${imageHostOrigin}/scripted.svg?run=${run}`;

    initNodeMarkdownEngine();
    const rendered = await renderDocument(`# Proxied images\n\n![Pixel](${pixel})\n\n<img src="${svg}" alt="Vector" width="8" height="8">\n`, "README.md", { rewriteImageUrl: imageProxyRewriter(secret()) });
    expect(rendered.html).not.toContain(imageHostOrigin);
    const { rawKey } = await createKey(page, organization.id, project);
    await pushSite(baseURL, organization.id, project, rawKey, { "index.html": html("Proxied images", rendered.html) }, "images");

    const imageRequests: string[] = [];
    page.on("request", request => { if (request.resourceType() === "image") imageRequests.push(request.url()); });
    // Real CSP violations in any frame (browsers' informational CSP console warnings are not violations).
    const violations: string[] = [];
    await page.context().exposeBinding("recordImageProxyViolation", (_source, value: string) => { violations.push(value); });
    await page.context().addInitScript(() => {
      document.addEventListener("securitypolicyviolation", event => {
        void (window as unknown as { recordImageProxyViolation(value: string): Promise<void> }).recordImageProxyViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
      });
    });

    await test.step("the viewer shows both images, requested from our origin only", async () => {
      await page.goto(`/organizations/${organization.id}/projects/${project}/docs?doc=index.html`);
      const frame = page.frameLocator("#content-frame");
      await expect(frame.getByRole("heading", { name: "Proxied images" }).first()).toBeVisible();
      for (const name of ["Pixel", "Vector"]) {
        await expect.poll(() => frame.getByRole("img", { name }).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), name).toBe(true);
      }
      const proxied = imageRequests.filter(url => new URL(url).pathname.startsWith("/img/"));
      expect(proxied).toHaveLength(2);
      expect(imageRequests.filter(url => new URL(url).origin !== baseURL)).toEqual([]);
      expect(violations).toEqual([]);
    });

    await test.step("the Worker, not the reader, fetched them, with nothing of the reader's", async () => {
      const seen = (await imageHostRequests()).filter(request => request.url.includes(`run=${run}`));
      expect(seen.map(request => request.url).sort()).toEqual([pixel, svg].sort());
      const readerAgent = await page.evaluate(() => navigator.userAgent);
      for (const { headers } of seen) {
        expect(headers["user-agent"]).toBe("Rendro-Image-Proxy/1.0 (+https://rendro.app)");
        for (const name of ["cookie", "authorization", "referer", "origin"]) expect(headers[name], name).toBeUndefined();
        // The network guard gives each test its own 198.18.x.y client address.
        expect(Object.values(headers).filter(value => value.includes("198.18.") || value === readerAgent)).toEqual([]);
      }
    });

    await test.step("proxied responses carry fixed headers and drop the upstream's cookie", async () => {
      const path = await imageProxyPath(secret(), pixel) as string;
      const reply = await page.request.get(path);
      expect(reply.status()).toBe(200);
      expect(reply.headers()["set-cookie"]).toBeUndefined();
      expect(reply.headers()).toMatchObject({
        "content-type": "image/png",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "content-disposition": "inline",
      });
    });

    await test.step("a proxied SVG opened directly runs no script", async () => {
      const reader = await page.context().newPage();
      const response = await reader.goto(await imageProxyPath(secret(), svg) as string);
      expect(response?.headers()["content-type"]).toBe("image/svg+xml");
      await reader.waitForLoadState("load");
      expect(await reader.evaluate(() => document.documentElement.getAttribute("data-ran"))).toBeNull();
      await reader.close();
    });

    await test.step("it is not an open proxy, and refused upstreams fail closed", async () => {
      const path = await imageProxyPath(secret(), pixel) as string;
      const [, , signature, encoded] = path.split("/");
      const flipped = signature.slice(0, 20) + (signature[20] === "A" ? "B" : "A") + signature.slice(21);
      const forged = Buffer.from(`${imageHostOrigin}/page.html?run=${run}`).toString("base64url");
      for (const unsigned of [`/img/${flipped}/${encoded}`, `/img/${signature}/${forged}`, `/img/${encoded}`, "/img/"]) {
        expect((await page.request.get(unsigned)).status(), unsigned).toBe(404);
      }
      for (const refused of [`${imageHostOrigin}/page.html?run=${run}`, `${imageHostOrigin}/to-private?run=${run}`]) {
        expect((await page.request.get(await imageProxyPath(secret(), refused) as string)).status(), refused).toBe(502);
      }
      // The forged URL was never fetched; the redirect target was never followed (teardown would fail).
      const fetched = (await imageHostRequests()).map(request => request.url);
      expect(fetched.filter(url => url.includes("/page.html") && url.includes(run))).toHaveLength(1);
    });
  });
});
