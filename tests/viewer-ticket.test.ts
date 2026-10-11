import { afterEach, describe, expect, it, vi } from "vitest";
import { createViewerTicket, readViewerTicket, viewerSessionCookie, VIEWER_TICKET_SECONDS } from "@/viewer-ticket";
import { redactViewerPath } from "@/viewer-log";

const scope = { organizationId: "org-a", projectId: "project-a", manifestKey: "deploy-a/manifest.json" };
const cookie = "__Secure-better-auth.session_token=private-session-material";
afterEach(() => { vi.useRealTimers(); });

describe("encrypted private viewer capabilities", () => {
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

  it("redacts tickets from both successful and malformed request paths", () => {
    expect(redactViewerPath("/organizations/a/projects/b/docs/view/ciphertext/files/site.css"))
      .toBe("/organizations/a/projects/b/docs/view/[redacted]/files/site.css");
    expect(redactViewerPath("/docs/view/malformed" )).toBe("/docs/view/[redacted]");
    expect(redactViewerPath("/legacy-view/example/view/ciphertext/files/site.css")).toBe("/legacy-view/example/view/[redacted]/files/site.css");
    expect(redactViewerPath("/docs/files/index.html")).toBe("/docs/files/index.html");
  });
});
