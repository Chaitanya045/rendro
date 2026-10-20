import type { User } from "better-auth/types";
import { Hono } from "hono";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { afterAll, describe, expect, it } from "vitest";
import authPages from "@/routes/auth-pages";
import { commentRecoveryScript } from "@/commentor/recovery-session";
import { nonceContext } from "@/middleware/html-nonce";
import { renderNotFoundPage } from "@/routes/not-found";
import { repoShell } from "./helpers/repo-shell";

/**
 * Every request or repository value a page shows (#288) arrives intact and inert: markup escapes it, and a
 * script reads it back as data. A hostile value never adds an element, an attribute or a script.
 */
const hostile = "</script><script>alert(1)</script><!--\"'&\u2028\u2029 <b x=\"1\">";
const window = new Window();
afterAll(() => window.happyDOM.close());

const parse = (html: string) => new window.DOMParser().parseFromString(html, "text/html");
const scripts = (html: string) => [...parse(html).querySelectorAll("script")].map(script => script.textContent ?? "");
/** Runs a data script against a bare `window` and returns what it assigned. */
function assigned(code: string): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  runInNewContext(code, { window: target });
  return target;
}

describe("repository shell", () => {
  const values = {
    namespace: `docs${hostile}`, title: `acme/${hostile}`, basePath: `/r/acme/${hostile}`, frameBase: `/r/acme/@${hostile}`, selectedPath: `${hostile}.md`,
    repoCommentConfig: { repoId: 9, accessUrl: `/r/${hostile}/comment-access`, convexUrl: `https://${hostile}`, documentPath: `${hostile}.md` },
    privateViewerBase: `/r/acme/@${hostile}`, monitoring: true,
  };
  const benign = nonceContext.run("n", () => repoShell({ privateViewerBase: "/r/acme/docs/@c0ffee", monitoring: true, repoCommentConfig: { repoId: 9, accessUrl: "/a", convexUrl: "https://convex.test" } }));
  const html = nonceContext.run("n", () => repoShell(values));

  it("shows the title and names the tree's bases as text and attributes", () => {
    const document = parse(html);
    expect(document.title).toBe(`${values.title} — Rendro`);
    expect(document.querySelector(".topbar-logo")?.textContent).toBe(values.title);
    const tree = document.querySelector(".sidebar-tree");
    expect(tree?.getAttribute("data-tree-org")).toBe(values.namespace);
    expect(tree?.getAttribute("data-document-base")).toBe(values.basePath);
    expect(tree?.getAttribute("data-frame-base")).toBe(values.frameBase);
    expect(JSON.parse(document.querySelector("script[data-viewer=parent]")?.getAttribute("data-config") ?? "")).toEqual({ base: values.privateViewerBase });
  });

  it("hands the bootstrap its values as data, with no script element of their own", () => {
    expect(html).not.toContain("<script>alert(1)");
    expect(scripts(html)).toHaveLength(scripts(benign).length);
    const bootstrap = scripts(html).find(code => code.startsWith("window.RENDRO_INITIAL_DOC="));
    expect(bootstrap).not.toMatch(/<\/script|<!--|[\u2028\u2029]/);
    expect(assigned(bootstrap ?? "")).toEqual({
      RENDRO_INITIAL_DOC: `${values.namespace}/${values.selectedPath}`, RENDRO_ORG: values.namespace, RENDRO_DOCUMENT_BASE: values.basePath, RENDRO_REPO_COMMENT_CONFIG: values.repoCommentConfig,
    });
  });
});

describe("not-found page", () => {
  const options = { path: `/r/${hostile}`, homeHref: `/home?${hostile}`, homeLabel: `Home ${hostile}`, heading: `Gone ${hostile}`, message: `Moved ${hostile}` };
  const html = renderNotFoundPage(options);

  it("shows every option as text or one attribute", () => {
    const document = parse(html);
    expect(document.title).toBe(`404 · ${options.heading} — Rendro`);
    expect(document.querySelector("h1")?.textContent).toBe(options.heading);
    expect(document.querySelector(".panel > p")?.textContent).toBe(options.message);
    expect(document.querySelector("code.path")?.textContent).toBe(options.path);
    const home = document.querySelector("a.btn.primary");
    expect(home?.getAttribute("href")).toBe(options.homeHref);
    expect(home?.textContent).toBe(options.homeLabel);
    expect(document.querySelector("#go-back")?.getAttribute("data-home-href")).toBe(options.homeHref);
    expect(scripts(html)).toHaveLength(scripts(renderNotFoundPage()).length);
  });
});

describe("authentication pages", () => {
  function signedIn(user: Partial<User>) {
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", async (c, next) => { c.set("user", user as User); await next(); });
    return app.route("/", authPages);
  }
  const user = { id: `user${hostile}`, name: `Ada ${hostile}`, email: `ada${hostile}@example.test` };

  it.each(["/home", "/account/security"])("shows the reader's identity on %s as text", async path => {
    const html = await (await signedIn(user).request(path)).text();
    const document = parse(html);
    expect(document.querySelector(".heading strong")?.textContent).toBe(user.email);
    if (path === "/home") expect(document.querySelector(".heading h1")?.textContent).toBe(`Welcome, ${user.name}`);
    expect(html).not.toContain("<script>alert(1)");
    const recovery = scripts(html).find(code => code.includes('const key = "rendro-sign-out"')) ?? "";
    expect(JSON.parse(/const userId = (.*);/.exec(recovery)?.[1] ?? "")).toBe(user.id);
  });

  it("hands the runtime the return path and reset token as data", async () => {
    const returnTo = `/r/acme/${hostile}`;
    const html = await (await authPages.request(`/reset-password?token=${encodeURIComponent(hostile)}&returnTo=${encodeURIComponent(returnTo)}`)).text();
    const state = scripts(html).find(code => code.startsWith("window.__AUTH_STATE__=")) ?? "";
    expect(state).not.toMatch(/<\/script|<!--|[\u2028\u2029]/);
    expect(assigned(state).__AUTH_STATE__).toEqual({ page: "reset-password", returnTo, token: hostile });
    expect(scripts(html)).toHaveLength(scripts(await (await authPages.request("/reset-password?token=t")).text()).length);
  });

  it("never echoes a sign-in error code", async () => {
    const html = await (await authPages.request(`/sign-in?error=${encodeURIComponent(hostile)}`)).text();
    expect(parse(html).querySelector("#form-error")?.textContent).toBe("We couldn't complete sign-in. Please try again or use your email and password.");
    expect(html).not.toContain("alert(1)");
  });
});

describe("comment recovery bootstrap", () => {
  it("embeds the user id as a JSON string", () => {
    const code = commentRecoveryScript(hostile);
    expect(code).not.toContain("</script");
    expect(JSON.parse(/const userId = (.*);/.exec(code)?.[1] ?? "")).toBe(hostile);
  });
});
