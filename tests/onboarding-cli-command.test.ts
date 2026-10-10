import { Hono } from "hono";
import type { User } from "better-auth/types";
import vm from "node:vm";
import { expect, it } from "vitest";
import pages from "../src/routes/organization-pages";
import { version } from "../package.json";

it.each(["https://dev.rendro.app", "https://rendro.app"])("pins the compatible CLI and targets onboarding's actual origin %s", async origin => {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => { c.set("user", { id: "owner", name: "Owner", email: "owner@example.invalid" } as User); await next(); });
  app.route("/", pages);
  const html = await (await app.request("/organizations/org/onboarding?projectId=project")).text();
  const functions = html.match(/ {2}function shellQuote[^\n]+\n {2}function cliPushCommand[^\n]+/)?.[0];
  expect(functions).toBeDefined();
  const context = vm.createContext({ orgId: "org", projectId: "project", location: { origin }, key: "disposable-test-key" });
  vm.runInContext(functions ?? "", context);
  const command = vm.runInContext("cliPushCommand(key)", context) as string;
  expect(command).toContain(`npx --yes rendro@${version} push --source ./docs`);
  expect(command).toContain("--organization 'org' --project 'project'");
  expect(command).toContain(`--endpoint '${origin}'`);
  expect(vm.runInContext('shellQuote("x\'y")', context)).toBe("'x'\\''y'");
});
