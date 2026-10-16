import type { LoggerOptions } from "pino";

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
  // A second pass over Pino's serialized output retains only our fixed category.
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
    if (sensitiveNames.has(name) || /password|secret|token|ticket|credential|apikey|authorization|cookie/.test(name) || diagnosticName.test(name)) return [key, redacted];
    if (name === "err" || name === "error") return [key, { category: errorCategory(item) }];
    if (name === "errortype") return [key, typeof item === "string" && ["TypeError", "RangeError"].includes(item) ? item : "Error"];
    return [key, sanitize(item, seen)];
  }));
}

export const logRedaction: Pick<LoggerOptions, "redact" | "formatters" | "hooks"> = {
  // Pino also applies these paths to child bindings. The input hook handles
  // arbitrary nesting/casing and strips URL-bearing diagnostics before serialization.
  redact: { paths: credentials.flatMap(name => [`["${name}"]`, `*["${name}"]`, `*.*["${name}"]`]), censor: redacted },
  // Pino resets binding formatters on child(); scrub the final record as well
  // so child bindings cannot bypass the recursive policy.
  hooks: {
    logMethod(args, method) {
      // Scrub before Pino derives a default message from an Error/err argument.
      if (args[0] !== null && typeof args[0] === "object") args[0] = sanitize(args[0], new WeakSet());
      method.apply(this, args);
    },
    streamWrite: line => JSON.stringify(sanitize(JSON.parse(line), new WeakSet())) + "\n",
  },
  formatters: {
    bindings: bindings => sanitize(bindings, new WeakSet()) as Record<string, unknown>,
  },
};
