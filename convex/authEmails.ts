type AuthEmailUser = {
  email: string;
  name?: string | null;
};

type AuthEmailKind = "verification" | "password-reset";

function requiredEmailEnv(name: "RESEND_API_KEY" | "AUTH_EMAIL_FROM"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for authentication email delivery`);
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function deliverEmail(message: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEmailEnv("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: requiredEmailEnv("AUTH_EMAIL_FROM"),
      ...message,
    }),
  });
  if (!response.ok) {
    throw new Error(`Authentication email delivery failed with status ${response.status}`);
  }
}

export async function sendAuthLinkEmail(
  kind: AuthEmailKind,
  user: AuthEmailUser,
  url: string,
): Promise<void> {
  const verification = kind === "verification";
  const subject = verification ? "Verify your Rendro email" : "Reset your Rendro password";
  const action = verification ? "Verify email" : "Reset password";
  const intro = verification
    ? "Confirm this email address to finish setting up your Rendro account."
    : "Use this link to choose a new Rendro password. If you did not request a reset, you can ignore this email.";
  const safeName = escapeHtml(user.name?.trim() || "there");
  const safeUrl = escapeHtml(url);
  await deliverEmail({
    to: user.email,
    subject,
    text: `Hi ${user.name?.trim() || "there"},\n\n${intro}\n\n${url}\n\nThis link expires in one hour.`,
    html: `<p>Hi ${safeName},</p><p>${escapeHtml(intro)}</p><p><a href="${safeUrl}">${action}</a></p><p>This link expires in one hour.</p>`,
  });
}

export async function sendExistingAccountNotice(user: AuthEmailUser): Promise<void> {
  await deliverEmail({
    to: user.email,
    subject: "A Rendro sign-up was requested",
    text: "A sign-up was requested for this email address. Your existing account was not changed. If this was you, sign in or request a password reset.",
    html: "<p>A sign-up was requested for this email address.</p><p>Your existing account was not changed. If this was you, sign in or request a password reset.</p>",
  });
}

export async function sendOrganizationInvitationEmail(input: {
  email: string;
  inviterName: string;
  organizationName: string;
  invitationUrl: string;
}): Promise<void> {
  const inviterName = input.inviterName.trim() || "A Rendro teammate";
  const organizationName = input.organizationName.trim() || "a Rendro organization";
  await deliverEmail({
    to: input.email,
    subject: `Join ${organizationName} on Rendro`,
    text: `${inviterName} invited you to join ${organizationName} on Rendro.\n\nAccept the invitation:\n${input.invitationUrl}\n\nThis invitation expires in seven days.`,
    html: `<p>${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(organizationName)}</strong> on Rendro.</p><p><a href="${escapeHtml(input.invitationUrl)}">Accept invitation</a></p><p>This invitation expires in seven days.</p>`,
  });
}
