# Rendro — Product

What the product is, who it serves, and how users experience it.

## What is Rendro?

A self-hosted documentation service where each organization owns its own docs and authenticates its own users. An organization stores HTML files in a Git repo, and the Rendro server makes them readable at `example.com/<org>`.

It is the alternative to Confluence or Notion for teams that want their docs to be version-controlled alongside their code, edited as plain HTML, and deployed in seconds — not via a clunky editor.

## The people

There are two kinds of people in this product's world:

**Visitors** — members of a customer organization. They open `acme-corp.docs.example.com` (or `example.com/acme-corp`), sign in through their company's existing login (Okta, Google, Entra — whatever IT set up), and read the docs.

**Publishers** — typically engineers at the same company. They write HTML in a Git repo, push, and the docs are live within 40 seconds. The publisher never logs into Rendro directly — they push code, the CLI picks it up.

## The visitor experience

A visitor lands on the Rendro home page (`rendro.example.com`).

1. If they're not signed in, they see a "Sign in with Google" button. No org selection, no URL paths — just one page.
2. They sign in with their work Google account (`alice@acme-corp.com`). Rendro derives their org from the email domain (`acme-corp`).
3. If the org's docs folder exists in the blob store, they see a tree of HTML files. If the org doesn't exist yet, they see a form pre-populated with their org slug to create it.
4. They click a file. The HTML renders as-is — no theme imposed, no sidebar injected, no popups. Whoever wrote the HTML owns the page.
5. They log out by clicking the sign-out link in the top right. The session is gone.

A visitor never sees another company's docs. A visitor from `acme-corp.com` only sees `acme-corp/` files, even if they know the URL of a `startup-io` doc.

## The publisher experience

A publisher works in a Git repo. The repo has a `docs/` folder with HTML files. The structure mirrors the URL — `docs/api/reference.html` becomes `example.com/acme-corp/api/reference.html`.

When they push a change:

1. CI runs the CLI: `rendro push --source ./docs --org acme-corp`.
2. The CLI walks the local `docs/` folder, hashes every file, asks the server which ones are stale.
3. The server replies with the diff. Only changed files are uploaded.
4. Done. The visitor sees the new content within 40 seconds.

The publisher never authenticates to Rendro. They use a CI secret (`DOCSYNC_TOKEN`) that proves the upload is from their CI pipeline. The org is in the URL — the CLI says "this upload is for acme-corp" and the server trusts it because the sync token is valid.

## The product model

### One bucket, many tenants

All HTML files for all customers live in a single object store (MinIO in dev, S3 in prod). The org slug is the prefix:

```
docs/
├── acme-corp/
│   ├── index.html
│   └── api/
│       └── reference.html
└── startup-io/
    └── handbook.html
```

The org slug is the only key. There is no per-org storage account, no separate database, no permission mapping to maintain.

### SSO as a feature, not a setup step

When a customer signs up, the only thing we ask of them is "what's your WorkOS org ID?" — we don't ask them to set up an IdP, configure a domain, or invite users. They bring their own IdP via WorkOS. If they have Okta, they're done. If they have Google Workspace, they're done. The single sign-on is their single sign-on, not ours.

The downside is that each new customer needs their WorkOS org set up with a domain and an SSO connection. We do this once at onboarding, never again.

### Files as the product

The product is "HTML files served under an org subdomain." Not "documents with rich text." Not "pages with comments and search." Files.

This is a deliberate scope choice. By making the unit of value a file, we get:
- **Version control for free** — files are in Git, versioned, branchable
- **Editors for free** — whatever the user wants: VS Code, Vim, Notepad
- **Diff for free** — every change is a git diff
- **Reviews for free** — pull requests, code review, all the Git workflows

The trade-off is that the visitor-facing surface is whatever the publisher builds. We don't give them a template. They write the HTML, the styles, the navigation. This is the same trade-off GitHub Pages or Netlify makes — and it works because the publisher is a developer.

## User guide

### For visitors

1. Open the Rendro home page in your browser — `rendro.example.com`.
2. Click **Sign in with Google**. Sign in with your work Google account (`you@company.com`). No org selection needed — your org is determined by your email domain.
3. If your company already has docs, you land on the doc tree. Files at the top level, folders with a `▶` next to them. Click `▶` to expand a folder; click the file name to open it.
4. The file loads as raw HTML — whatever the publisher wrote, exactly. There is no theme, no sidebar, no popups. The document links use the `/files/` path prefix.
5. To end the session, click **Sign out** in the top-right. Your cookie is cleared; the next request will show the sign-in page again.

### For publishers

1. **Create a `docs/` folder in your repo** and put your HTML files in it. The folder structure mirrors the URL — `docs/api/reference.html` becomes `example.com/acme-corp/api/reference.html`. The first file in the folder should usually be `index.html`.

