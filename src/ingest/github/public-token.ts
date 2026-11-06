/**
 * Rendro's own credential for reading public repositories (#354). Any signed-in
 * reader may open the docs of a public repository the App is not installed on,
 * and GitHub is asked about it with, in order:
 *
 * 1. the reader's GitHub App user-to-server token (control Worker only: user
 *    tokens never leave it), and
 * 2. this token, when GitHub refuses the user token for a repository without an
 *    installation. GitHub's documentation contradicts itself on whether a user
 *    token may read such a repository, so the fallback is the safe bet. This
 *    needs a live check once the App is registered ([SETUP.md]).
 *
 * The same token reads those repositories' branch heads and content for ingest
 * and for the reconciliation cron, where there is no reader. It is
 * public-read only: a fine-grained personal access token with "Public
 * repositories (read-only)" access, or a classic one with no scopes, owned by a
 * Rendro service account. It never sees a private repository, so a leak costs
 * nothing a public search would not.
 */
export interface PublicReadTokens {
  /** The token, or null where none is configured (a refused user token then ends the lookup). */
  token(): string | null;
}

const TOKEN_FORMAT = /^[\w.-]{1,512}$/;

/** `GITHUB_PUBLIC_READ_TOKEN`; an unset or malformed value is no token. */
export function publicReadTokens(value: string | undefined): PublicReadTokens {
  const token = value !== undefined && TOKEN_FORMAT.test(value) ? value : null;
  return { token: () => token };
}
