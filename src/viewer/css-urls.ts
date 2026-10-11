import {
  isTokenAtKeyword, isTokenFunction, isTokenString, isTokenURL,
  isTokenWhiteSpaceOrComment, tokenize, type CSSToken,
} from "@csstools/css-tokenizer";

/** Rewrite URL values, preserving all other publisher CSS (including comments). */
export function rewriteCssUrls(css: string, replace: (url: string) => string): string {
  let previous: CSSToken | undefined;
  return tokenize({ css }).map(token => {
    const isUrl = isTokenURL(token);
    const isUrlString = isTokenString(token) && (
      (isTokenFunction(previous) && previous[4].value.toLowerCase() === "url")
      || (isTokenAtKeyword(previous) && previous[4].value.toLowerCase() === "import")
    );
    let text = token[1];
    if (isUrl || isUrlString) {
      // The tokenizer decodes CSS escapes, including escaped function names,
      // parentheses and hex escapes. Strings/comments containing url() aren't URLs.
      const value = token[4].value;
      const replacement = replace(value);
      if (replacement !== value) {
        const quoted = '"' + Array.from(replacement, char => {
          const code = char.charCodeAt(0);
          return char === '"' || char === "\\" || code < 32 || code === 127
            ? `\\${code.toString(16)} ` : char;
        }).join("") + '"';
        text = isUrl ? `url(${quoted})` : quoted;
      }
    }
    if (!isTokenWhiteSpaceOrComment(token)) previous = token;
    return text;
  }).join("");
}
