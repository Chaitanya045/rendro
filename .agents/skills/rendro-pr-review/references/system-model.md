# Rendro system model for reviewers

This is a compact model to reason from, not a list whose items must all appear in every review.

## Boundaries and owners

Rendro is a Cloudflare Worker/Hono application with Convex metadata and comments, Better Auth identity/organizations, R2 immutable document storage, server-rendered HTML, vanilla browser TypeScript, and a Node CLI.

| Concern | Primary owner |
|---|---|
| HTTP route order and edge response | `src/worker.ts`, `src/routes/`, `src/middleware/` |
| Session, organization membership, roles | Better Auth plus `convex/authorization.ts` |
| Projects, deployments, publications, shares, credentials, comments | Convex schema/functions and Worker proxy routes |
| Immutable deployment objects and manifests | R2 helpers, deployment routes, CLI |
| App chrome and management UI | SSR route templates plus vanilla browser controllers |
| Document content | publisher-owned HTML inside an iframe |
| Client server-state cache | `src/management-query/` using `@tanstack/query-core` |
| Generated browser/runtime artifacts | build scripts producing tracked or release-time `public/*.js` and `bin/rendro.mjs` |

The UI deliberately has no React/Vue/Svelte runtime. React can appear transitively in the lockfile through dependencies; that is not evidence that Rendro uses React. Query Core is used directly from vanilla TypeScript.

Public publication/share routes and static browser assets intentionally execute before session middleware. Their safety comes from capability/record validation and the absence of private data, not from route position. Cross-organization navigation intentionally performs a full document navigation; same-organization management navigation preserves the shell.

## Core security invariant

Human-readable slugs and labels orient the user; opaque stored IDs and authenticated context establish authority.

A protected operation normally proves:

```text
session or hashed API credential
  -> organization membership or credential organization binding
  -> role or scope
  -> project belongs to organization
  -> child record belongs to project and organization
  -> R2 prefix/path derives from authorized stored records
```

The exact chain varies by operation, but no client value, hidden UI, cached organization list, optimistic label, email domain, or route slug may replace a server-side link in the chain.

Convex public functions are callable independently of the Worker. Authorization assumptions at the proxy do not protect a public query/mutation/action. Author and actor fields should come from authenticated context. Worker-only paths need an internal function or authenticated internal HTTP boundary.

Public capabilities have narrower invariants:

- publications resolve an indexed public record and its allowed project/path/deployment;
- private shares resolve a stored hash, expiry, revocation state, pinned deployment, and exact allowed HTML path/assets;
- normalized manifest paths—not arbitrary bucket prefixes—bound storage reads.

## State machines worth reconstructing

### Immutable deployment

```text
start/recover staging
  -> upload/copy delta objects
  -> write canonical manifest
  -> verify manifest and required objects
  -> atomically activate project pointer
  -> retain superseded deployment while referenced
```

Retries must be idempotent. A partial upload must not become active. Retention must consider active projects, pinned publications, and unexpired shares.

### Management navigation

```text
user navigation
  -> route-leave guards
  -> destination-shaped skeleton in existing shell
  -> version-matched public controller or authenticated-HTML fallback
  -> fresh access and data requests
  -> paint only while page scope still owns the route
  -> dispose/abort listeners and work on next navigation
```

There should not be a generic first loader followed by the real skeleton. Primary content should not wait for independent history/invitation/optional-selection reads.

### Retained management data

```text
identity-scoped query key
  -> Query Core freshness/deduplication
  -> fresh organization access gate for retained data
  -> page-scope ownership before paint
  -> targeted invalidation around writes
  -> clear on authorization failure/sign-out/page exit
```

Only explicitly approved project/deployment/publication read models are cached. Permission responses, credentials, invitations, shares, secrets, authenticated HTML, and mutation responses are not.

The organization list is a distinct display-only cache: sanitized `id`, `name`, and `slug` can persist in tab-local session storage and remain fresh until an organization/membership mutation, authorization failure, or sign-out. It never proves membership.

### One-time secret

```text
successful creation
  -> render secret once
  -> block every close/navigation path until user confirms storage
  -> clear DOM value and copy handlers
  -> subsequent screens show prefix only
```

### Comments

The browser receives a short-lived Convex identity, but thread/reply authorship and organization/file access are derived and verified server-side. A client cannot select another author or organization. Navigation and status changes must not drop drafts or allow older subscriptions to repaint newer state.

## Scaling dimensions

Reason about the dimension a query or loop follows:

| Dimension | Typical risk |
|---|---|
| organization members/teams | unsupported offset APIs, truncation, per-member lookups |
| projects per organization | unbounded `.collect()`, per-project latest-deployment N+1 |
| deployments per project | history scans, retention fan-out, oversized selection lists |
| files per deployment | manifest buffering, bucket-wide listing, repeated object metadata calls |
| comments/replies per document | thread-plus-replies N+1 and unbounded subscriptions |
| publications/shares | missing project/org index prefix, retention references |
| open tabs/navigation events | duplicate refetches, cross-tab invalidation storms, leaked listeners |
| DOM options/rows/tree nodes | full rebuilds, mutation-observer feedback loops, mobile overflow |