2. **Scaffold an example** to make sure your layout is right:

   ```bash
   rendro init --source ./docs
   ```

   This writes a sample `index.html` and a few empty sub-folders. Edit from there.

3. **Push the docs to your org:**

   ```bash
   rendro push --source ./docs --org acme-corp
   ```

   The CLI reads `DOCSYNC_API_KEY` from your environment. Get your org's API key from the org creation page — it's shown once when the org is created. The CLI walks the folder, MD5-hashes every file, asks the server which ones are stale, and uploads only what's changed. First push of 100 files might take 10 seconds; subsequent pushes of 2 changed files take under a second.

4. **Put it in CI** so docs deploy on every git push. A minimal GitHub Actions step:

   ```yaml
   - name: Deploy docs
     env:
       DOCSYNC_API_KEY: ${{ secrets.DOCSYNC_API_KEY }}
     run: rendro push --source ./docs --org acme-corp
   ```

   `DOCSYNC_API_KEY` is a per-org CI secret. Each org gets a unique key (`docsk_...`) on creation. The key is tied to the org — it can only upload files under that org's prefix.

5. **Preview locally** by opening any HTML file in your browser. There's no local dev server — it's just HTML, served by `file://` or any static server. Push to staging when you want to see the live version.

### For admins (setting up a new org)

1. The first user from a new domain (e.g., `alice@acme-corp.com`) signs in with Google.
2. Rendro derives the org slug `acme-corp` from the email domain. No docs folder exists yet, so the user sees a "Create your org" form with the slug pre-populated.
3. The user submits the form. Rendro creates the `acme-corp/` folder in MinIO with a welcome page and `rendro push` instructions.
4. The publisher pushes the org's docs via the CLI: `rendro push --source ./docs --org acme-corp --token $DOCSYNC_TOKEN`.
5. Done. Any user from `acme-corp.com` who signs in now sees the org's docs.

No WorkOS setup. No per-org env vars. No dashboard clicks. The email domain IS the org.

## What Rendro is not

- **Not a CMS.** No rich text editor, no media library, no draft state. The publisher writes HTML in their editor of choice.
- **Not multi-user editing.** There's no concept of "Alice is editing this page right now." If two publishers push conflicting changes, the last one wins.
- **Not a wiki.** No cross-linking, no backlinks, no internal search. The publisher builds whatever navigation their HTML needs.
- **Not a collaboration tool.** No comments, no reactions, no notifications. The visitor reads; the publisher pushes.
- **Not identity-aware on the read path.** Once a visitor is authenticated, we don't track which files they read. There's no analytics layer in the product.

## Key product decisions

### Why HTML and not Markdown?

HTML gives the publisher full control. The publisher can include a `<script>` tag if they want live examples, a `<style>` block for one-off styling, or an entire React app. Markdown would have forced us to render through a sanitizing pipeline, which would have meant making choices about what the publisher can and can't do. HTML is a strict superset of "what the publisher can write."

### Why per-org rather than per-team?

An organization is the unit of identity (SSO), the unit of access (one JWT org claim), and the unit of storage (one prefix in MinIO). A "team" inside an org is just a folder. The org is the security boundary; everything else is a content convention.

### Why no database (yet)?

The current product has no state that doesn't fit in either WorkOS (orgs, identities) or MinIO (files). Adding a database would mean a sync story — every change in WorkOS would need to be reflected locally. The current build is fully stateless except for the cache, which is regenerable. When we hit a real need for state (e.g., per-user bookmarks, per-org API keys, audit logs), we add Postgres then.

### Why JWT in a cookie and not in the URL?

Cookies are invisible to the publisher's link-sharing. A visitor can copy a doc URL and paste it in Slack — the recipient sees a login page if they're not signed in, the doc if they are. The publisher never has to think about whether a link contains a token.

### Why 40 seconds?

That's the round-trip time for "push to GitHub, CI runs, files are live." It's the slowest acceptable latency for a documentation product. The actual median is closer to 15 seconds. We could push to "instant" with a webhook from Git, but webhooks add operational burden (retry logic, queue, dead-letter handling) that isn't worth it for docs.

## What a publisher's `docs/` looks like

```
docs/
├── index.html
├── api/
│   ├── index.html
│   └── reference.html
├── onboarding/
│   └── index.html
└── assets/
    └── logo.png
```

Becomes:

- `acme-corp.docs.example.com/` — `docs/index.html`
- `acme-corp.docs.example.com/api/` — `docs/api/index.html`
- `acme-corp.docs.example.com/api/reference.html`
- `acme-corp.docs.example.com/onboarding/`
- `acme-corp.docs.example.com/assets/logo.png` (yes, binaries are fine — the visitor just gets the raw file)

The publisher can put any structure they want. The URL structure mirrors the directory structure. There is no "front matter," no "slug," no "tags." It's just files.
