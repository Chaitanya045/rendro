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
- **2026-10-16 ~23:55 IST:** dev Worker `23c4097a` runs `main` `d4a7a92`.
  - It includes #168 (#118 batch A: viewer, lazy-tree, UI and management-query at 100%) and #171 (#165: self-hosted Inter plus a 35-icon Material Symbols subset, CSP `font-src 'self'`, layout-safe icon boxes).
  - Live checks: fonts return 200 `font/woff2` with an immutable cache; a non-allowlisted path under /fonts returns 404; the HTML has no Google font hosts.
  - 23 files remain in `coverage-debt.json`.
- **Asset-version collisions between parallel PRs:** #168 and #171 both bumped `LAZY_TREE_VERSION` to 39 with different bundles. The PR that merges second must take the next version and re-record it. Also merge `scripts/asset-versions.json` as a union of both sides, never with "take theirs", or the other branch's new entries are lost. For `tests/ui-transitions.json`, do a per-edge three-way merge and recompute the family statuses (`tests/ui-transitions.test.ts` checks them).
- **#172 merged (2026-10-17, `58bfcf5`; dev Worker `5042dac4` plus Convex):** subprocess V8 coverage (CLI, server, scripts) is now merged into the gate, and every cli/shared/scripts file is at 100%. Only the 8 src/commentor entries remain in `coverage-debt.json` (#118 batch B).
  - Lesson: tests that run repository scripts inside fixture repos must clear CI-provided env vars such as `ASSET_VERSION_BASE`, or they look up commits the fixture lacks. CI only exposes this; local runs pass.
