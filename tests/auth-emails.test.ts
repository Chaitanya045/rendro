import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAuthLinkEmail, sendExistingAccountNotice, sendOrganizationInvitationEmail } from "../convex/authEmails";

type Delivered = { to: string; subject: string; text: string; html: string; from: string };
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("AUTH_EMAIL_FROM", "Rendro <auth@example.test>");
  fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}", { status: 200 })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function delivered(): Delivered {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("https://api.resend.com/emails");
  expect(init?.method).toBe("POST");
  expect(init?.headers).toEqual({ Authorization: "Bearer re_test_key", "Content-Type": "application/json" });
  return JSON.parse(init?.body as string) as Delivered;
}

describe("authentication email delivery", () => {
  it.each([
    ["verification", "Verify your Rendro email", "Verify email", "Confirm this email address"],
    ["password-reset", "Reset your Rendro password", "Reset password", "choose a new Rendro password"],
  ] as const)("renders the %s message with an escaped HTML copy and the plain link in text", async (kind, subject, action, intro) => {
    await sendAuthLinkEmail(kind, { email: "ada@example.test", name: "  <b>Ada</b> & \"Co\" 'x'  " }, "https://rendro.test/v?a=1&b=<2>");
    const message = delivered();
    expect(message).toMatchObject({ to: "ada@example.test", subject, from: "Rendro <auth@example.test>" });
    expect(message.text).toContain(intro);
    expect(message.text).toContain("Hi <b>Ada</b> & \"Co\" 'x',");
    expect(message.text).toContain("\nhttps://rendro.test/v?a=1&b=<2>\n");
    expect(message.text).toContain("This link expires in one hour.");
    expect(message.html).toContain("<p>Hi &lt;b&gt;Ada&lt;/b&gt; &amp; &quot;Co&quot; &#39;x&#39;,</p>");
    expect(message.html).toContain(`<a href="https://rendro.test/v?a=1&amp;b=&lt;2&gt;">${action}</a>`);
    expect(message.html).not.toMatch(/<b>|<2>/);
  });

  it.each([undefined, null, "", "   "])("greets an unnamed user (%j) generically", async name => {
    await sendAuthLinkEmail("verification", { email: "anon@example.test", name }, "https://rendro.test/v");
    const message = delivered();
    expect(message.text.startsWith("Hi there,\n")).toBe(true);
    expect(message.html.startsWith("<p>Hi there,</p>")).toBe(true);
  });

  it("greets a user without a name property generically", async () => {
    await sendAuthLinkEmail("password-reset", { email: "anon@example.test" }, "https://rendro.test/r");
    expect(delivered().text.startsWith("Hi there,\n")).toBe(true);
  });

  it("sends the existing-account notice without revealing the account or exposing a link", async () => {
    await sendExistingAccountNotice({ email: "taken@example.test", name: "Taken" });
    const message = delivered();
    expect(message).toMatchObject({ to: "taken@example.test", subject: "A Rendro sign-up was requested" });
    expect(message.text).toContain("Your existing account was not changed.");
    expect(message.html).toContain("Your existing account was not changed.");
    expect(message.text + message.html).not.toMatch(/https?:|Taken/);
  });

  it("renders an organization invitation with escaped names and URL", async () => {
    await sendOrganizationInvitationEmail({
      email: "new@example.test", inviterName: " Grace <Hopper> ", organizationName: " R&D \"Lab\" ",
      invitationUrl: "https://rendro.test/accept?id=1&x=<y>",
    });
    const message = delivered();
    expect(message.to).toBe("new@example.test");
    expect(message.subject).toBe("Join R&D \"Lab\" on Rendro");
    expect(message.text).toBe("Grace <Hopper> invited you to join R&D \"Lab\" on Rendro.\n\nAccept the invitation:\nhttps://rendro.test/accept?id=1&x=<y>\n\nThis invitation expires in seven days.");
    expect(message.html).toBe("<p>Grace &lt;Hopper&gt; invited you to join <strong>R&amp;D &quot;Lab&quot;</strong> on Rendro.</p><p><a href=\"https://rendro.test/accept?id=1&amp;x=&lt;y&gt;\">Accept invitation</a></p><p>This invitation expires in seven days.</p>");
  });

  it("falls back to generic names for blank inviter and organization names", async () => {
    await sendOrganizationInvitationEmail({ email: "new@example.test", inviterName: "  ", organizationName: "", invitationUrl: "https://rendro.test/a" });
    const message = delivered();
    expect(message.subject).toBe("Join a Rendro organization on Rendro");
    expect(message.text.startsWith("A Rendro teammate invited you to join a Rendro organization on Rendro.")).toBe(true);
    expect(message.html).toContain("<strong>a Rendro organization</strong>");
  });

  it.each(["RESEND_API_KEY", "AUTH_EMAIL_FROM"])("fails closed without sending when %s is missing or blank", async name => {
    for (const value of ["", "   "]) {
      vi.stubEnv(name, value);
      await expect(sendExistingAccountNotice({ email: "a@example.test" })).rejects.toThrow(`${name} is required for authentication email delivery`);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports provider failures by status only, never echoing the response body or credentials", async () => {
    fetchMock.mockResolvedValueOnce(new Response("re_test_key leaked secret detail", { status: 422 }));
    const failure = await sendAuthLinkEmail("verification", { email: "a@example.test" }, "https://rendro.test/v").catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Authentication email delivery failed with status 422");
    // Validation rejections are permanent: no retry, and the body is never echoed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a throttled or transient provider failure and delivers once it succeeds", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    await sendExistingAccountNotice({ email: "a@example.test" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient transport failure and delivers once it succeeds", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    await sendAuthLinkEmail("verification", { email: "a@example.test" }, "https://rendro.test/v");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded retries when the transport keeps failing", async () => {
    const recorded = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await expect(sendExistingAccountNotice({ email: "a@example.test" })).rejects.toThrow("network down");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recorded).toHaveBeenCalledWith("Authentication email delivery failed", { attempts: 3 });
    recorded.mockRestore();
  });

  it("gives up after the bounded retries when the provider keeps failing", async () => {
    const recorded = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    await expect(sendAuthLinkEmail("password-reset", { email: "a@example.test" }, "https://rendro.test/v"))
      .rejects.toThrow("Authentication email delivery failed with status 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recorded).toHaveBeenCalledWith("Authentication email delivery failed", { attempts: 3 });
    recorded.mockRestore();
  });
});
