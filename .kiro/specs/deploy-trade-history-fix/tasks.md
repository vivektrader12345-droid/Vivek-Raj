# Deployment Execution Plan

> Execute one leaf task at a time in dependency order. Stop when a task's acceptance gate fails. Do not combine later tasks into an earlier dispatch.

- [x] 1. Inspect the repository, branch, upstream, and Netlify configuration
  - Confirm the repository root, current branch, upstream tracking branch, configured Git remote, local/remote relationship, staged/unstaged/untracked status, and relevant recent commits using read-only inspection.
  - Inspect `netlify.toml`, linked-site metadata, and available authenticated Netlify configuration to identify the build command, publish directory, SPA redirect, site, and configured production branch without printing credentials.
  - Inspect `.kiro/specs/trade-history-black-screen/` and confirm its 9/9 completion record, prior validation, intended fix behavior, and recorded artifact marker baseline.
  - Stop before any mutation if the branch, upstream, production branch, repository state, or deployment configuration is missing, divergent, inconsistent, or unexplained.
  - _Depends on: none_
  - _Requirements: 1.1, 1.2, 1.5, 1.6_

- [x] 2. Build and review the intended-file inventory
  - Enumerate each changed Trade History source, approved test/configuration path, and relevant spec artifact proposed for the release; justify every included path from the actual diff and completed fix scope.
  - Record all other staged, unstaged, and untracked paths as unrelated; leave them unmodified and unstaged.
  - Exclude generated `dist/`, local Netlify state, environment files, logs, browser profiles, credentials, and any path not needed for this release.
  - Stop if any path cannot be safely classified.
  - _Depends on: 1_
  - _Requirements: 1.3, 1.4, 1.5, 1.6_

- [x] 3. Run targeted Trade History validation
  - Run `npm run test:trade-history:exploration`, `npm run test:trade-history:preservation`, and `npm run test:trade-history` as one-shot commands in that order.
  - Record each command, result, and any generated built-artifact entry asset; do not start a development server or watcher.
  - If a check fails, capture the release-blocking error and proceed only to task 5; do not stage, commit, push, or deploy.
  - _Depends on: 2_
  - _Requirements: 2.1, 2.3, 2.4_

- [x] 4. Run the full test suite and production build
  - Run `npm test` as the repository's full configured non-watch test suite, then run `npm run build`.
  - Record both outcomes and the final production entry asset referenced by `dist/index.html`; do not stage generated build output.
  - If either command fails, capture the release-blocking error and proceed only to task 5; do not stage, commit, push, or deploy.
  - _Depends on: 3 passing_
  - _Requirements: 2.2, 2.3, 2.4, 2.5_

- [x] 5. Resolve only attributable release-blocking errors and revalidate
  - If tasks 3 or 4 found no failure, record this conditional task as not needed and continue.
  - For each failure, determine whether it blocks this release and is directly attributable to an intended Trade History source/test/spec path or its validation configuration.
  - If attributable, apply the smallest safe correction, add only directly affected intended paths to the inventory, rerun the failed command, then rerun every downstream command from tasks 3 and 4.
  - If unrelated, secret-dependent, broad, destructive, or unsafe to fix without touching unrelated work, make no correction and stop with a blocker report.
  - Continue only when all targeted checks, `npm test`, and `npm run build` pass and the updated inventory has been reviewed.
  - _Depends on: 3 attempted; 4 attempted only when 3 passed; conditional execution on any failure_
  - _Requirements: 1.4, 2.3, 2.4, 2.5_

- [-] 6. Stage only intended Trade History release paths and review the staged diff
  - Stage each reviewed inventory path explicitly; do not use broad staging that could include unrelated work.
  - Review the staged path list, complete staged diff, and diff summary; verify unrelated changes, generated build output, local Netlify state, and secret-bearing files/content are absent.
  - Compare the staged payload with the final inventory and stop if any path or hunk is unexplained.
  - _Depends on: 3 and 4 passing, and 5 complete or not needed_
  - _Requirements: 1.3, 1.4, 1.6, 3.1, 3.2_

- [~] 7. Create the normal deployment commit
  - Create one normal commit from the reviewed staged payload with a release-specific message and allow repository hooks to run.
  - Record the resulting commit SHA and verify its committed path list matches the approved inventory.
  - Do not amend unrelated history, bypass hooks, force, reset, clean, or perform another destructive Git action.
  - If commit creation or a hook fails, stop and report; fix only a release-blocking attributable failure under task 5, then restage and create a new normal commit.
  - _Depends on: 6_
  - _Requirements: 3.2, 3.3, 3.4, 3.6_

- [~] 8. Push normally to the configured production branch and verify the remote SHA
  - Push the release commit without force to the configured upstream GitHub branch confirmed in task 1 as Netlify production.
  - Verify the remote production branch resolves to the recorded release commit SHA and record the destination branch and remote SHA.
  - Stop without claiming deployment if the push fails or the remote SHA differs.
  - _Depends on: 7_
  - _Requirements: 3.4, 3.5, 3.6_

