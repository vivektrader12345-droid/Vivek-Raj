# Implementation Plan

- [x] 1. Write and run the finite read-only bug-condition exploration test against the existing project `.venv`
  - **Property 1: Bug Condition** - Clean Policy-Compliant Local Backend
  - **CRITICAL**: Perform this exploration before provisioning or implementing any repair. A failure of the expected-behavior property on the unfixed environment is the expected result and confirms the bug.
  - Treat the existing `<workspace>\.venv` as read-only evidence: do not install, uninstall, upgrade, repair, rename, delete, activate for general use, or start `backend/app.py` as a server.
  - Implement the exploration as a finite, standard-library-only, data-driven probe protocol parameterized by interpreter and source location so the same logical property can later be rerun against the repair context; do not add a test dependency to the old environment.
  - Run only timeout-bounded child probes with the absolute old `.venv\Scripts\python.exe` path: interpreter identity/version, distribution metadata, `requests` warning capture, `ccxt` import, gRPC/cygrpc native import, and `backend/app.py` import from the workspace backend directory.
  - Before the `app.py` probe, ensure it cannot consume secrets: run in a child environment with credential/token/key variables removed, trading flags explicitly false, no environment values printed, and a short overall timeout. Do not display or read `backend/.env`; if the workspace import could implicitly load it, skip that probe and record `SECRET_RISK` rather than weakening the guard.
  - Bound the number of probes and output retained; sanitize exception output and record only interpreter path/version, package/module name, warning or exception class, blocked DLL filename, and pass/fail classification.
  - Assert the design's `expectedBehavior(result)` for the scoped context. Expected counterexamples include Python `3.14.6`, invalid `~harset-normalizer` metadata, `RequestsDependencyWarning`, a blocked `grpc/cygrpc` import, or inability to reach a healthy backend without starting one.
  - Stop after the finite probes. Do not make network requests, invoke pip mutations, modify policy, start a server, or attempt a fix in this task.
  - Document the exact sanitized counterexamples and classify the baseline as `BUG_REPRODUCED`, `POLICY_BLOCKED`, `SECRET_RISK`, or `BUG_NOT_REPRODUCED`; if the known condition is not reproduced, stop and revise the root-cause hypothesis before repair.
  - **Validation checkpoint**: Confirm every probe exited or was terminated by its deadline, no server remains, no file changed, no secret was shown, and the expected-behavior property failed for at least one concrete old-environment input before marking this task complete.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.5, 3.6, 3.7, 3.8_

