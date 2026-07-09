# Rendro — Technical

Architecture, data flow, design decisions. For engineers and operators.

## Architecture

```
Browser → Cloudflare Workers (Hono) → Convex (auth, comments, API keys)
                                    → R2 (doc blob storage)
```

| Component | Role |
|---|---|
| **Cloudflare Workers** | Web server, auth proxy, static file serving |
| **Convex** | Auth (better-auth component), comments, API keys, soft-delete |
| **R2** | HTML doc blob storage (S3-compatible) |
| **CLI** | Zero-dependency Node.js script for pushing docs |

## Auth Flow

```
1. User visits rendro.app → "Sign in with Google"
2. POST /api/auth/sign-in/social → Workers → Convex HTTP action
3. Convex better-auth initiates Google OAuth → returns redirect URL
4. User authenticates with Google → redirected to /api/auth/callback/google
5. Workers proxies callback → Convex validates state (cookie + DB)
6. Convex creates session in Convex DB, sets signed JWT cookie
7. Redirect to rendro.app/ → session middleware validates cookie via get-session
8. User sees org docs tree
```

Auth runs entirely in Convex HTTP actions. Workers proxies all `/api/auth/*` requests, forwarding cookies and stripping Domain from Set-Cookie headers.

## Org Isolation

```
1. Session cookie → Convex get-session → user email: "alice@acme-corp.com"
2. emailToOrgSlug(email) → org = "acme-corp"
3. File prefix validation: key must start with "acme-corp/"
4. Cross-org access → 403
```

The email domain IS the authorization boundary. No per-org env vars, no permission tables.

## Data Storage

### Convex (component tables)
- `user`, `session`, `account`, `verification` — better-auth auth tables
- `threads`, `replies` — inline comments
- `api_keys` — API key hashes per org
- `deleted_files` — soft-delete records

### R2 (blob storage)
- Keys: `<org>/<path>.html`
- One bucket (`rendro-docs`), namespaced by org prefix
- Streaming: files served directly from R2 via Workers

## Workers Architecture

```
worker.ts
├── DOMParser polyfill (IIFE) — AWS SDK XML parser for R2
├── Env bridging — process.env from Worker env/secrets
├── Session middleware — validates session via Convex get-session
├── Auth proxy — /api/auth/* → Convex HTTP actions
│   ├── Cookie forwarding (curated headers)
│   ├── Domain stripping (Set-Cookie)
│   └── redirect: manual (prevent 302 loops)
├── App routes — landing page, org creation, tree rendering
├── Docs routes — file streaming, sync API, tree API
├── Static files — lazy-tree.js, commentor.js from ASSETS binding
└── Sign-out — GET → POST proxy with cookie clearing
```

## Sync API

| Endpoint | Auth | Purpose |
|---|---|---|
| POST `/api/sync/upload` | API key | Upload HTML file |
| GET `/api/sync/check` | API key | Check file existence + hash match |
| GET `/api/sync/list` | API key | List all org files |
| DELETE `/api/sync/delete` | API key | Soft-delete a file |
| GET `/api/tree/:org` | Session | Lazy-load tree children |

## CLI Design

- **Zero dependencies** — Node.js built-ins only
- **Hash-based diffing** — MD5 local hash vs server ETag
- **Three phases**: list → check → upload/delete
- **Distribution**: npm package (4.7KB) or direct curl download

## Tree UI

- **Server-rendered**: top-level items via `renderOrgTreePage`
- **Client JS**: `lazy-tree.js` (IIFE) handles folder expansion, infinite scroll
- **Lazy loading**: `GET /api/tree/:org?prefix=...` per folder
- **Pagination**: `limit` + `startAfter` for large directories
- **Sticky headers**: CSS `position: sticky` with depth-based z-index
- **Cross-doc nav**: postMessage between iframe and parent

## DOMParser Polyfill

Workers runtime lacks `DOMParser` and `Node` globals needed by AWS SDK S3 XML parser. An IIFE polyfill provides:
- `DOMParser` class with `parseFromString` → Document-like object
- `Node` global with `ELEMENT_NODE`, `TEXT_NODE` constants
- `XmlNode` class with `nodeName`, `nodeValue`, `childNodes`, `getElementsByTagName`
- `documentElement` property pointing to root element

Wrapped in IIFE to prevent esbuild tree-shaking.

## Key Design Decisions

### Convex for auth vs D1/KV
**Chosen: Convex component.** better-auth runs in Convex HTTP actions with `convexAdapter`. Workers proxies auth requests. Convex handles schema, migrations, and session storage.

### Hash-based diffing vs timestamp
**Chosen: MD5 hashing.** File content determines staleness, not timestamps. Renaming a file doesn't trigger re-upload. CI builds are deterministic.

### iframe vs fetch+render for docs
**Chosen: iframe.** Native navigation, sandboxed scripts, commentor widget runs independently. `about:blank` + `src` assignment avoids navigation blocking from `srcdoc`.

### Soft-delete vs hard-delete
**Chosen: soft-delete.** Files marked hidden in Convex, remain in R2. Direct URL access still works. Re-upload un-deletes. Safety net for accidental deletions.

### CSS sticky vs IntersectionObserver for headers
**Chosen: CSS `position: sticky`.** Zero JS, GPU-accelerated, natural stacking with depth-based offsets. Open folder content uses `overflow:visible` to unblock sticky.