- [~] 9. Observe the branch-triggered Netlify production deployment
  - Using available authenticated Netlify CLI, API, dashboard, or browser tooling, locate the deployment triggered by the pushed commit without displaying tokens, cookies, or credentials.
  - Record the deployment ID/URL, source commit, branch, production context, start/completion times, and final state.
  - Confirm the deployment is published successfully and its source commit equals the release SHA before any live acceptance check.
  - If it is missing, failed, canceled, mismatched, or unverifiable, preserve sanitized evidence, stop live acceptance, and proceed to task 14 for outcome classification.
  - _Depends on: 8_
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [~] 10. Verify the production root, direct History route, active asset, and fix markers
  - Request `https://vijaycontractor.space` and direct `https://vijaycontractor.space/history`; confirm successful SPA entry responses with no 404, redirect loop, or static error page.
  - Resolve the JavaScript entry asset referenced by the active production document, confirm it returns successfully, and tie it to the matching Netlify deployment and release SHA.
  - Verify the active asset contains `Trade History`, `Unknown`, `Something went wrong`, `React Error Boundary caught:`, `Reload App`, and `Try Again`.
  - Record route statuses, active asset URL/hash, marker results, and sanitized traceability evidence; on failure, stop functional verification and proceed to task 14.
  - _Depends on: 9 passing_
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [~] 11. Verify authenticated Dashboard View All and direct History behavior when available
  - If an existing authenticated browser session or approved production account is available, open Dashboard, select Recent Trades `View All`, and confirm `/history`, the application shell, and Trade History content render without a black screen or error-boundary fallback.
  - In the same approved session, directly load `/history` and verify the same visible behavior.
  - If a naturally occurring unsupported direction exists, verify it displays `Unknown` while the route remains usable; do not create or mutate data to manufacture this case.
  - If no approved session is available, do not request, create, print, or expose credentials; record both authenticated checks as not executed and mark complete acceptance unavailable.
  - _Depends on: 10_
  - _Requirements: 6.1, 6.2, 6.4, 6.5, 7.3_

- [~] 12. Verify browser runtime health and zero Firestore writes
  - During only the non-mutating root, Dashboard, navigation, viewing, filtering, searching, and sorting flows available from tasks 10 and 11, inspect browser console/runtime and network evidence.
  - Confirm there is no fix-related uncaught exception, null-direction `toUpperCase` failure, fix-related console error, or failed request for the active entry asset.
  - Confirm the verification interval contains no Firestore create, update, delete, commit, batch-write, synchronization, import, or other write request.
  - Do not run test fixtures or automated suites against production Firebase and do not invoke any mutating UI action.
  - Stop immediately and preserve sanitized evidence if an exception, asset failure, credential exposure, or Firestore write/attempt occurs.
  - _Depends on: 10 and 11_
  - _Requirements: 6.3, 7.1, 7.2, 7.3, 7.4, 7.5_

- [~] 13. Record the deployment acceptance result
  - Correlate the repository baseline, validation results, intended commit, remote SHA, Netlify deployment, route/asset markers, authenticated checks, runtime health, and Firestore write evidence.
  - Declare full success only if every required check passed, including authenticated checks; otherwise report the precise partial, blocked, or failed status without overstating verification.
  - If any rollback criterion in Requirement 8.1 is proven, identify it precisely and proceed to task 14; an unavailable session/tooling alone is incomplete verification, not a rollback trigger.
  - _Depends on: 9 through 12 completed as applicable_
  - _Requirements: 8.1, 8.2, 8.7_

- [~] 14. Preserve failure evidence and determine whether rollback approval is required
  - For a proven Requirement 8.1 failure, stop further acceptance and preserve the failing deployment URL, deployment/commit IDs, active asset URL, sanitized console/runtime evidence, and reproducible steps.
  - Identify the immediately preceding known-good Netlify production deployment and describe the impact and proposed recovery without changing production.
  - If no Requirement 8.1 criterion is proven, do not initiate rollback; finalize the status from task 13.
  - _Depends on: 9, 10, 11, 12, or 13 reporting a failure_
  - _Requirements: 8.1, 8.2, 8.3_

- [~] 15. Obtain explicit approval for the proposed production rollback
  - Present the sanitized evidence, exact failure criterion, proposed known-good deployment or revert target, expected impact, and reversibility to the user.
  - Proceed only if the exact high-impact rollback action is explicitly approved or was already unambiguously authorized; otherwise leave production unchanged and report the unresolved failure.
  - _Depends on: 14 proving a rollback criterion_
  - _Requirements: 8.4_

- [~] 16. Execute only the approved rollback method
  - Restore the explicitly approved immediately preceding known-good Netlify production deployment.
  - Only if Netlify restoration is unavailable and a repository revert was explicitly approved, create a normal non-force revert commit that preserves unrelated work and push it to the configured production branch.
  - Record the rollback deployment, commit, method, and timestamps; do not force push, rewrite history, or treat deployment rollback as Firestore restoration.
  - _Depends on: 15 with explicit approval_
  - _Requirements: 8.4, 8.5_

- [~] 17. Verify and report the approved rollback outcome
  - Confirm the restored production root and direct `/history` entry are reachable and record the active restored deployment and commit identifiers.
  - Report runtime observations and any separate data-recovery concern; do not claim that deployment rollback restored Firestore data.
  - Publish the final rolled-back status with sanitized evidence.
  - _Depends on: 16_
  - _Requirements: 8.6, 8.7_
