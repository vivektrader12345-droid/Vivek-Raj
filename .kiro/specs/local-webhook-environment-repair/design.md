# Local Webhook Environment Repair Bugfix Design

## Overview

This bugfix repairs only the local Windows backend runtime. It does not change application source, `backend/requirements.txt`, frontend routing, Render configuration, webhook behavior, exchange connectivity, or live-trading controls.

The repair uses a clean native Windows CPython 3.11.9 x64 installation and a dedicated virtual environment under an organization-approved, non-synchronized local path such as `%LOCALAPPDATA%\vivek-crypto-trader\local-webhook-017a607`. Python 3.11.9 matches the version declared for Render and avoids the unsupported project environment's Python 3.14.6. Both the clean source snapshot and the new virtual environment are kept outside OneDrive so package extraction, DLL loading, and virtual-environment updates do not encounter OneDrive locks or partial synchronization. The source snapshot is exported from the verified `origin/main` commit `017a607`; untracked files such as `backend/.env` and the existing `.venv` are not copied.

The existing project `.venv` is evidence of the defect and remains untouched. It is never repaired in place, selected as the interpreter, renamed, or deleted without explicit user authorization. The global Python installation may be inspected for discovery only; successful imports from global Python do not count as a repaired environment.

Provisioning and verification are organized as fail-closed gates. A result is healthy only if the selected interpreter is the clean external environment, all seven direct dependencies match the repository pins, dependency metadata is healthy, warning-free imports succeed, `backend/app.py` imports successfully, bounded local HTTP checks return `200` and `401` as specified, the child server is terminated, and bounded read-only Render checks preserve the production responses. A Windows Application Control block of `grpc` or `cygrpc` is a policy-blocked safe stop, not a reason to disable, weaken, or bypass security.

### Repair Architecture

1. **Baseline Gate** verifies that `origin/main` resolves to `017a607`, confirms the seven pins in that commit, and records that tracked application and deployment files will not be changed.
2. **External Repair Root** contains a secret-free source export, a new `venv`, and sanitized diagnostics under an approved path outside OneDrive.
3. **Interpreter Gate** selects trusted native Windows CPython 3.11.9 x64 and thereafter invokes the virtual environment's full `python.exe` path for every Python or pip operation.
4. **Dependency Gate** installs only from the exported `backend/requirements.txt`, verifies exact direct versions and transitive consistency, and rejects invalid distributions or `RequestsDependencyWarning`.
5. **Application Control Gate** performs bounded native-module and application imports. A blocked DLL stops the workflow and routes the evidence through the normal administrator/security approval process.
6. **Secret-Safe Runtime Gate** starts the backend from the external source snapshot with trading flags disabled and without copying or displaying credentials.
7. **Bounded Health Harness** owns the child process, polls localhost with per-request and overall timeouts, verifies the two expected statuses, and terminates the process in a `finally` path.
8. **Render Regression Gate** sends only unauthenticated GET requests with finite timeouts to the existing production health endpoints. It never sends webhook payloads or trade requests.
9. **Result Classifier** produces `HEALTHY`, `POLICY_BLOCKED`, `PROVISIONING_FAILED`, `LOCAL_HEALTH_FAILED`, or `REGRESSION_DETECTED`; only `HEALTHY` satisfies the repair.

### Workflow

```text
Verify commit and pins
        |
        v
Create versioned external repair root outside OneDrive
        |
        v
Export tracked commit 017a607 without .env or .venv
        |
        v
Select trusted CPython 3.11.9 x64 by absolute path
        |
        v
Create new external venv and bind all commands to its python.exe
        |
        v
Install exact repository pins with bounded retries/timeouts
        |
        v
Verify interpreter -> metadata -> pip check -> warning-free imports
        |
        v
Import backend/app.py with timeout
        |                         \
        | success                  \ native module blocked
        v                           v
Start child server             POLICY_BLOCKED; stop and request
with safe local flags          sanctioned administrator review
        |
        v
GET /health == 200 and unauthenticated
GET /api/v1/webhooks/health == 401
        |
        v
Terminate and reap child process in all outcomes
        |
        v
Bounded read-only Render checks and tracked-file comparison
        |
        v
HEALTHY only if every required gate passed
```

## Glossary

