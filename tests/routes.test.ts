import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import workerApp from "@/worker";
import type { User } from "better-auth/types";

describe("session middleware", () => {
  let sessionMiddleware: MiddlewareHandler;

  beforeEach(async () => {
    const mod = await import("@/middleware/session");
    sessionMiddleware = mod.sessionMiddleware;
  });

  function makeSessionApp() {
    const app = new Hono<{ Variables: { user?: User } }>();
    app.use("*", sessionMiddleware);
    app.get("/me", (c) => c.json(c.get("user") ?? null));
    return app;
  }

  it("ignores X-Dev-User even in development", async () => {
    process.env.NODE_ENV = "development";
    const res = await makeSessionApp().request("/me", {
      headers: { "X-Dev-User": "alice@acme-corp.com" },
    });
    expect(await res.json()).toBeNull();
  });

  it("ignores dev_user on the public dev hostname", async () => {
    process.env.NODE_ENV = "development";
    const res = await makeSessionApp().request(
      "https://dev.rendro.app/me?dev_user=carol%40acme-corp.com",
    );
    expect(await res.json()).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("ignores the legacy development user cookie", async () => {
    process.env.NODE_ENV = "development";
    const res = await makeSessionApp().request("/me", {
      headers: { cookie: "rendro-dev-user=bob%40acme-corp.com" },
    });
    expect(await res.json()).toBeNull();
  });
});

// ────────────────────────────────────────────────────
// 4. Unauthenticated landing — product and auth contract
// ────────────────────────────────────────────────────
describe("unauthenticated landing", () => {
  it("presents the product before offering sign-up", async () => {
    process.env.NODE_ENV = "development";

    const res = await workerApp.request("https://dev.rendro.app/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<title>Rendro — Documentation that ships with your code</title>");
    expect(html).toContain('<h1 id="hero-title">Your docs should ship with your code.</h1>');
    expect(html).toContain('src="/landing-product.webp"');
    expect(html).toContain('id="product"');
    expect(html).toContain('id="workflow"');
    expect(html).toContain('id="security"');
    // Every call to action is a plain link to email sign-up: no third-party sign-in starts from the landing page (#286).
    for (const id of ["hero-start", "security-start", "final-start"]) expect(html).toContain(`href="/sign-up" data-action-id="${id}">Get started</a>`);
    expect(html).not.toContain("/api/auth/sign-in/social");
    expect(html).not.toMatch(/google/i);
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain('href="#product" data-scroll-section="product" data-action-id="explore-product"');
    expect(html).not.toContain('href="https://dev.rendro.app/public/rendro-feature-test/reference"');
    expect(html).toContain("data-reveal-group");
    expect(html).toContain("IntersectionObserver");
    expect(html).toContain('document.documentElement.classList.add("motion-ready")');
    expect(html.match(/data-scroll-section=/g)).toHaveLength(7);
    expect(html).toContain('history.replaceState(null, "", window.location.pathname + window.location.search)');
    expect(html).toContain('window.scrollTo({ top: sectionTop');
    expect(html).toContain('navigationEntry.type === "reload"');
    expect(html).not.toContain('window.addEventListener("hashchange"');
    expect(html).not.toContain("Sign in to read your team's docs.");
  });

});

// ────────────────────────────────────────────────────
// 5. Worker auth proxy — browser request context
// ────────────────────────────────────────────────────
describe("worker auth proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the browser origin, cookies and body of a sign-in request", async () => {
    let proxiedHeaders = new Headers();
    let proxiedBody = "";
    const upstreamUrls: string[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      upstreamUrls.push(url);
      if (url.includes("/api/auth/get-session")) return Promise.resolve(Response.json(null));
      if (url.includes("/api/auth/sign-in/email")) {
        proxiedHeaders = new Headers(init?.headers);
        proxiedBody = typeof init?.body === "string" ? init.body : "";
        return Promise.resolve(Response.json({ redirect: false }));
      }
      return Promise.resolve(new Response("unexpected fetch", { status: 500 }));
    };
    vi.stubGlobal("fetch", fakeFetch);

    const body = JSON.stringify({
      email: "reader@example.test",
      password: "synthetic-password-0123",
      callbackURL: "https://dev.rendro.app/",
    });
    const res = await workerApp.request("https://dev.rendro.app/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        cookie: "theme=dark",
        "content-type": "application/json",
        origin: "https://dev.rendro.app",
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(proxiedHeaders.get("origin")).toBe("https://dev.rendro.app");
    expect(proxiedHeaders.get("content-type")).toBe("application/json");
    expect(proxiedHeaders.get("cookie")).toBe("theme=dark");
    expect(upstreamUrls.filter((url) => url.includes("/api/auth/get-session"))).toHaveLength(0);
    expect(proxiedBody).toBe(body);
  });
});



// ────────────────────────────────────────────────────
// 6. Worker auth sign-out — stale OAuth cookie cleanup
// ────────────────────────────────────────────────────
describe("worker auth sign-out", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("expires auth cookies and asks the browser to clear site cookies", async () => {
    const upstreamHeaders = new Headers();
    upstreamHeaders.append(
      "set-cookie",
      "__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=convex.site",
    );
    upstreamHeaders.append(
      "set-cookie",
      "__Secure-better-auth.state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=convex.site",
    );
    const calls: string[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/api/auth/get-session")) return Promise.resolve(new Response("null", { status: 200 }));
      if (url.includes("/api/auth/sign-out")) {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200, headers: upstreamHeaders }));
      }
      return Promise.resolve(new Response("unexpected fetch", { status: 500 }));
    };
    vi.stubGlobal("fetch", fakeFetch);

    const res = await workerApp.request("https://dev.rendro.app/api/auth/sign-out", {
      method: "POST",
      headers: {
        origin: "https://dev.rendro.app",
        cookie: [
          "__Secure-better-auth.session_token=session",
          "__Secure-better-auth.state=oauth-state",
          "__Secure-better-auth.session_data.0=cache",
          "rendro-dev-user=carol%40acme-corp.com",
        ].join("; "),
      },
    });

    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
    const joined = setCookies.join("\n");
    expect(joined).toContain("__Secure-better-auth.session_token=;");
    expect(joined).toContain("__Secure-better-auth.state=;");
    expect(joined).toContain("__Secure-better-auth.session_data.0=;");
    expect(joined).toContain("rendro-dev-user=;");
    expect(res.headers.get("clear-site-data")).toBe('"cache"');
    expect(joined).toContain("__Secure-better-auth.state=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure; Domain=.rendro.app");
    expect(joined).toContain("__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure; Domain=.rendro.app");
    expect(joined).not.toContain("Domain=convex.site");
    // Current host-only names are cleared without Domain (browsers would reject it).
    for (const name of ["session_token", "session_data", "dont_remember", "convex_jwt", "state"]) {
      expect(setCookies).toContain(`__Host-better-auth.${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`);
      expect(setCookies).toContain(`__Secure-better-auth.${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`);
      expect(setCookies).toContain(`better-auth.${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Domain=.rendro.app`);
    }
    expect(setCookies.filter(value => value.startsWith("__Host-") && /Domain=/i.test(value))).toEqual([]);
    expect(setCookies).toContain("rendro-dev-user=; Max-Age=0; Path=/; SameSite=Lax; Domain=.rendro.app");
    expect(calls.some((call) => call.includes("/api/auth/sign-out"))).toBe(true);
  });

  it("retains cookies and offers retry when upstream sign-out fails", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.reject(new Error("Convex unavailable"));
    vi.stubGlobal("fetch", fakeFetch);

    const res = await workerApp.request("https://dev.rendro.app/api/auth/sign-out", { method: "POST", headers: { origin: "https://dev.rendro.app" } });
    expect(res.status).toBe(502);
    expect(res.headers.has("location")).toBe(false);
    expect(res.headers.has("clear-site-data")).toBe(false);
    expect(res.headers.has("set-cookie")).toBe(false);
    expect(await res.text()).toContain("Try again");
  });
});


// ────────────────────────────────────────────────────
// 7. Create org screen — design-system chrome
// ────────────────────────────────────────────────────
describe("authenticated entry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("redirects an authenticated session to its home", async () => {
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.includes("/api/auth/get-session")) {
        return Promise.resolve(Response.json({
          session: { expiresAt: Date.now() + 60_000 },
          user: {
            id: "user_owner",
            email: "owner@gmail.com",
            name: "Owner",
            emailVerified: true,
            image: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        }));
      }
      return Promise.resolve(new Response("unexpected fetch", { status: 500 }));
    });

    const res = await workerApp.request("https://dev.rendro.app/", {
      headers: { cookie: "__Secure-better-auth.session_token=test-session" },
    });
    expect(await res.text()).toBe("");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/home");
  });
});

// ────────────────────────────────────────────────────
