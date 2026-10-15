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