- **Bug_Condition (C)**: A local Windows backend execution context in which the current OneDrive-hosted project `.venv`, unsupported Python 3.14.6, corrupted package metadata, missing/inconsistent dependencies, or an Application Control-blocked native module prevents a healthy local Flask backend.
- **Property (P)**: The repaired context uses trusted CPython 3.11.9 in a clean non-OneDrive environment, has the exact direct dependency pins and healthy imports, and passes bounded local health checks without weakening security.
- **Preservation**: The source baseline, production deployment, frontend localhost target, authentication behavior, Windows security policy, secrets, trading controls, and corrupted project `.venv` remain unchanged.
- **Repair_Root**: A versioned, organization-approved local directory outside OneDrive, for example `%LOCALAPPDATA%\vivek-crypto-trader\local-webhook-017a607`.
- **Base_Interpreter**: A trusted native Windows CPython 3.11.9 x64 installation approved by the machine's normal software policy.
- **Repair_Interpreter**: The absolute path `%REPAIR_ROOT%\venv\Scripts\python.exe`; it is the only interpreter accepted after environment creation.
- **Source_Snapshot**: A tracked-file-only export of Git commit `017a607` placed under `%REPAIR_ROOT%\source`.
- **Dependency_Health**: Exact direct-pin equality, successful `pip check`, valid distribution metadata, and no invalid-distribution or Requests dependency warnings.
- **Application_Control_Gate**: A fail-closed check that detects blocked native modules and requires a sanctioned security-administration resolution.
- **Bounded_Health_Harness**: A finite process controller that starts, polls, verifies, terminates, and reaps the local Flask child process.
- **Safe_Stop**: Termination without declaring success, bypassing policy, deleting the old `.venv`, changing source, or leaving a server running.
- **F**: The original local setup using the corrupted project `.venv`.
- **F'**: The repaired local setup using the external clean environment.

## Bug Details

### Bug Condition

Let `X` be a local backend execution context and let `C(X)` identify a context affected by the defect:

\[
C(X) = Windows(X) \land LocalWebhookBackend(X) \land
(ProjectVenvSelected(X) \lor UnsupportedPython(X) \lor CorruptMetadata(X) \lor DependencyWarning(X) \lor MissingDependency(X) \lor NativeModuleBlocked(X) \lor BackendUnreachable(X))
\]

**Formal Specification:**

```pascal
FUNCTION isBugCondition(input)
  INPUT: input of type LocalBackendContext
  OUTPUT: boolean

  RETURN input.operatingSystem = "Windows"
         AND input.target = "local-webhook-backend"
         AND (
           input.selectedInterpreter = input.oneDriveProjectVenv
           OR input.pythonVersion = "3.14.6"
           OR input.hasInvalidDistribution("~harset-normalizer")
           OR input.emitsWarning("RequestsDependencyWarning")
           OR NOT input.canImport("ccxt")
           OR input.applicationControlBlocks("grpc/cygrpc")
           OR NOT input.hasHealthyServer("http://localhost:5000")
         )
END FUNCTION
```

The repaired behavior predicate is:

```pascal
FUNCTION expectedBehavior(result)
  INPUT: result of type RepairResult
  OUTPUT: boolean

  RETURN result.repairRoot.isOutsideOneDrive
         AND result.sourceCommit = "017a607"
         AND result.interpreter.version = "3.11.9"
         AND result.interpreter.path = result.repairRoot + "\\venv\\Scripts\\python.exe"
         AND result.directDependencyVersions = REQUIRED_PINS
         AND result.pipCheckPassed
         AND NOT result.hasInvalidDistribution
         AND NOT result.hasRequestsDependencyWarning
         AND result.appImportSucceeded
         AND result.localHealthStatus = 200
         AND result.localWebhookHealthStatus = 401
         AND result.serverProcessTerminated
         AND result.applicationControlRemainedEnforced
         AND result.oldProjectVenvUntouched
         AND result.secretsWereNotExposed
END FUNCTION
```

### Examples

