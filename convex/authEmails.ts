type AuthEmailUser = {
  email: string;
  name?: string | null;
};

type AuthEmailKind = "verification" | "password-reset";

// Transport errors and provider outages (5xx, throttling) are usually momentary;
// Better Auth swallows send failures, so a single lost attempt would otherwise
// silently leave the user with nothing to verify. Convex functions have no
// timers, so the bounded retries are immediate.
const DELIVERY_ATTEMPTS = 3;

function retryableDeliveryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

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
  const authorization = `Bearer ${requiredEmailEnv("RESEND_API_KEY")}`;
  const from = requiredEmailEnv("AUTH_EMAIL_FROM");
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          ...message,
        }),
      });
      if (response.ok) return;
      lastError = new Error(`Authentication email delivery failed with status ${response.status}`);
      // Non-retryable provider rejections (validation, authentication) are permanent.
      if (!retryableDeliveryStatus(response.status)) break;
    } catch (error) {
      lastError = error;
    }
  }
  // Better Auth discards send errors without recording them; keep the failure diagnosable.
  console.error("Authentication email delivery failed", { attempts: DELIVERY_ATTEMPTS });
  throw lastError;
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
