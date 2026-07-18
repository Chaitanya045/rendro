# Rendro

Documentation hosting platform. Write docs as HTML, push via CLI, read them live with inline comments.

## Install the CLI

**Option A — npm:**
```bash
npx rendro push --source ./docs --org my-org --repo my-repo
# or install globally
npm install -g rendro
rendro push --source ./docs --org my-org --repo my-repo
```

**Option B — direct download (no install):**
```bash
curl -sL https://raw.githubusercontent.com/Chaitanya045/rendro/main/bin/rendro.mjs -o rendro
chmod +x rendro
./rendro push --source ./docs --org my-org --repo my-repo --endpoint https://rendro.app
```

## Quick Start

1. Sign in at [rendro.app](https://rendro.app) with Google
2. Create your org — you'll get an API key
3. Push your docs:
   ```bash
   export RENDRO_API_KEY=rendro_xxx
   rendro push --source ./docs --org my-org --repo my-repo --endpoint https://rendro.app
   ```
4. View live at `https://rendro.app`

## Features

- **Zero frontend** — raw HTML streamed from blob storage, no build step
- **Lazy tree** — VS Code-style sidebar, loads one level at a time
- **Inline comments** — select text, leave threaded comments (Convex real-time)
- **Dark mode** — matches system preference
- **CI/CD native** — hash-based diffing, uploads only changed files
- **Soft-delete** — removed files hidden from tree, still accessible via URL
- **Multi-repo orgs** — use `--repo <slug>` to isolate each repo under `<org>/<repo>/`; sync deletes only touch that repo prefix
- **API key auth** — per-org keys, org isolation by email domain

## Tech Stack

| Layer | Choice |
|---|---|
| Host | Cloudflare Workers |
| Storage | Cloudflare R2 |
| Auth | Convex + better-auth + Google OAuth |
| Comments | Convex |
| CLI | Node.js (zero dependencies) |

## License

MIT
