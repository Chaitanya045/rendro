# Rendro — Setup

Local development and deployment guide.

## Prerequisites

- **Node.js** ≥ 22
- **pnpm** ≥ 9
- **Google Cloud** — OAuth 2.0 client for sign-in
- **Cloudflare** — Workers + R2 for deployment
- **Convex** — account for auth + database

## Local Development

### 1. Clone & Install

```bash
git clone https://github.com/Chaitanya045/rendro
cd rendro
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Required environment variables in `.env`:

```env
PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret
AUTH_SECRET=generate-at-least-32-random-characters
CONVEX_URL=https://your-project.convex.cloud
CONVEX_SITE_URL=https://your-project.convex.site
CONVEX_INTERNAL_SECRET=separate-legacy-service-secret
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=docs
MINIO_REGION=us-east-1
MINIO_FORCE_PATH_STYLE=true
```

Set Convex development environment values before starting:

```bash
pnpm exec convex env set GOOGLE_CLIENT_ID <value>
pnpm exec convex env set GOOGLE_CLIENT_SECRET <value>
pnpm exec convex env set AUTH_SECRET <same-value-as-.env>
pnpm exec convex env set SITE_URL http://localhost:3000
pnpm exec convex env set CONVEX_INTERNAL_SECRET <same-value-as-.env>
```

### 3. Start Services

```bash
docker compose up -d minio
pnpm init:minio
pnpm exec convex dev
pnpm dev
```

The app starts at `http://localhost:3000`; MinIO’s S3 API and console use ports 9000 and 9001. Add `http://localhost:3000/api/auth/callback/google` to the OAuth client. Development impersonation headers and query parameters are intentionally ignored.

### 4. Create the organization and project

Sign in, create or join an organization, then open **Projects** and create a project. Organization and project pages show their opaque IDs. Slugs are display fields, not authorization keys.

### 5. Create a scoped API credential

Open **Organization settings → API keys**. For CI, select the project and grant only:

- `docs:read`
- `docs:write`
- `publications:read` and `publications:write` only when that workflow also releases public docs

Set an expiry. The raw `rendro_…` value is shown once.

### 6. Push docs

```bash
pnpm cli:build
RENDRO_API_KEY=rendro_xxx ./bin/rendro.mjs push \
  --source ./docs \
  --organization <organization-id> \
  --project <project-id> \
  --endpoint http://localhost:3000
```

The command computes a SHA-256 manifest, reuses unchanged active objects, uploads changes to an isolated staging deployment, and commits the project pointer only after verification. Re-run the same command to resume an interrupted upload.

### 7. Browse, share, and publish

The project page links to **Browse docs** and **Publications**. Authenticated project docs remain private. **Share document** creates a seven-day revocable capability pinned to the current deployment.

Create a public release in the Publications UI or CLI:

```bash
RENDRO_API_KEY=rendro_xxx ./bin/rendro.mjs publication create \
  --organization <organization-id> \
  --project <project-id> \
  --slug product \
  --path product-docs \
  --entry index.html \
  --title "Product documentation" \
  --endpoint http://localhost:3000

./bin/rendro.mjs publication list \
  --organization <organization-id> --project <project-id> \
  --endpoint http://localhost:3000
```

The public URL is `http://localhost:3000/p/product`. A tracked publication follows future active deployments; `--pin <deployment-id>` keeps it on one immutable version.

## Deployment

### Convex

```bash
pnpm exec convex env set GOOGLE_CLIENT_ID <value>
pnpm exec convex env set GOOGLE_CLIENT_SECRET <value>
pnpm exec convex env set AUTH_SECRET <value>
pnpm exec convex env set SITE_URL https://rendro.app
pnpm exec convex env set RESEND_API_KEY <value>
pnpm exec convex env set AUTH_EMAIL_FROM auth@rendro.app
pnpm exec convex env set RETENTION_SECRET <random-32-plus-character-value>
pnpm exec convex env set CONVEX_INTERNAL_SECRET <legacy-service-secret>
pnpm exec convex deploy --cmd "push"
```

`AUTH_SECRET` must equal the Worker value. `CONVEX_INTERNAL_SECRET` remains only for compatibility paths during migration.

### Cloudflare Workers and R2

Create the private `rendro-docs` R2 bucket and an S3 API token restricted to that bucket. The endpoint is `https://<account-id>.r2.cloudflarestorage.com`; do not append the bucket name.

```bash
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put AUTH_SECRET
pnpm exec wrangler secret put CONVEX_URL
pnpm exec wrangler secret put CONVEX_SITE_URL
pnpm exec wrangler secret put CONVEX_INTERNAL_SECRET
pnpm exec wrangler secret put MINIO_ENDPOINT
pnpm exec wrangler secret put MINIO_ACCESS_KEY
pnpm exec wrangler secret put MINIO_SECRET_KEY
pnpm exec wrangler secret put MINIO_BUCKET
pnpm exec wrangler secret put MINIO_REGION
pnpm exec wrangler secret put MINIO_FORCE_PATH_STYLE
pnpm exec wrangler deploy --config wrangler.toml
```

Do not configure public R2 access. Worker routes are the authorization boundary.

### Scheduled retention

Configure the repository secrets named in `.github/workflows/retention.yml`: `CONVEX_SITE_URL`, `RETENTION_SECRET`, `R2_ENDPOINT`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, and `R2_BUCKET`. The daily job purges eligible deployment namespaces; pinned publications and unexpired shares block deletion.

## CLI Build

```bash
# Build the CLI
node scripts/build-cli.mjs

# The output is bin/rendro.mjs (zero dependencies)
# Make executable
chmod +x bin/rendro.mjs

# Test
./bin/rendro.mjs --help
```

## Commentor Build

```bash
npx esbuild src/commentor/commentor.ts \
  --bundle --format=iife \
  --outfile=public/commentor.js \
  --platform=browser
```

## Quality Gates

```bash
pnpm typecheck   # TypeScript
pnpm lint        # ESLint
pnpm test        # Vitest
```

## Project Structure

```
rendro/
├── src/
│   ├── worker.ts          # Cloudflare Workers entry
│   ├── index.ts           # Local dev server
│   ├── auth.ts            # Auth module (memory/proxy)
│   ├── config.ts          # Zod env config
│   ├── api-keys.ts        # API key management (Convex HTTP)
│   ├── soft-delete.ts     # Soft-delete operations (Convex HTTP)
│   ├── minio.ts           # R2/MinIO S3 client
│   ├── orgs.ts            # Org derivation from email
│   ├── middleware/         # Session middleware
│   ├── routes/             # App + docs routes
│   └── commentor/          # Inline comment widget
├── convex/
│   ├── http.ts            # Convex HTTP actions (auth)
│   ├── auth.ts            # better-auth configuration
│   ├── auth.config.ts     # Convex auth provider config
│   ├── convex.config.ts   # Convex component registration
│   ├── schema.ts          # App tables (non-auth)
│   ├── apiKeys.ts         # API key mutations/queries
│   ├── deletedFiles.ts    # Soft-delete mutations/queries
│   ├── threads.ts         # Comment threads
│   └── replies.ts         # Comment replies
├── cli/src/index.ts       # CLI source
├── bin/rendro.mjs         # Built CLI (zero deps)
├── public/
│   ├── lazy-tree.js       # Tree UI (IIFE)
│   └── commentor.js       # Comment widget (IIFE)
├── wrangler.toml          # Cloudflare Workers config
├── convex.json            # Convex project config
└── package.json
```
