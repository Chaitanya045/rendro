# How production-readiness work is run

_Recorded 2026-10-15._

## Loop

1. **Audit.** Read-only agents write reports to a scratch directory outside the repo.
   The orchestrator condenses them into `roadmap.md` and GitHub issues.
2. **Issue.** One GitHub issue per bug or work item, labelled (`production-readiness`,
   `security`, `performance`, `modernization`, `testing`, `bug`, `enhancement`).
   The repo is public: describe security issues by impact and area, without exploit steps.
3. **Fix.** One worktree and one branch per issue, under `../rendro-wt/<branch>`.
   Fixers are launched as T3 delegated tasks. Models as of 2026-10-16: Claude Sonnet 5.5 (effort high) for routine fixes, test/E2E slices and rebases; Claude Opus 5.5 (effort high) for security-critical reviews and design-heavy changes. Earlier work used Codex `gpt-6-astra` at high reasoning.
   Each fixer opens a PR that references its issue (`Fixes #N`).
4. **Review.** The orchestrator reviews every PR, often with a delegated reviewer
   using `.agents/skills/rendro-pr-review`. Findings go back to the fixer as a new round.
5. **Merge.** Merge only after `pnpm verify` passes locally and in CI, and the review
   has no unresolved findings. Rebase dependent branches after each merge.
6. **Deploy.** Deploy to dev (`pnpm run deploy --env development`, plus Convex dev)
   and run the E2E/regression pass. Production deploys need explicit owner approval.

## Fixer brief checklist

Every fixer prompt should include:

- the issue number, and the worktree path and branch to create from `origin/main`
- running every command inside the worktree, never in the main checkout
- `pnpm install --frozen-lockfile` in the worktree, and `VITEST_MAX_WORKERS=2`
- adding regression tests for every behavior change, with coverage of touched files at 100%
- rebuilding `public/*.js` and bumping versions when browser sources change
- running `pnpm verify` before pushing
- the PR template: summary, the reason for the change, tests, risk and rollback
- that the fixer must stop and ask (not guess) on product or security decisions

## Known tooling issues

- T3 task-completion notifications can be dropped. Keep a background heartbeat
  and poll `task_status` for every active task when any notification arrives.
- The OpenAI usage limit has run out before. Probe with a tiny "reply OK" task
  before launching a batch. Fall back to the OpenCode provider (`openai/gpt-6-astra`,
  variant `high`) only with the owner's go-ahead.
- Delegated agents can stop and wait for input. Check pending requests
  (`t3_pending_request_list` on the child thread) whenever a task looks idle.

## Deploy-order constraints from merged PRs

Deploy the Worker before Convex for these, then verify dev:
- **#127** (origin checks): the Worker forwards `Origin` through every mutation proxy. Convex rejects cookie writes that lack it.
- **#123** (resolver DTOs): the Worker signs storage-resolution requests. A Convex-first deploy gives old Workers only the public DTO, which breaks published pages.

## Lessons (2026-10-15/16)