- **Corrupted environment**: Selecting `<OneDrive workspace>\.venv\Scripts\python.exe` identifies Python 3.14.6 and emits an invalid `~harset-normalizer` warning. This satisfies `C(X)` and must not be repaired in place.
- **Partial workaround**: Installing `ccxt==4.5.68 --no-deps` lets `ccxt` import but leaves `RequestsDependencyWarning`. The dependency gate fails; partial import success is not a healthy result.
- **Application Control block**: Importing `backend/app.py` raises a load/block error for the gRPC `cygrpc` DLL. The result is `POLICY_BLOCKED`; the verifier stops, terminates any child process, and produces sanitized evidence for administrator review.
- **Wrong interpreter**: Global Python imports `ccxt` and `firebase_admin`, but `sys.executable` is outside the repair environment. Interpreter verification fails even if imports succeed.
- **Successful repair**: The external CPython 3.11.9 environment imports `app.py` without dependency warnings, local `/health` returns `200`, unauthenticated local `/api/v1/webhooks/health` returns `401`, and the harness stops its server. This satisfies `P(result)`.
- **Authentication edge case**: Local `/api/v1/webhooks/health` returns `200` without a bearer token. The backend is reachable, but the repair fails because authentication preservation requires `401`.
- **Lifecycle edge case**: Both local endpoints return expected statuses, but the child process cannot be confirmed terminated. The result is not healthy until cleanup succeeds.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- Git commit `017a607` remains the verified baseline, and `backend/requirements.txt` retains `requests==2.34.2` and all other declared pins.
- The original project `.venv` remains byte-for-byte untouched unless the user later provides explicit deletion permission.
- `src` continues to target `http://localhost:5000`; no production redirect or frontend source change is introduced.
- Local and production unauthenticated `GET /api/v1/webhooks/health` continue to return `401`.
- Render continues using its existing `/health` check, `render.yaml`, root directory, build command, start command, and production safety flags.
- Windows Application Control remains enabled and unchanged. No exclusions, policy edits, copied DLLs, alternate loaders, or file-unblocking commands are used.
- No `.env`, service-account file, bearer token, API key, exchange credential, webhook secret, or secret-bearing pip configuration is copied into the repair root, printed, persisted in diagnostics, or sent over the network.
- No POST, PATCH, DELETE, webhook ingestion, exchange-connect, synchronization, or trading endpoint is called during verification.
- `WEBHOOK_LIVE_EXECUTION_ENABLED`, `LEGACY_WEBHOOK_LIVE_ENABLED`, and `AUTO_TRADE_ENABLED` remain false in the verification child process; exchange keys are absent from that process.

**Scope:**

Inputs outside `C(X)` must remain unaffected. In particular, the repair does not alter:

- tracked application, frontend, dependency, or deployment files;
- production service state or production credentials;
- Windows security configuration;
- global Python package state;
- the existing project `.venv`;
- webhook execution and live-trading behavior.

## Hypothesized Root Cause

1. **In-place environment mutation inside OneDrive**: pip was interrupted by `WinError 5` while renaming or uninstalling `charset_normalizer`.
   - OneDrive synchronization, antivirus scanning, or another process can hold package files while pip replaces them.
   - The leftover `~harset-normalizer` metadata proves the environment is not transactionally healthy.

2. **Unsupported interpreter selection**: The project `.venv` uses Python 3.14.6 while production is configured for Python 3.11.9.
   - Native dependency wheels and application dependencies are more predictably available for the production-aligned interpreter.
   - A global interpreter that happens to import packages is not isolated or reproducible.

3. **Partial dependency installation**: `ccxt==4.5.68 --no-deps` repaired one missing top-level import without repairing the dependency graph.
   - `RequestsDependencyWarning` and invalid metadata remain observable evidence.
   - The exact repository requirements were not installed into a clean environment as one coherent operation.

4. **Windows Application Control trust decision**: `firebase-admin` reaches Firestore dependencies that load the native gRPC `cygrpc` extension.
   - The DLL may be correctly installed but disallowed by current machine policy or provenance rules.
   - Relocating or reinstalling alone cannot be assumed to make the binary policy-compliant.

5. **Health symptom rather than frontend defect**: Vite correctly targets `http://localhost:5000`, but no importable and healthy Flask process owns that endpoint.
   - Redirecting the frontend to production would hide the local runtime defect and violate preservation requirements.

These hypotheses must be confirmed by finite exploration before implementation. If the clean external environment still produces an error outside these categories, the result is classified and the root-cause analysis is revised rather than broadening the repair destructively.