- [x] 2. Write and run observation-first preservation property tests on the unfixed baseline
  - **Property 2: Preservation** - Source, Security, Secrets, Production, and Existing Environment
  - **IMPORTANT**: This is a standalone pre-fix task. Capture actual non-buggy behavior before any repair action; do not assume the baseline is clean and do not normalize existing user changes.
  - Verify read-only that local `refs/remotes/origin/main` resolves exactly to `017a607`; do not fetch, checkout, reset, merge, stash, or change branches. If the ref is absent or differs, classify `BASELINE_MISMATCH` and stop.
  - Read `backend/requirements.txt` directly from commit `017a607` and require exact direct pins: `flask==3.0.0`, `flask-cors==4.0.0`, `python-dotenv==1.0.0`, `ccxt==4.5.68`, `requests==2.34.2`, `gunicorn==21.2.0`, and `firebase-admin==6.4.0`.
  - Record a secret-safe baseline of the current repository without changing it: current commit/ref, `git status --porcelain` names/statuses, and deterministic hashes/existence state for tracked files. Explicitly include `backend/requirements.txt`, `render.yaml`, `backend/render.yaml` if tracked, and frontend files containing the `http://localhost:5000` target. Do not hash, open, print, or include untracked `.env` or credential files.
  - Record a finite read-only state manifest for the existing `.venv` (relative path, file size, and SHA-256 for readable files, plus directory/reparse metadata); never print file contents. If a file is unreadable, stop and record the path and exception class rather than changing permissions.
  - Observe production using GET only and finite deadlines: require `https://vivek-raj.onrender.com/health` to return `200` and an unauthenticated `https://vivek-raj.onrender.com/api/v1/webhooks/health` to return `401`. Use no authorization header, payload, webhook request, deployment action, restart, or trading/exchange endpoint. Classify timeout/DNS failure as `EXTERNAL_VERIFICATION_FAILED`, not as permission to modify production.
  - Encode the observed baseline as the preservation property: for generated/checklisted non-bug contexts, tracked-file state, deployment declarations, localhost target, old `.venv` manifest, Application Control posture, secret-disclosure count, and trading-side-effect count remain invariant; production statuses remain `200`/`401` when reachable.
  - Run the preservation checks against the unfixed state and require them to pass. Keep only allowlisted, sanitized observations in the task execution record; do not create an application or deployment file.
  - **Validation checkpoint**: Confirm commit and pin equality, baseline observations are complete enough for a later before/after comparison, production requests were bounded and read-only, the old `.venv` was not changed, and the preservation property passed.
  - _Requirements: 2.1, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 3. Obtain the explicit approval and safety gate for external provisioning
  - Present the sanitized results from tasks 1 and 2, including any `BASELINE_MISMATCH`, `SECRET_RISK`, or `POLICY_BLOCKED` result. Do not continue while either of the first two classifications is unresolved.
  - Propose an exact, new, versioned repair root such as `%LOCALAPPDATA%\vivek-crypto-trader\local-webhook-017a607-YYYYMMDD-HHmmss`; resolve its canonical parent and demonstrate that it is outside the workspace, OneDrive, Dropbox, network shares, redirected/synchronized folders, and the existing `.venv`.
  - Identify an organization-approved source for native Windows CPython `3.11.9` x64. If it is not already installed, state that installing it changes machine software, identify the publisher/source and install scope, and request approval for that installation as part of this gate.
  - State the bounded network actions that later tasks may perform: approved CPython acquisition if needed, pip installation from the approved package source, and read-only health GETs. Do not expose authenticated package-index URLs or configuration.
  - Ask the user for explicit approval of the exact repair-root path and, separately if needed, installation of trusted CPython. Approval to create the repair root does **not** authorize deleting or changing the project `.venv`, changing Windows Application Control, modifying global packages, or changing production.
  - Create nothing outside the workspace and perform no installation until approval is recorded. If the proposed root or interpreter source is rejected, revise the proposal and repeat this gate.
  - **Validation checkpoint**: Record the approved canonical repair-root path, approved interpreter source/path or approved installation action, allowed network scope, and explicit exclusions before task 4 starts.
  - _Requirements: 2.1, 2.3, 2.5, 3.5, 3.6, 3.7, 3.8_

