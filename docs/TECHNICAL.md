# Rendro — Technical

Complete technical reference: architecture, data flow, API, design decisions, and operational details.

> For the chronological evolution of these decisions, see [docs/HISTORY.md](HISTORY.md).

---

## Architecture

```
Browser → Cloudflare Workers (Hono) → Convex (auth, comments, API keys, soft-delete)
                                    → R2 (doc blob storage)
```

### Component Roles

| Component | Technology | Purpose |
|---|---|---|
| **Web Server** | Hono on Cloudflare Workers | Request routing, auth proxy, session verification, SSR, file streaming |
| **Auth** | better-auth + Convex component | Google OAuth, session management, cookie signing |
| **Database** | Convex | Auth tables (component), comments, API keys, soft-delete |
| **Blob Storage** | Cloudflare R2 | HTML docs, org-namespaced, S3-compatible API |
| **CLI** | Node.js (zero deps) | Doc upload, hash-based diffing, CI/CD integration |
| **Tree UI** | Vanilla JS (8KB IIFE) | Lazy-loading sidebar, infinite scroll, cross-doc navigation |
| **Comments** | Vanilla JS (Convex real-time) | Inline text selection, threaded replies |

---

## Full Auth Flow

```
1. User visits rendro.app → "Sign in with Google" button
2. Browser POST /api/auth/sign-in/social
3. Workers proxy → Convex HTTP action
4. Convex betterAuth stores OAuth state in verification table + signed cookie
5. Convex returns Google OAuth URL with state param
6. Worker returns URL (strips Domain from Set-Cookie)
7. Browser redirects to Google
8. User authenticates with Google
9. Google redirects to /api/auth/callback/google?code=...&state=...
10. Browser sends state cookie + URL params
11. Workers proxy → Convex (forwards cookie header)
12. Convex betterAuth validates:
    a. State cookie signature (signed JWT)
    b. State parameter matches cookie value
    c. State exists in verification table (not expired)
13. Convex exchanges code for tokens with Google
14. Convex creates/updates user in Convex DB
15. Convex creates session (signed JWT token) in Convex DB
16. Convex sets session cookie (__Secure-better-auth.session_token)
17. Convex returns 302 redirect to /
18. Worker returns redirect (strips Domain from Set-Cookie)
19. Browser stores session cookie, follows redirect
20. Browser GET / with session cookie
21. Worker session middleware:
    a. Reads cookie header
    b. Calls Convex GET /api/auth/get-session with cookie
    c. If user returned → c.set("user", user)
22. App route checks user → derives org from email → renders org docs
```

### Cookie Flow

| Cookie | Set During | Purpose | Format |
|---|---|---|---|
| `__Secure-better-auth.state` | Sign-in (step 4) | OAuth state validation | signed JWT |
| `__Secure-better-auth.session_token` | Callback (step 16) | Session identification | signed JWT |

Both cookies are:
- HttpOnly — not accessible to JavaScript
- Secure — HTTPS only
- SameSite=Lax — sent on same-site navigation
- Path=/ — available to all paths
- No explicit Domain — scoped to request origin (rendro.app)

### Workers Proxy Details

The proxy handles three concerns:

1. **Cookie forwarding**: Curated allowlist of safe headers (cookie, content-type). Host and cf-* headers excluded to prevent misrouting.

2. **Domain stripping**: Convex sets `Domain=convex.site` on cookies. Workers strips the Domain attribute so cookies bind to `rendro.app`.

3. **Redirect control**: `redirect: "manual"` prevents fetch from following 302 redirects — the browser handles redirections.

---

## Org Isolation

```
1. Session → Convex get-session → user.email = "alice@acme-corp.com"
2. emailToOrgSlug(email) = "acme-corp"
3. File prefix check: key.startsWith("acme-corp/")
4. Cross-org access → 403
```

**Three-layer enforcement:**
1. **Auth layer**: Session cookie → Convex → user identity
2. **Derivation**: Email domain → org slug (deterministic, no lookup)
3. **Storage layer**: R2 key prefix must match derived org

No permission tables, no role mapping, no env vars per org. The email domain IS the authorization boundary.

---

## Data Storage

### Convex Tables

