import { afterEach, describe, expect, it, vi } from "vitest";
import { createLegacyViewerTicket, readLegacyViewerTicket, createViewerTicket, readViewerTicket, viewerSessionCookie, sessionTokenCookie, VIEWER_TICKET_SECONDS } from "@/viewer-ticket";

const scope = { organizationId: "org-a", projectId: "project-a", manifestKey: "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json" };
const cookie = "__Secure-better-auth.session_token=private-session-material";
afterEach(() => { vi.useRealTimers(); });

describe("encrypted private viewer capabilities", () => {
  it.each(["", "__Secure-"])("retains the %s signed lifetime preference through both ticket kinds", async prefix => {
    const token = `${prefix}better-auth.session_token=signed-token`;
    const preference = `${prefix}better-auth.dont_remember=signed-preference`;
    const header = `theme=dark; ${preference}; ${token}; better-auth.session_data=unused; __Secure-better-auth.session_data.0=unused; better-auth.dont_remember_extra=unused`;
    const filtered = `${token}; ${preference}`;
    expect(viewerSessionCookie(header)).toBe(filtered);
    expect(sessionTokenCookie(header)).toBe(token);
    expect(viewerSessionCookie(filtered)).toBe(filtered);
    expect(await readViewerTicket(await createViewerTicket({ ...scope, cookie: header }), scope)).toEqual({ ...scope, cookie: filtered });
    expect(await readLegacyViewerTicket(await createLegacyViewerTicket("example", header), "example")).toEqual({ cookie: filtered, storagePrefix: "example/" });
    for (const invalid of [preference, `${preference}; ${prefix}better-auth.session_token=`]) {
      expect(viewerSessionCookie(invalid)).toBe("");
      await expect(createViewerTicket({ ...scope, cookie: invalid })).rejects.toThrow("Viewer session required");
      await expect(createLegacyViewerTicket("example", invalid)).rejects.toThrow("Viewer session required");
    }
  });

  it("round trips scope and only the session token, without readable session material", async () => {
    const token = await createViewerTicket({ ...scope, cookie: `${cookie}; other=secret; better-auth.session_data=cache` });
    expect(token.split(".")).toHaveLength(5);
    expect(token).not.toContain("private-session-material");
    for (const segment of token.split(".")) {
      expect(Buffer.from(segment, "base64url").toString()).not.toContain("private-session-material");
    }
    expect(await readViewerTicket(token, scope)).toEqual({ ...scope, cookie });
    expect(viewerSessionCookie("better-auth.session_data=cached; unrelated=value")).toBe("");
    await expect(createViewerTicket({ ...scope, cookie: "other=value" })).rejects.toThrow("Viewer session required");
  });

  it("rejects tampering, malformed input, and org/project substitutions", async () => {
    const token = await createViewerTicket({ ...scope, cookie });
    const parts = token.split(".");
    parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
    expect(await readViewerTicket(parts.join("."), scope)).toBeNull();
    expect(await readViewerTicket("not-a-ticket", scope)).toBeNull();
    expect(await readViewerTicket(token, { ...scope, organizationId: "org-b" })).toBeNull();
    expect(await readViewerTicket(token, { ...scope, projectId: "project-b" })).toBeNull();
  });

  it("expires at fifteen minutes, even if the underlying session is valid", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-10-10T00:00:00Z");
    vi.setSystemTime(start);
    const token = await createViewerTicket({ ...scope, cookie });
    vi.setSystemTime(start.getTime() + VIEWER_TICKET_SECONDS * 1000 - 1000);
    expect(await readViewerTicket(token, scope)).not.toBeNull();
    vi.setSystemTime(start.getTime() + VIEWER_TICKET_SECONDS * 1000);
    expect(await readViewerTicket(token, scope)).toBeNull();
  });

});
