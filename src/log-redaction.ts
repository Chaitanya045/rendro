const credentials = [
  "authorization", "cookie", "set-cookie", "password", "newPassword", "currentPassword",
  "token", "accessToken", "refreshToken", "idToken", "sessionToken", "apiKey", "secret",
  "rawKey", "key", "credential", "credentials", "clientSecret", "ticket", "viewerTicket", "shareToken", "resetToken", "verificationToken",
  "invitationToken", "invitationId", "internalSecret",
];
const sensitiveNames = new Set(credentials.map(name => name.replace(/[-_]/g, "").toLowerCase()));
const diagnosticName = /(?:url|uri|path|query|search|headers|body|message|stack|cause)$/;
const redacted = "[redacted]";

// Names, messages, stacks, causes and custom exception properties are untrusted.
function errorCategory(error: unknown): string {
  // Sanitized child bindings and already-serialized errors retain a fixed category.
  if (error && typeof error === "object" && "category" in error
    && (error.category === "TypeError" || error.category === "RangeError")) return error.category;
  return error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : "Error";
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) return { category: errorCategory(value) };
  if (typeof value === "function") return redacted;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return redacted;
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const name = key.replace(/[-_]/g, "").toLowerCase();
    if (name === "msg" || sensitiveNames.has(name) || /password|secret|token|ticket|credential|apikey|authorization|cookie/.test(name) || diagnosticName.test(name)) return [key, redacted];
    if (name === "err" || name === "error") return [key, { category: errorCategory(item) }];
    if (name === "errortype") return [key, typeof item === "string" && ["TypeError", "RangeError"].includes(item) ? item : "Error"];
    return [key, sanitize(item, seen)];
  }));
}

// This runs before either Pino implementation sees a record or serializes errors.
export function sanitizeLogFields(value: unknown): Record<string, unknown> {
  return sanitize(value, new WeakSet()) as Record<string, unknown>;
}