## Correctness Properties

Property 1: Bug Condition - Clean Policy-Compliant Local Backend

_For any_ Windows local backend context where `isBugCondition` returns true, the repaired workflow SHALL select the clean external CPython 3.11.9 interpreter, install and verify the exact repository pins, import the application without invalid-distribution or Requests dependency warnings, preserve Application Control, and produce bounded local status responses `200` for `/health` and `401` for unauthenticated `/api/v1/webhooks/health`, with the server terminated afterward. If Application Control still blocks a required native module, the workflow SHALL safely return `POLICY_BLOCKED` and SHALL NOT claim the environment is healthy.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

Property 2: Preservation - Source, Security, Secrets, Production, and Existing Environment

_For any_ repair or verification input, including inputs where `isBugCondition` returns false, `F'` SHALL preserve the observable source and deployment behavior of `F`: tracked source and dependency declarations remain unchanged, the frontend remains local, unauthenticated production webhook health remains `401`, Render `/health` remains available, Windows Application Control remains enforced, secrets remain undisclosed, no trading action occurs, global Python remains unmodified, and the corrupted project `.venv` remains retained until explicit deletion permission is given.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

## Fix Implementation

### Changes Required

The implementation is an operational repair in the external repair root. It must not edit tracked project source, `backend/requirements.txt`, `render.yaml`, the global interpreter, or the existing project `.venv`.

#### 1. Establish the Baseline Without Mutating It

- Resolve `origin/main` locally and require commit `017a607`. Do not fetch, checkout, reset, merge, or otherwise change repository state as part of the repair.
- Read the requirements from commit `017a607` and require exact equality with the seven expected direct pins.
- Export tracked files from commit `017a607` to a new versioned directory under `%LOCALAPPDATA%` or another administrator-approved, non-synchronized local path.
- Reject a repair root under OneDrive, Dropbox, a network share, `/mnt`, or another synchronized/redirected location.
- Do not copy the workspace `.env`, `serviceAccountKey.json`, `.venv`, Git credentials, or untracked files.

#### 2. Select and Bind the Interpreter

- Use native Windows CPython **3.11.9 x64**, installed from an organization-approved source. Render declares Python 3.11.9, making this the compatibility target.
- Discovery may use the Windows Python launcher, but creation must use the verified absolute base-interpreter path.
- Verify `sys.version_info[:3] == (3, 11, 9)`, `platform.architecture()` is 64-bit, and the interpreter is not inside OneDrive or the existing project `.venv`.
- Create `%REPAIR_ROOT%\venv` and bind every later command to `%REPAIR_ROOT%\venv\Scripts\python.exe`.
- After creation, verify `sys.prefix` is the repair venv, `sys.base_prefix != sys.prefix`, and `sys.executable` exactly matches the expected absolute path.
- Do not install into or use global Python as a fallback. A global import can be recorded only as diagnostic context.

#### 3. Install the Exact Direct Pins

The exported `backend/requirements.txt` is the single installation input:

| Package | Required version |
|---|---:|
| `flask` | `3.0.0` |
| `flask-cors` | `4.0.0` |
| `python-dotenv` | `1.0.0` |
| `ccxt` | `4.5.68` |
| `requests` | `2.34.2` |
| `gunicorn` | `21.2.0` |
| `firebase-admin` | `6.4.0` |

The installer invocation design is equivalent to:

```powershell
& $RepairPython -m pip install `
  --disable-pip-version-check `
  --timeout 30 `
  --retries 2 `
  --requirement "$RepairRoot\source\backend\requirements.txt"
```

- Do not use `--no-deps`; transitive dependencies must resolve coherently.
- Do not substitute a nearby version if an exact pin is unavailable. Classify that outcome as `PROVISIONING_FAILED` and preserve evidence.
- Do not add or change pins in `backend/requirements.txt` during this repair.
- Use only the organization's approved package source configuration. Do not print `pip config`, index URLs containing credentials, or authentication headers.
- Bound the full installer process in addition to pip's network timeout. On timeout, terminate it and create a fresh versioned repair environment for the next attempt instead of mutating the failed one repeatedly.

#### 4. Verify Dependency and Import Health

Run each check with the repair interpreter and a finite subprocess timeout:

1. **Interpreter identity**: exact executable, venv prefix, Python 3.11.9 x64, non-OneDrive location.
2. **Direct distribution versions**: use `importlib.metadata.version` and compare all seven distributions to the table.
3. **Metadata integrity**: inspect only the repair venv's distributions and fail on a name beginning with `~`, malformed metadata, or an invalid-distribution warning.
4. **Dependency graph**: require `python -m pip check` exit code zero and sanitized output.
5. **Top-level imports**: import `flask`, `flask_cors`, `dotenv`, `ccxt`, `requests`, `gunicorn`, and `firebase_admin` while capturing warnings; fail on `RequestsDependencyWarning` or invalid-distribution text.
6. **Native-module probe**: import the gRPC path required by the resolved Firebase dependency graph before importing the application.
7. **Application import**: from the external snapshot's `backend` working directory, import `app` and verify the Flask application and both routes are registered. This probe must have a short overall timeout and must not start a server.

A Firebase-unavailable warning caused solely by intentionally absent local credentials may be recorded as an optional-service state if the application import completes and no secret is exposed. A dependency warning, native-module block, uncaught exception, or timeout is a failure.

#### 5. Handle Windows Application Control Without Weakening Security

If `grpc` or `cygrpc` is blocked:

- Stop before server startup and classify the result `POLICY_BLOCKED`.
- Record only sanitized evidence: timestamp, Python version/path, package name/version, blocked module filename, exception class, Windows event identifier if available, signer status, and file hash. Never include environment-variable values, tokens, or credential contents.
- Ask the machine's administrator/security team to approve the exact signed CPython/package provenance, provide the dependency from an approved internal package source, or provide an organization-managed Python 3.11.9 environment that complies with existing policy.
- After approval or an administrator-provided trusted package is available, discard the failed new repair environment and provision a fresh versioned environment from the unchanged pins.
- Do **not** disable Application Control, edit its policy, add exclusions, use `Unblock-File`, rename/copy the DLL to evade controls, load a DLL from global Python, use `--no-deps`, patch out Firebase/gRPC imports, or move execution to another subsystem merely to evade enforcement.
- An organization-approved alternate runtime may be used only when security administrators explicitly designate it as compliant; it is not an automatic workaround and cannot silently replace the required Windows repair result.

#### 6. Protect Secrets and Disable Side Effects

- Run from the secret-free external source snapshot so `load_dotenv()` cannot read the workspace `backend/.env`.
- Construct a child-process environment that removes exchange keys, Firebase credential paths, bearer tokens, and webhook secrets rather than printing or copying them.
- Explicitly set only non-secret safety values needed for verification: `PORT=5000`, `AUTO_TRADE_ENABLED=false`, `WEBHOOK_LIVE_EXECUTION_ENABLED=false`, `LEGACY_WEBHOOK_LIVE_ENABLED=false`, and `USE_TESTNET=true`.
- Do not pass `Authorization` to the webhook health check; the expected `401` is the assertion.
- Diagnostics use an allowlist of non-secret fields. Exception text is redacted before persistence if it contains URLs, query strings, authorization data, or values from sensitive environment variables.
- Verification uses GET requests only. It must not call webhook ingestion, exchange connection, synchronization, or trade endpoints.

#### 7. Perform Finite Local Health Verification

The health harness owns the entire process lifecycle:

```pascal
FUNCTION verifyLocalHealth(repairInterpreter, backendDirectory)
  INPUT: absolute repair interpreter and secret-free backend directory
  OUTPUT: LocalHealthResult

  child := START_PROCESS(
    executable = repairInterpreter,
    arguments = ["app.py"],
    workingDirectory = backendDirectory,
    environment = sanitizedSafetyEnvironment
  )

  TRY
    WAIT_UNTIL deadline = now + 30 seconds
      response := GET "http://127.0.0.1:5000/health" WITH timeout 3 seconds
      IF response.status = 200 THEN BREAK
      SLEEP with bounded backoff
    END WAIT

    ASSERT child is running
    ASSERT GET("http://127.0.0.1:5000/health", timeout=3s).status = 200
    ASSERT GET(
      "http://127.0.0.1:5000/api/v1/webhooks/health",
      headers = NO_AUTHORIZATION_HEADER,
      timeout = 3s
    ).status = 401

    RETURN VERIFIED
  FINALLY
    TERMINATE child WITH gracePeriod = 5 seconds
    IF child still runs THEN FORCE_TERMINATE child
    WAIT_FOR_PROCESS_EXIT child WITH timeout = 5 seconds
    ASSERT port 5000 is not owned by child
  END TRY
END FUNCTION
```

