# Deployment Follow-up Requirements

## Introduction

This specification governs the controlled production release and verification of the completed `trade-history-black-screen` fix to `https://vijaycontractor.space`. The source fix is complete (9/9 implementation tasks), its recorded tests and build have passed, and the intended local build entry asset recorded by the source spec is `/assets/index-BqALrodG.js`. Netlify is expected to deploy automatically from its configured GitHub production branch. Verification must not expose credentials or write to real Firestore data.

## Requirements

### Requirement 1: Establish the release baseline

**User Story:** As a release operator, I want a verified repository and deployment baseline, so that I release the intended change without disturbing unrelated work.

#### Acceptance Criteria

1.1 BEFORE any validation, staging, commit, or push, the release operator SHALL identify the repository root, current branch, upstream tracking branch, configured remote, configured Netlify production branch, working-tree status, staged diff, unstaged diff, untracked files, and relevant recent commits.

1.2 THE release operator SHALL inspect `netlify.toml`, the linked Netlify site configuration available without exposing credentials, and the completed `trade-history-black-screen` specification to confirm the build command, publish directory, SPA redirect, production site, completed 9/9 tasks, recorded validation, and intended fix markers.

1.3 THE release operator SHALL create an intended-file inventory for the Trade History application fix, its approved tests, and its related specification artifacts, and SHALL separately identify every unrelated staged, unstaged, or untracked path.

1.4 THE release operator SHALL leave unrelated work unmodified, unstaged, and outside all validation-driven repairs and the deployment commit.

1.5 IF the current branch is not the configured Netlify production branch, the expected upstream is absent, local/remote history has diverged unexpectedly, deployment configuration is inconsistent, or any change cannot be classified, THEN the release operator SHALL stop before staging, commit, or push and report the discrepancy.

1.6 THE release operator SHALL NOT read, print, stage, commit, transmit, or otherwise expose `.env` values, authentication tokens, service-account material, browser credentials, or other secrets.

### Requirement 2: Validate and repair only release-blocking failures

**User Story:** As a release operator, I want the intended release validated with tightly scoped remediation, so that production receives a buildable and tested fix without unrelated changes.

#### Acceptance Criteria

2.1 AFTER the baseline and inventory pass, the release operator SHALL run the targeted Trade History exploration, preservation, full Trade History, and built-artifact checks using one-shot commands and SHALL record each command and result.

2.2 AFTER targeted checks pass, the release operator SHALL run the repository's full non-watch test suite and a production build and SHALL record the resulting entry asset and build outcome.

2.3 IF a test or build failure blocks this release and is directly attributable to the intended Trade History release or its validation configuration, THEN the release operator SHALL automatically apply the smallest safe correction, add only directly affected fix/spec/test paths to the intended-file inventory, and rerun the failed check plus all downstream checks.

2.4 IF a failure is unrelated, requires secrets, changes deployment scope or authorization, requires destructive Git operations, or cannot be corrected without modifying unrelated work, THEN the release operator SHALL stop and report the blocker without making that correction.

2.5 THE release SHALL proceed to staging only when all targeted checks, the full test suite, and the production build pass after any permitted corrections.

### Requirement 3: Commit and push only the intended release

**User Story:** As a release operator, I want a narrowly scoped normal commit and push, so that the configured production branch contains only the approved Trade History release.

#### Acceptance Criteria

3.1 WHEN preparing the deployment commit, the release operator SHALL stage only paths in the reviewed intended-file inventory and SHALL NOT use broad staging that includes unrelated paths.

3.2 BEFORE committing, the release operator SHALL review the staged path list, staged diff, diff summary, and secret-sensitive filenames or content indicators and SHALL confirm that unrelated changes and generated build output are excluded.

3.3 THE release operator SHALL create a normal deployment commit, record its commit SHA, and SHALL NOT amend an unrelated commit, rewrite history, bypass hooks, or perform a destructive Git operation.

3.4 EXPLICIT authorization for the normal deployment commit and push is already granted; after Requirements 1 and 2 and staged-diff review pass, the release operator SHALL proceed without requesting duplicate authorization.

3.5 THE release operator SHALL push without force to the configured upstream GitHub branch that Netlify uses for production and SHALL verify that the remote production branch resolves to the recorded release commit SHA.

3.6 IF commit creation, hooks, push, or remote-SHA verification fails, THEN the release operator SHALL stop and SHALL NOT represent the release as deployed.

### Requirement 4: Observe and verify the Netlify deployment

**User Story:** As a release operator, I want the branch-triggered Netlify deployment tied to the pushed commit, so that I can verify the exact production release.

#### Acceptance Criteria

4.1 WHEN the production-branch push succeeds, Netlify SHALL create a production deployment from the recorded release commit without a manual file upload.

4.2 THE release operator SHALL use available authenticated Netlify CLI, API, dashboard, or browser tooling to observe the deployment without displaying or persisting credentials in logs or spec artifacts.

4.3 THE release operator SHALL record the deployment identifier or URL, source commit, branch, production context, start time, completion time, and final status.

4.4 LIVE acceptance SHALL begin only when Netlify reports a successful published production deployment whose source commit equals the recorded release commit.

4.5 IF no deployment is triggered, the deployment fails or is canceled, the source commit differs, or authenticated deployment status cannot be established, THEN the release operator SHALL preserve available evidence, stop live acceptance, and evaluate Requirement 8 without initiating rollback automatically.

### Requirement 5: Confirm production route and artifact parity

**User Story:** As a release verifier, I want production routes and assets tied to the release commit, so that I know the active site contains the intended fix.

