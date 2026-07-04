# Rendro — Local Setup

Get Rendro running on your machine in under 10 minutes.

## Prerequisites

- **Node.js** ≥ 22
- **pnpm** ≥ 9 (`npm install -g pnpm`)
- **Docker** (for MinIO blob storage)

## 1. Clone & Install

```bash
git clone <repo-url> rendro
cd rendro
pnpm install
```

## 2. Start MinIO

Rendro stores HTML files in MinIO, an S3-compatible object store. The docker-compose file starts it on port 9000.

```bash
docker compose up -d minio
```

Verify it's running:

```bash
curl http://localhost:9000/minio/health/live
# → 200 OK
```

## 3. Configure Environment

Copy the example env file and edit it:

```bash
cp .env.example .env
```

Minimal `.env` for local dev:

```env
PORT=3000
NODE_ENV=development

# MinIO
MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=docs
MINIO_REGION=us-east-1
MINIO_FORCE_PATH_STYLE=true

# Google OAuth (for sign-in)
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret

# Base URL
BASE_URL=http://localhost:3000
```

For local dev without setting up Google OAuth, use the dev mode bypass:

```bash
# Visit with ?dev_user=your-email to skip sign-in
http://localhost:3000/?dev_user=test@example.com
```

## 4. Initialize MinIO Bucket

```bash
pnpm run init-minio
```

This creates the `docs` bucket in MinIO.

## 5. Start the Server

```bash
pnpm run dev
```

The server starts on `http://localhost:3000`.

## 6. Create an Org

Visit `http://localhost:3000/?dev_user=you@yourcompany.com`. If the org doesn't exist, you'll see a "Create your org" form. Submit it to create the org folder in MinIO.

## 7. Upload Docs

Create some HTML files and push them with the CLI:

```bash
# Create a docs directory
mkdir -p my-docs/api
echo "<h1>Hello World</h1>" > my-docs/index.html

# Push to your org
DOCSYNC_API_KEY=your-api-key ./bin/rendro.mjs push \
  --source ./my-docs \
  --org yourcompany \
  --endpoint http://localhost:3000
```

Get your API key from the org creation page, or generate one:

```bash
pnpm run cli push --source ./my-docs --org yourcompany
```

## 8. Build the CLI

The CLI is built with esbuild:

```bash
# Build once
npx esbuild cli/src/index.ts --bundle --platform=node --target=node22 --format=esm --outfile=bin/rendro.mjs --banner:js='#!/usr/bin/env node'
chmod +x bin/rendro.mjs

# Use it
./bin/rendro.mjs push --source ./docs --org my-org --endpoint http://localhost:3000
```

## 9. Build Commentor Widget

The inline comment widget is built separately:

```bash
npx esbuild src/commentor/commentor.ts --bundle --format=iife --outfile=public/commentor.js --platform=browser
```

Note: Comments require a running Convex backend. For local dev, comments are optional.

## Quality Gates

```bash
pnpm typecheck   # TypeScript type checking
pnpm lint        # ESLint
pnpm test        # Vitest test suite
```

## Architecture

See [docs/TECHNICAL.md](TECHNICAL.md) for the full architecture, data flow, and design decisions.

See [docs/PRODUCT.md](PRODUCT.md) for the product roadmap and user stories.
