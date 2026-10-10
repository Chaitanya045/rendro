# Rendro — Product

What the product is, who it serves, how it evolved, and how users experience it.

> For the chronological evolution, see [docs/HISTORY.md](HISTORY.md).
> For technical details, see [docs/TECHNICAL.md](TECHNICAL.md).

---

## What is Rendro?

Rendro hosts static HTML documentation. Teams write docs as plain HTML in their code repositories, push them with the CLI, and read them in a viewer with a sidebar tree and inline comments.

It is for teams that want docs version-controlled alongside their code, edited as plain HTML, and deployed from CI — not written in a hosted editor.

## The Problem It Solves

**Before Rendro:**
- Docs live in a separate tool (Confluence, Notion) → out of sync with code
- Docs require a build pipeline (Docusaurus, Nextra) → slow iteration
- Feedback on docs happens in Slack or email, away from the text

**With Rendro:**
- Docs are HTML files in the same repo as code
- CI runs `rendro push`; only changed files are uploaded
- Each push is an immutable deployment that becomes active atomically
- Readers select text and leave threaded comments in context
- Publishing publicly is a separate, explicit step

## Core Concepts

| Concept | What it is |
|---|---|
| **Organization** | The security boundary. Members have one role: `owner`, `admin`, or `member` |
| **Team** | A named group of organization members. Teams do not currently grant or restrict project access |
| **Project** | A documentation product inside an organization. It has one active deployment at a time |
| **Deployment** | An immutable snapshot of the uploaded folder, with a SHA-256 manifest and provenance (git commit, ref, CI run, CLI version) |
| **API key** | A credential for the CLI and CI, bound to one organization, optionally to one project, with explicit scopes and an optional expiry |
| **Publication** | An explicit public mapping of one project folder to `/p/:slug`. It tracks the active deployment or is pinned to one |
| **Private share** | A revocable, expiring link (`/s/:token`) to one document in one deployment |

## The People

### Members (readers)

1. Sign in with Google, or with email and password (email verification required)
2. Choose an organization at `/organizations`
3. Open a project's documentation
4. Expand folders in the sidebar tree and read documents
5. Select text to leave comments; reply, resolve, or archive threads
6. Create a private share link for a single document

### Publishers (writers)

1. Create HTML files in the repo's `docs/` folder (`rendro init` scaffolds one)
2. Push to Git → CI runs `rendro push` with a scoped API key
3. The CLI hashes files, reuses unchanged files server-side, and uploads only changed ones
4. The new deployment becomes active only when every file is present
5. Optionally publish a folder at a stable, anonymous read-only URL with `rendro publication create`

### Owners and admins

1. Create the organization and invite people (invitations expire after 7 days and require a verified email)
2. Assign roles, create teams, and manage team membership
3. Create projects, API keys, and publications; revoke keys, publications, and private shares

Members can read projects, deployments, and publications, comment, and create private shares. They cannot create projects, API keys, or publications.

### Anonymous visitors

- Open a publication URL (`/p/:slug`) and navigate only within that published folder
- Open a private share URL (`/s/:token`) and see only that document and its same-folder assets

## Onboarding

New organizations go through three steps at `/organizations/:id/onboarding`:

1. **Organization** — name and slug
2. **Project** — the first documentation project
3. **First deployment** — create a project-scoped API key, copy the generated `npx --yes rendro@<version> push …` command (pinned to the CLI version and pointing at the current site), and push. The page polls until the first deployment is active and then links to the documentation.

## The Reader Experience

### Navigation
- **Sidebar tree**: folders expand on click, files load in the content area
- **Active indicator**: shows the current document; the row shimmers while it loads
- **Cross-doc links**: clicking a link in one document navigates to another, and the tree follows
- **History**: the selected document is in the URL (`?doc=<path>`), so Back/Forward and deep links work
- **Shell**: the tree can be resized or hidden (Ctrl/Cmd+Shift+H)
- **Mobile**: the tree opens as a drawer; secondary toolbar actions move into a "More document actions" menu

### Reading
- **Raw HTML**: docs render exactly as the publisher wrote them, in a sandboxed iframe
- **No imposed theme**: the publisher owns the document's styling
- **Theme**: the Rendro interface cycles between system, dark, and light; the choice persists and syncs across tabs

### Interacting
- **Inline comments**: select text or an element, leave a comment
- **Threaded replies**, resolve/reopen, archive/unarchive, delete with undo
- **Real-time**: comments update live through Convex
- **Share**: the toolbar creates a private share link valid for 7 days and copies it

Comments are available in the signed-in project viewer, not on publications or private shares.

## The Publisher Experience

### Writing
- Any text editor
- Any structure: nested folders become the tree
- Any styling: inline CSS, CDN stylesheets, custom fonts
- Any content: code blocks, tables, images, scripts (scripts run inside the sandbox)

### Pushing
```bash
rendro push --source ./docs --organization <organization-id> --project <project-id>

# What happens:
# 1. Walk docs/ and compute SHA-256 + size for each file
# 2. Compare with the active deployment's manifest
# 3. Start a new staging deployment
# 4. Copy unchanged files server-side (16 per request)
# 5. Upload changed files (8 in parallel by default)
# 6. Commit: verify every manifest file is present, then activate
```