- Before startup, fail if port 5000 belongs to an unrelated process; never terminate an unrelated process.
- Capture bounded stdout/stderr in memory or a sanitized repair-root log; prevent unbounded output.
- A readiness timeout, early exit, wrong status, request timeout, or cleanup failure is `LOCAL_HEALTH_FAILED`.
- The harness terminates in every branch. It must not use a watch mode, debugger, reloader, or unmanaged terminal server.

#### 8. Verify Render Regression Read-Only

After local cleanup, use finite unauthenticated GET requests only:

- `GET https://vivek-raj.onrender.com/health` must return `200`.
- `GET https://vivek-raj.onrender.com/api/v1/webhooks/health` without `Authorization` must return `401`.
- Each request has a short per-request timeout and a small finite retry allowance for Render cold start; the overall phase has a hard deadline.
- Verify tracked `render.yaml`, `backend/requirements.txt`, and relevant source files have not changed during repair.
- A timeout or DNS/network failure is classified as an external verification failure and does not authorize a production change. A reachable wrong status is `REGRESSION_DETECTED` and requires investigation outside this local repair.
- Do not authenticate, wake the service through state-changing requests, deploy, restart Render, or alter configuration.

### Error Classification and Recovery

| Classification | Trigger | Safe response | Healthy? |
|---|---|---|---|
| `BASELINE_MISMATCH` | `origin/main` is not `017a607` or pins differ | Stop; report expected and observed commit/pin metadata without checkout or edits | No |
| `UNSUPPORTED_INTERPRETER` | Not CPython 3.11.9 x64 or wrong executable | Stop; select/install an approved interpreter, then create a new repair root | No |
| `ONEDRIVE_LOCATION` | Source snapshot or new venv resolves under a synchronized path | Stop; choose a new approved non-synchronized root | No |
| `PROVISIONING_FAILED` | Exact pin unavailable, installer timeout, metadata corruption, or `pip check` failure | Retain sanitized diagnostics; abandon that new venv and retry in a fresh versioned root | No |
| `POLICY_BLOCKED` | Application Control blocks `grpc`, `cygrpc`, or another required binary | Stop; preserve policy and request sanctioned administrator remediation | No |
| `SECRET_RISK` | A secret-bearing file/value would be copied, printed, or sent | Stop before import/server/network checks; remove the unsafe diagnostic design | No |
| `IMPORT_FAILED` | Warning-free top-level or `app.py` import fails for a non-policy reason | Stop; classify exception and revise root-cause hypothesis before retry | No |
| `PORT_CONFLICT` | Port 5000 is owned by another process | Stop; do not kill it; ask the user to free the port or approve another bounded verification arrangement | No |
| `LOCAL_HEALTH_FAILED` | Local timeout, early exit, wrong HTTP status, or failed cleanup | Terminate owned child, retain sanitized logs, investigate only the external environment | No |
| `EXTERNAL_VERIFICATION_FAILED` | Render cannot be reached within bounded retries | Record inconclusive external state; do not change production | No |
| `REGRESSION_DETECTED` | Reachable Render endpoint returns a status other than expected | Stop and escalate separately; do not repair production in this workflow | No |
| `HEALTHY` | Every interpreter, dependency, import, local health, cleanup, preservation, and Render gate passes | Select the repair interpreter for local backend use and retain reproducible instructions | Yes |

### Rollback and Recovery

