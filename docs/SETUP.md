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

# Google OAuth
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret

# Auth secret (32+ chars — generate: openssl rand -hex 32)
AUTH_SECRET=your-secret-32chars

# Convex
CONVEX_URL=https://your-project.convex.cloud

# MinIO / R2 (local dev uses MinIO)
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=docs
MINIO_REGION=us-east-1
MINIO_FORCE_PATH_STYLE=true

SYNC_TOKEN=dev-sync-token
```

### 3. Start Services

```bash
# Convex dev (auth, database)
npx convex dev

# Local dev server
pnpm dev
```

Server starts on `http://localhost:3000`.

For local dev without Google OAuth, use the dev bypass:

```
http://localhost:3000/?dev_user=test@example.com
```

### 4. Generate API Key

Sign in at `http://localhost:3000/?dev_user=test@acme-corp.com`, create your org (the form auto-fills `acme-corp` from email domain). You'll get an API key.

### 5. Push Docs

```bash
# Using the CLI
RENDRO_API_KEY=rendro_xxx ./bin/rendro.mjs push \
  --source ./docs --org acme-corp --endpoint http://localhost:3000

# Or via curl
curl -X POST http://localhost:3000/api/sync/upload \
  -H "Authorization: Bearer rendro_xxx" \
  -H "Content-Type: application/json" \
  -d '{"key": "acme-corp/index.html", "content": "<h1>Hello</h1>"}'
```

## Deployment

### Convex

```bash
npx convex deploy --cmd "push"
```

Set Convex environment variables:

```bash
npx convex env set GOOGLE_CLIENT_ID=xxx
npx convex env set GOOGLE_CLIENT_SECRET=xxx
npx convex env set AUTH_SECRET=xxx
npx convex env set SITE_URL=https://rendro.app
```

### Cloudflare Workers

```bash
npx wrangler deploy --config wrangler.toml
```

Set Cloudflare secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put AUTH_SECRET
npx wrangler secret put CONVEX_URL
npx wrangler secret put MINIO_ENDPOINT
npx wrangler secret put MINIO_ACCESS_KEY
npx wrangler secret put MINIO_SECRET_KEY
npx wrangler secret put MINIO_BUCKET
npx wrangler secret put MINIO_REGION
npx wrangler secret put MINIO_FORCE_PATH_STYLE
```

### R2 Setup

Create bucket via Cloudflare Dashboard → R2 → Create bucket (`rendro-docs`).

Configure in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "DOCS"
bucket_name = "rendro-docs"
```

The `MINIO_ENDPOINT` for R2 in production:

```
https://<account-id>.r2.cloudflarestorage.com
```

**Important**: Do NOT include the bucket name in the endpoint URL.

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

Repo-scoped pushes:

```bash
export RENDRO_API_KEY=rendro_xxx
rendro push --source ./docs --org gmail --repo rendro-test --endpoint https://rendro.app
```

Use a distinct `--repo` slug for each source repository in the same org. Sync deletes are scoped to `<org>/<repo>/`.

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
