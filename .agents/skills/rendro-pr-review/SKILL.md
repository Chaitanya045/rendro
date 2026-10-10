---
name: rendro-pr-review
description: Review Rendro pull requests or branch diffs by reasoning about system invariants, adversarial states, scale, and change amplification. Use for correctness, security, scalability, maintainability, performance, accessibility, and release-risk reviews in this repository; do not use for ordinary implementation work.
---

# Rendro PR Review

Review a change by building and trying to falsify a model of it. Do not turn this skill into a checklist scan.

This is a review workflow. Do not edit code, publish review comments, approve, merge, push, deploy, or change PR state unless the user separately authorizes that action.

## Form a change thesis

Before looking for defects, explain to yourself:

- What user or system behavior is changing?
- Which implementation mechanism is supposed to produce that behavior?
- Which old behavior is intentionally removed?
- What must remain true even if the change succeeds?

Use the PR body and commit messages as claims, not proof. Read the actual base-to-head diff and enough surrounding code to correct the thesis. If you cannot state the change in a few causal sentences, you do not understand it well enough to review.

Inspect `git status --short` first and preserve unrelated changes. Prefer the PR's real base/head metadata; otherwise derive the merge base with the stated base branch. Review the complete PR, not only the latest commit.

Read [references/system-model.md](references/system-model.md) to understand Rendro's trust boundaries, deliberate architectural choices, state machines, and scaling dimensions. Then selectively read:

- `../../../docs/TECHNICAL.md` for auth, data, API, storage, deployment, publication, sharing, comments, or CLI changes.
- `../../../docs/DESIGN.md` for rendered HTML, browser behavior, navigation, loading, theme, motion, responsive layout, or accessibility changes.
- `../../../docs/PRODUCT.md` when workflows or product claims change.

Code and tests are evidence of current behavior. Documentation is evidence of intent. Reconcile conflicts instead of mechanically preferring either one.

## Build the affected system slice

Trace only the slice touched by the change, across boundaries. A useful slice often looks like:

```text
input/event
  -> route or browser handler
  -> identity and authorization
  -> validation and normalization
  -> Convex/R2/query cache operation
  -> response/state transition
  -> rendering, invalidation, cleanup, retry
```

Include both sides of every changed contract. For example, an API response change requires checking its Convex producer, Worker proxy, browser/CLI consumers, cache keys, error mapping, and tests. A generated bundle change requires finding its canonical TypeScript source and build path.

Write down the invariants that cross the slice. Prefer causal invariants such as “cached project data is not painted until fresh membership succeeds” over local rules such as “call function X.”

## Generate failure hypotheses

Ask what happens when the assumptions behind the happy path are false. Choose lenses that fit the diff rather than applying every lens equally.

### Identity and authority

Substitute one identity dimension at a time: another user, organization, project, role, API-key scope, deployment, publication, share token, or comment author. Then combine substitutions. Ask where the server derives truth and whether any client/cache value can become authority.

### Time and concurrency

Turn async code into a timeline. Reorder completions; navigate away; close a dialog; double-submit; revoke access mid-request; let a timeout race a success; assume the server commits but the response is lost; reopen another tab. Follow which callback still owns the right to paint, invalidate, retry, or commit.

### State transitions

Model important flows as states and transitions, not isolated handlers. Look for unreachable recovery, skipped validation, duplicate transitions, and states with no cleanup. Pay special attention to deployment staging/commit, one-time secrets, management page scopes, organization switching, cached reads, invitations, and destructive actions.

### Scale and cost

Estimate how work grows with organizations, members, projects, deployments, files, comments, and open tabs. Identify the dominant operation: indexed lookup, table scan, `.collect()`, per-row query, bucket listing, DOM rebuild, bundle parse, or network waterfall. Test the reasoning at roughly 10, 1,000, and 100,000 relevant records where the product can plausibly reach them.

Do not label code “unscalable” without naming the growing dimension, the operation performed per item/request, and the failure mode or service limit it approaches.

### Change amplification

Imagine the next reasonable product change. Count how many duplicated contracts or implementations must change together. Duplication is a finding only when drift can produce a concrete security, correctness, UX, or release failure. Prefer the existing owner of a concern over proposing a new abstraction.

### User-observable states

For UI changes, reason through loading, populated, empty, partial, error, retry, blocked navigation, long content, narrow mobile, keyboard-only, reduced motion, dark/light, and slow/offline states. Check whether the state shown is truthful and whether focus, layout, and interaction ownership remain stable.

## Try to disprove each hypothesis

Actively search for counter-evidence before reporting:

- an earlier authorization or validation guard;
- a database index or strict cardinality bound;
- an abort signal, page-scope ownership check, request version, or cleanup hook;
- a targeted invalidation or compensating retry;
- a shared renderer/template that keeps server and browser behavior aligned;
- a regression test that exercises the exact failure state, not merely a source string.

If the counter-evidence closes the path, discard the finding. If it only reduces likelihood or impact, adjust severity. Do not report speculative concerns that cannot be connected to a reachable input and observable consequence.

Distinguish an introduced defect from existing debt. Report existing behavior only when the diff starts relying on it, broadens its reach, or makes it materially harder to repair.

## Verify the model

Run the narrowest relevant tests first. Broaden when practical:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build:assets
git diff --check
```

When relevant:

- dependency/lockfile changes: `pnpm audit --audit-level=high`
- substantive Convex changes: `pnpm exec tsc -p convex/tsconfig.json --noEmit`
- CLI source changes: `pnpm cli:build` and CLI/deployment protocol tests

`build:assets` rewrites tracked bundles. Do not run it over unrelated dirty files. Use an isolated checkout or inspect source/output parity when running it would disturb the user's work. Never reset or clean the user's worktree after verification.

Tests inform the model; they do not replace it. A passing suite cannot prove a missing tenant, race, scale, or browser state safe. A failing test becomes a finding only after you tie it to the change.

## Findings bar

Report a finding only when all are present:

1. a changed line or changed contract;
2. a reachable triggering state or input;
3. an observable incorrect outcome;
4. evidence that existing guards do not prevent it;
5. a focused correction direction.

Lead with findings in severity order:

```text
[P1] Short imperative title — path/to/file.ts:42
Under <specific state/input>, <mechanism> causes <incorrect result>. <Existing guard> does not cover it because <reason>. This affects <scope/impact>. Correct it by <bounded direction>.
```

- **P0:** exploitable cross-tenant/security breach, irreversible data loss, credential exposure, or broad outage.
- **P1:** broken core workflow, authorization bypass, corruption, major availability/performance regression, or common production failure; block merge.
- **P2:** bounded correctness, scalability, accessibility, or maintainability defect with credible production cost.
- **P3:** low-impact issue worth fixing. Omit preferences and lint-level style.

After findings, include only material assumptions/gaps and verification actually performed. If there are no findings, say so and name meaningful residual risks. Never claim the review guarantees no defects, and do not expose private chain-of-thought; provide concise evidence and conclusions.