**Component namespace** (`betterAuth`):
| Table | Fields | Indexes |
|---|---|---|
| `user` | id, name, email, emailVerified, image, createdAt, updatedAt | email, name |
| `session` | id, expiresAt, token, userId, ipAddress, userAgent, createdAt, updatedAt | token, userId, expiresAt |
| `account` | id, accountId, providerId, userId, accessToken, refreshToken, createdAt, updatedAt | userId |
| `verification` | id, identifier, value, expiresAt, createdAt, updatedAt | identifier, expiresAt |
| `jwks` | id, publicKey, privateKey, createdAt | — |
| `rateLimit` | key, count, lastRequest | — |

**App namespace:**
| Table | Fields | Indexes |
|---|---|---|
| `api_keys` | orgSlug, keyHash, createdAt | keyHash |
| `deleted_files` | orgSlug, fileKey, deletedAt | fileKey |
| `threads` | orgSlug, filePath, authorEmail, authorName, body, anchor, resolved | org_file |
| `replies` | threadId, authorEmail, authorName, body | threadId |

### R2 Structure

```
rendro-docs/
├── gmail/
│   ├── index.html
│   ├── api/
│   │   ├── overview.html
│   │   └── reference.html
│   └── getting-started/
│       └── quickstart.html
└── acme-corp/
    └── handbook.html
```

Keys follow the pattern `<org>/<relative-path>.html`. The org prefix doubles as the security boundary.

---

## Workers Internals

### Request Pipeline

```
Request
  │
  ├─ 1. DOMParser polyfill (IIFE, module load time)
  ├─ 2. Env bridging (c.env → process.env)
  ├─ 3. CORS (for /api/sync/*)
  ├─ 4. Request logging
  ├─ 5. Session middleware (Convex get-session)
  ├─ 6. Route matching
  │   ├─ /api/auth/sign-out → sign-out handler
  │   ├─ /api/auth/* → Convex proxy
  │   ├─ / → app routes
  │   ├─ /docs/:org → app shell with tree only
  │   ├─ /docs/:org/:path* → app shell with selected document
  │   ├─ /files/* → doc streaming
  │   ├─ /api/sync/* → sync API
  │   ├─ /api/tree/* → tree API
  │   ├─ /lazy-tree.js → ASSETS binding
  │   ├─ /commentor.js → ASSETS binding
  │   ├─ * → ASSETS binding fallback
  │   └─ /health → text response
  └─ 7. Error handler
```

### DOMParser Polyfill

The AWS SDK S3 client uses browser XML APIs for parsing ListObjectsV2 responses. Workers lacks these.

