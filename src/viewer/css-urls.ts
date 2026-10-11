import {
  isTokenAtKeyword, isTokenFunction, isTokenString, isTokenURL,
  isTokenWhiteSpaceOrComment, tokenize, TokenType, type CSSToken,
} from "@csstools/css-tokenizer";

/** Rewrite URL values, preserving all other publisher CSS (including comments). */
export function rewriteCssUrls(css: string, replace: (url: string) => string): string {
  let previous: CSSToken | undefined;
  const contexts: Array<{ close: TokenType; name?: string }> = [];
  return tokenize({ css }).map(token => {
    const isUrl = isTokenURL(token);
    const isUrlString = isTokenString(token) && (
      (isTokenFunction(previous) && ["url", "src"].includes(previous[4].value.toLowerCase()))
      || ["image-set", "-webkit-image-set"].includes(contexts.at(-1)?.name ?? "")
      || (isTokenAtKeyword(previous) && previous[4].value.toLowerCase() === "import")
    );
    let text = token[1];
    if (isUrl || isUrlString) {
      // The tokenizer decodes CSS escapes, including escaped function names,
      // parentheses and hex escapes. Strings/comments containing url() aren't URLs.
      const value = token[4].value;
      const replacement = value.trimStart().startsWith("#") ? value : replace(value);
      if (replacement !== value) {
        const quoted = '"' + Array.from(replacement, char => {
          const code = char.charCodeAt(0);
          return char === '"' || char === "\\" || code < 32 || code === 127
            ? `\\${code.toString(16)} ` : char;
        }).join("") + '"';
        text = isUrl ? `url(${quoted})` : quoted;
      }
    }
    // Only direct string children of image-set are candidates. Strings inside
    // type(), var(), or other nested functions/blocks retain their own meaning.
    if (isTokenFunction(token)) contexts.push({ close: TokenType.CloseParen, name: token[4].value.toLowerCase() });
    else if (token[0] === TokenType.OpenParen) contexts.push({ close: TokenType.CloseParen });
    else if (token[0] === TokenType.OpenSquare) contexts.push({ close: TokenType.CloseSquare });
    else if (token[0] === TokenType.OpenCurly) contexts.push({ close: TokenType.CloseCurly });
    else if (token[0] === contexts.at(-1)?.close) contexts.pop();
    if (!isTokenWhiteSpaceOrComment(token)) previous = token;
    return text;
  }).join("");
}

/** Detect decoded at-keywords, including escaped/case-insensitive imports. */
export function hasCssImports(css: string): boolean {
  return tokenize({ css }).some(token => isTokenAtKeyword(token) && token[4].value.toLowerCase() === "import");
}
