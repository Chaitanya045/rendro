import { describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import { renderFaviconLinks } from "@/routes/favicon";

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
import { app as local } from "@/index";

const runtimes = [
  { name: "Worker without ASSETS", request: (path: string, init?: RequestInit) => worker.request(path, init) },
  {
    name: "Worker with an ASSETS miss",
    request: (path: string, init?: RequestInit) => worker.request(path, init, {
      ASSETS: { fetch: () => new Response("<h1>Static asset missing</h1>", { status: 404, headers: { "Content-Type": "text/html" } }) },
    }),
  },
  {
    name: "Node",
    request: (path: string, init?: RequestInit) => local.request(path, init, {
      incoming: { socket: { remoteAddress: "127.0.0.1" } },
    }),
  },
];

function expectNotFound(response: Response, asset = false) {
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe(asset ? null : "nosniff");
}

describe.each(runtimes)("global not-found handler: $name", ({ request }) => {
  it.each([
    { label: "HTML", accept: "text/html" },
    { label: "browser document", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8" },
    { label: "XHTML", accept: "application/xhtml+xml" },
    { label: "missing Accept", accept: undefined },
  ])("preserves styled HTML for $label requests", async ({ accept }) => {
    const response = await request("/missing/page", { headers: accept ? { Accept: accept } : {} });
    expectNotFound(response);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('<h1 id="not-found-title">Page not found</h1>');
    expect(html).toContain(renderFaviconLinks());
    const nonce = response.headers.get("Content-Security-Policy")?.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    const tags = [...html.matchAll(/<(?:script|style)\b[^>]*>/g)];
    expect(tags.length).toBeGreaterThan(0);
    for (const [tag] of tags) expect(tag).toContain(`nonce="${nonce}"`);
  });

  it.each([
    { path: "/share/unknown/missing.png", accept: "image/*" },
    { path: "/missing/font.woff2", accept: "*/*" },
    { path: "/missing/style.css", accept: undefined },
    { path: "/missing/script.js", accept: undefined },
    { path: "/missing/image%2Epng", accept: undefined },
    { path: "/missing/data.json", accept: undefined },
    { path: "/missing/image", accept: "image/*" },
    { path: "/missing/font", accept: "font/woff2" },
    { path: "/missing/style", accept: "text/css" },
    { path: "/missing/script", accept: "application/javascript" },
    { path: "/missing/data", accept: "application/json" },
    { path: "/missing/data", accept: "application/problem+json" },
  ])("returns an empty asset error for $path (Accept: $accept)", async ({ path, accept }) => {
    const response = await request(path, { headers: accept ? { Accept: accept } : {} });
    expectNotFound(response, true);
    expect(response.headers.get("Content-Type")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it.each(["application/json", "text/html", undefined])("returns JSON for an unknown API route (Accept: %s)", async accept => {
    const response = await request("/api/missing", { headers: accept ? { Accept: accept } : {} });
    expectNotFound(response);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("preserves JSON errors from matched API routes", async () => {
    const response = await request("/api/rendro/publications", { method: "POST", body: "invalid JSON" });
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
  });

  it.each([
    { path: "/missing/page", type: "text/html" },
    { path: "/missing/image.png", type: null },
    { path: "/api/missing", type: "application/json" },
  ])("classifies non-GET fallback requests at $path", async ({ path, type }) => {
    const response = await request(path, { method: "POST" });
    expectNotFound(response, type === null);
    if (type === null) expect(response.headers.get("Content-Type")).toBeNull();
    else expect(response.headers.get("Content-Type")).toContain(type);
  });
});
