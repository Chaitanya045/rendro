# How production-readiness work is run

_Recorded 2026-10-15._

## Loop

1. **Audit.** Read-only agents write reports to a scratch directory outside the repo.
   The orchestrator condenses them into `roadmap.md` and GitHub issues.
2. **Issue.** One GitHub issue per bug or work item, labelled (`production-readiness`,
   `security`, `performance`, `modernization`, `testing`, `bug`, `enhancement`).
   The repo is public: describe security issues by impact and area, without exploit steps.
3. **Fix.** One worktree and one branch per issue, under `../rendro-wt/<branch>`.
   Fixers are Codex `gpt-6-astra` at high reasoning, launched as T3 delegated tasks.
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