- **2026-10-17 ~05:30 UTC (about 11:00 IST), API outage:** all three running Claude agents (#118B, #112, #90) failed with "Claude gave up after repeated API errors". Their work was intact in the worktrees, committed or uncommitted. Recovery: a tiny "reply OK" probe (`mode: wait`), then takeover tasks pointing at the existing worktree and commits. Takeover prompts should name the commits and uncommitted files, and say exactly where the previous agent stopped.
- **#173 merged (2026-10-17, `94c8a1a`, dev Worker `d4226774`):** #90 per-deployment path and directory index (`index/v1/` beside the manifest; hash-sharded with a secret per-deployment salt; root written last) plus a byte-bounded per-isolate cache of immutable metadata only.
  - Asset lookup at 100k files dropped from 15.6 MB to 24 KB. The tree's first page dropped from 450 requests and 7 GB to 1 request and 5 KB. The tree now pages and loads directories lazily (`lazy-tree.js` v41).
  - Worker-only deploy. Deployments without an index fall back to the manifest.
  - Follow-up: share/publication creation and the deployment check/commit still read the full manifest; acceptable for now.
- **#175 merged (2026-10-17, `e4f0522`):** #112 E2E for organizations, onboarding, people, invitations and teams. 110 edges moved to e2e credit. The registry now has e2e=344, browser=75, unit=47, untested=424 (from 666 untested at baseline).
  - The suite pinned 6 real product bugs as `test.fail` "(known bug)" tests: #176 (security: members can list invitations; slug format only checked client-side) and #177 (UX).
  - Pattern that works: an E2E slice is the cheapest way to discover authorization gaps at the product level.
- **Escalation to Opus (2026-10-17, owner policy):** #118B's coverage of the commentor browser code stayed nondeterministic in CI across 3 Sonnet rounds, with a different set of uncovered statements each time, while local runs passed. Moved it to Opus with an evidence-first method: download the CI coverage artifact, diff it against a local `CI=true` run, then find the test that should cover those lines.
- **`main` was red from flakes:** `failOnFlakyTests` turns any retry-pass into a failure. That's intended, but each new flake then blocks every PR. Seen so far: the lazy-tree navigation-confirmation browser test, and the org-onboarding select option hiding mid-click (#179). Fix flakes promptly, ideally in the PR that hits them first, and track the rest as issues.
- **#180 merged (2026-10-17, `eb02600`; Convex dev deployed, codegen produced no diff):** #176.
  - Only owners and admins can read an organization's invitation list. A Better Auth after-hook does a fresh role lookup. Members get 403 from `list-invitations` and `invitations: []` from `get-full-organization`.
  - Slug format is validated on organization create and update. Legacy slugs can be resubmitted unchanged.
  - Live dev check with the test accounts: the member gets 403 and 0 invitations; the owner gets 200 and 2.
- **MILESTONE (2026-10-17, `a074f08`, dev Worker `188a66e5`): `coverage-debt.json` is EMPTY.** Every authored source file is at 100% statements, branches, functions and lines in the merged Node + Chromium + subprocess report. Totals: 10,468/10,468 statements and 7,453/7,453 branches.
  - #174 closed out #118 batch B. Opus (round 3) found the CI-only coverage drift: Playwright's fake clock was installed but not paused, so the widget's short timers (150–450 ms) raced test steps on slow runners. The fix was `pauseClock()` before timing-sensitive steps and waiting on the widget's own animation frame.
  - The same round found and fixed a real tree bug (#169 part 1): overlapping navigations could highlight a different document than the one shown (lazy-tree v42).
  - Next for epic #99: the remaining E2E slices (#113, #114, #115), inline controller extraction (#105, #106), visual/a11y baselines (#120), then make the 100% gate required (#121).
- **#181 merged (2026-10-17, `c66becd`; dev Worker `ed103d23` + Convex):** #177.
  - Expired invitations show as Expired, decided client-side from `expiresAt`.
  - Blank team names are rejected in the dialog and by server hooks.
  - Remove team is disabled on the last team.
  - Team writes cancel in-flight roster reads, so a refresh never reuses a pre-write read.
  - Follow-up #182: the same treatment for the session's active team.
- **#183 merged (2026-10-17, `654d59b`, dev Worker `3e4c2ccd`):** #161 and #182.
  - Back/Forward in the management shell restores the saved scroll position after the destination finishes rendering. User scrolling wins, and a newer navigation cancels the pending restore. Reload and back-forward-cache restores go through `pagehide` state and `history.scrollRestoration = "manual"`.
  - "Remove team" is disabled for the session's active team.
- **#184 merged (2026-10-17, `289e0b0`, dev Worker `91b543aa`):** #179 was a real product bug. The enhanced select closed on a late scroll event (browsers deliver scroll events a frame later), so a click during scroll settle lost the popup. Scroll now closes it only if the trigger actually moved. Evidence came from CI trace artifacts, because it couldn't be reproduced locally in 65 runs.
  - Lesson: when a flake won't reproduce locally, download the CI trace or screenshots and write a deterministic browser test of the suspected sequence.
  - New flakes surfaced by that run went to #185.
- **#186 merged (2026-10-17, `d19e95f`):** #113 E2E for projects, deployments, API keys, shares and publications in all three engines. The tests confirm that revoking a key or share stops the very next request.
  - Registry now: e2e=428, browser=137, unit=47, untested=279 (from 666 untested at baseline).
  - 4 validation bugs went to #187.
  - Lesson: a CLI run in CI records the commit SHA, while a local run doesn't. Tests that assert CLI-derived text must accept both, or control the env.
- **Cancelling an agent does not stop its detached scripts.** The cancelled #113 agent left a `run-gates.sh` (reparented to systemd) that ran full three-engine E2E for over an hour and pushed host load to 27. After every cancel or finish, find processes whose cwd or cmdline references that worktree or its `~/.cache/rendro-agents/<task>` directory, and stop them by exact PID.
- **Speed policy (2026-10-17):** agents spent hours waiting for host load to drop below 10 before running the full three-engine E2E suite locally. With 3 agents running, it rarely does. New rule in the fixer brief: locally, run only the specs you touched (new specs ×3) plus verify/coverage. The full per-engine suite runs in CI on clean runners, and nothing merges unless CI is all green. A local failure in an unrelated spec under load is not a blocker unless CI shows it too.
- **#188 merged (2026-10-17, `ff5a87f`, dev Worker `4915c084`):** #185 + #162.
  - Firefox sign-out flake: the button moved when the skeleton was replaced, so the click was lost. Fix: wait for `aria-busy=false` before clicking. Old test failed 14 of 20 under load; fixed one passed 20 of 20.
  - Widget resolve/reopen flake: the test settled a request before it reached the host. Fix: `Lab.release()` waits for arrival. This root cause came from reading the code; the flake was not reproduced locally.
  - #162: a user-activated form Reset restores controls only after microtasks have run, so the select now also syncs with `setTimeout(0)`.
  - Watch item: the E2E `pooled` fixture's setup takes about 26 of its 30 seconds under local load. If CI starts timing out there, budget that setup separately.
- **#189 merged (2026-10-17, `8c2fba9`; Convex dev, then Worker `c89b072b`):** #187 server-side input validation.
  - Ill-formed Unicode (lone surrogates) is rejected with 400 in both the Worker body-admission middleware and the shared Convex `httpAction` wrapper, so it applies to every JSON route, including Better Auth.
  - Length limits: organization and team names at most 80 characters, publication title at most 100, description at most 500.
  - API key expiry must be a safe integer in the future, at most 366 days ahead; scopes are de-duplicated.
  - Live check: a lone-surrogate sign-in body returns 400.
- **#192 merged (2026-10-18; Convex dev plus Worker):** #89 part B.
  - Every GitHub Action is pinned to a commit SHA, `persist-credentials: false`, and permissions are set per job. `tests/workflow-supply-chain.test.ts` enforces all three.
  - `release.yml` runs the full gate through the reusable `quality.yml`, then publishes SHA256SUMS with build-provenance attestation. Its first real run will be the first `v*` tag.
  - Dependabot added for the pins.
  - CLI: `--dry-run`, an expanded default list of sensitive files skipped, and https-only endpoints except loopback.
  - Shared `constantTimeEqual`/`bearerMatches` now used for the retention, migration and internal secrets, the purge token and share links.
- **#190 merged (2026-10-18, `9b5e2a0`):** #114 E2E covering the viewer tree, fragments and link confirmation, viewer chrome, and private/publication/share viewers in all three engines.
  - Registry: e2e=507, untested=219 (666 at baseline).
  - Found 5 bugs, now #191.
  - WebKit lesson: pause Playwright's clock only after the first document's load event has fired. Pausing earlier freezes the load progress timer in WebKit.
- **Dependabot is live** (from #192). Its grouped Actions PRs run the full gate, plus the stability and release gates, because they touch workflows. Review major-version bumps individually.
- **Pending questions hide behind "working":** #89A waited about 1.5 hours on an AskUserQuestion, and `task_status` still showed `workState: working`. Check each running child's `pendingRequestCount` (`t3_thread_read`) on every heartbeat, and answer through `t3_pending_request_respond`.
  - Decision recorded: the viewer drops Tailwind utilities for plain CSS with design tokens (about 25 classes). Reasons: no Tailwind 3 dependency, since its `braces` advisory has no fix, and no audit exception. This matches the target stack in epic #101.
- **#193 merged (Dependabot, 2026-10-18):** GitHub Actions major bumps: checkout v7, setup-node v7, cache v6, upload-artifact v7, download-artifact v8, pnpm/action-setup v6, action-gh-release v3. Every gate job passed. The release `publish` job (gh-release v3, download-artifact v8) is still untested until the first `v*` tag.
- **Load threshold relaxed to about 22 (2026-10-18):** CI is now the authority for full-suite results (see the speed policy), so local load only slows agents down; it no longer threatens correctness. Four agents typically run the host at 15–20. Pause one only if load stays above about 22, or if an agent's local touched-spec runs keep timing out.
- **#196 merged (2026-10-18, `a23baf6`):** #115 comments and recovery E2E. No product bugs found.
  - All six E2E slices (#110–#115) are now done.
  - Registry: e2e=554, browser=81, unit=47, untested=210.
  - The remaining untested edges are spread over about 50 families. They were split into gap sweeps: #197 auth/landing, #198 management, #199 viewer/comments.
  - Each sweep uses the cheapest test level that genuinely asserts an edge, and may remove edges that can't be reached, with a justification.
  - After the sweeps: #105/#106 controller extraction, #120 visual/a11y, #121 require 0 untested plus 100% coverage in CI.
- **#195 merged (2026-10-18, `bf0df90`, dev Worker `03956ae2`):** #95. Public static files are served before the session middleware, from one exact allowlist.
  - Bundles are immutable only for the exact current `?v=`; any other version gets the current bytes with `no-store`.
  - The ASSETS catch-all is removed, so unknown paths return 404.
  - Session RPCs per document page load dropped from 2 to 1/3 (see the PR table).
  - Live check confirmed the headers. `commentor.js` is now in the ledger at v46.
  - Follow-up #200: an intermittent upload 500 seen in E2E.
- **#194 merged (2026-10-18, dev Worker deployed):** #191 viewer/tree fixes.
  - Closed folders are `inert`, and open folders size to their content with a grid-rows transition.
  - External links ask for confirmation and then open in a new `noopener` tab.
  - Menus close when the document is clicked. Firefox fallback: a `doc-pointer` postMessage, accepted only from the content frame.
  - `returnTo` carries a validated `doc`/`docQuery`, with open-redirect denial tests.
  - Follow-up #202: the share viewer still has no external-link confirmation.
- **#204 merged (2026-10-18, `992478f`):** #198 management transition sweep. 81 of 223 in-scope edges were untested; now 1 is (a pinned known bug).
  - One design-note edge was removed, and four edges were reworded because their paths are unreachable (no Cancel button on create-organization, a default team always exists, the last team can't be removed, onboarding offers only two scopes).
  - The sweeps found #205: verify-email shows success for invalid tokens, and onboarding reads the wrong commit field.
  - Lesson: new browser tests can pass in `verify` yet fail in the CI `coverage` job, because the instrumented browser is slower. Run new browser tests once under `CI=true pnpm coverage`, not just `verify`.
- **#203 merged (2026-10-18, `50d5e5c`):** #197 auth/landing transition sweep. In-scope untested edges went from 52 to 1. Registry-wide: e2e=594, browser=135, unit=85, untested=78 (666 at baseline).
  - Lesson: the coverage collector can't attach to a browser context with JavaScript disabled, so no-JS tests must run without collection, or as E2E.
  - The second-tab sign-out flake (`shell-menus.spec.ts:170`) recurred on WebKit; #185 was reopened.
- **#207 merged (2026-10-18; dev Worker deployed):** #205. `/verify-email` with any `error` shows "invalid or has expired" plus the resend form, even if `verified=1` is set. Onboarding reads `provenance.source.commit`. Live check passed.
  - Lesson: new icons must be in the committed Material Symbols subset, or `verify:fonts` fails. Reuse existing icons, or regenerate the subset deliberately.
- **#201 merged (2026-10-18, `105ae26`; Worker `f73cb2fb` deployed first, then Convex; codegen produced no diff):** #89 part A.
  - Session cookies are now `__Host-better-auth.*`, with a migration from `__Secure-` that logs nobody out. #145 lifetimes are preserved.
  - The viewer's Tailwind CDN is replaced by a 1.4 KB self-hosted stylesheet (2,548 element snapshots, 0 diffs).
  - Strict nonce CSP with `'strict-dynamic'`, plus COOP/CORP same-origin on trusted shells and CORP on `/api`.
  - Live dev check: new `__Host-` cookies with no Max-Age when not remembered; a legacy-named cookie works and is re-issued while the old name expires; CSP and COOP/CORP headers present.
  - Playwright quirk: with COOP, Firefox automation drops emulated media on the first navigation into the new browsing-context group, so tests must navigate before calling `emulateMedia`.
  - Follow-up: remove the legacy cookie read after the production migration window (new issue, alongside #149).
- **#209 merged (2026-10-18, `573bdd8`, dev Worker `329fa54e`):** #94 delivery.
  - Strong ETags (`sha256-<manifest hash>`) with 304, single-range 206/416 read from storage as ranged GETs, `If-Range`, and HEAD that doesn't touch storage. All of it runs after authorization, so denied requests get a plain 404 with no validators.
  - Public HTML now streams through the bounded injector: 8 MiB peak memory went from 44 MiB to 3.2 MiB, and it now preserves bytes, which fixes non-UTF-8 pages.
  - Transformed HTML is never ranged.
  - Flake #210 (cookie-migration on Firefox) was surfaced; the job was rerun once to unblock this unrelated PR.
- **#206 merged (2026-10-18, `ac516b9`, dev Worker `448841e0`):** #199 viewer/comment transitions, #202 share external-link confirmation, and the UI-100-E09 fix.
  - Shares now ask before opening an external link, through the same parent-owned prompt as the private viewer (`src/viewer/navigation-notice.ts`). The parent re-validates the href.
  - The prompt's styles live in the nonced shell CSS, with no inline styles, so it's CSP-clean.
  - E09 fix: `grid-template-columns:minmax(0,1fr)` on `.tree-folder-collapse`.
  - Versions: lazy-tree 45, private-viewer 17.
  - Untested transitions: 3 (UI-006-E04, UI-115-E03 reply time, UI-134-E03 comments-list scroll). The last two are pinned product bugs and get a follow-up fix.
  - Review step: the PR was based on `105ae26`, but main had moved on (#209 also touched `share-v2.ts`). I trial-merged into a temporary worktree and ran typecheck plus the registry test before merging. That's a cheap check when GitHub says CLEAN but the base is stale.
- **Active agents (2026-10-18, after #206):**
  - #185+#200 stability (Sonnet).
  - #96 takeover (Sonnet).
  - #210 cookie-migration flake (Sonnet, `fix/210-cookie-migration-flake`).
  - The two pinned commentor bugs: reply time and scroll keeping (Sonnet, `fix/commentor-reply-time-scroll`).
  - Queued for Opus when a slot frees: UI-006-E04 (a 503 with Retry-After when the backend is down, instead of a false 404) and UI-134-E03 (an expired verification token shows recovery with a resend form, without account enumeration).
- **#212 merged (2026-10-18, `fbbf56f`):** main had gone red after #206+#209. Both PRs passed CI on their own bases, but #206 added a stream-errors case that expected buffered public HTML (a 503), which #209 had just replaced with streaming.
  - Lesson: a semantic conflict that auto-merges cleanly only shows up on main CI. Check main's run after every merge, not just the PR's.
  - #211 (#96) was rebased with `gh pr update-branch --rebase` once its agent had finished.
- **New flake:** `e2e/shell-selects.spec.ts:303` on Firefox (select closes on scroll…), seen in #213's CI. Routed to the #185/#200 stability agent.
- **Research:** "GitHub docs viewer performance" report at `/home/chaitanya/work/rendro-audit/reports/GitHub docs viewer performance.md`, notes in `rendro-audit/research_notes/`. It's kept outside the public repo on purpose. It feeds the GitHub-pivot epic.
- **#211 + #213 merged (2026-10-18, `e819059`, dev Worker `4269d3de`):**
  - #96: hidden tabs pause ticket renewal and comment-token refresh, and comment pins are laid out in one read-then-write pass. 500 pins went from 598 ms to 1.8 ms per frame.
  - #210: the cookie-migration spec now observes the wire. Firefox lists cookies that are already expired, so it was never a product race.
  - Versions: private-viewer 18, commentor-parent 17, commentor 47.
- **Pivot epic #214 created (2026-10-18).** #100/#101 are commented as on hold.
  - Sub-issues: #215 (P3a, the ingest content pipeline: detection, render, sanitize, sidebar) and #216 (UI-006-E04, 503 instead of 404 when the backend is down).
  - Running: Opus on #215, Sonnet on #216, Sonnet on the commentor bugs, Sonnet on #185/#200 stability.
  - P1 (GitHub App sign-in) waits for the owner to create the GitHub App and decide on account migration.
- **Main CI green on `e819059`** (2026-10-18): all six jobs pass across three engines. This is the first fully green main since #201.
- **Pivot work started in parallel (2026-10-18):**
  - #220 P3b ingest orchestration (Opus; fake GitHub behind a `GitHubSource` interface; render-then-flip, Durable Object single flight, reconciliation).
  - #221 native R2 binding replacing the S3 keys (Sonnet).
  - Together with #215 (Opus), everything except P1 sign-in is unblocked. P1 needs the owner to create the GitHub App (offered: a manifest link, one click).
- **#218 merged (2026-10-18, `4439ad0`, dev Worker `5aea85e8`):** fixes #185 and #200 plus two flakes.
  - WebKit drops a click when the pressed text node is replaced before release, so labels must be updated in place (`RendroUI.setOrganizationChrome`). That was a real product bug.
  - Tampering with only the last base64url character of an HMAC can leave the token valid (unused bits; 6.6% of the time). Tests must flip a middle character (`tamperedToken`).
  - Inject test probes only after `.loading-view[aria-busy]` clears (`pageSettled`).
  - Transient storage faults now return 503 + Retry-After via `src/storage-fault.ts`, and the CLI replays idempotent requests (max 3).
  - Management shell version 29.
- **#219 merged (2026-10-18, `243f09f`):** UI-134-E03 is credited with the existing expired-link tests. Untested edges are down to 2: UI-006-E04 (#216, in progress) and UI-115-E03 (#217, being fixed). Registry-only change, no deploy.
- **#222 (#215 ingest content pipeline) reviewed (2026-10-18), waiting on CI.**
  - Choices: comrak WASM (robust against pathological input; micromark is quadratic on hostile input, extrapolating to about 700 s), lowlight/highlight.js with class output (8× faster than Shiki's JS engine), and a hast-util-sanitize allowlist over parse5 with a fixed-point re-parse check.
  - About 6 ms/doc in workerd.
  - Follow-ups filed: #223 (build our own comrak WASM; the npm package has one maintainer and is two months old) and #224 (image proxy so readers' IPs aren't exposed to third-party hosts).
- **#222 merged (2026-10-18, `ca71c6b`):** closes #215. `src/ingest/` holds the content pipeline. Not on the request path, the Worker bundle is byte-identical, so no deploy.
- **Housekeeping (2026-10-18):** pruned agent worktrees from 53 to 8, keeping only active ones plus 3 that are unmerged or dirty (`perf/96` was rebased on GitHub, so its local branch is not an ancestor; `review-155-2`; `test/113`). Rule: remove a worktree only if it is clean and its branch is an ancestor of origin/main.
- **Lesson (2026-10-18):** an agent can end its turn on "X is running, I'll check later" after the background job has already died. Its task then shows completed with no PR. Verify the process exists (`readlink /proc/<pid>/cwd` maps a process to its worktree) and nudge it to push and let CI run the gate.
- **#225 merged (2026-10-18, `a4c11b4`, dev Worker `1db171d1`):** closes #216 (UI-006-E04).
  - Every delivery surface now answers a retryable 503 with Retry-After and `no-store` when the backend is unavailable, through one helper (`src/routes/viewer-unavailable.ts`). Denied requests stay a plain 404, and a 503 only follows authorization.
  - Storage reads have a 10 s deadline.
  - The recovery page asks the shell to reload the frame (`doc-retry`, source-checked), because a sandboxed frame's link carries no cookie.
  - E2E fault injection happens in the Node harness's outbound fetch (`e2e/faults.ts`), never in the product Worker.
  - Untested edges: 1 (UI-115-E03, #217).
- **#224 image proxy started (2026-10-18, Opus, `feat/224-image-proxy`):** HMAC-signed same-origin `/img/<sig>/<url>`, SSRF guards, streaming size cap, sandboxed SVG, Cache API. It needs `IMAGE_PROXY_SECRET` on dev; I'll set it when merging.
- **CI timeout risk (2026-10-18):** #217's WebKit job was cancelled at the 30-minute job limit (main WebKit takes about 21 min). Filed sharding as an issue. The agent re-ran it.
- **#217 merged (2026-10-18, `47c2b4b`, dev Worker `c5312e55`), a milestone:** replies show their age, and the comments list keeps the reader's place without drift (it remembers the restored offset, so 1px rounding never accumulates). Commentor version 48.
  - **Zero untested UI transitions:** all 892 edges asserted (605 e2e, 187 browser, 100 unit).
  - #228 (mine) enforces zero-untested in the registry test. It is mutation-checked.
- **WebKit E2E took 29.5 of 30 minutes** on #217's rerun. #226 (sharding) is assigned to Sonnet as urgent.
- **#227 (#221 native R2) first review (2026-10-18):** bundle −28.8%, MinIO/S3Proxy gone, retention moves to a Worker cron.
  - The real buckets are `rendro-docs` (production) and `dev-rendro` (development); the PR had guessed `rendro-docs-dev`. Check with `npx wrangler r2 bucket list` and `r2 bucket info`.
  - Dev rollout after merge:
    1. Set `RETENTION_SECRET` on the dev Worker, piping the value from `convex env get` so it is never printed.
    2. Deploy.
    3. Verify documents are served.
    4. Only then remove the `MINIO_*` Worker secrets.
    5. The owner revokes the R2 API token and removes the GitHub `R2_*` secrets.
    6. The bucket-privacy workflow needs `CLOUDFLARE_ACCOUNT_ID` plus a read-only R2 token as repo secrets (owner).
- **Silent revert caught in review (2026-10-18):** #229 (#220 ingest) commit `10233e5` deleted or rewound all of #225 (backend-unavailable source, tests, E2E and registry credit) while staying CI-green, because the reverted state is self-consistent. Detect it with `git diff --name-status $(git merge-base origin/main BR) BR` and look for D/M on files outside scope. Added a scope self-check section to the fixer brief. Use `git ls-tree -r --name-only` for file presence; a `cat-file -e` check chained with && and || misreported.
- **#230 merged (2026-10-18, `2a980c2`):** closes #226. E2E now runs 2 shards per engine: worst shard WebKit 1/2 at 20m of 30 (was 29.5m unsharded), with a 60% duration warning and merged reports. Stopgap #232 closed. Follow-up: balance the shards (1/2 is about 2x 2/2 for every engine), assigned to the same agent.
- **#229 merged (2026-10-18):** closes #220, P3b ingest orchestration.
  - GitHub source with ETag/304, pacing and a streaming tar reader; render-then-flip with a pointer compare-and-swap; a Durable Object per repo for single flight, dedupe and forward-only flips; queue consumer; reconciliation cron.
  - Measured: first import is 3 GitHub requests; a 2-page push is 5; a duplicate is 0. In workerd, queue to served took about 2.3 s for a first import and 1.2 s for a push.
  - Dev/test only (`wrangler.ingest.toml`); the product Worker is unchanged.
  - Root cause of the #225 revert: `git reset --soft origin/main` for a squash right after `origin/main` moved. Squash onto `$(git merge-base HEAD origin/main)` instead.
  - Open items for P4/P1: a per-installation rate budget; rendering inside the Durable Object hits about 8.7 s on hostile pages, so split renders into per-blob queue messages before production.
- **P4a started (2026-10-18):** #234, the authorized snapshot read path (capability cookie, memory → Cache API → R2, immutable SHA headers), Opus, `feat/234-snapshot-read-path`. Needs `REPO_CAPABILITY_SECRET` on dev at merge time.
- **Model policy update (2026-10-18, user):** free OpenCode models are allowed: `opencode/glm-5.3-flash-free` and `opencode/deepseek-v4.1-flash-free` (high), falling back to `opencode-go/glm-5.3-flash`. First trials: GLM on #235 (drawer-scroll E2E flake), DeepSeek on #223 (our own comrak WASM).
- **Free-model trial (2026-10-18):** `opencode/glm-5.3-flash-free` failed immediately with "Upstream request failed: Endpoint is unavailable" and touched nothing. #235 was relaunched on `opencode-go/glm-5.3-flash` (the user's Go subscription) with the worktree command built into the prompt. Always put the worktree setup in OpenCode prompts.
- **Reasoning effort (2026-10-18, user):** always pass `options: {variant: "high", agent: "build"}` for OpenCode targets. `opencode-go/glm-5.3-flash` has no default. Verify with `t3_thread_configuration`.
- **#227 merged (2026-10-18, `498df98`):** closes #221. The dev Worker `b6946687` is on the native R2 binding (`STORAGE` → `dev-rendro`) with a nightly cron at 03:23 UTC. Bundle 1786 KiB (gzip 345, −28.8%).
  - `RETENTION_SECRET` was freshly generated and set on both Convex dev and the dev Worker; never printed.
  - Verified live: signed in as the E2E owner; the docs tree and a private document come from R2 (200), anonymous gets 404.
  - Old `MINIO_*` dev Worker secrets are kept for the rollback window. They become useless once the owner revokes the R2 API token.
  - Owner actions:
    1. Revoke the R2 API token.
    2. Delete the GitHub `R2_*` secrets.
    3. Add `CLOUDFLARE_ACCOUNT_ID` plus a read-only R2 `CLOUDFLARE_API_TOKEN` for the daily bucket-privacy check, which fails as "NOT verified" until then.
    4. Decide whether to keep `scripts/migrate-legacy-tenancy.ts`.
  - Lessons:
    - An agent's decision question can be **aborted** without reaching me (#221 said "the decision question was aborted"), and the agent then picks its own default. Ask agents to put decisions in the PR body too.
    - The same agent ran a broad `pkill -f` despite the brief.
- **#228 merged (2026-10-18):** the registry test now fails CI on any untested UI transition (#121, partly).
- **Free models, user preference (2026-10-18):** use `opencode/glm-5.3-flash-free` and `opencode/deepseek-v4.1-flash-free` (high) first. GLM free still answered "Endpoint is unavailable" on a probe at about 17:30 IST, so #235 moved from the Go GLM to DeepSeek free (takeover). Re-probe GLM free with a "reply OK" wait task before each use; use the Go sub only when both free ones fail.
- **#233 merged (2026-10-18):** E2E shards are balanced with `fullyParallel` plus `PWTEST_SHARD_WEIGHTS=47:63` (internal Playwright variable, guarded by a repo test). Every shard takes 11.6–14.8 min, under 50% of the 30 min limit. Retune the weights when the duration warning appears.
- **#231 merged (2026-10-18, `2f4a113`, dev Worker `e1d2df43`):** closes #224. Signed same-origin image proxy `/img/<sig>/<b64url>` with SSRF guards (blocked v4/v6 ranges, metadata/local names, no ports or creds, max 3 redirects each re-checked), a 10 MiB streaming cap, sandboxed SVG and fail-closed rendering. `RENDERER_VERSION` 2. CORP is `cross-origin` (required: sandboxed frames have an opaque origin). `IMAGE_PROXY_SECRET` set on the dev Worker. The agent's CORP question 'didn't go through', the second aborted question today; ask agents to also state decisions in the PR body.
- **GLM 5.3 Flash free is back (2026-10-18 ~18:15 IST, probe OK):** assigned #238 (Firefox flakes in auth.spec:75 and comments-journeys:15), high.
- **GLM 5.3 Flash free is intermittent (2026-10-18):** the probe answered OK, then the #238 task failed with "Endpoint is unavailable" a minute later. #238 moved to DeepSeek free, which runs 3 tasks concurrently (#223/#237, #235, #238). Treat GLM free as best-effort.
- **Provider outage (2026-10-18 ~18:45 IST):** DeepSeek free dropped all 3 tasks (#235, #238, #223/#237) with "Cannot connect to API". New user rule: on provider errors use only `opencode-go/glm-5.3-flash` high, otherwise Sonnet 5.5 high. #235 and #238 were relaunched on Go GLM high as takeovers. #237 was already pushed and green.
- **#237 merged (2026-10-18):** closes #223. comrak 0.56.0 is built ourselves as reproducible WASM (path remapping, pinned toolchain and wasm-bindgen, `--locked`); the committed artifact plus sha256 is checked by `pnpm verify:wasm`, and the CI `comrak-engine` job rebuilds and compares bytes. Output is byte-identical to the npm build over 5,009 inputs, the slowest hostile input went from 1306 ms to 962 ms, and the WASM from 2.32 MiB to 360 KiB. The first work by a free model (DeepSeek V4.1 Flash) was excellent.
- **Stash collision (2026-10-18):** `git stash` is shared across worktrees. My `stash/pull/pop` and a takeover agent's `stash/rebase/pop` interleaved, so each popped the other's changes. Repaired by swapping the diffs. New rules: agents never use `git stash` (in the brief); the orchestrator updates main with `cp notes /tmp; git checkout -- notes; git pull --ff-only; cp back`, never stash. Also, a concurrent `git fetch` in a worktree can make `pull` fail with "cannot lock ref"; just retry.
- **#239 (#234 P4a) first review (2026-10-18):** the design is approved. Requested change: the repo frame CSP had `img-src origin https:`, which would defeat #231's proxy backstop; it must be `'self'` only, plus tests. Measured on workerd: a cached private view is about 2–4 ms over the floor, an R2 miss about +5.5 ms, a cookie miss about +6 ms. `REPO_CAPABILITY_SECRET` must be set on dev at merge. zsh gotcha: `$b:src/...` is parsed as a zsh modifier, so write `${b}:path`.
- **#239 merged (2026-10-18, `dbdcb8e`, dev Worker `98e58ead`):** closes #234 (P4a).
  - `/r/{owner}/{repo}[/~branch|/@commit]`, an authorized read path with a session-bound HMAC capability cookie (5 min), epoch revocation, memory → Cache API → R2, an asset ticket for opaque frames, frame `img-src` self only, and lazy tree v46.
  - `/r/` stays 404 until P5 adds the `REPO_CONTENT`, `REPO_EPOCHS` and `REPO_ACCESS` bindings. `REPO_CAPABILITY_SECRET` is set on dev.
  - Follow-ups filed as #242.
- **Main coverage red (2026-10-18):** `commentor-pin-layout-browser` "follows the highlighted anchor in the same pass" saw 3 forced layouts where 1 is expected, about 1 in 3 runs. Filed #241, assigned to DeepSeek free (high), which answered a probe again.
- **#240 merged (2026-10-18):** closes #235. Drawer measurements now look the card up by `data-thread-id` inside one `list.evaluate`, because `replaceChildren()` detaches held nodes. Firefox 20/20, Chromium 5/5, WebKit 5/5. Written by GLM 5.3 Flash (Go) at high, a clean first PR. Coverage needed one rerun for the #241 pin-layout flake.
- **P5 started (2026-10-18):** #243 permission mirror + revocation epochs (control Worker, webhooks, encrypted token storage, fail-closed), Opus high, `feat/243-permission-mirror`, built against the fake GitHub.
- **#244 merged (2026-10-18):** closes #241. The pin-layout test raced a stray widget timer (`tipTimer`, 150 ms after a real pointerover), proven with a CDP trace and reproducible before #217, so not a regression. The test now pauses the page clock and keeps real rAF; the assertion is still exactly 1. 40/40 runs. Main's coverage should be green again. By DeepSeek V4.1 Flash free at high.
- **P4b started (2026-10-18):** #245 instant in-shell navigation (prefetch with an evidence-based reuse check, Speculation Rules, view transitions, ≤200 ms switch budget), DeepSeek free high. GLM free was still unavailable at a 15:50 UTC probe.
- **#246 (#238) review (2026-10-18):** both root causes are approved: a real product race where a selection made before write access arrived never got a chip, and auth clicks swallowed during the web-font swap (tests now wait for `document.fonts.ready`). CI coverage failed on `commentor-edges-browser` 'keeps the selection control when a fast scroll hides it', most likely caused by the new re-evaluation on every compatibility callback. Asked the agent to act only on canWrite transitions.
- **Lesson (2026-10-18):** `t3_pending_request_list` without `threadId` checks only the orchestrator's own thread, so child questions were invisible all day and agents reported them as 'aborted'. Approvals never show there; read `pendingRequestCount` via `t3_thread_read`. #245 attempt 1 stalled on 8 sub-agent approvals; it was relaunched with 'no sub-agents', which is now a brief rule.
- **#247 (#243 P5) reviewed (2026-10-18), approved pending CI.** A control-Worker Durable Object directory: registry, per-user mirror with a 5 min TTL and ETags, sealed tokens (AES-256-GCM, HKDF, AAD = user ID), epoch outbox. Payloads can only deny; grants are confirmed with GitHub (guards against replay under a fresh delivery ID). Decisions are made from storage alone (race-free, at most 6 rounds, then 503). Fails closed. Bounds: ≈60–90 s on KV Classic, <1 s on KV Instant, ≤10 min without a webhook. Measured delivery → first denied view about 60 ms. Needs the `GITHUB_TOKEN_KEY` secret when it is deployed (P1).
- **#247 merged (2026-10-18):** closes #243 (P5). The control Worker is dev/test only; no production bindings yet.
- **#246 merged (2026-10-18):** closes #238. The selection chip is re-read only when canWrite crosses the guard (fixes a selection made before the handshake leaving a dead chip, without racing the scroll-hide logic). Auth E2E waits for `document.fonts.ready`. Commentor v49 deployed to dev. By GLM 5.3 Flash (Go) at high, two review rounds.
- **#242 items 1+2 started (2026-10-18):** Clear-Site-Data on sign-out and ingest on first view, on GLM 5.3 Flash free at high (probe OK at about 17:15 UTC).
- **OpenCode run ending mid-task (2026-10-18):** the #242 GLM-free run went 'completed' with a mid-sentence summary, uncommitted work and nothing pushed. Resumed by sending the thread a 'continue from here' message; this starts a new run on the same thread and keeps high reasoning. Always check the worktree and remote branch after an OpenCode task reports completed.
- **#248 (#245 P4b) reviewed (2026-10-19):** findings with evidence: a shell `fetch` does NOT warm the opaque sandboxed frame (cache partitioned by opaque origin; 2 requests); moving or `replaceWith`-ing an iframe re-requests; hidden sibling frames swapped in place by visibility and id cost 1 request total. Readiness is the frame's own announcement (aborted subframes still fire `load`). Pool of 3, saveData and slow connections excluded, view transitions honour reduced motion, Speculation-Rules header to same-origin JSON. Lazy tree v47, registry UI-162. Approved pending CI. Free models are slow on big tasks (about 2.5 h) but sound.
- **#248 CI round 1 (2026-10-19):** (a) a real regression: deployment-tree Back/Forward showed the wrong document on all engines; preload adoption leaked into the non-repo viewer; (b) a unit test used the global `URLPattern`, which Node 22 in CI lacks (the agent ran Node 24). Lesson for the brief: CI is Node 22, so don't rely on Node 24-only globals in tests.
- **#248 merged (2026-10-19, `629c966`):** closes #245 (P4b). Repo-only (opt-in via `data-frame-base`) hidden sibling-frame preload pool, Speculation-Rules header, view transitions, frame-switch measures. Lazy tree v48. Round 2 fixed the leak into the deployment viewer's Back/Forward and the Node 22 `URLPattern` test. By DeepSeek free, 2 rounds, about 4.5 h total.
