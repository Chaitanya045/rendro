import "./fixtures/management-page-presentation";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import vm from "node:vm";
import { expect, it } from "vitest";
import pages from "../src/routes/organization-pages";
import projectPages from "../src/routes/project-pages";
import { managementUiRuntime } from "../src/ui/management-ui";
import { version } from "../package.json";

function sharedBuilder(origin: string) {
  const ui: Record<string, (...args: unknown[]) => string> = {};
  vm.runInNewContext(managementUiRuntime, { window: { RendroUI: ui }, location: { origin }, addEventListener() {} });
  return ui.cliPushCommand as (options: Record<string, string>) => string;
}

async function pageScript(path: string): Promise<string> {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => { c.set("user", { id: "owner", name: "Owner", email: "owner@example.invalid" } as User); await next(); });
  app.route("/", pages);
  app.route("/", projectPages);
  const html = await (await app.request(path)).text();
  return html.match(/<script data-cp-page-script>([\s\S]*?)<\/script>/)?.[1] ?? "";
}

it.each(["https://dev.rendro.app", "https://rendro.app"])("pins the compatible CLI and targets onboarding's actual origin %s", origin => {
  const command = sharedBuilder(origin)({ apiKey: "disposable'key", organizationId: "org", projectId: "project", endpoint: origin });
  expect(command.split("\n")).toEqual([
    "export RENDRO_API_KEY='disposable'\\''key'",
    `npx --yes rendro@${version} push --source ./docs \\`,
    "  --organization 'org' --project 'project' \\",
    `  --endpoint '${origin}'`,
  ]);
});

it("shows the same pinned command on the project page without exposing a key", () => {
  const command = sharedBuilder("https://rendro.app")({ organizationId: "org", projectId: "project", endpoint: "https://rendro.app" });
  expect(command).toContain("# Set RENDRO_API_KEY securely in your environment; never commit it.");
  expect(command).toContain(`npx --yes rendro@${version} push --source ./docs`);
  expect(command).not.toContain("export RENDRO_API_KEY");
});

it("routes onboarding and project pages through the one shared builder", async () => {
  const onboarding = await pageScript("/organizations/org/onboarding?projectId=project");
  const project = await pageScript("/organizations/org/projects/project");
  expect(onboarding).toContain("RUI.cliPushCommand({apiKey:rawKey,organizationId:orgId,projectId:projectId,endpoint:location.origin})");
  expect(project).toContain("RUI.cliPushCommand({organizationId:state.organizationId,projectId:state.projectId,endpoint:location.origin})");
  for (const script of [onboarding, project]) {
    expect(script).not.toContain("rendro push --organization");
    expect(script).not.toContain("npx --yes");
  }
});
