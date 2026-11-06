import { readFileSync } from "node:fs";
import { shellScript } from "../../src/shell/shell-script";
import { renderScopedDocumentShell, type ScopedDocumentShellOptions } from "../../src/routes/app";

/** The repository docs shell (`/r/acme/docs`) as the read path renders it, with test overrides. */
export function repoShell(overrides: Partial<ScopedDocumentShellOptions> = {}): string {
  return renderScopedDocumentShell({
    namespace: "docs", title: "acme/docs", basePath: "/r/acme/docs", frameBase: "/r/acme/docs", selectedPath: "index.html",
    repoCommentConfig: { repoId: 9101, accessUrl: "/r/acme/docs/comment-access", convexUrl: "" },
    ...overrides,
  });
}

/** The shell's behaviour as `/shell.js` serves it (minified there; the readable source behaves the same). */
export const shellAsset: readonly [string, string] = ["/shell.js", shellScript];

/** The shell's own stylesheet (a hashed same-origin file since #359), as authored. */
export const shellCss = (): string => readFileSync("src/styles/shell.css", "utf8");
