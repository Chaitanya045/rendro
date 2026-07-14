# Rendro — Product

What the product is, who it serves, how it evolved, and how users experience it.

> For the chronological evolution, see [docs/HISTORY.md](HISTORY.md).
> For technical details, see [docs/TECHNICAL.md](TECHNICAL.md).

---

## What is Rendro?

Rendro is a documentation hosting platform that turns static HTML files into a live, searchable knowledge base. Teams write docs as plain HTML in their code repos, push via CLI, and Rendro serves them instantly with a VS Code-style sidebar tree, inline comments, and dark mode.

It is the alternative to Confluence or Notion for teams that want their docs version-controlled alongside their code, edited as plain HTML, and deployed in seconds — not via a clunky editor.

## The Problem It Solves

**Before Rendro:**
- Docs live in a separate tool (Confluence, Notion) → out of sync with code
- Docs require a build pipeline (Docusaurus, Nextra) → slow iteration
- Docs need a CMS login → extra friction for engineers
- Docs don't support inline comments → feedback via Slack/email

**With Rendro:**
- Docs are HTML files in the same repo as code → always in sync
- Push to Git, CI uploads automatically → under 40 seconds to live
- No separate auth — sign in with Google, org derived from email
- Select text, leave comments → threaded, real-time, in context

## The People

### Visitors (readers)

Members of an organization who read documentation:
1. Visit `rendro.app`
2. Sign in with Google (`alice@acme-corp.com`)
3. See their org's docs in the sidebar tree
4. Click files to read, expand folders to navigate
5. Select text to leave comments

### Publishers (writers)

Engineers who write and maintain documentation:
1. Create HTML files in their repo's `docs/` folder
2. Push to Git → CI runs `rendro push`
3. CLI hashes files, uploads only changed ones
4. Docs are live within 40 seconds

### Admins (org creators)

First user from a new domain:
1. Signs in with Google
2. Sees "Create your org" form (slug auto-filled from email)
3. Submits → org folder created in R2, API key generated
4. Shares API key with team for CI/CD

## The Visitor Experience

### Authentication
- One click: "Sign in with Google"
- No org selection, no URL paths, no setup
- Email domain determines which docs you see

### Navigation
- **Sidebar tree**: folders expand on click, files load in content area
- **Lazy loading**: large directories load one level at a time
- **Infinite scroll**: "Load more" button for directories with 50+ files
- **Breadcrumb-free**: tree shows your location with an active indicator
- **Cross-doc links**: clicking a link in one doc navigates to another, tree follows

### Reading
- **Raw HTML**: docs render exactly as the publisher wrote them
- **No imposed theme**: the publisher owns the styling
- **Dark mode**: toggle in header, persists across sessions
- **Responsive**: works on desktop and tablet

### Interacting
- **Inline comments**: select any text, leave a comment
- **Threaded replies**: reply to comments in context
- **Real-time**: comments appear instantly via Convex
- **Share**: copy a signed public document URL with one click and inline confirmation

### Org Isolation
- Users from `acme-corp.com` only see `acme-corp/` docs
- Cross-org access blocked at three layers (auth, derivation, storage)
- No permission tables, no role management

## The Publisher Experience

### Writing
- Any text editor: VS Code, Vim, Notepad
- Any structure: nested folders mirror the URL structure
- Any styling: inline CSS, CDN stylesheets, custom fonts
- Any content: code blocks, tables, callouts, images, scripts

### Pushing
```bash
# One command
rendro push --source ./docs --org my-org

# What happens:
# 1. Walk docs/ directory
# 2. MD5-hash each file
# 3. Check server for matches (skip unchanged)
# 4. Upload changed/new files
# 5. Soft-delete removed files
```

### CI/CD
```yaml
# .github/workflows/sync-docs.yml
on:
  push:
    branches: [main]
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Sync docs
        env:
          RENDRO_API_KEY: ${{ secrets.RENDRO_API_KEY }}
        run: rendro push --source ./docs --org my-org
```