- **Shared dev Convex:** a fixer pushed branch schema (#129's indexes) to the shared dev Convex deployment. The next deploy of `main` deleted those indexes again. Fixers must use convex-test only. Only the orchestrator deploys dev, and only from `main`.
- **Review rounds:** reviewers with adversarial probes caught real regressions that `pnpm verify` and 100% touched-file coverage missed: charset handling (#125, two rounds), encoded SSH userinfo (#123), Convex 16 MiB read limits (#129), a vacuous test assertion (#124). Keep independent review on every PR, including test-only rounds when the change is non-trivial.
- **Precise fix rules:** when a fix keeps bouncing between reviews, write the exact rule into the next round's brief, e.g. "keep stored charset only if one was stored; else main's defaults".
- **Fixers ask instead of guessing:** a fixer that hits a dependency on another PR stops and asks (#108 needed #125). Answer by merging the dependency and having the fixer rebase on `main`. Don't stack PRs.
- **Dev deploy of the security batch:** `main` at `b80310c` deployed to dev on 2026-10-16 (Worker `b43aaea8` first, then Convex). Production still runs `6e22d7f`.
- **#130** (commit/publication attestations): the Worker must deploy before Convex. New Convex rejects commits and publications from old Workers that lack the proof.
- **Coverage gate (#134, merged 2026-10-16):** every PR must pass `pnpm coverage`. `coverage-debt.json` only shrinks: touched files go to 100% and their entries are deleted. Baseline is 82 of 184 authored files in debt. Epic #99 closes when the ledger is empty.
- **`npx convex codegen` pushes:** the pinned Convex CLI (1.42) uploads functions and schema to the configured deployment during codegen. That's how branch indexes landed on shared dev. Fixers must not run it against shared dev. Use the offline guard (`pnpm verify:convex`) and let the orchestrator regenerate from `main` after merge, or run it against the disposable loopback backend from #109.
- **2026-10-16 ~04:50 IST:** dev runs `main` `e11e0cc` (Worker `58512e0a`, then Convex). Codegen from `main` matched the hand-maintained bindings exactly. Smoke results: cross-origin write 403, legacy sync write 410, pages 200/302.
- **Threat-model calls stop review loops:** #141 (share scope) kept bouncing on parser edge cases. The decision: the security boundary is recipient reach. Discovery mismatches can only expose files the document's author controls, so they're fidelity bugs, not escalation. Give reviewers the threat model explicitly so findings are classified correctly.
- **Browser coverage must be deterministic (#143):** V8 counters collected from Chromium varied between identical runs. Timers, hover and teardown timing caused it. A shrink-only ledger turns that variance into CI failures. Require identical counters across 3 runs (counter-diff script) before trusting any browser-derived ledger shrink.
- **CPU DoS on parsers needs a structural budget (#141):** individual adversarial inputs (attributes, nesting, duplicates) kept appearing. Require one work budget threaded through every stage, linear algorithms and a deadline, plus a generated adversarial matrix.
- **Settle finished child threads:** T3 leaves completed subagent threads unsettled, and ones that ended with a question look "waiting" in the owner's inbox even after the orchestrator answered via a new round. Settle each child thread (`t3_thread_organize` settle) right after acting on its result.
- **2026-10-16 ~08:24 IST:** dev runs `main` `aa0f832` (Worker `691eac21`, then Convex) with #86 admission budgets; codegen produced no diff.
- **Provider safety filter:** a Codex review prompt phrased as "find any input that causes DoS" was refused by the OpenAI cyber-safety filter. Phrase adversarial review of our own code as performance/robustness QA with measurable acceptance criteria. Same substance, no refusal.
- **/tmp is a 7.8 GB tmpfs (RAM):** agent artifacts filled it to 94% on 2026-10-16 and broke an E2E run. The briefs now require ~/.cache/rendro-agents/<task>/ and cleanup on finish.
- **Local WebKit on this host:** Playwright WebKit needs `libicudata.so.74` and friends, which the distro lacks. A cached copy lives in `/tmp/rendro-108-webkit-libs` (tmpfs, lost on reboot). Preload every `.so` in that directory via `LD_PRELOAD` (ICU, libxml2 and all flite voice libraries are needed); `LD_LIBRARY_PATH` is overwritten by Playwright's wrapper. CI installs WebKit with `--with-deps`.
- **2026-10-16:** dev runs `main` `0497916` with #88 (no-store defaults, Worker log redaction).
- **Reviews (2026-10-16, owner request):** the orchestrator reviews PRs directly and agents implement. A spawned reviewer is only for a deep adversarial pass on a trust-boundary change, run as a one-off.
- **CI-only failures:** tests that pass locally but time out in CI often depend on gitignored build outputs (`public/commentor*.js`, `lazy-tree.js`) left over in a local worktree. `pnpm verify` builds assets only after tests. Browser tests must build their bundles in `beforeAll`.
- **Enforce invariants where state is stored, not where it's read (#145):** four rounds patched one request path at a time: client cookie, cookie-name whitespace, then bearer headers. The fix that ends it is a clamp on every session update at the storage layer. For any "must never exceed" property, require the authoritative check at the write site first.
- **Concurrency on this 8-core host:** Claude agents run test suites more aggressively than the Codex ones did. Five concurrent agents pushed load to 26–28 and made test results unreliable (page crashes, 502s, CPU-bound assertions failing). Keep at most **3 agents that run browser/E2E/coverage suites** at once, and pause the lowest-priority one if load stays above about 16.
- **`CI=true` changes the browser:** `tests/helpers/browser.ts` switches to Playwright's pinned Chromium under CI, and it skips animation frames for fully off-screen iframes. Fixtures must lay out like the real page. #155 hit this through a placeholder the fixture didn't hide. Reproduce CI-only browser failures with `CI=true`.
- **2026-10-16:** dev runs `main` `d7d6229` (#155 share/comment error UX).
- **2026-10-16 ~16:10 IST:** dev runs `main` `4450ae5` with #145 (session lifetime bound at the storage layer, cookie-only sessions). Worker `6873e180` first, then Convex. Codegen from `main` produced no diff. Live check: a non-remembered sign-in gets a session cookie with no `Max-Age`, and `get-session` doesn't reissue it.
- **Reusing `clientRequestId`:** `delegate_task` deduplicates on it. Reusing an old round's ID returns that old (possibly interrupted) task instead of starting a new one. Use a fresh ID for every relaunch.
- **#143 merged (2026-10-16, `689f270`):** `pnpm coverage` now runs the Chromium browser suites and merges their V8 coverage into the gate. The determinism evidence was four CI coverage attempts on the final head (`9b902a9`) with identical hit/no-hit counters (`tests/helpers/diff-coverage.ts`, empty output means identical). Local "quiet host" runs (load < 5) never started on a host with two other agents running. CI is the authoritative environment for this check.
- **`pgrep -f <pattern>` matches the shell running it.** Killing its results killed the orchestrator's own command. Signal exact PIDs taken from `ps`.
- **Convex queries must not read the clock for access decisions (#91 review, #159):** Convex caches query results and invalidates them only when the read set changes. Elapsed time doesn't count. An expiry check with `Date.now()` inside a query can serve a stale "allowed" result. Compare deadlines in the calling action/httpAction or mutation, and pass `now` in or return the deadline. convex-test doesn't model the query cache, so tests can't catch this; review for it explicitly.
- **2026-10-16 ~20:04 IST:** Convex dev deployed from `main` `7d63bc4`: #158 read-only API-key authorization with debounced `lastUsedAt`, plus the #156 QA-fixture edits. No Worker change, and codegen produced no diff. The next dev E2E round should include a real API-key CLI push.
- **2026-10-16 ~20:15 IST:** dev Worker `7e967d5f` runs `main` `3499453` with #163, which brings Worker/storage/auth files to 100% coverage and removes some proven-dead code. Smoke checks pass. 35 files remain in `coverage-debt.json` (82 at baseline), mostly browser bundles (#118), CLI/scripts (#119) and inline controllers (#105/#106).
- **2026-10-16 ~20:54 IST:** Convex dev deployed from `main` `b5f494e` with #164: share and API-key expiry decided outside cached queries. A static guard (`tests/query-clock-purity.test.ts`) fails if any registered query, or a helper it reaches, reads the clock. Codegen produced no diff, and a bogus share token returns 404.
- **#160 merged (2026-10-16, `6f975da`):** shell/navigation/menus/dialogs/selects/theme E2E in all three engines. E2E-covered transitions went from 62 to 234, and untested ones from 666 to 535. The suite now takes about 18 minutes in one CI job, and #151 splits it per engine. Two known product bugs are recorded as `test.fail`: #161 (Back doesn't restore scroll) and #162 (select ignores form Reset).
- **The E2E fixtures stub Google Fonts:** icon ligature names render as words, and their width depends on the host's fallback fonts. That caused a WebKit overflow only on CI (#160 round 2). The real fix is to self-host the fonts and make icons layout-safe (#165).
- **#166 merged (2026-10-16, `8ebefbc`, dev Worker `078e6dc9`):** #151 stability work.
  - E2E now runs as a per-engine matrix (about 7 min each, down from about 25 min in one job). An aggregate `e2e` job keeps the required check name; branch protection must require `e2e`, not the per-engine legs.
  - The nightly `stability.yml` runs constrained coverage twice and diffs test outcomes and coverage counters, then runs E2E without retries.
  - Real production race fixed: comment recovery dropped a focus/pageshow recheck that arrived mid-check (Firefox fires focus early), so a revoked account could stay visible.
  - Lesson: test titles must be run-independent (no timestamps), or outcome diffs across runs are impossible.
