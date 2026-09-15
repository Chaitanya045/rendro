/* eslint-disable */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { Hono } from "hono";
import authPageRoutes from "@/routes/auth-pages";
import { renderNotFoundPage } from "@/routes/not-found";

class InputMock {
  id = "";
  name = "";
  type = "text";
  value = "";
  minLength = 0;
  required = false;
  validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
  attributes = new Map<string, string>();
  focus = () => { (this as any).ownerDocument.activeElement = this; };
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
}

class ElementMock {
  id = "";
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  textContent = "";
  className = "";
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: any) => unknown)[]>();
  children: any[] = [];
  email!: InputMock;
  password!: InputMock;
  confirmPassword!: InputMock;
  rememberMe!: { checked: boolean };
  constructor(public kind: string, public ownerDocument: any, public inputs: InputMock[] = []) {}
  addEventListener(type: string, listener: (event: any) => unknown) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  async dispatch(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) await listener({ target: this, ...event }); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelector(selector: string) {
    if (selector === ":invalid") return this.inputs.find((input) => !input.validity.valid) ?? null;
    if (selector === "button[type=submit]") return this.children.find((child) => child.kind === "submit");
    return null;
  }
  elements = { namedItem: (name: string) => this.inputs.find((input) => input.name === name) };
}

async function runtime(
  page: "sign-in" | "sign-up" | "verify-email" | "forgot-password" | "reset-password",
  fetchImpl: (...args: any[]) => Promise<any>,
  query = "",
) {
  const response = await authPageRoutes.request(`/${page}${query}`);
  const html = await response.text();
  const script = html.match(/<script id="auth-runtime">([\s\S]*?)<\/script>/)?.[1] ?? "";
  const state = JSON.parse(html.match(/window\.__AUTH_STATE__=([^;]+);/)?.[1] ?? "{}");
  const document: any = { activeElement: null, documentElement: { classList: { toggle() {} } }, map: new Map() };
  const theme = new ElementMock("button", document); const themeIcon = new ElementMock("span", document);
  const google = new ElementMock("button", document); google.id = "google-auth";
  const divider = new ElementMock("div", document); divider.className = "divider";
  const error = new ElementMock("p", document); error.id = "form-error";
  const formMessage = new ElementMock("p", document); formMessage.id = "form-message";
  const submit = new ElementMock("submit", document); const form = new ElementMock("form", document);
  const makeInput = (name: string, type = "text") => {
    const input = new InputMock(); input.name = name; input.id = name; input.type = type; input.required = true;
    (input as any).ownerDocument = document;
    return input;
  };
  const email = makeInput("email", "email");
  const password = makeInput("password", "password");
  const confirmPassword = makeInput("confirmPassword", "password");
  const name = makeInput("name");
  if (page === "sign-in") form.inputs = [email, password];
  else if (page === "sign-up") form.inputs = [name, email, password];
  else if (page === "reset-password") { password.minLength = 15; confirmPassword.minLength = 15; form.inputs = [password, confirmPassword]; }
  else form.inputs = [email];
  form.email = email; form.password = password; form.confirmPassword = confirmPassword; form.rememberMe = { checked: true }; form.elements.namedItem = (fieldName: string) => form.inputs.find((input) => input.name === fieldName);
  form.children = [submit];
  const successPanel = new ElementMock("section", document); successPanel.id = "success-panel"; successPanel.hidden = true;
  document.map.set("theme-toggle", theme); document.map.set("theme-icon", themeIcon); document.map.set("google-auth", page === "sign-up" ? google : null); document.map.set("divider", page === "sign-up" ? divider : null); document.map.set("auth-form", page === "verify-email" ? null : form); document.map.set("resend-form", page === "verify-email" ? form : null); document.map.set("form-error", error); document.map.set("form-message", formMessage); document.map.set("success-panel", successPanel);
  document.getElementById = (id: string) => document.map.get(id) ?? null;
  document.querySelector = (selector: string) => selector === "#auth-form button[type=submit]" || selector === "button[type=submit]" ? submit : selector === ".divider" ? divider : null;
  document.querySelectorAll = (selector: string) => selector === "form" ? [form] : [];
  const context: any = { window: { __AUTH_STATE__: state, RendroTheme: { mount() {} } }, document, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { origin: "http://local", assign() {} }, fetch: fetchImpl, console, Error, HTMLInputElement: InputMock };
  context.window.matchMedia = context.matchMedia; context.window.localStorage = context.localStorage; context.window.location = context.location;
  vm.runInNewContext(script, context);
  return { form, email, password, confirmPassword, name, submit, error, formMessage, successPanel, document };
}

