import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";
import { localHttp } from "./backend";
import { password, roles } from "./seed";
import type { Mail } from "./services";
import type { RepoFixtures } from "./repo-fixtures";

for (const role of roles) {
  test(`seeded ${role} session enforces organization and credential boundaries`, async ({ page, context, baseURL, seed }, info) => {
    await context.addCookies(seed.cookies[role].split("; ").map(pair => {
      const split = pair.indexOf("=");
      return { name: pair.slice(0, split), value: pair.slice(split + 1), url: baseURL ?? "" };
    }));
    await page.goto("/organizations?choose=1");
    const result = await page.evaluate(async ({ organizationId, otherOrganizationId, slug }) => {
      const access = await fetch(`/api/rendro/management/access?organizationId=${organizationId}`);
      const other = await fetch(`/api/rendro/management/access?organizationId=${otherOrganizationId}`);
      const keys = await fetch(`/api/rendro/credentials?organizationId=${organizationId}`);
      const create = await fetch("/api/rendro/projects", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, name: "Denied control", slug }) });
      return { access: access.status, other: other.status, keys: keys.status, create: create.status, body: await access.json() as { member?: { role: string } } };
    }, { ...seed, slug: `role-control-${role}-${info.project.name}-${info.retry}` });
    expect(result.access).toBe(role === "outsider" ? 403 : 200);
    expect(result.other).toBe(role === "outsider" ? 200 : 403);
    expect(result.keys).toBe(role === "owner" || role === "admin" ? 200 : 403);
    expect(result.create).toBe(role === "member" || role === "outsider" ? 403 : 201);
    if (role !== "outsider") expect(result.body.member?.role).toBe(role);
  });
}

test("Google OAuth uses local code exchange and rejects a changed state", async ({ page }) => {
  await page.goto("/sign-in");
  // An invalid state must not create a session.
  await page.goto("/api/auth/callback/google?code=invalid&state=invalid");
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rendro" })).toBeVisible();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByLabel("Organization name", { exact: true })).toBeVisible();
  const user = await page.evaluate(async () => {
    const response = await fetch("/api/auth/get-session");
    return await response.json() as { user: { email: string; emailVerified: boolean } };
  });
  expect(user.user).toMatchObject({ email: "oauth@example.test", emailVerified: true });
});

test("sign up → verify → organization → project → repository document → reactive comment", async ({ page, context, baseURL }, info) => {
  test.setTimeout(90_000);
  const email = `journey-${info.project.name}-${info.retry}@example.test`;
  await page.goto("/sign-up");
  await page.getByLabel("Full name", { exact: true }).fill("Journey Author");
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  // Email/password login is denied before the captured verification link is used.
  await page.goto("/sign-in");
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#form-error")).toContainText(/verif/i);
  const messages = JSON.parse((await localHttp(`${process.env.RENDRO_E2E_MAIL}/mail?to=${encodeURIComponent(email)}`)).body) as Mail[];
  const link = messages[0]?.text.match(/http:\/\/[^\s]+/)?.[0];
  expect(link).toBeTruthy();
  if (!link || new URL(link).origin !== baseURL) throw new Error("Verification link escaped local Worker");
  await page.goto(link);
  await page.goto("/sign-in");
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Organization name", { exact: true }).fill(`Journey ${info.project.name} ${info.retry}`);
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Journey documents");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.locator(".cp-page-heading")).toHaveText("Journey documents");
  // Anyone signed in may comment on a public repository: the new account reads one and writes there at once.
  const { viewer } = JSON.parse(readFileSync(process.env.RENDRO_E2E_REPOS as string, "utf8")) as RepoFixtures;
  await page.goto(`/r/${viewer.owner}/${viewer.name}?doc=${encodeURIComponent("docs/comment.md")}`);
  const frame = page.frameLocator("#content-frame");
  await expect(frame.getByRole("heading", { name: "Comment page", level: 1 })).toBeVisible();
  const observer = await context.newPage();
  await observer.goto(page.url());
  const otherFrame = observer.frameLocator("#content-frame");
  await expect(otherFrame.getByTestId("commentor-panel-btn")).toBeEnabled();
  await otherFrame.getByTestId("commentor-panel-btn").click();
  const body = `Real Convex subscription delivered this comment (${info.project.name} ${info.retry})`;
  await frame.getByText("The quick brown fox jumps over the lazy dog.").dblclick({ position: { x: 60, y: 8 } });
  await frame.getByTestId("commentor-selection-action").click();
  await frame.getByTestId("commentor-composer-textarea").fill(body);
  await frame.getByTestId("commentor-composer-post").click();
  await expect(frame.getByTestId("commentor-composer-textarea")).toBeHidden();
  await expect(otherFrame.getByText(body, { exact: true })).toBeVisible();
  await observer.reload();
  await otherFrame.getByTestId("commentor-panel-btn").click();
  await expect(otherFrame.getByText(body, { exact: true })).toBeVisible();
  await observer.close();
});