### Performance
- **First push** (100 files): ~10 seconds
- **Incremental push** (2 changed): <1 second
- **Hash-based**: content determines staleness, not timestamps
- **Parallel**: concurrent uploads (default 5)

## The Product Model

### Files as the Product

The unit of value is a file. Not "documents with rich text." Not "pages with metadata." Files.

This gives us:
- **Version control for free** — files in Git, versioned, branchable
- **Editors for free** — whatever the publisher wants
- **Diff for free** — every change is a git diff
- **Reviews for free** — pull requests, code review, Git workflows

### One Bucket, Many Tenants

All files for all orgs live in a single R2 bucket. The org slug is the prefix:

```
rendro-docs/
├── gmail/
│   ├── index.html
│   └── api/
│       └── reference.html
└── acme-corp/
    └── handbook.html
```

No per-org storage account. No separate database. The org slug is the only namespace mechanism.

### Self-Service Orgs

When a new user signs in:
1. Email domain → org slug (automatic)
2. If org exists → see docs
3. If org doesn't exist → create form (pre-filled)

No admin intervention. No dashboard. No configuration. The email domain IS the org.

## Feature Timeline

### v0.1 — Core Platform
- SSR doc platform with Hono
- Sidebar tree with lazy loading
- Document streaming from MinIO
- Google OAuth with better-auth + SQLite
- Email-domain org derivation
- MinIO blob storage

### v0.2 — Tree UX
- Infinite scroll with pagination
- Sticky folder headers (CSS)
- Cross-doc navigation (postMessage)
- Browser history support
- Dark mode toggle
- Copy signed URL button with inline confirmation

### v0.3 — Migration
- Renamed from docsync to Rendro
- SQLite → Convex for API keys and soft-delete
- R2 for production blob storage
- WorkOS SSO integration (later replaced)

### v0.4 — Workers
- Cloudflare Workers deployment
- DOMParser polyfill for AWS SDK
- D1 for auth sessions (later replaced)
- CLI distribution (npm + standalone)

### v0.5 — Convex Auth
- Auth migrated to Convex component
- Workers proxy to Convex HTTP actions
- Cookie forwarding + Domain stripping
- Session middleware via Convex get-session
- Convex REST API for Workers compat

### v0.6 — Production
- Inline comments (Convex real-time)
- Soft-delete with recovery
- CI/CD with GitHub Actions
- 200 doc test suite
- npm package (4.7KB, zero deps)
- Standalone CLI binary download

## What Rendro Is Not

- **Not a CMS** — no rich text editor, no media library, no draft/publish workflow
- **Not multi-user editing** — last push wins, use Git for conflict resolution
- **Not a wiki** — no cross-linking engine, no built-in search
- **Not a collaboration tool** — no reactions, no notifications (comments only)
- **Not a blogging platform** — no RSS, no tags, no archives
- **Not identity-aware on the read path** — no per-user tracking, no analytics

## Comparisons

| | Rendro | Confluence | Notion | Docusaurus | GitBook |
|---|---|---|---|---|---|
| **Content format** | HTML | Rich text | Blocks | Markdown | Markdown |
| **Version control** | Git | Built-in | Built-in | Git | Git |
| **Deployment** | CI push | Hosted | Hosted | Build + deploy | Hosted |
| **Auth** | Google OAuth | Built-in | Built-in | None/plugin | Built-in |
| **Comments** | Inline | Inline | Inline | None | Inline |
| **Custom domain** | Yes | Yes | No | Yes | Yes |
| **Self-hosted** | Yes | No | No | Yes | No |
| **Editor** | Any text editor | Web | Web | Any text editor | Web |

## Roadmap

### Short Term
- Full-text search (Algolia or Lunr integration)
- Multiple API keys per org
- Webhook notifications on doc changes
- Markdown-to-HTML conversion in CLI

### Medium Term
- Analytics dashboard (page views, popular docs)
- Org branding (custom logo, colors)
- PDF export
- Multi-language support (i18n)

### Long Term
- Fine-grained permissions (reader/writer/admin)
- Doc versioning (view previous versions)
- Plugin system for custom widgets
- On-premise deployment option
