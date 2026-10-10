# Core workflow regression — 2026-09-16

## Result

**Not a production-readiness sign-off.** Reproduced core workflow defects were fixed and deployed to DEV. Local regression and deployed authorization checks passed. T3 disconnected before the final live/browser matrix could finish.

- DEV Worker: `c25597a0-f963-4c17-9466-c349fa374f55`, management shell **9**.
- DEV Convex: `deafening-beagle-38`; final backend fixes and guarded cleanup action deployed.
- `pnpm verify`: **380 tests / 46 files**, typecheck, lint, asset builds and whitespace checks passed. Convex typecheck also passed.
- Final deployed API fixture run: `0c3b77c060054daa`, **105/105**, zero remaining fixtures, no cleanup/execution failure.
- No commit/push or production deployment. Existing dirty changes preserved.

## Reproduced and fixed

1. **Project dialog saves but does not navigate.** The open dialog tripped the existing unload/navigation guard. The saved project existed while the button remained busy. Success now clears pending UI, closes the dialog and uses enhanced navigation. Pending duplicate submissions are ignored.
2. **Second team creation is disabled.** The reused dialog's submit button stayed busy after success. Each reload also attached another submit handler. Binding is now once per form, and successful creation resets the name and busy state.
3. **Missing member-management UI.** Teams had add controls but no roster or individual removal control. People similarly lacked organization-member removal. Added manager-only roster expansion/removal and role-aware organization removal with confirmation, self/sole-owner protection, and updated counts.
4. **Roster silently truncated to 100 members.** Synthetic data exposed the full-organization join limit. The native offset endpoint also returned HTTP 500 because the installed Convex adapter rejects offsets. Added freshly authorized, no-store cursor endpoints. A 121-member organization returned 100 + 21 members; the UI displayed all 121, including the final member and team-assignment option.
5. **Duplicate-project error exposes a stack trace.** The UI displayed an `Uncaught ConvexError` and backend filename. Project validation now emits only allowlisted, readable messages. Automated regression passed; final browser recheck was interrupted by the host disconnect.
6. **Validation/deploy concurrency:** ESLint inspected a temporary Wrangler worker bundle during deployment. Generated `.wrangler/**` output is now excluded.

Rendro's design-review guidance informed the new controls: existing button/select/row styling, accessible labels, explicit destructive confirmations, local loading/retry states, and no new UI framework or animation dependency. Screenshot-based visual sign-off remains blocked.

## Synthetic data

- Isolated organization created through the real browser form: `kn7ft0fbzt1c034px3cv2jkks18ehsb0`.
- Run marker: `b9f26d8a16c043e7`.
- Seeded **120 synthetic users, 120 projects and 12 teams**, plus the real signed-in owner and automatically created default team.
- Direct seeding deliberately exceeded Better Auth's default 100-member admission limit to exercise existing/imported-data boundaries. This does not certify inviting 120 users through the normal invitation flow or change that configured limit.
- Browser tests created five further projects and three teams. One synthetic organization membership was removed; the underlying test user remained tracked for cleanup.
- No real document uploads, publications, share grants or credentials were created in this workspace. No email sends were attempted.
- Fixtures require the DEV site, exact deployment confirmation and exact organization slug/run marker. Cleanup refuses workspaces containing deployments or additional publication/share/credential resources. It never deletes the signed-in real user or revokes their sessions.

## Verification matrix

| Workflow | Evidence this run |
|---|---|
| Organization creation | Live UI success; creator-owner and duplicate-slug behavior also verified through deployed API |
| Organization renaming | Deployed API success and persisted value; unauthorized member denied |
| First-project onboarding | Live UI created project and reached credential-setup stage; no key generated |
| Project modal creation | Live UI created two successive projects and opened their detail screens; repeated pending submission generated one POST |
| Project validation/retry | Duplicate slug rejected, fields retained/button enabled; changed slug retried successfully; friendly-error final recheck blocked |
| Team creation | Two successive live creations, exactly one POST each; form reset and re-enabled |
| Add/remove team member | Live UI: member appears in roster, existing option disabled, removal produces empty roster and re-enables assignment; organization access retained in API checks |
| Team rename/delete | Deployed API success; individual removal persisted; final live team-delete check interrupted |
| Organization roles/removal | Live UI promoted member 120 and removed member 002; rows/count updated 121 → 120; API checks verify access revocation, privilege escalation denial and owner protection |
| Permissions and sessions | Owner/admin/member/outsider/anonymous; cross-tenant IDs, expired/revoked sessions, and fresh roster access checked on DEV |
| Invitations | Seeded invitation accept/reject/cancel/expiry/wrong-recipient checks passed on DEV; email delivery explicitly excluded |
| API keys | Deployed create/list role checks; local scope/project/expiry/revocation regressions; management empty-state/navigation smoke |
| Deployments, publications, shares, comments and CLI | Existing local regression suite passed, including immutable deployment failure/concurrency and comment lifecycle/security tests. NOT a fresh full live write-cycle certification |
| Navigation/UI | Desktop checks of overview, projects/detail, People, Teams, settings, API keys, publications and shares. Header retained; no observed horizontal overflow or captured script error in completed samples. Some dark-theme navigation checked |

Browser actions used the T3-owned `tab_f`. Destructive confirmation branches in synthetic UI tests were accepted with a narrowly matched temporary `confirm` stub; this is not proof of native-dialog keyboard handling. Form/DOM event automation likewise does not certify physical-device input.

## Performance observations and remaining work

These are isolated DOM-ready observations, not p95/p99 benchmarks:

- Large project list: approximately **446–848 ms** in completed desktop samples; a cached revisit needed only a fresh access check.
- Full People/Teams roster: approximately **1.6–1.85 seconds**; cursor hydration still introduces sequential work.
- Large overview: approximately **3.1 seconds**, confirming remaining room to avoid loading a full roster just for counts.
- API keys: approximately **1.29 seconds**; publications/shares: approximately **0.42–0.46 seconds** in sampled empty states.
- One overview sample matched skeleton structure too early and was excluded from the content-ready assessment. Zero-status requests from its immediate onward navigation were aborts, not successful responses.

Next improvements should use a compact overview summary and truly paginated People/team-assignment rendering. Project lists also remain unpaginated. This dataset does not establish high-concurrency load limits or mobile performance.

## Explicit gaps

- T3 screenshots consistently failed. Resize to 1280×800 succeeded; subsequent mobile resize attempts failed, then the automation host disconnected. Final corrected mobile/visual/animation checks remain unverified.
- Host disconnect also prevented restoring the tab's original light preference and removing temporary in-page instrumentation. Reloading clears that instrumentation; the theme was last switched from Light to System for dark-style checks.
- Firefox/Safari, physical devices, reduced-motion/native keyboard matrix, throttled-network load percentiles, monitoring/alert delivery and rollback/restore rehearsal remain outstanding.
- Email remains parked by user instruction.
- Requested Sol/high delegation could not start: Orca returned `no_active_sender_terminal`; no substitute agents were used or claimed.

## Cleanup completed

The guarded cleanup removed **125 synthetic-workspace projects plus 5 related audit records, all 120 synthetic users, and the isolated organization's teams, memberships and organization record**. Verification reported **0 remaining fixtures**. Active-session pointers to this deleted QA organization were cleared without revoking sign-in. Existing organizations, users and document data were left untouched. These disposable test records were intentionally deleted, not archived.

The disconnected tab may still display the deleted QA workspace. On reconnect, reload and return to `/organizations?choose=1`; restore the Light theme if desired.
