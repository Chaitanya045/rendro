# Development identity and permission QA — 2026-09-15

The user authorized creating temporary users directly in the development database. This deliberately bypasses signup/email verification **for synthetic fixtures only**; it does not verify inbox ownership, mail delivery, password sign-in, or OAuth.

## Method

- Target only `dev.rendro.app` and the `deafening-beagle-38` Convex deployment.
- Use a separate, privileged, internal QA action with the installed Better Auth test utilities. The production auth configuration and public routes do not gain a fixture/login endpoint.
- Seed unique owner, admin, member, and outsider users with reserved `.invalid` email addresses. Use isolated QA organizations, not the user's existing memberships.
- Use native short-lived fixture sessions for real deployed HTTP requests. Do not print cookies, tokens, credentials, or complete response bodies. No passwords are created or entered.
- Revoke fixture sessions and remove only exact fixture-owned application and auth records after the run; independently verify cleanup.

## Planned live matrix

| Scenario | Expected behavior |
| --- | --- |
| Owner/admin/member session | Resolves to the correct distinct fixture identity |
| Project listing | Organization members allowed; outsider and anonymous denied |
| Project creation | Owner/admin allowed; member and outsider denied |
| Credential listing/creation | Owner/admin allowed; member denied |
| Self-escalation | Member cannot grant itself administrator or owner privileges |
| Owner changes role | Demotion immediately removes writes; promotion grants authorized writes |
| Membership removal | Existing session immediately loses organization access |
| Cross-organization project lookup | Wrong organization/project pairing denied |
| Session expiry/revocation | Expired or revoked fixture sessions cannot authorize requests; cached-cookie behavior checked separately |

## Remaining distinctions

- HTTP permission tests are not browser interaction tests of every role's screen.
- Initial source review found project-creation and member-role controls without a current-user role check. These were subsequently fixed and verified with executed VM tests and deployed browser presentation fixtures; this is distinct from backend permission enforcement.
- API-key members now receive a clear access-restricted state instead of a retry loop, and the page skips requests for forbidden credential data. Network failures still offer retry.
- Email delivery and real interactive identity-provider flows remain unverified regardless of fixture results.

## First live run

Run `2e0d801c372845e4` created four actual development users, two isolated organizations, four projects, and two API credentials. All four HTTP sessions resolved to their distinct expected identities. This was not mocked authorization.

- Owner/admin project and credential access passed; members could read projects but not create projects/credentials or list credentials.
- Member self-escalation was denied. Owner demotion immediately removed writes; promotion granted writes; removal denied further reads. Foreign organization/project pairing was denied.
- **Confirmed session issue:** a valid cached session cookie continued authorizing project reads after its database session was expired or revoked. Token-only requests were denied. Central auth cache handling is being corrected and must be rerun against the deployed service.
- **Confirmed response issue:** outsider/removed-member project requests were denied but returned 400 rather than 403. Native auth membership errors were not recognized by the custom HTTP error mapper.
- Two failed assertions were incorrect harness expectations: the native outsider organization endpoint correctly returned 403, not a 200/null response. This was not an application access leak.
- The runner reported 36/42 checks passing, zero execution errors, zero remaining fixture records, and successful cleanup. Those counts include the two incorrect assertions above and therefore are not a count of six application bugs.

Independent read-only database checks after cleanup confirmed the original one user and one organization remain, zero synthetic users/organizations remain, and zero projects/credentials/audit records remain for this run. Removed fixtures are disposable and can be recreated by the harness; no existing user or organization was changed.

## Fixed and verified against dev

The central Better Auth cookie cache is disabled so protected requests consult persisted sessions. The regression explicitly supplies a correctly signed legacy cache cookie, rather than merely testing that new cache cookies are no longer issued. Native organization errors are normalized to the existing authenticated/permission-denied response mapping.

Backend deployment completed at 12:52 IST. Live rerun `be4e159feaa844a3` passed **42/42** assertions, including cached and uncached expiry/revocation, a native organization endpoint after revocation, outsider denial with 403, and all role transitions above. There were no execution or cleanup errors; the harness reported zero remaining fixture records. Independent database reads again confirmed one original user and organization, zero synthetic identities/organizations, and zero run-owned projects, credentials, or audit records.

Local checks before this deployment: **185 tests in 24 files**, root and Convex TypeScript checks, and ESLint passed. These are automated regression tests, not 185 browser E2E scenarios. Role-aware UI improvements are being validated separately and are not covered by the live 42-check claim.

## Expanded team and invitation run

Backend harness update deployed at 12:57 IST; run `0cc85ed16b62463b` passed **65/65** live checks with zero execution/cleanup errors and zero remaining fixture records. Added coverage:

- Owner/admin team creation and member denial; admin adds/removes team members, duplicate add creates exactly one membership, and team removal does not remove organization access.
- Seeded invitations: expired/declined/canceled invitations cannot be accepted; the wrong recipient is denied; decline/cancel/accept succeed for authorized identities; repeat acceptance is denied and creates no duplicate membership. An accepted member can read projects but cannot create them.
- All 42 earlier checks still pass, including legacy-cookie expiry/revocation.

Invitation records were created directly in the isolated fixture organization, with no outgoing email. This validates deployed invitation processing, not sending, inbox delivery, or clicking an emailed link. Cleanup now explicitly includes teams, team members, and invitations.

Independent post-run database checks confirmed zero fixture users, organizations, teams, invitations, projects, credentials, and related audit records; no orphan team memberships remain. The original one user and organization remain intact. The later UI Worker deployment `ecd7dc63-fdb5-40d8-acef-5ad9727c6411` passed its 221-test local gate and deployed T3 follow-up; see the release gate for the precise browser scope.
