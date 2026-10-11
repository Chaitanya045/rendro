import type { User } from "better-auth/types";
import { renderOrganizationSection } from "../src/routes/organization-pages";
import { renderProjectPage } from "../src/routes/project-pages";
import { renderPublicationPage } from "../src/routes/publication-pages";
import { renderSharePage } from "../src/routes/share-pages";
import { renderApiKeyPage } from "../src/routes/api-key-pages";
import { MANAGEMENT_SHELL_VERSION } from "../src/routes/management-navigation";

// Generate from the same pure renderers as SSR, without session authorization
// or backend requests. Dialogs/controllers stay identical to initial page loads.
export function managementPagesSource() {
  const user = { id: "__RD_USER__", name: "Build fixture", email: "build@example.invalid" } as User;
  const org = "__RD_ORG__", project = "__RD_PROJECT__";
  const templates = {
    overview: () => renderOrganizationSection(user, org, "overview"),
    projects: () => renderProjectPage(user, org),
    people: () => renderOrganizationSection(user, org, "people"),
    teams: () => renderOrganizationSection(user, org, "teams"),
    settings: () => renderOrganizationSection(user, org, "settings"),
    "api-keys": () => renderApiKeyPage(user, org),
    project: () => renderProjectPage(user, org, project),
    deployments: () => renderProjectPage(user, org, project, "deployments"),
    publications: () => renderPublicationPage(user, org, project),
    shares: () => renderSharePage(user, org, project),
  };
  const entries = [];
  for (const [section, render] of Object.entries(templates)) {
    const html = render();
    const script = html.match(/<script data-cp-page-script>([\s\S]*?)<\/script>/)?.[1];
    const state = html.match(/<script data-cp-page-state type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    const content = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    if (!script || !state || !content || !title) throw new Error(`Incomplete management template: ${section}`);
    const dialogs = [...content.matchAll(/<dialog\b[\s\S]*?<\/dialog>/g)].map((match) => match[0]).join("");
    entries.push(`${JSON.stringify(section)}:{title:${JSON.stringify(title)},state:${JSON.stringify(state)},dialogs:${JSON.stringify(dialogs)},mount:function(){${script}\n}}`);
  }
  return `window.RendroManagementPages={version:${JSON.stringify(MANAGEMENT_SHELL_VERSION)},pages:{${entries.join(",")}}};`;
}
