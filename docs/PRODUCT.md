# Rendro — Product

Documentation hosting platform. Write docs as HTML, push via CLI, read live with inline comments.

## What is Rendro?

Rendro turns static HTML files into a live, searchable knowledge base. Teams write docs as plain HTML in their code repos, push via CLI or CI, and Rendro serves them instantly with a VS Code-style sidebar tree, inline comments, and dark mode.

It's the alternative to Confluence or Notion for teams that want docs version-controlled alongside code, edited as plain HTML, and deployed in seconds — not via a clunky editor.

## How It Works

1. **Write docs** — plain HTML files in your repo's `docs/` folder
2. **Push via CLI** — `rendro push --source ./docs --org my-org` uploads to R2 blob storage
3. **Read live** — visit `rendro.app`, sign in with Google, browse your docs
4. **Comment inline** — select any text on a doc page, leave threaded comments

## The visitor experience

1. Visit `rendro.app` — see "Sign in with Google" button
2. Sign in with Google (`alice@acme-corp.com`). Org is derived from email domain (`acme-corp`)
3. If docs exist: see tree with HTML files. Folders expand on click, docs load in iframe
4. If no docs: see "Create your org" form
5. Click a file — raw HTML renders with commentor widget injected

Cross-org isolation: users from `acme-corp.com` only see `acme-corp/` docs.

## The publisher experience

1. Put HTML files in your repo's `docs/` folder
2. Push to CI: `rendro push --source ./docs --org my-org`
3. CLI walks files, MD5-hashes each, uploads only changed files
4. Done — docs live within seconds

No login required for CLI — API keys authenticate per-org operations.

## Key Features

- **Zero frontend code** — raw HTML streamed from R2, no build step
- **Lazy tree** — sidebar loads one level at a time, infinite scroll for large folders
- **Inline comments** — select text, leave threaded comments (Convex real-time)
- **Dark mode** — matches system preference, shared with commentor widget
- **CI/CD native** — hash-based diffing, uploads only changed files
- **Soft-delete** — removed files hidden from tree, accessible via URL
- **API key auth** — per-org keys, org isolation by email domain
- **Cross-doc navigation** — links between docs sync the tree + browser history
- **Sticky headers** — VS Code-style folder headers during scroll
- **Share button** — copy doc URL with toast notification

## Tech Stack

| Layer | Choice |
|---|---|
| Host | Cloudflare Workers |
| Storage | Cloudflare R2 |
| Auth | Convex + better-auth + Google OAuth |
| Comments | Convex |
| CLI | Node.js (zero dependencies) |

## What Rendro is not

- **Not a CMS** — no rich text editor, no media library
- **Not a wiki** — no cross-linking engine, no built-in search
- **Not multi-user editing** — last push wins, use git for conflict resolution

## Org model

The email domain IS the org. No per-org config, no dashboard setup, no workos configuration:
- `alice@acme-corp.com` → org `acme-corp`
- `bob@startup.io` → org `startup-io`

First user from a domain creates the org. Subsequent users see existing docs.