#### Acceptance Criteria

5.1 AFTER publication, requesting `https://vijaycontractor.space` SHALL return a successful application entry response, and the release operator SHALL identify the JavaScript entry asset referenced by that response.

5.2 REQUESTING `https://vijaycontractor.space/history` directly SHALL return a successful SPA application entry rather than a 404, redirect loop, or static error page.

5.3 THE served entry asset MAY be `/assets/index-BqALrodG.js` or a different content-hashed asset; any active asset SHALL return successfully and SHALL be attributable to the published deployment for the recorded release commit.

5.4 THE active JavaScript asset SHALL contain the intended fixed-build markers `Trade History`, `Unknown`, `Something went wrong`, `React Error Boundary caught:`, `Reload App`, and `Try Again`.

5.5 IF either route is unavailable, the entry document references a missing asset, any required marker is absent, or the active asset cannot be tied to the intended deployment, THEN production acceptance SHALL fail and Requirement 8 SHALL be evaluated.

### Requirement 6: Verify authenticated Trade History behavior and runtime health

**User Story:** As an authenticated user, I want Dashboard navigation and direct Trade History loading to remain usable, so that the deployed fix removes the black screen without regressions.

#### Acceptance Criteria

6.1 IF an existing authenticated production session or approved account is available, WHEN the verifier opens Dashboard and selects Recent Trades `View All`, THEN the application SHALL navigate to `/history` and display the application shell and Trade History content without a black screen or error-boundary fallback.

6.2 IF an existing authenticated production session or approved account is available, WHEN `/history` is loaded directly, THEN the authenticated SPA SHALL display the application shell and Trade History content without a black screen or error-boundary fallback.

6.3 DURING root, Dashboard-to-History, and direct-History checks, the browser SHALL report no fix-related uncaught exception, no null-direction `toUpperCase` failure, no fix-related console error, and no failed request for the active entry asset.

6.4 IF existing production data contains a non-canonical direction or another heterogeneous field, THEN Trade History SHALL remain usable and SHALL display the fixed stable fallback, including `Unknown` for an unsupported direction, without data repair.

6.5 IF no authenticated session or approved account is available, THEN the release operator SHALL NOT solicit, expose, or create credentials; SHALL record the authenticated checks as not executed; and SHALL NOT claim complete authenticated acceptance.

### Requirement 7: Preserve production data and verification boundaries

**User Story:** As a data owner, I want production verification to be read-only and credential-safe, so that release checks cannot mutate customer trade data or disclose access material.

#### Acceptance Criteria

7.1 PRODUCTION verification SHALL use only root loading, navigation, viewing, filtering, searching, sorting, and other non-mutating interactions and SHALL NOT add, edit, delete, clear, import, synchronize, or otherwise write trade data.

7.2 THE release operator SHALL NOT run test fixtures, automated test suites, mutation scripts, or local Firebase tooling against production Firebase.

7.3 ABSENCE of a naturally occurring heterogeneous production record SHALL NOT permit creation or mutation of a Firestore record; active artifact markers and the passed automated tests SHALL provide fix-specific evidence instead.

7.4 THE verifier SHALL inspect available browser network/runtime evidence for the verification interval and SHALL confirm that no Firestore create, update, delete, commit, batch-write, or other write operation was issued.

7.5 IF verification causes or attempts a Firestore write or exposes a credential, THEN verification SHALL stop immediately, evidence SHALL be preserved without reproducing the secret, and Requirement 8 SHALL be evaluated.

### Requirement 8: Decide release outcome and control rollback

**User Story:** As a release owner, I want explicit acceptance and rollback gates, so that high-impact recovery occurs only for defined failures and with proper approval.

#### Acceptance Criteria

8.1 ROLLBACK SHALL be considered only if the wrong commit is published, artifact parity fails, root or direct `/history` loading fails, authenticated `View All` or direct History produces a black screen or boundary fallback, a fix-related uncaught runtime error occurs, or verification causes or attempts a real Firestore mutation.

8.2 A deployment observation limitation, including unavailable authenticated credentials or tooling, SHALL be reported as incomplete verification and SHALL NOT by itself authorize or trigger production rollback unless it also proves one of the failure criteria in 8.1.

8.3 WHEN a criterion in 8.1 is proven, the release operator SHALL stop verification and preserve the failing deployment URL, deployment and commit identifiers, active asset URL, sanitized console/runtime evidence, and reproduction steps.

8.4 RESTORING a prior Netlify production deployment or pushing a repository revert is a high-impact production action; because automatic rollback is not authorized, the release operator SHALL obtain explicit approval after presenting the evidence and proposed rollback target unless that exact rollback action has already been unambiguously authorized.

8.5 ONLY AFTER approval, the release operator SHALL restore the immediately preceding known-good Netlify production deployment; IF deployment restoration is unavailable and repository revert is explicitly approved, THEN the release operator SHALL create a normal non-force revert commit and push it through the configured production branch while preserving unrelated work.

8.6 AFTER an approved rollback, the release operator SHALL verify that the production root and direct `/history` entry are reachable, record the restored deployment and commit identifiers, and report any data-recovery concern separately because deployment rollback SHALL NOT be treated as Firestore data restoration.

8.7 THE deployment SHALL be declared fully successful only when preflight, validation, intended-only commit/push, matching Netlify publication, route and artifact parity, authenticated checks, runtime health, and read-only Firestore verification all pass with recorded evidence; otherwise the operator SHALL report the precise partial, blocked, failed, or rolled-back outcome.
