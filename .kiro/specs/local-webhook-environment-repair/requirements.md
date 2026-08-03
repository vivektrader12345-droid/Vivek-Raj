# Local Webhook Environment Repair Bugfix Requirements

## Introduction

This bugfix addresses only the local Windows backend environment for the webhook application. The repository is located under OneDrive, and the existing project `.venv` is not a reliable runtime. The verified source baseline is `origin/main` commit `017a607`; its `backend/requirements.txt` pins `requests==2.34.2`. Production is already serving the authenticated v1 webhook API: an unauthenticated `GET https://vivek-raj.onrender.com/api/v1/webhooks/health` returns `401`. Therefore, the remaining defect is local to Windows and must be repaired without changing production, live-trading behavior, or security policy.

## Bug Analysis

### Current Behavior (Defect)

The present local environment cannot provide a healthy Flask backend for the localhost frontend.

1.1 WHEN the backend is run with the current project `.venv` under the OneDrive workspace THEN the system uses Python `3.14.6` from an environment left partially corrupted after `WinError 5` interrupted pip while renaming or uninstalling `charset_normalizer`.

1.2 WHEN dependencies in the current project `.venv` are inspected or imported THEN the system reports an invalid `~harset-normalizer` distribution; the environment initially lacks `ccxt`, and after the targeted `ccxt==4.5.68 --no-deps` installation it can import `ccxt` but still emits `RequestsDependencyWarning`.

1.3 WHEN `backend/app.py` is imported with the current project `.venv` THEN the system fails before the Flask application can become healthy because Windows Application Control blocks the gRPC `cygrpc` DLL.

1.4 WHEN the localhost Vite application sends its designed backend requests to `http://localhost:5000` THEN the system reports the backend as unreachable because no healthy local Flask server is running.

1.5 WHEN the global Python installation is checked as a possible workaround THEN the system can import `ccxt` and `firebase_admin`, but it does not provide an isolated, exact-version, reproducible project backend environment.

### Expected Behavior (Correct)

The repaired setup must create a safe and repeatable local backend environment while retaining the existing environment until the user explicitly authorizes its removal.

2.1 WHEN a user follows the local Windows backend setup instructions from a workspace located under OneDrive THEN the system SHALL use a clean, isolated, supported Python environment in a location that avoids OneDrive locking or partial-sync interference, SHALL leave the existing project `.venv` untouched unless the user explicitly confirms deletion, and SHALL provide recovery guidance for `WinError 5` without requiring destructive cleanup.

2.2 WHEN the clean local environment is provisioned THEN the system SHALL install the backend dependencies at the exact repository-pinned versions: `flask==3.0.0`, `flask-cors==4.0.0`, `python-dotenv==1.0.0`, `ccxt==4.5.68`, `requests==2.34.2`, `gunicorn==21.2.0`, and `firebase-admin==6.4.0`; it SHALL complete without an invalid `~harset-normalizer` distribution or `RequestsDependencyWarning`.

2.3 WHEN `backend/app.py` is imported from the clean local environment THEN the system SHALL load successfully under Windows Application Control without weakening, disabling, or bypassing Windows security policy; if a required native module remains blocked, the instructions SHALL stop safely and provide a policy-compliant recovery path rather than treating the setup as healthy.

2.4 WHEN the local backend is started according to the instructions and checked with finite, timeout-bounded verification THEN the system SHALL return HTTP `200` from `GET http://localhost:5000/health` and HTTP `401` from an unauthenticated `GET http://localhost:5000/api/v1/webhooks/health`, after which the verification process SHALL terminate cleanly and SHALL not leave an unmanaged long-running server.

2.5 WHEN a user performs the repair from a machine where global Python can already import `ccxt` and `firebase_admin` THEN the system SHALL provide clear, reproducible instructions that identify the intended Python interpreter and environment, install exact versions, verify imports and dependency health, start the local backend explicitly, run the two bounded health checks, and distinguish successful setup from fallback/global-interpreter behavior.

### Unchanged Behavior (Regression Prevention)

The repair is local-only and must preserve the verified source and deployed service behavior.

3.1 WHEN the local environment is repaired THEN the system SHALL CONTINUE TO preserve the `origin/main` commit `017a607` dependency baseline, including `requests==2.34.2`, without modifying application source or production dependency declarations as part of environment repair.

3.2 WHEN an unauthenticated client requests `https://vivek-raj.onrender.com/api/v1/webhooks/health` THEN the system SHALL CONTINUE TO return HTTP `401`, preserving proof that the authenticated v1 API is deployed on Render.

3.3 WHEN Render performs its production health check THEN the system SHALL CONTINUE TO expose the existing production `/health` behavior and deployment configuration without local-repair changes.

3.4 WHEN the Vite application runs locally THEN the system SHALL CONTINUE TO target `http://localhost:5000` by design; the repair SHALL make that local endpoint healthy rather than redirecting the frontend to production.

3.5 WHEN Windows Application Control blocks a binary or DLL THEN the system SHALL CONTINUE TO enforce the configured Windows security policy; no requirement, instruction, or repair action may weaken, disable, or bypass that policy.

3.6 WHEN local backend configuration or diagnostics are created, displayed, or shared THEN the system SHALL CONTINUE TO protect secrets and credentials; instructions, logs, commands, and verification output must not expose `.env` values, API keys, Firebase credentials, webhook secrets, exchange credentials, or tokens.

3.7 WHEN the local webhook environment is repaired or verified THEN the system SHALL CONTINUE TO leave production behavior, Render configuration, webhook execution controls, exchange connectivity, and live-trading behavior unchanged; no production or live trade may be triggered.

3.8 WHEN the existing project `.venv` is found to be corrupted THEN the system SHALL CONTINUE TO retain it unless and until the user gives explicit confirmation to delete it.