describe("auth UI regressions", () => {
  it("rejects backslash-based external return targets while preserving invitations", async () => {
    const unsafe = await authPageRoutes.request("/sign-in?returnTo=%2F%5Cevil.example");
    const safe = await authPageRoutes.request("/sign-in?returnTo=%2Faccept-invitation%2Finv-123");
    const unsafeHtml = await unsafe.text();
    const safeHtml = await safe.text();

    expect(unsafe.status).toBe(200);
    expect(unsafeHtml).toContain('"returnTo":"/"');
    expect(unsafeHtml).not.toContain("evil.example");
    expect(safeHtml).toContain('"returnTo":"/accept-invitation/inv-123"');
    expect(safeHtml).toContain("You have been invited to collaborate.");
  });

  it("renders an immediate recovery state when a reset token is missing", async () => {
    const response = await authPageRoutes.request("/reset-password");
    const html = await response.text();
    expect(html).toContain("Reset link unavailable");
    expect(html).toContain("This reset link is missing or invalid.");
    expect(html).toContain("Request a new reset link");
    expect(html).not.toContain('class="button-label">Update password');
  });

  it("hides only the mobile viewport scrollbar on auth surfaces", async () => {
    const response = await authPageRoutes.request("/sign-in");
    const html = await response.text();
    expect(html).toContain("@media(max-width:760px){html{scrollbar-width:none}html::-webkit-scrollbar{display:none}}");
  });

  it("hides only the mobile viewport scrollbar on not-found surfaces", () => {
    const html = renderNotFoundPage({ path: "/missing" });
    expect(html).toContain("@media(max-width:760px){html{scrollbar-width:none}html::-webkit-scrollbar{display:none}}");
  });

  it("top-aligns security so loading and loaded card heights do not recenter it", async () => {
    const app = new Hono<{ Variables: { user?: any } }>();
    app.use("*", async (c, next) => { c.set("user", { id: "u", email: "qa@example.com", name: "QA" }); await next(); });
    app.route("/", authPageRoutes);
    const html = await (await app.request("/account/security")).text();
    expect(html).toContain('<main class="main security-main">');
    expect(html).toContain('.main.security-main{align-items:start}');
    expect(html).toContain('.main.security-main{place-items:start center}');
  });

  it("gives account-security method actions complete secondary-button states", async () => {
    const app = new Hono<{ Variables: { user?: any } }>();
    app.use("*", async (c, next) => { c.set("user", { id: "u", email: "qa@example.com", name: "QA" }); await next(); });
    app.route("/", authPageRoutes);
    const html = await (await app.request("/account/security")).text();
    expect(html).toContain(".method-action:hover:not(:disabled){border-color:var(--muted);background:var(--surface-2)}");
    expect(html).toContain(".method-action:active:not(:disabled){transform:scale(.98)}");
    expect(html).toContain(".method-action:disabled{cursor:wait;opacity:.62;transform:none}");
    expect(html).toContain(".button,.field input,.method-action{transition-duration:.01ms}");
    expect(html).toContain(".reveal,.account-footer a,.switch a,.form-row>a{transition-duration:.01ms}");
    expect(html).toContain(".method-action:active:not(:disabled){transform:none}");
  });

  it("wires the unconfigured password action to the initial-password section", async () => {
    const app = new Hono<{ Variables: { user?: any } }>();
    app.use("*", async (c, next) => { c.set("user", { id: "u", email: "qa@example.com", name: "QA" }); await next(); });
    app.route("/", authPageRoutes);
    const html = await (await app.request("/account/security")).text();
    expect(html).toContain('section=document.getElementById("initial-password-section")');
    expect(html).toContain('section.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"nearest"})');
    expect(html).toContain('input.focus({preventScroll:true})');
  });

  it("blocks invalid auth submits and focuses the first invalid field", async () => {
    let calls = 0;
    const ui = await runtime("sign-in", async () => { calls += 1; return { ok: true, json: async () => ({}) }; });
    ui.email.validity = { valueMissing: true, typeMismatch: false, tooShort: false, valid: false };
    await ui.form.dispatch("submit", { preventDefault() {} });
    expect(calls).toBe(0);
    expect(ui.document.activeElement).toBe(ui.email);
    expect(ui.email.attributes.get("aria-invalid")).toBe("true");
    expect(ui.email.attributes.get("aria-describedby")).toBe("form-error");
  });

  it("allows only one in-flight submit and restores the button after failure", async () => {
    let calls = 0;
    let rejectRequest!: (error: Error) => void;
    const pending = new Promise((_, reject) => { rejectRequest = reject; });
    const ui = await runtime("sign-in", async () => { calls += 1; return pending; });
    ui.email.value = "person@example.com"; ui.email.validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
    ui.password.value = "password"; ui.password.validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
    const first = ui.form.dispatch("submit", { preventDefault() {} });
    const second = ui.form.dispatch("submit", { preventDefault() {} });
    expect(calls).toBe(1); expect(ui.submit.disabled).toBe(true);
    rejectRequest(new Error("offline"));
    await Promise.all([first, second]);
    expect(ui.submit.disabled).toBe(false);
    expect(ui.error.textContent).toBe("offline");
  });

  it("keeps recovery non-enumerating but reports server failures for retry", async () => {
    const ui = await runtime("forgot-password", async () => ({ ok: false, status: 503, json: async () => ({}) }));
    ui.email.value = "person@example.com"; ui.email.validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
    await ui.form.dispatch("submit", { preventDefault() {} });
    expect(ui.formMessage.textContent).toContain("couldn't send");
    expect(ui.formMessage.textContent).toContain("try again");
    expect(ui.formMessage.textContent).not.toContain("If an account exists");
  });

  it("rejects mismatched reset passwords before making a request", async () => {
    let calls = 0;
    const ui = await runtime("reset-password", async () => { calls += 1; return { ok: true, json: async () => ({}) }; }, "?token=synthetic-token");
    ui.password.value = "a-safe-password-1";
    ui.confirmPassword.value = "a-different-password";
    ui.password.validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
    ui.confirmPassword.validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
    await ui.form.dispatch("submit", { preventDefault() {} });
    expect(calls).toBe(0);
    expect(ui.error.textContent).toBe("Passwords do not match.");
    expect(ui.submit.disabled).toBe(false);
  });

  it("restores reset controls after a failed request and permits retry", async () => {
    let calls = 0;
    const ui = await runtime("reset-password", async () => {
      calls += 1;
      if (calls === 1) throw new Error("Reset service unavailable");
      return { ok: true, json: async () => ({}) };
    }, "?token=synthetic-token");
    ui.password.value = "a-safe-password-1";
    ui.confirmPassword.value = "a-safe-password-1";
    ui.password.validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
    ui.confirmPassword.validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
    await ui.form.dispatch("submit", { preventDefault() {} });
    expect(calls).toBe(1);
    expect(ui.submit.disabled).toBe(false);
    expect(ui.error.textContent).toBe("Reset service unavailable");
    await ui.form.dispatch("submit", { preventDefault() {} });
    expect(calls).toBe(2);
    expect(ui.successPanel.hidden).toBe(false);
  });

  it("preserves returnTo in sign-up verification callback and shows success", async () => {
    let body = "";
    const ui = await runtime("sign-up", async (_path: string, options: { body: string }) => {
      body = options.body;
      return { ok: true, json: async () => ({}) };
    }, "?returnTo=%2Faccept-invitation%2Finv-123");
    ui.name.value = "Synthetic QA";
    ui.email.value = "qa@example.com";
    ui.password.value = "a-safe-password-1";
    for (const input of [ui.name, ui.email, ui.password]) input.validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
    await ui.form.dispatch("submit", { preventDefault() {} });
    expect(JSON.parse(body).callbackURL).toBe("http://local/verify-email?verified=1&returnTo=%2Faccept-invitation%2Finv-123");
    expect(ui.successPanel.hidden).toBe(false);
  });

  it("reports verification resend transport failure while keeping account privacy", async () => {
    const ui = await runtime("verify-email", async () => ({ ok: false, status: 503, json: async () => ({}) }));
    ui.email.value = "qa@example.com";
    ui.email.validity = { valueMissing: false, typeMismatch: false, tooShort: false, valid: true };
    await ui.form.dispatch("submit", { preventDefault() {} });
    expect(ui.formMessage.textContent).toBe("We couldn't send that email. Please try again.");
    expect(ui.formMessage.textContent).not.toContain("account");
    expect(ui.submit.disabled).toBe(false);
  });
});