- **No source rollback is normally needed** because implementation does not edit tracked source or deployment files. A post-check difference is a preservation failure and must be investigated, not auto-reset.
- **New repair environment rollback** consists of stopping owned processes and ceasing use of that versioned external root. Deleting a newly created failed repair root is separate from the protected project `.venv`; preserve diagnostics first and obtain user confirmation before destructive cleanup when uncertain.
- **Interpreter rollback** consists of deselecting the failed repair interpreter. It does not mutate global Python or select the corrupted project `.venv` as a fallback.
- **Retry strategy** always creates a fresh versioned external environment. It does not repeatedly uninstall or overwrite packages in a failed environment.
- **Existing `.venv` recovery** is retention only. Deletion, rename, or cleanup of the OneDrive project `.venv` is out of scope until the user explicitly authorizes that exact action.
- **Application Control recovery** is an administrator-approved trust/provenance change or approved software distribution, followed by fresh provisioning. Security policy remains enforced throughout.
- **Production recovery** is out of scope. No local failure authorizes a deploy, restart, configuration edit, or trading change.

## Testing Strategy

### Validation Approach

Validation follows the bug-condition workflow: first surface finite counterexamples on the unfixed environment, then observe and encode non-buggy behavior to preserve, then run the same checks against the clean environment. Exploration must occur before any repair is treated as implemented. Every subprocess, installer, import, network request, and child-server lifecycle has both per-operation and overall time bounds.

### Exploratory Bug Condition Checking

**Goal**: Confirm the failure signatures without modifying, uninstalling from, or deleting the existing project `.venv`.

**Finite Test Plan**:

1. Invoke the old `.venv` interpreter only for read-only identity and import probes, each in a child process with a short timeout.
2. Record whether it identifies as Python 3.14.6, reports `~harset-normalizer`, emits `RequestsDependencyWarning`, imports `ccxt`, and blocks at `cygrpc` during `app.py` import.
3. Do not run pip install/uninstall, start a server, read `.env`, or print environment values in the old environment.
4. Stop exploration after the known signatures are confirmed or a fixed maximum number of probes is reached.

**Expected Counterexamples**:

- The old interpreter path resolves inside OneDrive and reports Python 3.14.6.
- Distribution inspection reports invalid `~harset-normalizer` metadata.
- Requests emits `RequestsDependencyWarning` despite `ccxt` importing.
- `app.py` import fails when Application Control blocks `cygrpc`.
- Localhost remains unavailable because no healthy backend starts.

If these counterexamples are not reproduced, reclassify the observed failure and revise the root-cause hypothesis before proceeding; do not infer that the old environment is healthy from one successful import.

### Fix Checking

**Goal**: For all contexts satisfying the bug condition, verify the clean environment either meets `expectedBehavior` or safely reports a policy block without false success.

```pascal
FOR ALL input WHERE isBugCondition(input) DO
  result := repairAndVerify_fixed(input)
  IF result.classification = POLICY_BLOCKED THEN
    ASSERT result.applicationControlRemainedEnforced
    ASSERT result.serverProcessTerminated
    ASSERT NOT result.claimedHealthy
  ELSE
    ASSERT expectedBehavior(result)
  END IF
END FOR
```

Fix checking includes exact interpreter identity, exact direct pins, dependency health, warning-free imports, successful application import, the local `200`/`401` pair, and confirmed process cleanup.

### Preservation Checking

**Goal**: Verify the repair changes only the selected local runtime environment.

```pascal
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT observableTrackedBehavior(F(input)) = observableTrackedBehavior(F'(input))
  ASSERT sourceAndDeploymentHashesBefore = sourceAndDeploymentHashesAfter
  ASSERT projectVenvStateBefore = projectVenvStateAfter
  ASSERT applicationControlPolicyBefore = applicationControlPolicyAfter
  ASSERT noSecretsDisclosed
  ASSERT noTradingSideEffects
END FOR
```

**Observation-first Test Plan**:

1. Before repair, record non-secret hashes/status for the baseline commit, `backend/requirements.txt`, `render.yaml`, frontend localhost configuration, and the existence/location of the project `.venv`.
2. Observe production unauthenticated webhook health `401` and Render `/health` behavior with bounded GET requests.
3. Record only approved non-secret observables; do not snapshot `.env` contents or credentials.
4. After repair, compare the same observations and require equality plus the specified production statuses.

### Unit Tests