**Polyfill provides:**
- `globalThis.Node` with type constants (ELEMENT_NODE=1, TEXT_NODE=3, etc.)
- `globalThis.DOMParser` class with `parseFromString()` → Document-like object
- `XmlNode` class implementing: `nodeType`, `nodeName`, `nodeValue`, `tagName`, `textContent`, `childNodes`, `firstChild`, `getElementsByTagName()`
- `documentElement` property pointing to root element (not #document node)

**Tree-shaking protection**: The polyfill is wrapped in an IIFE. Without it, esbuild evaluates `typeof DOMParser === "undefined"` at build time (where it IS defined) and removes the entire block.

### ConvexClient → HTTP Migration

`ConvexClient` from `convex/browser` uses WebSocket for real-time sync. Workers can't reuse WebSocket connections across requests. All Convex calls now use raw HTTP:

```typescript
// Query
POST https://<deployment>.convex.cloud/api/query
Body: { "path": "module:function", "args": [{ ... }] }

// Mutation
POST https://<deployment>.convex.cloud/api/mutation
Body: { "path": "module:function", "args": [{ ... }] }
```

Affected modules: `api-keys.ts`, `soft-delete.ts`, `session.ts` (middleware).

---

## Sync API

| Method | Path | Auth | Body/Params | Returns |
|---|---|---|---|---|
| POST | `/api/sync/upload` | API Key | `{ key, content, contentType? }` | `{ ok, key, bucket }` |
| GET | `/api/sync/check` | API Key | `?key=&hash=` | `{ exists, etag?, size?, match? }` |
| GET | `/api/sync/list` | API Key | — | `{ keys: string[] }` |
| DELETE | `/api/sync/delete` | API Key | `?key=` | `{ deleted, key }` |

### Hash-Based Diffing

```
CLI                          Server                      R2
 │                             │                          │
 │ MD5-hash local file         │                          │
 │ GET /api/sync/check         │                          │
 │   ?key=org/x.html&hash=abc  │                          │
 │────────────────────────────>│                          │
 │                             │ HeadObject(org/x.html)   │
 │                             │─────────────────────────>│
 │                             │ { ETag: "def" }          │
 │                             │<─────────────────────────│
 │ hash=abc ≠ etag=def         │                          │
 │ POST /api/sync/upload       │                          │
 │────────────────────────────>│                          │
 │                             │ PutObject(org/x.html)    │
 │                             │─────────────────────────>│
 │                             │ OK                       │
 │                             │<─────────────────────────│
 │ { ok: true }                │                          │
 │<────────────────────────────│                          │
```

CLI phases:
1. **List**: GET `/api/sync/list` → existing server files
2. **Check**: For each local file, GET `/api/sync/check?key=&hash=` → match?
3. **Upload**: Changed/new files → POST `/api/sync/upload`
4. **Delete**: Files on server but not locally → DELETE `/api/sync/delete`

---

## Tree UI

### Component Architecture

```
Server (Hono SSR)
  │
  ├─ renderOrgTreePage(user, org, tree)
  │   ├─ Topbar (logo, hide shell, copy signed URL, theme, avatar)
  │   ├─ Sidebar
  │   │   ├─ data-tree-org attribute
  │   │   └─ #tree-container
  │   │       ├─ #active-indicator
  │   │       └─ renderTree(tree) — top-level only
  │   ├─ Main area
  │   │   ├─ #main-placeholder (shown when no doc selected)
  │   │   └─ #content-frame (iframe, hidden initially)
  │   ├─ Inline scripts (theme, shell hide/show, iframe shortcut forwarding, copy feedback, avatar menu)
  │   └─ <script src="/lazy-tree.js">
  │
Client (lazy-tree.js, 8KB IIFE)
  │
  ├─ handleClick(event)
  │   ├─ Folder click → expand(collapse)
  │   │   ├─ Already loaded? → toggle .open class
  │   │   └─ Not loaded? → GET /api/tree/:org?prefix=...
  │   │       └─ Render children + Load more button if truncated
  │   ├─ File click → loadDoc(path, pushState)
  │   │   ├─ Set iframe.src = /files/:org/:path
  │   │   ├─ updateIndicator
  │   │   └─ history.pushState to /docs/:org/:path
  │   └─ Load more click → next page
  │
  ├─ navigateToDoc(relPath)
  │   ├─ Expand ancestor folders iteratively
  │   └─ Highlight active item + indicator
  │
  ├─ postMessage listener
  │   ├─ doc-navigate → loadDoc(path, pushState)
  │   ├─ doc-loaded → syncActiveState(path)
  │   └─ shell-toggle → toggle parent shell when Ctrl/Cmd+Shift+H is pressed inside the document iframe
  │
  └─ popstate / initial URL
      ├─ /docs/:org/:path → window.RENDRO_INITIAL_DOC or path parse → loadDoc(path)
      └─ legacy ?doc=... → history.replaceState(/docs/:org/:path) → loadDoc(path)
```

### Sticky Headers (CSS)

```css
.tree-folder.open > .tree-item {
  position: sticky;
  top: calc(var(--depth) * 30px);  /* 0px, 30px, 60px... */
  z-index: calc(10 - var(--depth)); /* 10, 9, 8... */
  background: var(--sidebar-bg);
}
.tree-folder.open > .tree-folder-content {
  overflow: visible; /* unblock sticky positioning */
}
```

Zero JavaScript. GPU-accelerated by the browser. Multiple open folders stack with increasing top offset.

---

## Inline Comments

### Architecture

```
Doc HTML (iframe)                    Convex
  │                                    │
  │ User selects text                   │
  │ Commentor captures anchor           │
  │   (text quote + element path)       │
  │ POST thread/create                  │
  │────────────────────────────────────>│
  │                                    │ Thread stored
  │                                    │<───────────────
  │ Thread rendered as inline pin       │
  │                                    │
  │ Reply to thread                     │
  │ POST reply/add                      │
  │────────────────────────────────────>│
  │                                    │ Reply stored
  │                                    │<───────────────
```

### Anchor Format

```typescript
type Anchor =
  | { kind: "text-range"; quote: string; path: string[]; startOffset: number; endOffset: number }
  | { kind: "element"; path: string[] }
```

The anchor uniquely identifies text within a document, surviving minor edits.

---

## Deployment

### URL Scheme

| Purpose | URL |
|---|---|
| App shell, tree only | `/docs/:org` |
| App shell, selected document | `/docs/:org/:path*` |
| Iframe document stream | `/files/:org/:path*` |
| Legacy selected doc | `/?doc=:org/:path` redirects in-place to `/docs/:org/:path` |
| Public signed document | `/share/:token` |

The server injects `window.RENDRO_INITIAL_DOC` into the app shell for `/docs/:org/:path*`. `lazy-tree.ts` also parses `/docs/...` directly so back/forward navigation and static reloads restore the selected document.

Local development can still enter through `?dev_user=email` once. Session middleware persists that value as the `rendro-dev-user` cookie, then lazy-tree removes `dev_user` from visible URLs and iframe requests rely on the cookie.

Signed share links are created by `GET /api/share/create?key=:org/:path` for the currently signed-in owner. The server returns a 7-day HMAC-SHA256 token using `AUTH_SECRET`; the token payload contains the document key and expiry. `GET /share/:token` is mounted before session middleware in both runtime entrypoints, so it streams the raw document HTML without login and without commentor injection. Tampered tokens return `403`, expired tokens return `410`, and deleted/missing docs return `404`.

### Production URLs

| Service | URL |
|---|---|
| Web app | `https://rendro.app` |
| Worker | `https://rendro.schaitanya075.workers.dev` |
| Convex | `https://limitless-wolverine-248.convex.cloud` |
| Convex HTTP | `https://limitless-wolverine-248.convex.site` |
| R2 | `https://940d14f56cb81ce60ff9b23aeb820481.r2.cloudflarestorage.com` |

### Deploy Commands

```bash
# Workers
npx wrangler deploy --config wrangler.toml

# Convex
npx convex deploy --cmd "push"
```

### Environment Variables (Workers)

| Variable | Source | Purpose |
|---|---|---|
| `NODE_ENV` | wrangler.toml vars | "production" |
| `BASE_URL` | wrangler.toml vars | "https://rendro.app" |
| `GOOGLE_CLIENT_ID` | Secret | OAuth client |
| `GOOGLE_CLIENT_SECRET` | Secret | OAuth secret |
| `AUTH_SECRET` | Secret | Cookie signing |
| `CONVEX_URL` | Secret | Convex API endpoint |
| `MINIO_ENDPOINT` | Secret | R2 S3 endpoint |
| `MINIO_ACCESS_KEY` | Secret | R2 access key |
| `MINIO_SECRET_KEY` | Secret | R2 secret key |
| `MINIO_BUCKET` | Secret | "rendro-docs" |
| `MINIO_REGION` | Secret | "auto" |
| `MINIO_FORCE_PATH_STYLE` | Secret | "true" |

### Environment Variables (Convex)

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client |
| `GOOGLE_CLIENT_SECRET` | OAuth secret |
| `AUTH_SECRET` | Cookie signing (must match Workers) |
| `SITE_URL` | "https://rendro.app" |

---

## Key Technical Decisions

| # | Decision | Why |
|---|---|---|
| 1 | HTML over Markdown | Publisher owns rendering, no sanitization pipeline |
| 2 | Convex for auth | Built-in schema, HTTP actions, component architecture |
| 3 | Workers proxy pattern | Serverless, no database maintenance, global edge |
| 4 | DOMParser polyfill (IIFE) | Minimal, self-contained, tree-shake-proof |
| 5 | Hash-based diffing (MD5) | Content determines staleness, deterministic in CI |
| 6 | iframe doc rendering | Native navigation, sandboxed scripts |
| 7 | Soft-delete (Convex table) | Single query vs N R2 tag API calls |
| 8 | CSS sticky headers | Zero JS, GPU-accelerated, natural stacking |
| 9 | Email-domain orgs | Zero setup, self-service, no dashboard |
| 10 | Zero-dep CLI | 4.7KB, instant install, no dependency conflicts |
| 11 | Convex REST API (vs ConvexClient) | Workers I/O limitation, no WebSocket reuse |
| 12 | redirect:manual (vs default) | Prevents 302 loops causing 522 errors |
| 13 | Domain stripping (Set-Cookie) | Cookies must bind to rendro.app, not convex.site |
| 14 | Curated header allowlist | Only forward safe headers, exclude Host |

---

## Known Limitations

1. **No built-in search** — Publishers must implement their own (Algolia, Lunr, etc.)
2. **No WYSIWYG editor** — HTML-only, by design
3. **No fine-grained permissions** — All org members share the same API key
4. **No versioning of docs** — Always serves latest push, use git for history
5. **iframe doc rendering** — Double scrollbar potential with fixed headers
6. **Single Google OAuth client** — All tenants share one OAuth app
7. **Convex cold starts** — First HTTP action call may take ~1s
