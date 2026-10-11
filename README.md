# Rendro

Documentation hosting platform. Write docs as HTML, push via CLI, read them live with inline comments.

## Install the CLI

Requires Node.js 22 or newer. Use an explicit version for the project-based API:

```bash
npx --yes rendro@2.0.0 --version
# Or install this version globally:
npm install -g rendro@2.0.0
```

The CLI has no runtime dependencies. The `latest` tag is independent of this
explicit version; do not use an unversioned install in CI. If you are upgrading
from 1.x, see [Migrating from 1.x](#migrating-from-1x).

Build the current CLI from a trusted checkout:
```bash
pnpm install --frozen-lockfile
pnpm cli:build
node bin/rendro.mjs --help
```

## Quick Start

1. Sign in to your Rendro deployment. These examples target [dev.rendro.app](https://dev.rendro.app).
2. Create an organization and project, then create an API key scoped to that project.
   Use the organization and project **IDs**, not their slugs, from onboarding.
3. Optionally scaffold a docs folder:
   ```bash
   npx --yes rendro@2.0.0 init --source ./docs
   ```
4. Push your docs:
   ```bash
   # Set RENDRO_API_KEY securely in your environment; never commit it.
   npx --yes rendro@2.0.0 push --source ./docs \
     --organization <organization-id> --project <project-id> \
     --endpoint https://dev.rendro.app
   ```
5. From a trusted GitHub Actions workflow, keep the project private or publish an uploaded folder at a stable public URL:
   ```bash
   npx --yes rendro@2.0.0 publication create \
     --organization <organization-id> --project <project-id> \
     --path product-docs --slug product --endpoint https://dev.rendro.app
   # https://dev.rendro.app/p/product
   ```

CI must use a pinned compatible CLI, a scoped repository secret, and trusted branch triggers. Never make
deployment credentials available to untrusted pull-request code. Use
`--endpoint https://dev.rendro.app` for disposable QA rather than production.

## Commands

| Command | Purpose |
|---|---|
| `rendro init --source <dir>` | Create `<dir>/index.html` plus empty `onboarding/`, `api/`, and `engineering/` folders |
| `rendro push --source <dir> --organization <id> --project <id>` | Upload a new immutable deployment and activate it |
| `rendro publication create --organization <id> --project <id> --slug <slug>` | Publish a folder of the project at `/p/<slug>` |
| `rendro publication list --organization <id> --project <id>` | List the project's publications |
| `rendro publication remove --organization <id> --project <id> --id <publication-id>` | Remove a publication |
| `rendro --version` | Print the CLI version |

| Option | Applies to | Default |
|---|---|---|
| `--source <dir>` | `init`, `push` | `./docs` |
| `--endpoint <url>` | `push`, `publication` | `https://rendro.app` |
| `--concurrency <n>` | `push` | `8` parallel uploads |
| `--path <prefix>` | `publication create` | Deployment root |
| `--entry <file>` | `publication create` | `index.html` (relative to `--path`) |
| `--title <title>` | `publication create` | The slug |
| `--pin <deployment-id>` | `publication create` | Track the active deployment |

`push` and `publication` read the API key from `RENDRO_API_KEY`.

### API key scopes

Organization owners and admins create keys on the organization's API keys page. A key can be limited to one project and given an expiry. The secret is shown once.

| Command | Required scopes |
|---|---|
| `push` | `docs:read`, `docs:write` |
| `publication create` | `docs:read`, `publications:write` |
| `publication list` | `publications:read` |
| `publication remove` | `publications:write` |

### How push works

The CLI walks the source folder (skipping dot-folders and `node_modules`), computes a SHA-256 manifest, and compares it with the active deployment. Unchanged files are copied server-side from the active deployment; only changed files are uploaded. The new deployment becomes active only after every file in the manifest is present. If a copy, upload, or commit fails, the CLI marks the new deployment failed and the previous deployment stays active.

A publication created without `--pin` follows the project's active deployment. With `--pin`, it keeps serving that deployment after later pushes.

## Migrating from 1.x

The legacy `rendro@1.0.0` uses `--org` / `--repo` and is not compatible with the
project-based commands above. Verify server compatibility before migrating an
existing production workflow.

- Create a project and scoped API key; use the organization and project IDs, not legacy slugs.
- Replace `--org` / `--repo` with `--organization` / `--project`, and specify the endpoint.
- Replace legacy publishing commands with `publication create`, `publication list`, and `publication remove`.
- Pushes activate immutable snapshots. Documents removed from the source are absent from the new snapshot; pinned publications retain their older snapshot.

## Features

- **Zero frontend** — publisher HTML is served as uploaded, with no build step
- **Document tree** — sidebar tree with collapsible folders
- **Inline comments** — select text, leave threaded comments (Convex real-time)
- **Theme** — system, dark, and light modes for the Rendro interface
- **CI/CD native** — SHA-256 manifests; only changed files are uploaded
- **Immutable deployments** — activation is atomic; pinned publications retain older deployments
- **Scoped API keys** — explicit scopes, optional project binding and expiry
- **Public folders** — explicitly publish one uploaded folder at a stable, anonymous read-only URL
- **Private shares** — revocable, expiring links to a single document

## Tech Stack

| Layer | Choice |
|---|---|
| Host | Cloudflare Workers (Hono) |
| Document storage | Cloudflare R2 (S3 API) |
| Metadata | Convex (projects, deployments, publications, shares, API keys, comments) |
| Auth | Better Auth on Convex: Google OAuth or email/password with email verification; organizations and teams |
| CLI | Node.js 22+ (zero runtime dependencies) |

## Contributing

Install dependencies with `pnpm install --frozen-lockfile`. Run the quality gates
with `VITEST_MAX_WORKERS=1 pnpm verify` (includes the Convex typecheck and browser
tests; install Chromium first with `pnpm exec playwright install chromium`).

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

## License

MIT