An indexed equality lookup is usually stable; post-query filtering is not an index. `.collect()` is safe only when a real invariant bounds the result or the path is development-only. `.take(n)` silently truncates unless the contract exposes that limit. Pagination needs stable ordering and a continuation path.

For each performance concern, identify the dominant operation and estimate how often it runs. Separate latency hidden by a skeleton from latency actually removed.

## Failure and concurrency probes

Useful counterexamples for this system include:

- membership or role revoked between initial render and cached-data reuse;
- two tabs mutate the same organization while one displays retained data;
- the server commits a mutation and the response is lost;
- an old request resolves after same-shell navigation;
- a dialog closes or page scope disposes during a mutation/poll;
- a cross-organization switch is blocked by unsaved work;
- a staging deployment is retried after partial object upload;
- a share expires between shell render and asset request;
- an organization has more members than a Better Auth page limit;
- a long name, key, path, email, or URL reaches a narrow mobile layout;
- JavaScript, storage, clipboard, popover, or motion APIs are unavailable.

These are hypothesis generators. Search for guards before treating them as bugs.

## Rendering and browser reasoning

Rendro's HTML strings cross multiple parsing contexts. Track the context of every dynamic value: HTML text, attribute, URL, inline JSON, inline script, CSS, or DOM text. The escaping rule differs by context. TypeScript types do not sanitize runtime data.

Static `innerHTML` is not automatically unsafe. The question is whether tenant/user-controlled data flows into it. Prefer `textContent`/DOM construction for such data; inline JSON should be serialized and neutralize `<`.

Browser controllers live longer than individual management pages. Route work uses page scopes, abort signals, version/ownership checks, and cleanup. Model which scope owns every callback, timer, observer, subscription, channel, and event listener.

Visual correctness includes state transitions, not just a screenshot. Consider mobile and desktop, light/dark, keyboard and pointer, reduced motion, long/empty/error content, focus restoration, touch target size, viewport containment, and horizontal overflow. Publisher iframe content remains visually isolated from Rendro theme changes.

Single-value selects use the shared progressive-enhancement component and retain native form values, validation, events, and no-JavaScript behavior. Multi-select semantics remain native. Shared controls should not fork by route without a behavior that truly differs.

## Change-amplification model

Before calling duplication a maintainability defect, identify the future change likely to drift and the consequence of drift. High-risk duplicated knowledge includes:

- organization/project authorization sequences;
- path normalization and R2 key derivation;
- cacheability and invalidation policy;
- SSR loading templates versus browser controllers;
- API request/response/error shapes;
- theme and control interaction states;
- source versus generated browser/CLI artifacts.

Generated outputs are not independent implementations. Review their canonical source, then establish that the correct build/release path reproduces the artifact:

| Canonical source | Artifact | Repository treatment |
|---|---|---|
| `src/commentor/` | `public/commentor.js` | ignored; must build in the release path |
| `src/lazy-tree/` | `public/lazy-tree.js` | ignored; must build in the release path |
| `src/management-query/` | `public/management-query.js` | tracked; regenerate with source changes |
| shared select browser source | `public/select.js` | tracked; regenerate with source changes |
| management page controllers/templates | `public/management-pages.js` | tracked; regenerate with source changes |
| `cli/src/` | `bin/rendro.mjs` | ignored; verify `pnpm cli:build` for package/release |

A tracked source/artifact mismatch or a release path that does not rebuild an ignored artifact is a release defect. Do not demand that ignored bundles be committed. A large minified artifact diff by itself is not evidence of poor maintainability.

## Evidence map

Use tests to challenge the reasoning, not as a checklist:

- auth/session: `session-*`, `auth-*`, `security`, `fail-closed-boundaries`
- roles/membership/teams: `organization-role-ux`, `management-access`, `management-team-members`, `http-authorization-roles`
- deployment/publication/share/API keys: boundary, lifecycle, role, publication, share, and secret-lifecycle tests
- navigation/cache/loading: `management-navigation*`, `management-loading-parity`, `management-performance`, `management-query-cache`, `management-request-waterfall`
- organization switch/list: `organization-switcher`, `organization-list-cache`
- UI primitives/theme/mobile: `shared-select`, control-consistency, theme, mobile, and UI-regression tests
- comments/viewer: document-functional/UI and comment/viewer consistency tests

A security test should include the denied case and a valid control. An async test should control completion order. A scale test should cross a pagination or truncation boundary. A UI test that only searches source text is weak evidence for runtime behavior.
