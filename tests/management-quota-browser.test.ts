import type { User } from "better-auth/types";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { build } from "esbuild";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { renderProjectPage } from "../src/routes/project-pages";
import { managementPagesSource } from "../scripts/management-pages-source";
import { cookieWriteFixture, admissionHeaders } from "./helpers/cookie-write-fixture";
import { managementAccessFixture } from "./fixtures/management-access";
import { createBrowserHarness } from "./helpers/browser";
import { writeQuotaLimiter, writeQuotaLimits } from "../convex/writeQuotas";

const harness = createBrowserHarness();
let f: Awaited<ReturnType<typeof cookieWriteFixture>>;
let writes = 0;
beforeAll(async () => {
  const assets = new Map<string, string>();
  for (const [path, entry] of [["/management-query.js", "src/management-query/browser.ts"], ["/select.js", "src/ui/select-browser.ts"]]) {
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser" });
    assets.set(path, bundle.outputFiles[0].text);
  }
  assets.set("/management-pages.js", managementPagesSource());
  const app = new Hono();
  for (const [path, body] of assets) app.get(path, c => c.body(body, 200, { "Content-Type": "text/javascript" }));
  app.get("/api/rendro/projects", c => c.json({ projects: [] }));
  app.get("/api/rendro/management/access", c => {
    const user = { id: f.user._id, name: "Owner", email: "owner@example.test" } as User;
    return managementAccessFixture({ id: f.organizationId, name: "Quota org", slug: "quota", members: [{ id: "member", userId: user.id, role: "owner", user }] }, user)(c.req.raw)!;
  });
  app.get("/api/auth/organization/list", c => c.json([{ id: f.organizationId, name: "Quota org", slug: "quota" }]));
  app.post("/api/rendro/projects", async c => {
    writes++;
    return f.backend.fetch("/api/rendro/projects", { method: "POST", headers: admissionHeaders({ cookie: f.cookie }), body: await c.req.text() });
  });
  app.get("/organizations/:id/projects", c => c.html(renderProjectPage({ id: f.user._id, name: "Owner", email: "owner@example.test" } as User, String(f.organizationId))));
  const listener = getRequestListener(request => app.fetch(request));
  await harness.start((req, res) => { void listener(req, res).catch(error => res.destroy(error as Error)); });
  vi.stubEnv("SITE_URL", harness.origin);
  f = await cookieWriteFixture();
  await f.backend.run(async ctx => {
    const key = `user:${f.user._id}`;
    await writeQuotaLimiter.reset(ctx, "projects", { key });
    await writeQuotaLimiter.limit(ctx, "projects", { key, count: writeQuotaLimits.projects.capacity });
  });
});
afterAll(() => vi.unstubAllEnvs());

it("keeps the project dialog draft and restores controls with a clear quota retry message", async () => {
  const page = await harness.newPage();
  await page.route(url => url.hostname === "fonts.googleapis.com", route => route.fulfill({ contentType: "text/css", body: "" }));
  await page.goto(`${harness.origin}/organizations/${f.organizationId}/projects`);
  await page.getByText("No projects yet", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Create project", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project name", { exact: true }).fill("Quota documentation");
  const submitted = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/rendro/projects"));
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  expect((await submitted).status()).toBe(429);
  await page.getByRole("alert").filter({ hasText: "Too many writes. Please try again in" }).waitFor();
  expect(await dialog.isVisible()).toBe(true);
  expect(await dialog.getByLabel("Project name", { exact: true }).inputValue()).toBe("Quota documentation");
  expect(await dialog.locator("input[name=slug]").inputValue()).toBe("quota-documentation");
  expect(await dialog.getByRole("button", { name: "Create project", exact: true }).isEnabled()).toBe(true);
  expect(writes).toBe(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  expect(await dialog.isVisible()).toBe(false);
});