- [x] 4. Implement the approved external local-environment repair
  - Do not begin this parent task until tasks 1-3 are complete. Execute subtasks in order; each subtask must fail closed and retain only sanitized diagnostics.

  - [x] 4.1 Provision and verify trusted native Windows CPython 3.11.9 x64
    - Discover candidates read-only first. Accept only native Windows CPython with `sys.version_info[:3] == (3, 11, 9)`, 64-bit architecture, an absolute executable path outside OneDrive and the project `.venv`, and provenance allowed by the approval from task 3.
    - If no candidate exists and installation was explicitly approved, acquire/install CPython only from the approved source and verify publisher signature/provenance using the organization's normal validation process before execution. Do not alter global packages.
    - Reject Store aliases, Python `3.14.6`, architecture mismatches, global-import success as proof of repair, WSL/subsystem substitutions, and unapproved distributions. Record the absolute accepted base-interpreter path without recording environment values.
    - If exact trusted CPython cannot be obtained, classify `UNSUPPORTED_INTERPRETER` and stop before creating a venv.
    - **Validation checkpoint**: A bounded identity probe proves exact CPython `3.11.9` x64 and approved provenance; no pip package or application/deployment file has changed.
    - _Requirements: 2.1, 2.5, 3.1, 3.5, 3.7, 3.8_

  - [x] 4.2 Create the approved versioned repair root, export tracked source only, and create the new venv
    - Revalidate the canonical approved root immediately before creation. Refuse an existing/nonempty root or any path under a synchronized, redirected, network, workspace, or project-`.venv` location; use a fresh version suffix rather than overwriting a failed attempt.
    - Create only the approved external root and dedicated `source`, `venv`, `tools`, and sanitized-diagnostics locations.
    - Export commit `017a607` with a tracked-files-only Git archive into `source`; do not copy from the working tree. Verify archive membership against `git ls-tree -r --name-only 017a607` and reject `.env`, `.venv`, service-account keys, credential files, Git metadata, or other known secret-bearing paths. `.env.example` may remain only if it is tracked and contains no real credential.
    - Re-read the exported `source\backend\requirements.txt` and require exact equality with the seven approved pins before continuing.
    - Use the verified absolute base interpreter to create `venv`, then bind all subsequent Python/pip operations to the absolute `%REPAIR_ROOT%\venv\Scripts\python.exe`; never rely on PATH activation or fallback to global/project Python.
    - Verify `sys.executable` equals the expected repair interpreter, `sys.prefix` is the new venv, `sys.base_prefix != sys.prefix`, version is `3.11.9`, architecture is x64, and both source and venv resolve outside OneDrive.
    - Save the task-2 non-secret baseline manifest in sanitized diagnostics or regenerate and compare it before continuing; do not persist `.env` paths/contents or secrets.
    - **Validation checkpoint**: Source membership is exactly the tracked commit export, secret files are absent, the repair interpreter identity is exact, and workspace files plus the old `.venv` still match the task-2 baseline.
    - _Requirements: 2.1, 2.5, 3.1, 3.4, 3.6, 3.8_

  - [x] 4.3 Install the repository-pinned dependency graph coherently in the new venv
    - Invoke only the repair interpreter's pip with the exported `source\backend\requirements.txt`, `--disable-pip-version-check`, a 30-second per-operation network timeout, two retries, and a finite overall installer deadline.
    - Install all dependencies in one coherent operation. Do not use `--no-deps`, substitute versions, edit requirements, reuse packages from global Python, print pip credentials/configuration, or repeatedly mutate a timed-out/failed environment.
    - If installation times out, a pin is unavailable, or resolution fails, terminate the owned installer, classify `PROVISIONING_FAILED`, preserve sanitized evidence, and abandon this versioned venv. A retry requires returning to task 3 for approval of a fresh versioned repair root.
    - Compare installed direct distribution versions exactly to all seven pins and fail on missing or mismatched values. Require `python -m pip check` exit code zero.
    - Inspect only the repair venv's metadata; fail on a distribution name beginning with `~`, malformed metadata, invalid-distribution text, or `RequestsDependencyWarning`.
    - **Validation checkpoint**: Exact direct versions match, dependency graph is consistent, metadata is valid, no dependency warning is present, and no package outside the repair venv changed.
    - _Requirements: 2.2, 2.5, 3.1, 3.5, 3.6, 3.8_

  - [x] 4.4 Implement and run bounded secret-safe dependency, native-module, and application import verification
    - Create verification tooling only under `%REPAIR_ROOT%\tools`; do not modify exported application source, workspace source, dependency declarations, or deployment files.
    - Make every probe a child process with a short timeout and bounded captured output. Always invoke the absolute repair interpreter and use `source\backend` as the application-import working directory.
    - Build the child environment from an allowlist/minimal inherited environment: remove exchange keys, Firebase credential paths, authorization/bearer values, webhook secrets, tokens, and other credential variables without printing their names/values; set `AUTO_TRADE_ENABLED=false`, `WEBHOOK_LIVE_EXECUTION_ENABLED=false`, `LEGACY_WEBHOOK_LIVE_ENABLED=false`, `USE_TESTNET=true`, and `PORT=5000`.
    - Verify warning-free imports of `flask`, `flask_cors`, `dotenv`, `ccxt`, `requests`, `gunicorn`, and `firebase_admin`, then probe the resolved gRPC/cygrpc native import before importing `app` without starting a server.
    - Verify the imported Flask application exists and registers `/health` and `/api/v1/webhooks/health`. Treat a warning solely about intentionally absent Firebase credentials as an optional-service state only if import completes and no secret is exposed.
    - Detect Application Control denial separately from generic import failure. On blocked `grpc`, `cygrpc`, or another required binary, classify `POLICY_BLOCKED`, stop before server startup, and record only timestamp, interpreter path/version, package/module version, DLL filename, exception class, available Windows event identifier, signer status, and file hash.
    - For `POLICY_BLOCKED`, direct the user to the normal administrator/security approval path for the exact signed provenance or an approved internal package/runtime. Do not disable/edit policy, add exclusions, use `Unblock-File`, rename/copy a DLL, load from global Python, patch out Firebase/gRPC, use `--no-deps`, or change subsystem to evade enforcement. Any sanctioned resolution must be followed by fresh provisioning in a newly approved versioned root.
    - For a non-policy exception, timeout, dependency warning, or uncaught error, classify `IMPORT_FAILED` and stop to revise the hypothesis rather than broadening the repair.
    - Unit-test the verifier's timeout, output bound, warning classifier, policy-block classifier, and redaction allowlist using synthetic secrets/errors before accepting its output.
    - **Validation checkpoint**: All required imports and routes pass warning-free, or the workflow safely terminates with a non-healthy classified result; security policy remains enforced, output is sanitized, and no server was started.
    - _Requirements: 2.2, 2.3, 2.5, 3.5, 3.6, 3.7, 3.8_

  - [x] 4.5 Implement and run the owned bounded local health harness
    - Extend tooling only under `%REPAIR_ROOT%\tools`. The harness must use the absolute repair interpreter, the secret-free exported backend, the same sanitized safety environment from task 4.4, bounded in-memory/sanitized output, no debugger/reloader/watch mode, and GET requests only.
    - Before startup, check port `5000`. If an unrelated process owns it, classify `PORT_CONFLICT`, do not terminate it, and stop for user action.
    - Start `source\backend\app.py` as an owned child. Poll `http://127.0.0.1:5000/health` with 3-second request timeouts, bounded backoff, and a 30-second overall readiness deadline.
    - Require a final `GET http://127.0.0.1:5000/health` status of `200` and an unauthenticated `GET http://127.0.0.1:5000/api/v1/webhooks/health` status of exactly `401`; send no authorization header, body, webhook request, exchange request, synchronization request, or trading request.
    - In an unconditional `finally` path, terminate the child with a 5-second grace period, force-terminate only that owned child if necessary, wait up to 5 seconds for exit, close streams, and prove the child no longer owns port `5000`. Never terminate an unrelated process.
    - Unit-test the controller with test doubles for readiness, crash, timeout, wrong status, unrelated port ownership, cleanup resistance, bounded retries, and output overflow. Every generated timeline must reach a terminal classification and leave no owned child unmanaged.
    - Classify readiness timeout, early exit, wrong status, request timeout, or cleanup failure as `LOCAL_HEALTH_FAILED`; endpoint success without confirmed child cleanup is not healthy.
    - **Validation checkpoint**: Record sanitized evidence for local `/health=200`, unauthenticated v1 health `=401`, and confirmed child exit/port release. Confirm no credential or side-effecting request was used.
    - _Requirements: 2.4, 2.5, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 4.6 Verify the bug-condition exploration property now passes in the repaired context
    - **Property 1: Expected Behavior** - Clean Policy-Compliant Local Backend
    - **IMPORTANT**: Re-run the same parameterized probe protocol and expected-behavior assertions defined in task 1; point it at the repair interpreter and exported source rather than creating a weaker replacement test.
    - Combine task 4.5's health/cleanup result with interpreter, pin, metadata, warning, policy, and import observations. Require the complete design `expectedBehavior(result)` predicate: approved non-OneDrive root, commit `017a607`, exact repair interpreter, exact pins, healthy metadata/graph, warning-free successful app import, local `200`/`401`, enforced policy, terminated server, old `.venv` untouched, and no secret exposure.
    - A `POLICY_BLOCKED` result is a correct safe-stop classification but is not a passing healthy repair; verify no server started, policy remained enforced, and `claimedHealthy=false`.
    - **Validation checkpoint**: The unchanged Property 1 test passes completely for `HEALTHY`, or execution stops with the correct non-healthy classification and no unsafe workaround.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 4.7 Verify Render read-only and rerun the preservation property
    - **Property 2: Preservation** - Source, Security, Secrets, Production, and Existing Environment
    - **IMPORTANT**: Re-run the same observation-first preservation checks from task 2; do not write replacement assertions based only on the repaired state.
    - After proving local child cleanup, perform only finite unauthenticated GETs: require production `/health=200` and unauthenticated production `/api/v1/webhooks/health=401`, with short request timeouts, a small finite retry allowance for cold start, and a hard overall deadline.
    - Do not authenticate, send payloads, call webhook/trading/exchange/synchronization endpoints, deploy, restart Render, edit configuration, or infer authorization for production changes from a local failure.
    - Compare repository commit/ref, tracked working-tree status and hashes, `backend/requirements.txt`, Render declarations/configuration, frontend localhost target, Windows Application Control posture, and the full readable old-`.venv` manifest against task 2. Preserve pre-existing user changes exactly; do not auto-reset a difference.
    - Verify no secret-bearing file was copied to the repair root, no secret was persisted/displayed/sent, global Python package state was not modified, all three trading flags remained false in verification, and side-effecting request count is zero.
    - Classify unreachable production as `EXTERNAL_VERIFICATION_FAILED` and a reachable wrong status as `REGRESSION_DETECTED`; neither result authorizes a production modification.
    - **Validation checkpoint**: Property 2 passes with unchanged tracked source/deployment/frontend/policy/old-`.venv` state and expected Render statuses, or the workflow stops with a precise inconclusive/regression classification.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 4.8 Produce final reproducible local-run and recovery instructions
    - Write the instructions only under the approved repair root (for example, `%REPAIR_ROOT%\LOCAL-RUN-INSTRUCTIONS.md`) and include the exact approved root, source commit, absolute repair interpreter, Python version/architecture, exact dependency pins, and final classification. Do not edit repository documentation.
    - Provide copyable PowerShell steps that verify `sys.executable`, set the backend working directory, set non-secret safety flags, manually start the backend with the absolute repair interpreter, run bounded local `/health=200` and unauthenticated v1 health `=401` checks from a second terminal, and stop the process with confirmation that port `5000` is released.
    - Clearly state that the execution agent must not start a long-running server for the user; the user runs the documented foreground command manually and stops it explicitly. Do not recommend a watcher, debugger, reloader, or background/unmanaged process.
    - Explain that global Python and the project `.venv` are not fallbacks, secrets must be provisioned only through a separately approved secure mechanism, Application Control blocks require administrator remediation, failed environments are retried only in a fresh approved versioned root, and production/live-trading actions remain out of scope.
    - Include recovery for `WinError 5`: stop owned processes, retain the old project `.venv`, abandon the failed new versioned root, obtain approval for a fresh non-synchronized root, and repeat provisioning without in-place pip repair.
    - **Validation checkpoint**: Dry-review every command for absolute interpreter binding, correct working directory, exact safety flags, no embedded secret, no policy bypass, bounded health checks, and explicit user-controlled shutdown.
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x]* 5. Optional destructive cleanup of the old project `.venv`
  - **OPTIONAL / DESTRUCTIVE**: This task is not part of a healthy repair and must remain skipped by default. Do not infer approval from task 3 or from successful completion of task 4.
  - Immediately before any deletion, show the exact canonical old `.venv` path and request a new, separate, explicit user confirmation that names that path and authorizes permanent deletion. A generic “continue” or repair-root approval is insufficient.
  - If confirmation is absent, ambiguous, or withdrawn, retain the old `.venv` unchanged and mark this optional task skipped; do not rename, quarantine, repair, or partially clean it.
  - If separately confirmed, first prove no process uses that interpreter, preserve only user-approved sanitized diagnostic evidence, verify the target is exactly the workspace `.venv` and not the repair venv or another directory, then delete only that confirmed path.
  - Never use wildcard cleanup, recursive deletion against a parent directory, or deletion to resolve an active lock. On `WinError 5`, stop and report the lock without changing permissions or security policy.
  - **Validation checkpoint**: Either the old `.venv` remains byte-for-byte equal to the task-2 manifest, or a separately recorded path-specific confirmation exists and only the confirmed directory was removed.
  - _Requirements: 2.1, 3.5, 3.6, 3.8_

- [x] 6. Checkpoint - Confirm the repair is reproducible, bounded, local-only, and preservation-safe
  - Require completed evidence for tasks 1-4 and all validation checkpoints. Task 5 may remain skipped and must not block `HEALTHY`.
  - Declare `HEALTHY` only when the exact interpreter/pins, dependency and import health, local `200`/`401`, guaranteed child cleanup, Render read-only `200`/`401`, tracked-file invariance, old-`.venv` retention, secret safety, enforced Application Control, and zero production/trading mutations all pass.
  - For `POLICY_BLOCKED`, `PROVISIONING_FAILED`, `IMPORT_FAILED`, `LOCAL_HEALTH_FAILED`, `EXTERNAL_VERIFICATION_FAILED`, or `REGRESSION_DETECTED`, report the sanitized classification and safe next action without claiming success or broadening scope.
  - Confirm final instructions point only to the versioned external repair interpreter/source and explain manual startup/shutdown; ask the user if any result is unclear before further action.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_