Files removed from the source are simply absent from the new deployment. Nothing is overwritten in place.

### CI/CD
```yaml
# .github/workflows/docs.yml
on:
  push:
    branches: [main]
jobs:
  deploy-docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - name: Deploy docs
        env:
          RENDRO_API_KEY: ${{ secrets.RENDRO_API_KEY }}
        run: >
          npx --yes rendro@2.0.0 push --source ./docs
          --organization <organization-id> --project <project-id>
          --endpoint https://rendro.app
```

Pin the CLI version and run deployments only from trusted branches, never from untrusted pull-request code.

### Publishing
- `rendro publication create --slug <slug> [--path <folder>] [--entry <file>] [--pin <deployment-id>]`
- Without `--pin`, the publication follows each new active deployment
- With `--pin`, it keeps serving that deployment; retention will not delete a pinned deployment
- Publications can also be created and removed from the project's Publications page

## The Product Model

### Files as the Product

The unit of value is a file. Not "documents with rich text." Not "pages with metadata." Files.

This gives us:
- **Version control for free** — files in Git, versioned, branchable
- **Editors for free** — whatever the publisher wants
- **Diff for free** — every change is a git diff
- **Reviews for free** — pull requests, code review, Git workflows

### Storage

Document bytes live in one R2 bucket under opaque IDs:

```
tenants/{organizationId}/projects/{projectId}/deployments/{deploymentId}/
├── manifest.json
├── tree-index.json
└── files/…
```

Metadata — projects, deployments, publications, shares, API keys, comments, and audit events — lives in Convex. Slugs are display and URL fields only; access is always decided by organization membership or a scoped credential.

### Retention

Superseded deployments are kept for 30 days and failed deployments for 24 hours, unless a pinned publication or an unexpired share still references them. A daily job deletes the rest.

## Feature Timeline

### v0.1 — Core Platform (July 2026)
- SSR doc platform with Hono
- Sidebar tree with lazy loading
- Document streaming from MinIO
- Google OAuth with better-auth + SQLite
- Email-domain org derivation

### v0.2 — Tree UX
- Infinite scroll with pagination
- Sticky folder headers (CSS)
- Cross-doc navigation (postMessage)
- Browser history support
- Dark mode toggle
- Share button

### v0.3 — Migration
- Renamed from docsync to Rendro
- SQLite → Convex for API keys and soft-delete
- R2 for production blob storage

### v0.4 — Workers
- Cloudflare Workers deployment
- DOMParser polyfill for AWS SDK
- D1 for auth sessions (later replaced)
- CLI distribution (npm package)

### v0.5 — Convex Auth
- Auth migrated to Convex component
- Workers proxy to Convex HTTP actions
- Cookie forwarding + Domain stripping
- Session middleware via Convex get-session
- Convex HTTP API for Workers compatibility

### v0.6 — Production
- Inline comments (Convex real-time)
- Soft-delete with recovery
- CI/CD with GitHub Actions
- npm package (zero dependencies)

### v0.7 — Viewer polish (July 2026)
- Shadcn-style theme with radial theme transition
- Signed document links
- Resizable, auto-hiding shell with keyboard shortcut
- Shared 404 page
- Comment review workflow (filters, quotes, anchors)

### v0.8 — Public folders (August 2026)
- Explicit public documentation publishing (legacy `/public/:org/:slug`)
- Product landing page

### v2.0 — Projects and immutable deployments (August–October 2026)
- Better Auth organizations with owner/admin/member roles, teams, and invitations
- Email/password accounts with verification, password recovery, and account security page
- Projects inside organizations; tenant boundaries enforced by organization ID
- Scoped, expiring, revocable API keys
- Atomic immutable deployments with SHA-256 manifests and provenance
- Tracked or pinned publications at `/p/:slug`; revocable private shares at `/s/:token`
- Legacy migration and deployment retention jobs
- Management UI: onboarding, projects, people, teams, settings, API keys, publications, shares
- CLI 2.0.0 with `--organization` / `--project`, published as an explicit version

## What Rendro Is Not

- **Not a CMS** — no rich text editor, no media library, no draft workflow
- **Not multi-user editing** — the last push wins; use Git for conflict resolution
- **Not a wiki** — no cross-linking engine and no search
- **Not a notification tool** — no reactions, no email notifications for comments
- **Not a blogging platform** — no RSS, no tags, no archives
- **Not an analytics tool** — no page-view tracking
- **No custom domains** — publications are served from the Rendro origin

## Roadmap

These are candidates, not commitments.

### Short Term
- Full-text search
- Webhook notifications on new deployments
- Markdown-to-HTML conversion in CLI

### Medium Term
- Team-based project access
- Browsing previous deployments in the viewer
- Analytics (page views, popular docs)
- Organization branding (logo, colors)

### Long Term
- Custom domains for publications
- PDF export
- Plugin system for custom widgets
