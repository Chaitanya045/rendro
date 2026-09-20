import { Hono } from "hono";
import type { User } from "better-auth/types";
import organizationPages from "../src/routes/organization-pages";
import projectPages from "../src/routes/project-pages";
import publicationPages from "../src/routes/publication-pages";
import sharePages from "../src/routes/share-pages";
import apiKeyPages from "../src/routes/api-key-pages";
import { MANAGEMENT_SHELL_VERSION } from "../src/routes/management-navigation";

// Generate from the real SSR routes so dialogs/controllers cannot drift between
// initial loads and navigation. This build never connects to auth or user data.
export async function managementPagesSource() {
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "__RD_USER__", name: "Build fixture", email: "build@example.invalid" } as User);
    await next();
  });
  for (const routes of [organizationPages, projectPages, publicationPages, sharePages, apiKeyPages]) app.route("/", routes);
  const suffixes = { overview: "", projects: "/projects", people: "/people", teams: "/teams", settings: "/settings", "api-keys": "/api-keys", project: "/projects/__RD_PROJECT__", publications: "/projects/__RD_PROJECT__/publications", shares: "/projects/__RD_PROJECT__/shares" };
  const entries = [];
  for (const [section, suffix] of Object.entries(suffixes)) {
    const response = await app.request(`/organizations/__RD_ORG__${suffix}`);
    const html = await response.text();
    const script = html.match(/<script data-cp-page-script>([\s\S]*?)<\/script>/)?.[1];
    const state = html.match(/<script data-cp-page-state type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    const content = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    if (!response.ok || !script || !state || !content || !title) throw new Error(`Incomplete management template: ${section}`);
    const dialogs = [...content.matchAll(/<dialog\b[\s\S]*?<\/dialog>/g)].map((match) => match[0]).join("");
    entries.push(`${JSON.stringify(section)}:{title:${JSON.stringify(title)},state:${JSON.stringify(state)},dialogs:${JSON.stringify(dialogs)},mount:function(){${script}\n}}`);
  }
  return `window.RendroManagementPages={version:${JSON.stringify(MANAGEMENT_SHELL_VERSION)},pages:{${entries.join(",")}}};`;
}
