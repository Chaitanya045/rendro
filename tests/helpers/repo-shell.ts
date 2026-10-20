import { renderScopedDocumentShell, type ScopedDocumentShellOptions } from "../../src/routes/app";

/** The repository docs shell (`/r/acme/docs`) as the read path renders it, with test overrides. */
export function repoShell(overrides: Partial<ScopedDocumentShellOptions> = {}): string {
  return renderScopedDocumentShell({
    namespace: "docs", title: "acme/docs", basePath: "/r/acme/docs", frameBase: "/r/acme/docs", selectedPath: "index.html",
    repoCommentConfig: { repoId: 9101, accessUrl: "/r/acme/docs/comment-access", convexUrl: "" },
    ...overrides,
  });
}
