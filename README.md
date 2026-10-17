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
| `rendro push --source <dir> --organization <id> --project <id>` | Upload filtered source files as a new immutable deployment and activate it |
| `rendro publication create --organization <id> --project <id> --slug <slug>` | Publish a folder of the project at `/p/<slug>` |
| `rendro publication list --organization <id> --project <id>` | List the project's publications |
| `rendro publication remove --organization <id> --project <id> --id <publication-id>` | Remove a publication |
| `rendro --version` | Print the CLI version |

| Option | Applies to | Default |
|---|---|---|
| `--source <dir>` | `init`, `push` | `./docs` |
| `--endpoint <url>` | `push`, `publication` | `https://rendro.app` |
| `--concurrency <n>` | `push` | `8` parallel uploads |
| `--include-sensitive` | `push` | Off; opt into sensitive files (warns and lists each one), still honoring `.rendroignore` |
| `--dry-run` | `push` | Off; list the files `push` would upload with sizes and a total, without credentials or any network access |
| `--path <prefix>` | `publication create` | Deployment root |
| `--entry <file>` | `publication create` | `index.html` (relative to `--path`) |
| `--title <title>` | `publication create` | The slug |
| `--pin <deployment-id>` | `publication create` | Track the active deployment |

`push` and `publication` read the API key from `RENDRO_API_KEY`.

`--endpoint` must be `https://`. Plain `http://` is refused with an error because the API key travels in a header; the only exceptions are `http://localhost`, `http://127.0.0.1` and `http://[::1]` for local development. Other schemes and unparseable URLs are refused too.

### API key scopes

Organization owners and admins create keys on the organization's API keys page. A key can be limited to one project and given an expiry. The secret is shown once.

| Command | Required scopes |
|---|---|
| `push` | `docs:read`, `docs:write` |
| `publication create` | `docs:read`, `publications:write` |
| `publication list` | `publications:read` |
| `publication remove` | `publications:write` |

### How push works

The CLI filters the source folder as described below, computes a SHA-256 manifest, and compares it with the active deployment. Unchanged files are copied server-side from the active deployment; only changed files are uploaded. The new deployment becomes active only after every file in the manifest is present. If a copy, upload, or commit fails, the CLI marks the new deployment failed and the previous deployment stays active.

Text assets keep their original bytes. The CLI records a media type without a
charset unless a UTF-8 or UTF-16 BOM identifies the encoding. This lets CSS
`@charset` and HTML `<meta charset>` declarations work on byte-preserving delivery
paths. Without a BOM or in-file declaration, decoding follows browser defaults.
Existing manifests remain valid; pushing again records the corrected
metadata even when unchanged file bytes are reused.

A publication created without `--pin` follows the project's active deployment. With `--pin`, it keeps serving that deployment after later pushes.

### Source filtering

By default, `push` skips these names at every depth (case-insensitive): `.env`,
`.env.*`, `.envrc`, `.envrc.*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`,
`.htpasswd`, `.pgpass`, `.dockercfg`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`,
`*.keystore`, `*.ppk`, `*.tfstate`, `*.tfvars`, `id_*` (including SSH private/public
key names), `credentials` and `credentials.{json,yml,yaml,toml,ini,csv,xml}`, and
`secret(s).{json,yml,yaml,toml,ini}`. Pages such as `credentials.html` stay eligible.
Each exclusion prints a `skipped` line with its relative path and reason;
excluded directories are listed once without reading their contents.
`--include-sensitive` permits these filenames, still honoring `.rendroignore`, and prints a
`warning:` on stderr naming every sensitive file it is about to upload. Review the list with
`--dry-run --include-sensitive` first.
Dot-directories are skipped by default, even with `--include-sensitive`. An explicit
`.rendroignore` negation such as `!.environment/` can re-include an ordinary
dot-directory. Metadata/credential directories `.git/`, `.ssh/`, `.aws/`, and
`node_modules/` (case-insensitive) are always excluded; neither negation nor the
flag can include them. Symbolic links and non-regular files are never
followed/uploaded. Ordinary dotfiles such as `.nojekyll` and `.environment` remain
eligible.

`push --dry-run` runs the same selection and limit checks, then prints each file that would
be uploaded with its size and a total, and exits without any request. It needs no
`--organization`, `--project` or API key.

Place `.rendroignore` in the **source root** (for example `docs/.rendroignore` for
`--source ./docs`). It applies with or without `--include-sensitive` and is never
uploaded. Nested ignore files are not loaded or uploaded. An unreadable root
ignore file stops the push before any deployment request.

The dependency-free matcher supports this gitignore-style subset:

- Blank lines and lines beginning with `#` are ignored; surrounding whitespace is trimmed.
- `*` matches within one path segment, `?` matches one non-slash character, and a whole segment `**` matches across directories (including zero directories before a following segment).
- Patterns without `/` match names at any depth. A leading `/`, or an internal `/`, anchors a pattern to the source root.
- A trailing `/` matches directories only. Excluded directories are pruned.
- `!` negates an earlier ignore rule or the default dot-directory exclusion; the last matching rule wins. Re-include an excluded parent before re-including a child. Negation cannot override sensitive defaults without `--include-sensitive`.
- Matching is case-sensitive. `\#` and `\!` escape a leading comment/negation marker. Character classes, brace expansion, other backslash escapes, and nested ignore files are unsupported; other metacharacters are literal.

```gitignore
# docs/.rendroignore
*.map
/drafts/
assets/**/scratch-?.txt
*.txt
!LICENSE.txt
!.environment/
```

These are filename safeguards, not content-based secret detection. Review the
selected source before publishing it; the flag does not change publication access.

## Migrating from 1.x

Legacy writes are retired. `rendro@1.x`, self-service namespace/key creation,
and legacy key authorization are no longer supported. `/api/sync/upload`,
`/api/sync/delete`, `/api/sync/check`, `/api/sync/list`, and legacy publication
requests carrying credentials return **410 Gone**. Use `rendro@2` organization/project deployments.

Legacy private reads, new publications/shares, and v1 comments require a live
member session in an explicitly operator-mapped Better Auth organization. Email
domains grant no access. Existing anonymous publication/share links work only
while that mapping points to an existing, non-tombstoned organization and the
target remains visible. Unmapped namespaces return 404; unavailable backends
return retryable 503. See the [legacy operator runbook](docs/TECHNICAL.md#legacy-operator-runbook).

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

## Limits

A deployment supports **1,000 files**, **8 MiB per file**, and **128 MiB total**.
Paths are limited to 1,024 characters (UTF-16 code units), and MIME strings to 128.
The deployment-start request, including its manifest, is limited to **2 MiB**;
other JSON/form requests are limited to **64 KiB**. File sizes/counts must be
non-negative safe integers. The CLI validates local limits before contacting the
server and reports which limit was exceeded. Split larger sets into projects or
reduce generated assets. Oversized request bodies return JSON with HTTP 413.

Per-user creation budgets are 30 comments/replies per minute, 20 shares per minute,
20 projects per hour, and 20 API keys per hour, with matching burst capacities.
Each organization has ten times those capacities/refill rates. A rejected creation
returns HTTP 429 with `Retry-After`; wait before trying again. Revocation remains
available. Anonymous publication/share resolution allows 600 requests/minute
(burst 1,200) per verified IP; direct unverified callers share 60/minute (burst 120).

The file-count and bounded storage-listing limits keep commit verification below
Workers' 50-subrequest ceiling: normally four requests, at most 29 with the
configured listing/retry budgets. See [resource limits and rationale](docs/TECHNICAL.md#request-and-deployment-resource-limits).

## License

MIT
