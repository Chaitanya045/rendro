import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

import { imageProxyPath } from "../src/image-proxy";
import { RENDERED_DOCUMENT_POLICY } from "../src/routes/asset-headers";
import worker from "../src/worker";
import { browserStep, createBrowserHarness } from "./helpers/browser";

/*
 * The proxy's responses in a real browser, served by the real Worker app with
 * the upstream fetch mocked. Any request that leaves the fixture origin fails
 * the harness, so an external image the frame policy did not block shows up.
 */
const harness = createBrowserHarness();
const SECRET = process.env.IMAGE_PROXY_SECRET as string;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const SCRIPTED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" onload="fetch(\'/beacon?onload\')"><rect width="4" height="4"/><script>document.documentElement.setAttribute("data-ran","1");fetch("/beacon?script")</script></svg>';
const beacons: string[] = [];
const paths: Record<string, string> = {};

async function send(response: ServerResponse, reply: Response) {
  response.writeHead(reply.status, Object.fromEntries(reply.headers));
  response.end(Buffer.from(await reply.arrayBuffer()));
}

beforeAll(async () => {
  for (const [name, url] of Object.entries({ png: "https://images.example.com/pixel.png", svg: "https://images.example.com/scripted.svg" })) {
    paths[name] = await imageProxyPath(SECRET, url) as string;
  }
  const frame = (img: string) => `<!doctype html><body>${img}<script>addEventListener("securitypolicyviolation",e=>parent.postMessage("violation "+e.effectiveDirective+" "+e.blockedURI,"*"));onload=()=>parent.postMessage([...document.images].map(i=>i.id+":"+i.naturalWidth).join(" "),"*")</script></body>`;
  await harness.start((request, response) => {
    const url = new URL(request.url ?? "/", harness.origin);
    if (url.pathname.startsWith("/img/")) {
      void Promise.resolve(worker.request(url.href)).then((reply) => send(response, reply));
    } else if (url.pathname === "/beacon") {
      beacons.push(url.search);
      response.writeHead(204).end();
    } else if (url.pathname === "/control/same-origin.png") {
      response.writeHead(200, { "Content-Type": "image/png", "Cross-Origin-Resource-Policy": "same-origin" }).end(PNG);
    } else if (url.pathname === "/control/scripted.svg") {
      response.writeHead(200, { "Content-Type": "image/svg+xml" }).end(SCRIPTED_SVG);
    } else if (url.pathname === "/frame") {
      // An ingest-rendered document: its images are proxy paths, plus one external image the policy must stop.
      response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": RENDERED_DOCUMENT_POLICY });
      response.end(frame(`<img id="png" src="${paths.png}"><img id="svg" src="${paths.svg}"><img id="external" src="http://127.0.0.2:9/track.png"><img id="corp" src="/control/same-origin.png">`));
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<!doctype html><script>window.messages=[];addEventListener("message",e=>messages.push(e.data))</script><iframe src="/frame"></iframe>');
    }
  });
});

beforeEach(() => {
  beacons.length = 0;
  vi.mocked(fetch).mockImplementation((input) => Promise.resolve((input as string).endsWith(".svg")
    ? new Response(SCRIPTED_SVG, { headers: { "Content-Type": "image/svg+xml" } })
    : new Response(PNG, { headers: { "Content-Type": "image/png" } })));
});

it("loads proxied images in a sandboxed rendered-document frame and blocks external ones", async () => {
  const page = await harness.newPage();
  await browserStep("open the viewer page", () => page.goto(harness.origin, { waitUntil: "load" }));
  await expect.poll(() => page.evaluate(() => (window as unknown as { messages: string[] }).messages.find((message) => message.startsWith("png:")))).toBeTruthy();
  const messages = await page.evaluate(() => (window as unknown as { messages: string[] }).messages);
  // The opaque-origin frame can load the proxy's cross-origin CORP responses, but not a same-origin CORP image.
  expect(messages.find((message) => message.startsWith("png:"))).toBe("png:1 svg:4 external:0 corp:0");
  expect(messages).toContain("violation img-src http://127.0.0.2:9/track.png");
  // Scripts in an SVG used as an image never run.
  expect(beacons).toEqual([]);
});

it("keeps a proxied SVG inert when it is opened directly", async () => {
  const page = await harness.newPage();
  // Positive control: the same SVG served plainly does run its script.
  await browserStep("open the unprotected SVG", () => page.goto(`${harness.origin}/control/scripted.svg`, { waitUntil: "load" }));
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-ran"))).toBe("1");
  // Both control beacons must have arrived before the list is reset, or a late one would be blamed on the proxy.
  await expect.poll(() => [...beacons].sort()).toEqual(["?onload", "?script"]);
  await browserStep("leave the control document", () => page.goto("about:blank"));
  beacons.length = 0;

  const response = await browserStep("open the proxied SVG", () => page.goto(`${harness.origin}${paths.svg}`, { waitUntil: "load" }));
  expect(response?.headers()["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  expect(await page.evaluate(() => document.documentElement.localName)).toBe("svg");
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-ran"))).toBeNull();
  expect(beacons).toEqual([]);
});
