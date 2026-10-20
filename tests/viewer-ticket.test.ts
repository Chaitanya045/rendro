import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieSite, sessionTokenCookie, viewerSessionCookie } from "@/viewer-ticket";

const sites = { "": "http://localhost:8787", "__Host-": "https://rendro.app" } as const;

afterEach(() => vi.unstubAllEnvs());

/** The session-cookie filter every Worker session read (#208) and the repository read path (#234) use. */
describe("session cookie selection", () => {
  it.each(Object.entries(sites))("keeps only the '%s' session token and its signed lifetime preference on %s", (prefix, site) => {
    const token = `${prefix}better-auth.session_token=signed-token`;
    const preference = `${prefix}better-auth.dont_remember=signed-preference`;
    const header = `theme=dark; ${preference}; ${token}; better-auth.session_data=unused; __Secure-better-auth.session_data.0=unused; better-auth.dont_remember_extra=unused`;
    const filtered = `${token}; ${preference}`;
    expect(viewerSessionCookie(site, header)).toBe(filtered);
    expect(sessionTokenCookie(site, header)).toBe(token);
    expect(viewerSessionCookie(site, filtered)).toBe(filtered);
    for (const invalid of [preference, `${preference}; ${prefix}better-auth.session_token=`]) expect(viewerSessionCookie(site, invalid)).toBe("");
  });

  it("reads only the site's own prefix: the retired __Secure- names never, and each site never the other's (#208)", () => {
    const pairs = (prefix: string) => `${prefix}better-auth.session_token=${prefix || "plain"}-token; ${prefix}better-auth.dont_remember=${prefix || "plain"}-preference`;
    // Over HTTPS an unprefixed cookie can come from a sibling subdomain (Domain=.rendro.app).
    for (const other of ["__Secure-", ""]) {
      expect(viewerSessionCookie(sites["__Host-"], pairs(other))).toBe("");
      expect(viewerSessionCookie(sites["__Host-"], `${pairs(other)}; ${pairs("__Host-")}`)).toBe(pairs("__Host-"));
      expect(viewerSessionCookie(sites["__Host-"], `${pairs("__Host-")}; ${pairs(other)}`)).toBe(pairs("__Host-"));
    }
    for (const other of ["__Secure-", "__Host-"]) {
      expect(sessionTokenCookie(sites[""], pairs(other))).toBe("");
      expect(viewerSessionCookie(sites[""], `${pairs(other)}; ${pairs("")}`)).toBe(pairs(""));
    }
  });

  it("never forwards session data, unrelated cookies or bearer material", () => {
    expect(viewerSessionCookie(sites[""], "better-auth.session_data=cached; unrelated=value")).toBe("");
    expect(sessionTokenCookie(sites[""], "other=value; Authorization=Bearer rnd_live_x")).toBe("");
    expect(viewerSessionCookie(sites["__Host-"], "")).toBe("");
  });
});

describe("cookie site", () => {
  it("prefers the configured SITE_URL, else the request's own origin", () => {
    vi.stubEnv("SITE_URL", "https://rendro.app");
    expect(cookieSite("http://127.0.0.1:8787/home")).toBe("https://rendro.app");
    vi.stubEnv("SITE_URL", undefined);
    expect(cookieSite("https://dev.rendro.app/r/o/n?x=1")).toBe("https://dev.rendro.app");
    expect(cookieSite("http://127.0.0.1:8787/home")).toBe("http://127.0.0.1:8787");
  });
});
