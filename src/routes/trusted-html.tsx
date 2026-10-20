import { raw } from "hono/html";
import type { JSXNode } from "hono/jsx";
import type { JSX } from "hono/jsx/jsx-runtime";
import type { StringBufferWithCallbacks } from "hono/utils/html";
import { requestNonce } from "@/middleware/html-nonce";

/*
 * The one module that writes text into a page without escaping it (#288). Every page renders through
 * Hono JSX, which escapes each string it is given; only two things pass through here unescaped:
 *
 * - the body of an inline <script> or <style>: code authored in this repository, never request or
 *   repository data. Data a script needs enters its body only as `scriptJson(value)`;
 * - a finished page, turned into the string a route sends.
 *
 * Lint (eslint.config.mjs) and tests/jsx-boundary.test.ts keep `raw` and `dangerouslySetInnerHTML` out
 * of every other module.
 */

type InlineCodeProps = { code: string; id?: string } & { [data: `data-${string}`]: string };

/** An inline script with the request's CSP nonce; `code` is source text from this repository. */
export function InlineScript({ code, ...attributes }: InlineCodeProps) {
  return <script nonce={requestNonce()} {...attributes}>{raw(code)}</script>;
}

/** An inline stylesheet with the request's CSP nonce; `code` is CSS from this repository. */
export function InlineStyle({ code, ...attributes }: InlineCodeProps) {
  return <style nonce={requestNonce()} {...attributes}>{raw(code)}</style>;
}

/** A JSON literal for a script body. `<` (so no `</script>` or `<!--`), U+2028 and U+2029 are escaped. */
export function scriptJson(value: object | string | null): string {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * A page (or a part of one) as the string a route sends. Hono's `toString()` also runs its React-style
 * document-metadata pass, which moves an async `<script src>` (and a `<link>`) outside `<head>` into it;
 * these pages place every element deliberately, so they render without that pass.
 */
export function renderHtml(page: JSX.Element | JSXNode, doctype = ""): string {
  const buffer: StringBufferWithCallbacks = Object.assign([""], { callbacks: [] });
  // A JSX expression is a JSXNode at runtime; its declared type is the rendered string. The metadata
  // pass is `buffer.callbacks`, never run. Only an async component would leave more than the one string.
  (page as unknown as JSXNode).toStringToBuffer(buffer);
  if (buffer.length > 1) throw new Error("Server pages render synchronously");
  return doctype + (buffer[0] as string);
}