- Test repair-root validation against OneDrive, synchronized, network, and approved local paths.
- Test interpreter validation for exact version, architecture, venv prefix, executable path, and global/project-venv rejection.
- Test exact-pin comparison for all seven distributions, including missing, extra-version, malformed, and unavailable-pin outcomes.
- Test warning and metadata classification for `~harset-normalizer`, `RequestsDependencyWarning`, `pip check` errors, and generic import errors.
- Test Application Control error recognition and verify that it maps to `POLICY_BLOCKED` without suggesting bypass actions.
- Test diagnostics redaction and allowlisting with synthetic tokens, URLs, API keys, credential paths, and exception messages.
- Test the process controller's deadline, retry bound, unrelated-port-owner protection, `finally` cleanup, force-termination fallback, and output-size bound.
- Test HTTP status predicates: local and Render `/health` require `200`; unauthenticated webhook health requires exactly `401`.

### Property-Based Tests

- Generate Windows paths and path-normalization variants to verify that every OneDrive/synchronized descendant is rejected and every approved external repair root remains eligible.
- Generate interpreter metadata combinations to verify that only CPython 3.11.9 x64 at the bound repair path passes.
- Generate direct-version maps to verify that success occurs if and only if all seven required versions match exactly.
- Generate warning, stderr, and exception records containing synthetic secrets to verify classification and redaction never disclose sensitive values.
- Generate child-process timelines—normal readiness, timeout, crash, wrong status, and cleanup resistance—to verify the harness always reaches a terminal result and never leaves its child unmanaged.
- Generate HTTP result sequences within retry limits to verify bounded readiness and Render cold-start handling cannot become an infinite loop.
- Generate non-bug-condition contexts to verify tracked-file hashes, project `.venv` state, policy state, and trading-side-effect counters are invariant.

### Integration Tests

- Provision a disposable external CPython 3.11.9 venv from the exact exported requirements and verify version metadata, `pip check`, warning-free imports, and `app.py` import.
- Run the bounded local harness against the secret-free source snapshot and verify `/health=200`, unauthenticated `/api/v1/webhooks/health=401`, and child termination.
- Simulate a native-module policy denial in a controlled test double and verify safe-stop classification, sanitized evidence, no server startup, and no bypass recommendation.
- Simulate package resolution and OneDrive lock failures and verify fresh-root recovery guidance rather than in-place mutation.
- Perform bounded unauthenticated Render GET checks and verify no state-changing request is emitted.
- Compare tracked files, dependency declarations, frontend target, Render configuration, policy state, and old `.venv` state before and after the repair workflow.

## Requirement Traceability

| Requirement | Design elements | Verification evidence |
|---|---|---|
| 1.1 | Bug Condition; external repair root; interpreter gate | Old environment identity and location counterexample |
| 1.2 | Dependency gate; metadata/warning classification | Invalid distribution, missing dependency, and warning probes |
| 1.3 | Application Control gate; root-cause hypothesis | Bounded `app.py` import and policy-block classification |
| 1.4 | Bounded health harness | Local readiness failure before repair; `200`/`401` after repair |
| 1.5 | Interpreter selection and global-fallback rejection | Exact `sys.executable`, prefix, and version assertions |
| 2.1 | Non-OneDrive source/venv architecture; retention and recovery rules | Path validation and old `.venv` before/after state |
| 2.2 | Exact pin table; coherent install; dependency health gates | Version map, `pip check`, metadata and warning checks |
| 2.3 | Native import probe and policy-compliant safe stop | Successful import or `POLICY_BLOCKED` with no bypass |
| 2.4 | Owned finite server lifecycle and exact local statuses | `/health=200`, webhook health `401`, confirmed child exit |
| 2.5 | Absolute interpreter binding; finite end-to-end workflow | Interpreter, install, import, health, and classification record |
| 3.1 | Baseline gate and no tracked changes | Commit/pin verification and tracked-file comparison |
| 3.2 | Render regression gate | Unauthenticated production webhook health `401` |
| 3.3 | Render `/health` preservation and no config changes | Production `/health=200`; unchanged `render.yaml` |
| 3.4 | Scope and preservation requirements | Unchanged frontend localhost target |
| 3.5 | Application Control restrictions | Unchanged policy state; blocked result fails closed |
| 3.6 | Secret-safe snapshot, environment, requests, and logs | Redaction tests; no secret files copied; no auth header |
| 3.7 | GET-only checks and disabled execution flags | Request audit and zero trading/exchange side effects |
| 3.8 | Existing-environment retention | Old project `.venv` existence/state comparison; no deletion action |
