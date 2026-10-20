import { describe, expect, it } from "vitest";
import { sessionTokenCookie, viewerSessionCookie } from "@/viewer-ticket";

/** The session-cookie filter every Worker session read (#208) and the repository read path (#234) use. */
describe("session cookie selection", () => {
  it.each(["", "__Secure-", "__Host-"])("keeps only the %s session token and its signed lifetime preference", prefix => {
    const token = `${prefix}better-auth.session_token=signed-token`;
    const preference = `${prefix}better-auth.dont_remember=signed-preference`;
    const header = `theme=dark; ${preference}; ${token}; better-auth.session_data=unused; __Secure-better-auth.session_data.0=unused; better-auth.dont_remember_extra=unused`;
    const filtered = `${token}; ${preference}`;
    expect(viewerSessionCookie(header)).toBe(filtered);
    expect(sessionTokenCookie(header)).toBe(token);
    expect(viewerSessionCookie(filtered)).toBe(filtered);
    for (const invalid of [preference, `${preference}; ${prefix}better-auth.session_token=`]) expect(viewerSessionCookie(invalid)).toBe("");
  });

  it("never forwards session data, unrelated cookies or bearer material", () => {
    expect(viewerSessionCookie("better-auth.session_data=cached; unrelated=value")).toBe("");
    expect(sessionTokenCookie("other=value; Authorization=Bearer rnd_live_x")).toBe("");
    expect(viewerSessionCookie("")).toBe("");
  });
});
