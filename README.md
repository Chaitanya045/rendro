# Rendro

Documentation hosting platform. Write docs as HTML, push via CLI, read them live with inline comments.

## Install the CLI

Requires Node.js 22 or newer. Use an explicit version for the project-based API:

```bash
npx --yes rendro@2.0.0 --version
# Or install this version globally:
npm install -g rendro@2.0.0
```

The legacy `rendro@1.0.0` uses `--org` / `--repo` and is not compatible with the
project-based commands below. The `latest` tag is independent of this explicit
version; do not use an unversioned install in CI. Verify server compatibility
before migrating an existing production workflow.

Build the current CLI from a trusted checkout:
```bash
pnpm install --frozen-lockfile
pnpm cli:build
node bin/rendro.mjs --help
```

## Quick Start

1. Sign in to your Rendro deployment. These examples target [dev.rendro.app](https://dev.rendro.app).
2. Create an organization and project, then create a project-scoped API key.
   Use the organization and project **IDs**, not their slugs, from onboarding.
3. Push your docs:
   ```bash
   # Set RENDRO_API_KEY securely in your environment; never commit it.
   npx --yes rendro@2.0.0 push --source ./docs \
     --organization <organization-id> --project <project-id> \
     --endpoint https://dev.rendro.app
   ```
4. From a trusted GitHub Actions workflow, keep the organization tree private or publish an uploaded folder at a stable public URL:
   ```bash
   npx --yes rendro@2.0.0 publication create \
     --organization <organization-id> --project <project-id> \
     --path product-docs --slug product --endpoint https://dev.rendro.app
   # https://dev.rendro.app/p/product
   ```

CI must use a pinned compatible CLI, a scoped repository secret, and trusted branch triggers. Never make
deployment credentials available to untrusted pull-request code. Use
`--endpoint https://dev.rendro.app` for disposable QA rather than production.

## Migrating from 1.x

- Create a project and scoped API key; use the organization and project IDs, not legacy slugs.
- Replace `--org` / `--repo` with `--organization` / `--project`, and specify the endpoint.
- Replace legacy publishing commands with `publication create`, `publication list`, and `publication remove`.
- Pushes activate immutable snapshots. Documents removed from the source are absent from the new snapshot; pinned publications retain their older snapshot.

## Features

- **Zero frontend** — raw HTML streamed from blob storage, no build step
- **Lazy tree** — VS Code-style sidebar, loads one level at a time
- **Inline comments** — select text, leave threaded comments (Convex real-time)
- **Dark mode** — matches system preference
- **CI/CD native** — hash-based diffing, uploads only changed files
- **Immutable deployments** — activation is atomic; pinned releases retain older documents
- **API key auth** — scoped credentials and explicit organization/project membership boundaries
- **Public folders** — explicitly publish one uploaded folder at a stable, anonymous read-only URL

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
