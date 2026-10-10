# Rendro release gates

Status: **not production-certified**. A passed local check is not authorization to deploy production. Email delivery is parked at the user's request.

## CLI release evidence (2026-10-10)

The public npm `rendro@1.0.0` contains the legacy `--org` / `--repo` sync CLI,
not this repository's `--organization` / `--project` deployment CLI. With the
release owner's approval, `rendro@2.0.0` is now published under `next`; `latest`
remains `1.0.0`. Use the exact version, not unversioned `npx rendro`.

Registry integrity matched the tested release tarball. A fresh, scripts-disabled
registry installation returned version `2.0.0`, exposed the current flags, and
successfully deployed an unchanged document to the disposable dev project
(zero uploaded, one reused). Deployment provenance recorded CLI version `2.0.0`.
The onboarding command is pinned to the package version and explicitly targets
the page's origin, preventing dev onboarding from defaulting to production.
The registry-installed CLI also created/listed/removed a disposable publication;
its anonymous document returned 200 before removal. Dev Worker version
`369c7f88-66d7-4ce6-add1-b787abe3ade7` serves the updated onboarding command.
T3 confirmed the live page contains the exact package pin and origin-based
endpoint. This is functional evidence, not a completed visual/cross-browser gate.
Production endpoint compatibility and rollout approval remain separate gates.

Live QA found that copying 200 unchanged files in one request exhausted the dev
Worker's external subrequest budget. The CLI now batches reuse in groups of 16;
the API rejects larger batches before storage work. A dedicated failure endpoint
also preserves scoped bearer authentication so failed CLI attempts do not remain
in staging. Keep the real GitHub CI regression and failure-state verification in
the release evidence, not only mocked storage tests.

## Automated verification

Run `pnpm verify` (typecheck, lint, complete unit/regression suite, browser asset build, whitespace check) and `pnpm audit --audit-level=high` before a DEV candidate. `.github/workflows/quality.yml` adds these checks for PRs, main/development pushes and manual runs, with read-only repository permission and no deployment credentials. The workflow is a local change until committed/pushed. Requiring its status through branch protection still needs repository-owner configuration.

Run `node scripts/run-permission-qa.mjs` deliberately against the development deployment, never production. Require every expected permission response to match and synthetic fixture cleanup to report zero remaining records. This is not a replacement for real signed-in multi-user browser testing.

## Screen refresh contract

| Screen/data | Entry and repeated navigation | Refresh and writes |
|---|---|---|
| Project list/details, deployment lists | Query Core, 30-second freshness / five-minute inactive retention; fresh membership before retained data is released | Project creation removes project lists, preserving existing details. Deployment/unknown writes invalidate conservatively. |
| Publications | Same bounded cache with fresh membership | Create/remove removes only the affected project's publication queries. |
| People, teams, settings | Fresh organization/permission data | Existing confirmed mutations update/reload their screen; authorization-changing writes invalidate all cached management data. |
| Credentials and private shares | Always fresh; no secrets, credentials or share responses retained | Existing mutation handlers reload the relevant uncached data; unrelated project/publication caches survive. |
| Onboarding | Existing fresh polling; outside enhanced-navigation cache | Actual deployment state drives completion. |
| Every management screen | Public, version-matched SSR-derived controllers/templates; fresh account/membership gate before management reads are released. SSR first load and authenticated-HTML fallback; no private HTML cache | Reconnect, visibility resume or cross-tab writes offer Refresh. Refresh invalidates and reloads only after dialog/write/draft guards permit it. No silent form reset or implied live synchronization. |

Latest implementation and evidence: [management content performance, September 16](MANAGEMENT-CONTENT-PERFORMANCE-2026-09-16.md). The public controller bundle must be rebuilt and its shared shell version bumped when controller/template code changes. Deployment includes the new Convex access/recent-deployment endpoints before the frontend switches to them.

## Required before a production rollout

1. No open critical/high findings. Lower-severity findings require a named owner, exposure assessment, expiry/review date and explicit release-owner acceptance.
2. Full browser evidence for all supported screen states and themes, desktop/mobile widths, keyboard use, reduced motion, long labels, disabled/empty/loading/error states, and supported Chromium/Firefox/Safari versions. T3 Chromium resizing does not establish physical-device or cross-browser compatibility. Screenshot failure is an evidence gap, not a pass.
3. Email sender/domain configuration and real delivery/verification/recovery/invitation tests, unless the release explicitly excludes those features and the release owner accepts the consequences. Currently parked, not passed.
4. Realistic load and real-user latency baselines. Agree numerical p95/p99 error/latency thresholds before rollout; isolated QA timing samples are not thresholds or SLAs.
5. Monitoring configured for client errors, server errors, auth failures, cache/refresh failures and latency, with a tested alert delivered to a named on-call recipient. Worker observability is enabled in configuration, but this does not prove alerting or client monitoring is configured.
6. Backup/restore rehearsal on disposable data, including database/storage consistency, plus an exercised rollback to an identified previous Worker version. Never test restore over user data.
7. Explicit production release approval identifying version, rollback version, rollout fractions, observation duration, minimum sample size, abort thresholds and owner. Start with the agreed small canary; advance only after the observation gate passes, and roll back on breached thresholds. Do not improvise percentages or deploy production before these decisions exist.

## Dependency findings (2026-09-15)

Compatible updates to Hono, the Node adapter, Wrangler and affected transitive dependencies reduced the audit from 12 high findings to **zero critical/high**. Two moderate findings remain in Vitest 3 / `@vitest/mocker` ([advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)). They concern test-server file access, not shipped browser code. Current verification uses `vitest run`, not an exposed test UI/server. Patched versions require a Vitest 4 migration; this is deferred, not silently accepted as risk-free. Release-owner acceptance or migration remains necessary.

Wrangler's optional Workers Types 5 peer differs from the Workers Types 4 peer used by the current authentication toolchain. Typecheck/build/deploy are verified, but reconciling that tooling peer constraint remains a follow-up. No broad authentication-stack upgrade was made merely to silence the warning.

## Release-owner deployment request (2026-10-10)

The owner has explicitly requested review, fixes, merge into `main`, and deployment
of that merged revision to production. This authorizes deployment, not an absolute
bug-free certification or completion of the visual, email, alerting, or restore
gates above. Email remains parked. The deployed production Worker rollback target
was recorded as `1c27ca58-b88b-4d6c-8147-220aef3ca5be`, and a production Convex
snapshot was exported to a restricted local release directory before changes.
No restore was performed over production data.

A fresh audit superseded the September dependency evidence: new advisories affected
Tinypool, Undici, Sharp, source-map-js, and fast-copy. Migrating Vitest/coverage to
4.1.11, updating Wrangler to 4.149.0, and refreshing the affected transitive patch
versions produced **no known vulnerabilities**. The 502-test suite, lint, and
typecheck passed with the new versions. The canonical `pnpm run deploy` now rebuilds
browser assets instead of relying on an earlier build in the operator's checkout.
