/// <reference lib="es2024.string" />
// Server-side text limits. Lengths count UTF-16 code units of the trimmed value, like the forms' maxlength attributes.
// Project names and slugs, API key names and publication slugs are enforced where they are stored.
export const DISPLAY_NAME_MAX_LENGTH = 80; // organization and team names
export const PUBLICATION_TITLE_MAX_LENGTH = 100;
export const PUBLICATION_DESCRIPTION_MAX_LENGTH = 500;

// A JSON escape such as "\ud800" decodes to a lone UTF-16 surrogate. Such a string cannot be stored or encoded as
// UTF-8, so the backend refuses it with an opaque failure. Rejecting it at the request boundary turns that outage
// into a normal client error. Raw UTF-8 bytes can never decode to a lone surrogate (the decoder substitutes U+FFFD),
// so the escape sequence is the only way in; query strings and path segments are normalized by the URL parser.
export const INVALID_TEXT_MESSAGE = "Request text must be well-formed Unicode";

export class IllFormedTextError extends Error {
  constructor() { super(INVALID_TEXT_MESSAGE); }
  response(): Response { return Response.json({ error: this.message }, { status: 400 }); }
}

// Cheap gate: any ill-formed string needs a surrogate escape (\uD800-\uDFFF), so most bodies are never parsed.
const surrogateEscape = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** True if the value, any object key, or any nested string is not well-formed UTF-16. Iterative, so depth is free. */
export function hasIllFormedText(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (!current.isWellFormed()) return true;
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current !== null && typeof current === "object") {
      for (const [key, nested] of Object.entries(current)) {
        if (!key.isWellFormed()) return true;
        pending.push(nested);
      }
    }
  }
  return false;
}

/** Text that is not valid JSON is left for the handler's own parse error. */
export function jsonTextHasIllFormedText(text: string): boolean {
  if (!surrogateEscape.test(text)) return false;
  try { return hasIllFormedText(JSON.parse(text)); } catch { return false; }
}

/** Body admission for JSON writes: throws IllFormedTextError without consuming the caller's request. */
export async function requireWellFormedBody(request: Request): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) return;
  if (jsonTextHasIllFormedText(await request.clone().text())) throw new IllFormedTextError();
}
