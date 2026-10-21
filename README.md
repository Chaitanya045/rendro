# Rendro

Rendro turns the Markdown in a GitHub repository into navigable documentation, with inline comments, for exactly the people who can read that repository. Nothing is uploaded and there is no separate permission model: a GitHub App's webhooks keep a rendered snapshot of each branch, and every page view follows the repository's own access.

> Status: the read path, ingest and permission mirror are built and tested; they are wired to production once the GitHub App exists. GitHub sign-in is built behind configuration (#338); until the App is registered, accounts use email and password.

## How it works

1. **Ingest.** A push to a repository the App is installed on reaches the ingest Worker. It fetches the commit, renders the Markdown with comrak (cmark-gfm lineage), sanitizes the HTML, highlights code, and writes an immutable snapshot to R2 with a full-text index in D1. Private repositories are sealed per repository at rest.
2. **Read.** `/r/{owner}/{repo}` serves the snapshot: a sidebar tree, search, and each page in a sandboxed frame. A signed capability cookie answers "may this reader see this repository" without calling GitHub or the database; a miss asks the control Worker, which mirrors GitHub's permissions.
3. **Revoke.** Removing a collaborator or an installation reaches the control Worker by webhook. It bumps the reader's revocation epoch, so every outstanding cookie and asset ticket stops working.
4. **Comment.** Select text and leave a threaded comment. Comments live in Convex, re-attach to their quote in later commits, and are readable and writable by exactly the people who can read the page.

## URLs

| URL | Serves |
|---|---|
| `/` | Landing page; a signed-in reader is redirected to `/home` |
| `/sign-in`, `/sign-up`, `/forgot-password`, `/account/security` | Email accounts |
| `/home` | The signed-in home: the account and how to open a repository |
| `/r/{owner}/{repo}` | The default branch's documentation; `/~{branch}` and `/@{commit}` select a branch or commit, `?doc=<path>` a page |

## Features

- **GitHub-backed access**: who can read the docs is who can read the repository
- **Document tree and search**: lazy sidebar with folders, and full-text search per repository
- **Inline comments**: anchored to text, real time through Convex, surviving later commits
- **Fast reads**: a cached page view verifies one HMAC and reads one epoch; frames are immutable at commit URLs
- **Private at rest**: per-repository AES-256-GCM sealing of private content, opened only after authorization
- **Theme**: system, dark and light modes

## Tech Stack

| Layer | Choice |
|---|---|
| Host | Three Cloudflare Workers (Hono): serving, ingest, control |
| Storage | R2 snapshots, D1 search, KV revocation epochs, Durable Objects for ingest coordination and the permission directory |
| Data | Convex: Better Auth identity, repository comments |
| Auth | Better Auth on Convex: email and password with verification (GitHub sign-in is next) |
| Rendering | comrak compiled to WebAssembly, a parse5 allowlist sanitizer, highlight.js |

## Development

See [docs/SETUP.md](docs/SETUP.md) for local development and deployment, [docs/TECHNICAL.md](docs/TECHNICAL.md) for the architecture, and [docs/BROWSER_TESTS.md](docs/BROWSER_TESTS.md) for the test layers.

## Contributing

Install dependencies with `pnpm install --frozen-lockfile`. Run the quality gates
with `VITEST_MAX_WORKERS=1 pnpm verify` (includes the Convex typecheck and browser
tests; install Chromium first with `pnpm exec playwright install chromium`).
`pnpm e2e` runs the end-to-end suite on workerd and a disposable local Convex, and
`pnpm coverage` the 100%-per-file coverage gate.

After changing Convex modules, schemas, or component functions, regenerate against
your configured **DEV** deployment in the ignored `.env.local`:

```bash
npx convex codegen
pnpm typecheck:convex
VITEST_MAX_WORKERS=1 pnpm verify:convex
git diff -- convex/_generated convex/betterAuth/_generated
```

Commit the exact output in both generated directories; do not edit bindings by
hand or commit `.env.local`. After committing, run `pnpm verify:convex:generated`
to regenerate and check both directories with `git diff --exit-code`.
This needs the DEV backend; codegen does not deploy application changes.

CI runs an offline drift guard through `pnpm verify`: both generated module
manifests must match the source tree, and the Better Auth component API must expose
exactly its public registered functions with the correct query/mutation/action
kinds. Internal component functions stay inside the component. The guard detects
missing, removed, or renamed modules/functions and visibility changes; it does not
replace full codegen for validator, argument, return-type, or formatting changes.

Full component codegen needs an authenticated backend to analyze the component
graph ([Convex CLI docs](https://docs.convex.dev/cli/overview#update-generated-code)).
In the pinned Convex 1.42.0 CLI, `--typecheck disable` only skips the typecheck;
the hidden `--system-udfs` option generates standalone bindings without the
component graph and cannot reproduce these files. An
[anonymous local backend](https://docs.convex.dev/cli/local-deployments) can avoid
cloud credentials, but requires downloading, provisioning, and configuring a
backend (the documented setup uses `convex dev`), not just an offline codegen flag.
Untrusted PR CI therefore uses the offline guard without deployment credentials.

## Limits

Ingest renders Markdown files of up to 1 MiB each; larger or pathological sources
are not rendered (`too-large`) rather than slowing the snapshot (see
[Repository Content Ingest](docs/TECHNICAL.md#repository-content-ingest-github-pivot-p3a)).
Each reader may create 30 comments and replies a minute, and each repository ten
times that; a rejected write is reported with the time to wait, and drafts are kept.
Other JSON and form requests are limited to 64 KiB (HTTP 413 beyond).

## License

MIT
