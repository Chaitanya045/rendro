# Docsync — Product

Docsync is a documentation hosting platform that turns HTML files into a live, searchable knowledge base. Teams write docs as plain HTML in their code repos, push via CLI, and Docsync serves them instantly with a VS Code-style sidebar tree, inline comments, and full-text search.

## How It Works

1. **Write docs** — plain HTML files in your repo's `docs/` folder
2. **Push via CLI** — `docsync push --source ./docs --org my-org` uploads to blob storage
3. **Read live** — visit `example.com/my-org`, sign in with Google, browse your docs
4. **Comment inline** — select any text on a doc page, leave threaded comments

## Key Features

- **Zero frontend code** — docs are raw HTML streamed directly from blob storage. No build step, no framework lock-in.
- **Lazy tree** — sidebar tree loads one level at a time. Folders expand on click. Infinite scroll for large folders.
- **VS Code-style UX** — depth-indented tree, sticky folder headers, smooth animations, dark mode.
- **Cross-doc navigation** — click a link in one doc, the tree follows and expands to show your location.
- **Inline comments** — select text, leave comments. Threaded, real-time, stored in Convex.
- **CI/CD native** — `docsync push` detects changed files via hash comparison. Uploads only what changed. Under 40 seconds from push to live.
- **Soft-delete** — removed files stay accessible via direct URL. Hidden from tree listing.
- **API key auth** — per-org API keys for the CLI. Org isolation by email domain.
- **Infinite scroll** — paginated tree API. Large folders load in pages of 50.

## Tech Stack

| Layer | Choice |
|---|---|
| Server | Hono (Node.js) |
| Storage | MinIO (S3-compatible) |
| Auth | better-auth + Google OAuth |
| Comments | Convex |
| CLI | Node.js (esbuild bundle) |
| Tree | Vanilla JS (8KB IIFE) |
| Styling | Inline CSS + Tailwind CDN |

## License

MIT
