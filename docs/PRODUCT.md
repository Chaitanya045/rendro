# Rendro — Product

What the product is, who it serves, and how they use it.

> For how it works, see [docs/TECHNICAL.md](TECHNICAL.md). For how it got here, see [docs/HISTORY.md](HISTORY.md).
> Organizations, projects, uploads, the CLI, API keys, publications, shares and Google sign-in were removed in #286.

---

## What is Rendro?

Rendro renders the docs in a GitHub repository as a navigable workspace with inline comments, for the people who can read that repository.

Nothing is uploaded and nothing is published. Rendro finds the docs in the repository, renders its Markdown and HTML, and re-renders when the branch moves. Who may read a repository's docs, and comment on them, is exactly who may read the repository on GitHub.

## The People

| Who | What they do |
|---|---|
| **Maintainers** | Own the repository and the docs in it. Install the Rendro GitHub App on the repositories Rendro may read (P1). They write and review docs the way they already work: in Git, through pull requests |
| **Readers** | Anyone GitHub lets read the repository: collaborators, organization members and teams for a private repository, everyone for a public one. They read, search and comment |
| **Anonymous visitors** | Read the docs of a public repository without an account. They cannot comment |

Rendro has no roles of its own. A reader's permission on GitHub is the whole permission model.

## Core Journeys

### Sign in

Today: an email and password account, verified by email (passwords are 15–128 characters; recovery by email link). A signed-in reader lands on `/home`, which explains how to open a repository. `/account/security` adds or changes the password.

With P1: **Sign in with GitHub**. Sign-in links the GitHub account, and the GitHub App's installations decide which repositories Rendro can see. See [Status](#status).

### Pick a repository

A repository's docs live at `/r/{owner}/{repo}` (the default branch), `/r/{owner}/{repo}/~{branch}` (a branch) or `/r/{owner}/{repo}/@{commit}` (one commit, immutable). Today the reader opens that URL; with P1, `/home` lists the reader's repositories.

Rendro detects where the docs are. The strongest signal wins:

1. A docs generator's configuration: Mintlify, GitBook, MkDocs, mdBook, VitePress, Read the Docs, Docusaurus, Sphinx (with Markdown pages), Docsify.
2. A conventional folder with Markdown: `docs`, `doc`, `documentation`, `website`, `site`, `guide`, `book`, `manual`, `wiki`, `handbook`.
3. Prebuilt HTML: an `index.html` with at least three HTML pages.
4. The root README.

The first visit to a repository or branch nobody has opened yet shows "Preparing these docs…" while Rendro renders it, then loads the docs by itself.

### Read

- **Sidebar tree**: folders load on demand, with each page's title. The current page is marked, and links between pages move the tree with the reader.
- **Search**: `/` focuses the search box. Results name the page and section, and open in place.
- **In-shell navigation**: pages switch inside the shell, and a likely next page is prefetched on hover or focus. The page is in the URL (`?doc=<path>`), so deep links, Back and Forward work.
- **Shell**: the tree can be resized or hidden (Ctrl/Cmd+Shift+H). On a phone it opens as a drawer, and secondary actions move into a "More" menu. **Copy link** copies the page's URL.
- **Theme**: system, dark or light, saved and shared across tabs.

What renders: GitHub-flavoured Markdown (tables, task lists, footnotes, strikethrough, autolinks, alerts, highlighted code) and HTML pages. Every page is sanitized against an allowlist (no scripts, styles, event handlers or embeds), set in one GitHub-style reading theme and shown in a sandboxed frame. External images load through Rendro's image proxy, so the image host never sees the reader. reStructuredText is not rendered.

### Comment

Select text on any page (or click an element with text) to open a thread.

- Reply, resolve and reopen; the drawer has Active, Resolved and History views.
- Comments update live, and the reader's own comment shows as soon as it is posted.
- A thread stays on its text across commits: it is found again by its section and quote. If the text is gone, the thread is listed as "Anchor no longer found" and never pinned to other text.
- Authors can archive and delete their own threads (with Undo).
- Writes are rate limited per user and per repository.

### Edit

- **Docs** are edited in the repository. A push to a branch re-renders that branch; the docs follow the commit, and an unchanged page keeps its comments exactly where they were.
- **Comments**: authors edit their own threads and replies in place. An edited comment is marked "edited" with the time, and other readers see the new text live.

## Permission Model

| | Read docs | Read comments | Write comments | Edit, archive or delete a comment |
|---|---|---|---|---|
| Private repository: someone GitHub lets read it | Yes | Yes | Yes | Their own |
| Private repository: anyone else | No (the same 404 as a repository that does not exist) | No | No | No |
| Public repository: signed-in reader | Yes | Yes | Yes | Their own |
| Public repository: anonymous visitor | Yes | Yes | No | No |

- Rendro mirrors GitHub's permissions and never asks GitHub on each view. When GitHub removes someone's access, their access to the docs and comments ends too, within minutes.
- Comments on a public repository are public. Author names are shown, email addresses never.
- When a repository leaves the GitHub App, its docs and comments are hidden at once. They are deleted only after 30 days, once GitHub confirms the removal.
- Private repository content is sealed per repository (AES-256-GCM) in storage and in the edge cache, and opened only after the reader is authorized.
- Rendered content nobody reads for 30 days expires, and is rendered again on the next visit.

## Status

| Piece | Status |
|---|---|
| Email sign-in, `/home`, account security | Available |
| Rendering, the read path, search, comments and comment editing | Built and tested against a fake GitHub; not wired in production yet |
| **P1: GitHub App sign-in** | **Pending.** Until it lands there is no GitHub account to link, so private repositories cannot be read, `/home` cannot list repositories, and the landing page's call to action is **Get started** (email sign-up) |

## Out of Scope

- **Uploads and publishing**: no CLI, no API keys, no CI step, no publications or share links. The repository is the source.
- **Rendro-side tenancy**: no organizations, teams, projects or roles. Access follows GitHub.
- **Editing docs in Rendro**: no editor and no drafts. Docs change through Git.
- **Repository scripts and styles**: pages are sanitized; a repository's own JavaScript and CSS do not run.
- **Notifications, reactions and analytics**: no email for comments, no page-view tracking.
- **Custom domains and branding**.
