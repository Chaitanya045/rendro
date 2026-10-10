# Management query caching — DEV verification

Implemented TanStack Query Core 5.102.8 without React or a UI rewrite. DEV Worker version: `0efda244-3d1a-4596-b291-d6a42d1e8503`; management shell version 3.

## Policy

- Memory-only cache of project lists/details, deployment lists, and publication lists.
- Keys include signed-in user, organization, endpoint, and project. Unknown endpoints, parameters and foreign organizations/origins are excluded.
- Freshness: 30 seconds. Inactive retention: five minutes. No silent retries or offline-paused navigation.
- Every fresh cache hit awaits a fresh, deduplicated organization-membership check. Authenticated HTML remains uncached and checks the session on navigation.
- Credentials, roles, invitations, private shares, secrets and mutation responses are not cached.
- Writes clear retained data before and after settlement, including uncertain failures. This cancels pre-write reads. Other-tab invalidations and page exit clear the cache. Visibility resume and reconnect invalidate without canceling initial requests.
- Page disposal cancels pending query reads; late responses cannot populate the cache or paint another screen. Controllers receive cloned data rather than mutable cache references.
- Cross-tab messages contain only an invalidation signal, no user data. No persistence, polling, React runtime, or live subscription was introduced.
- Invalidation affects the next read. It does not automatically refresh the currently rendered screen or overwrite an open form. A live-update experience would require explicit observers/subscriptions and draft-safe rendering.
- Shared cache script is preloaded, served before session middleware, and loads once per shell. Failure to load it leaves the existing uncached request path available. Existing shell versions fall back to full navigation to load the new runtime.

## Results

- 324 tests across 41 files passed; TypeScript, ESLint, asset build, and diff whitespace checks passed.
- Added 24 cache tests plus four navigation integration tests: freshness/GC, request deduplication, identity isolation, permission denial, mutation invalidation, errors, cancellation, late responses, visibility/reconnect, and mutable-data isolation.
- Browser bundle: 26,166 bytes minified / 7,909 bytes gzip.
- T3 embedded browser: all nine management screen types checked at actual 1280px and 375px widths. No viewport overflow, JavaScript error, header/theme-controller replacement, second skeleton, or whole-page animation restart observed. Skeleton nodes remained connected through authenticated HTML handoff. Immediate skeleton construction samples: 5–25ms, not a percentile SLA.
- Desktop before/after: People → Projects → People → Projects made two project-list API calls on shell v2 and zero on warmed shell v3 within its freshness window. Both runs still made four full-organization checks and two invitation-list calls.
- Project → Publications → Shares → Project → Publications made one project-detail, one deployment-list, one publication-list, one private-share-list, and five fresh organization requests. Revisited cached endpoints did not refetch.
- Cached navigation still took approximately 1.1–2.0 seconds in observed samples because authenticated HTML and fresh membership remain network-bound. This change reduces API traffic; it does not eliminate that remaining latency.
- Browser fault injection: a simulated 403 withheld cached project rows, showed the error, and recovered with a fresh project read. A simulated failed create POST never reached the server, preserved the draft, re-enabled submission, and invalidated the cached project list. Broadcast-channel invalidation and reconnect triggered fresh reads.
- Mobile theme cycle preserved dark/light/system across navigation without overflow or errors; restored system mode afterward.
- Deployed HTTP permission matrix: 65/65, run `bac8036d96ea46e3`. Deleted 12 synthetic application fixture records; zero remaining, cleanup succeeded. User data was preserved.

## Limits

T3 screenshot capture failed. This is DOM/layout/interaction/network verification, not pixel-perfect, physical-device, or cross-browser certification. No claim that the whole application is bug-free or production-certified follows from this targeted change. Email delivery remains outside the verified functionality. No production deployment or git commit was made.

TanStack's [important defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults) were checked through T3; explicit stale time and invalidation are necessary to achieve the desired reuse. The integration uses imperative Query Core reads, not React hook mount/focus behavior.
