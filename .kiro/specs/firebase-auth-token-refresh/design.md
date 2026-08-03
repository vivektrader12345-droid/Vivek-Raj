# Firebase Authentication Token Refresh Bugfix Design

## Overview

This bugfix makes the Webhook Intelligence authentication path fail closed and recover from one expired Firebase ID token without creating retry loops. It replaces repository-relative Firebase Admin credential loading with runtime-provisioned Application Default Credentials, gives backend authentication failures stable machine-readable classifications, and introduces a request-local two-attempt state machine in the shared frontend API client.

The change is deliberately narrow. It does not modify webhook ingestion authentication, tenant ownership, idempotency, risk validation, trading mode, exchange connectivity, or live-execution controls. Credential provisioning remains an out-of-band operator action; no credential contents are part of source, tests, diagnostics, or spec artifacts.

## Root Cause Analysis

### Reproduction Path

1. A signed-in user opens Webhook Intelligence.
2. `src/services/webhookIntelligenceService.js` reads `auth.currentUser` and calls `currentUser.getIdToken()`.
3. The service sends that cached token in `Authorization: Bearer <token>` to a protected `/api/v1/webhooks/*` endpoint.
4. `backend/webhook_intelligence.py` calls `firebase_admin.auth.verify_id_token(...)`.
5. If the cached token is expired, the backend returns a generic `401 invalid_token`.
6. The client converts that response to `WebhookApiError` and stops. There is no `getIdToken(true)`, replay, retry bound, or reauthentication transition.

### Evidence

- The shared client already attaches a Firebase bearer token and already separates timeout and basic network failures.
- The client has one `fetch` path and no branch that force-refreshes after `401`.
- The backend authentication decorator catches every verification exception with `except Exception` and maps all failures to the same invalid-or-expired response.
- Revocation checking is not requested from Firebase Admin.
- Backend startup tries `credentials.Certificate('serviceAccountKey.json')`, uses Firebase Admin private state, then silently continues if initialization fails.
- Protected Webhook Intelligence routes are tenant-scoped from the verified UID and must remain so.

### Confirmed Root Cause

The immediate user-visible defect is the absence of a bounded expired-token recovery protocol between the shared client and the backend. The backend cannot safely trigger the correct recovery because it does not distinguish token expiration from malformed, revoked, missing, or infrastructure failures. The initialization path compounds this by relying on a repository-relative credential filename and by allowing Firebase configuration failures to masquerade as user-token failures.

## Proposed Architecture

```text
Secure runtime credential provisioning
        |
        v
Firebase Admin initializer (once, ADC, sanitized state)
        |
        v
Protected-route verifier (check_revoked=True)
        |
        +--> verified UID -----------------------> route handler
        +--> 401 authentication_required
        +--> 401 token_expired ------------------+
        +--> 401 invalid_token                   |
        +--> 401 token_revoked / user_disabled   |
        +--> 503 auth_service_unavailable        |
                                                   v
Client request attempt 0 -- expired only --> getIdToken(true)
                                                   |
                                      refresh fails | succeeds
                                                   |       v
                                      reauthenticate   attempt 1
                                                           |
                                              success <----+----> any 401
                                                                     |
                                                              reauthenticate
                                                              (no more retry)
```

## Backend Design

### 1. Firebase Admin Initialization

Create a small initialization boundary used by `backend/app.py`:

- Call `firebase_admin.get_app()` to reuse an already initialized default app; catch the documented not-initialized result and initialize once.
- Call `firebase_admin.initialize_app()` without embedding credential contents. Firebase Admin then uses Application Default Credentials, including a runtime-provided `GOOGLE_APPLICATION_CREDENTIALS` path.
- Use an explicit, non-secret Firebase project ID option only if required by the deployment environment. Never place private keys or service-account JSON in options.
- Obtain Firestore and Auth services from the initialized app.
- Store only a safe readiness classification for error handling. Do not retain or return serialized credentials.
- Do not log exception text that may include file paths or credential metadata. Emit a stable safe event such as `firebase_admin_initialization_failed` with exception class and a generated request/startup correlation ID only.

For Render, an authorized operator provisions the service-account JSON as a Render secret file (or another supported workload identity/ADC mechanism) and sets `GOOGLE_APPLICATION_CREDENTIALS` to the runtime-mounted path. For local development, the developer uses ADC or an untracked credential path outside repository artifacts. Source and `.env.example` contain variable names/placeholders only. This task never creates, reads for display, copies, or checks in the credential file.

Protected endpoints fail closed if Firebase Admin is unavailable. A storage fallback must never become an authentication fallback. The public webhook-ingestion path retains its existing endpoint-secret authentication and is outside this bearer-token change.

### 2. Authentication Result Taxonomy

Replace the broad verification catch in the protected-route decorator with specific Firebase Admin exception handling. Verify with revocation enabled:

```python
decoded = firebase_auth.verify_id_token(token, check_revoked=True)
```

Map outcomes without returning exception text:

| Condition | HTTP | Stable code | Client action |
|---|---:|---|---|
| Missing/empty/non-Bearer header | 401 | `authentication_required` | Sign-in required; no retry |
| `ExpiredIdTokenError` | 401 | `token_expired` | One forced refresh may occur |
| `RevokedIdTokenError` | 401 | `token_revoked` | Sign out/reauthenticate; no retry |
| `UserDisabledError` | 401 | `user_disabled` | Sign out/reauthenticate; no retry |
| `InvalidIdTokenError`, token-shape `ValueError`, bad signature, wrong audience/issuer/project, or invalid subject | 401 | `invalid_token` | Reauthenticate; no retry |
| `CertificateFetchError` or a recognized Firebase certificate/transport/service failure | 503 | `auth_service_unavailable` | Surface availability error; no auth retry |
| Any unclassified verification exception | 503 | `auth_service_unavailable` | Fail closed, emit sanitized internal event, no auth retry |
| Valid token without usable `uid`/`sub` | 401 | `invalid_token` | Reauthenticate; no retry |
| Valid token | continue | n/a | Set `g.auth_uid` from verified claim |

Against the pinned `firebase-admin==6.4.0` API, handle specific subclasses before their parents: `ExpiredIdTokenError`, `RevokedIdTokenError`, `UserDisabledError`, `InvalidIdTokenError`, and `CertificateFetchError`; classify a token-shape `ValueError` as invalid input. Implementation must verify the pinned SDK's import locations, but it must not weaken this observable contract. A verification exception not proven to represent invalid credentials deterministically fails closed as sanitized `503 auth_service_unavailable`; it is never accepted and never misreported as a user-token `401`.

All protected Webhook Intelligence routes continue to use the decorator, and all Firestore paths continue to derive ownership only from `g.auth_uid`.

### 3. Error Response Contract

Use the existing structured error envelope and request ID. Authentication errors contain only:

```json
{
  "error": {
    "code": "token_expired",
    "message": "Your session token expired."
  },
  "requestId": "safe-correlation-id"
}
```

Messages are user-safe and contain no raw token, decoded claims, email, credential path, Firebase exception text, or authorization header. Logging follows the same allowlist.

## Frontend Design

### 1. Request State Machine

Refactor `webhookRequest` into one logical request coordinator and one low-level attempt function. The coordinator owns an integer `attempt` or boolean `hasRetried`; callers cannot enable additional retries through options.

```text
START
  |
  +-- no current user ----------------> authentication_required (0 fetches)
  |
  +-- getIdToken(false) fails --------> token_acquisition_failed (0 fetches)
  |
  v
FETCH attempt 0 with cached/current token
  |
  +-- success ------------------------> return payload
  +-- network/timeout/non-401 --------> return classified error
  +-- 401 not token_expired ----------> reauthenticate; return (no retry)
  +-- 401 token_expired
         |
         +-- getIdToken(true) fails --> token_refresh_failed; reauthenticate
         |
         v
       FETCH attempt 1 with refreshed token
         |
         +-- success -----------------> return payload
         +-- any 401 -----------------> reauthentication_required; no retry
         +-- other error -------------> return classified error; no retry
```

The coordinator captures the initiating `currentUser` object and UID before `getIdToken(false)`. Before `getIdToken(true)` and again before replay, it requires `auth.currentUser` to be the same user object with the same UID; sign-out or user switching terminates with `reauthentication_required` and no replay. Both token calls are made on the captured user, never on a newly read user.

The low-level attempt receives an immutable request snapshot containing method, full URL/query, serialized body, headers other than authorization, and timeout. It creates a fresh `AbortController`, discards any caller-supplied `Authorization` value, and inserts exactly one bearer header for each attempt. The replay uses the same snapshot and only substitutes the token. Because backend authentication executes before route handlers, an authentication-rejected mutation has not reached mutation logic; nevertheless, the retry remains limited to the explicit expired-token response and exactly one replay.

### 2. Reauthentication Boundary

Use the existing Firebase Auth sign-out/session mechanism or inject a small reauthentication callback into the service boundary. The action must be idempotent so concurrent failures do not cause navigation/toast loops. Required behavior:

- First expired-token `401`: do not sign out until refresh outcome is known.
- Forced-refresh failure: sign out or transition to reauthentication once.
- First `401` for revoked credentials (`token_revoked`), a disabled user (`user_disabled`), or invalid credentials: no replay; sign out or transition to reauthentication once.
- Sign-out or a UID/user-object change between attempts: no refresh through or replay as the new user; transition to reauthentication once.
- Second authentication `401`: no replay; sign out or transition to reauthentication once.
- Network errors, timeouts, `403`, `404`, `429`, and `5xx`: do not sign out solely because of that response.

### 3. Error Model

Retain `WebhookApiError` and existing structured server details while adding stable client codes:

- `authentication_required`: no signed-in user or missing bearer response.
- `token_acquisition_failed`: initial `getIdToken(false)` failed.
- `token_expired`: server expiration result before recovery; normally internal unless recovery cannot proceed.
- `invalid_token`: malformed/invalid credential; no replay.
- `token_revoked`: Firebase reports the token revoked; no replay.
- `user_disabled`: Firebase reports the account disabled; no replay.
- `reauthentication_required`: a second authentication `401` or auth-state/user change during recovery.
- `token_refresh_failed`: `getIdToken(true)` failed; no replay.
- `auth_service_unavailable`: backend Firebase verification service unavailable (`503`).
- `network_error`: fetch failed before an HTTP response; status `0`.
- `request_timeout`: abort caused by the configured deadline.

No error object or telemetry payload stores a token. Causes may remain in-memory for debugging only if downstream logging is guaranteed to sanitize them; otherwise omit sensitive SDK causes from serializable error data.

### 4. Concurrency

A single-flight forced-refresh promise may be shared per current user to avoid refresh storms, but it is not required for correctness. If implemented:

- Clear it in `finally`.
- Never share request replay state.
- Each logical request retains its own maximum of one replay.
- Reject all waiters consistently on refresh failure and trigger the reauthentication transition idempotently.

## Environment Configuration

### Frontend API Origin

- `VITE_WEBHOOK_API_URL` is the only client-visible API-origin setting.
- Development examples may use `http://127.0.0.1:5000` or `http://localhost:5000`.
- Production deployment sets it to the Render API origin, currently represented by a non-secret URL such as `https://vivek-raj.onrender.com`.
- Normalize trailing slashes once. Do not place `/api/v1/webhooks` in the origin because service methods already append that path.
- A localhost-only development fallback may remain for developer ergonomics; production must not silently target localhost. Production configuration should be explicit and validated.

### Backend External Webhook Origin

- `WEBHOOK_BASE_URL` remains the origin used to generate webhook callback URLs.
- Configure it independently for local and Render environments.
- `GOOGLE_APPLICATION_CREDENTIALS` is server-only and must never use a `VITE_` prefix.
- Environment examples contain placeholders, not service-account JSON or actual private paths that disclose user-specific information.

## Security and Trading Preservation

The fix must preserve these invariants:

1. No protected request reaches a route handler until Firebase Admin verifies the bearer token, including revocation status.
2. Tenant identity comes only from verified `uid`/`sub`; body/query/path user IDs are not authentication sources.
3. No code path treats Firebase initialization failure, verification outage, refresh failure, or network failure as authenticated access.
4. The public ingestion endpoint retains endpoint-secret verification, IP allowlisting, replay-window checks, rate limits, idempotency, and risk validation.
5. `WEBHOOK_LIVE_EXECUTION_ENABLED=false` and `LEGACY_WEBHOOK_LIVE_ENABLED=false` remain the defaults.
6. The v1 live path remains blocked without a tenant-safe adapter even if the live flag is true.
7. Tests use mocks/test clients and never invoke exchange or production trade execution.
8. Credential files and values are never copied into the repository, test fixtures, command output, logs, API payloads, screenshots, or generated artifacts.

## Testing Strategy

### Test Infrastructure

The repository currently has no frontend test script/framework and no product-level backend test suite. Add only the minimum focused infrastructure needed:

- Use Python's standard `unittest` and Flask test client where practical for backend tests, avoiding a runtime dependency solely for these cases.
- Add a compatible frontend unit-test runner only if needed; pin any new dependency to an exact reviewed version and add a finite non-watch test command.
- Mock Firebase Auth/Admin and `fetch`. Never use real service-account credentials, real ID tokens, production authentication, or production mutation endpoints.

### Bug-Condition Test

Before implementing the fix, add or run a focused test demonstrating that an expired first response currently causes failure without `getIdToken(true)` and replay. Record this as the regression test the implementation must make pass; do not weaken the expected result to match the defect.

### Frontend Unit Tests

1. **Valid**: `getIdToken(false)` returns `token-1`; one fetch contains `Bearer token-1`; no refresh/sign-out occurs.
2. **Missing user**: no user produces `authentication_required`; `getIdToken` and fetch are not called.
3. **Initial acquisition failure**: `getIdToken(false)` rejects; return `token_acquisition_failed`; no fetch occurs.
4. **Expired then valid**: first fetch returns `401 token_expired`; `getIdToken(true)` is called exactly once; second fetch contains the new token and succeeds; total fetch count is two.
5. **Expired then second 401**: force refresh once, perform one replay, then return `reauthentication_required`; total fetch count remains two and reauthentication occurs once.
6. **User changes during recovery**: sign-out, replacement of `auth.currentUser`, or UID change after attempt zero prevents forced refresh/replay as another user; both token calls, when made, target the captured initiating user.
7. **Malformed/invalid**: first fetch returns `401 invalid_token`; no forced refresh or replay; reauthentication occurs once.
8. **Revoked**: first fetch returns `401 token_revoked`; no forced refresh or replay; sign-out/reauthentication occurs once.
9. **Disabled user**: first fetch returns `401 user_disabled`; no forced refresh or replay; sign-out/reauthentication occurs once.
10. **Refresh failure**: first fetch returns `401 token_expired`; `getIdToken(true)` rejects; no second fetch; return `token_refresh_failed`; reauthentication occurs once.
11. **Network failure**: fetch rejects; return `network_error` with status `0`; no forced refresh/replay/sign-out.
12. **Timeout**: abort produces `request_timeout`; no forced refresh/replay/sign-out.
13. **Non-auth error**: representative `403`, `429`, and `503` responses preserve structured server details and `requestId` and never trigger refresh.
14. **Auth service unavailable**: `503 auth_service_unavailable` remains distinct from invalid credentials and causes no refresh, replay, or sign-out.
15. **Replay fidelity**: POST/PATCH replay preserves URL, query, body, and non-auth headers exactly while replacing only the bearer token.
16. **Authorization normalization**: even if an internal/caller-provided snapshot contains an `Authorization` value, each attempt sends exactly one service-controlled bearer header, initially and on replay.
17. **Concurrency if single-flight is implemented**: concurrent expiration shares refresh work but each logical request performs at most one replay.

### Backend Unit Tests

Use Flask's test client with mocked Firebase Admin verification:

1. **Valid**: decoded UID reaches a protected handler; assert `check_revoked=True` and tenant UID use.
2. **Missing**: absent, empty, and non-Bearer headers return `401 authentication_required`; verifier is not called.
3. **Expired**: SDK expiration exception maps to `401 token_expired`.
4. **Malformed/invalid**: invalid token exceptions map to `401 invalid_token`.
5. **Revoked**: revocation exception maps to `401 token_revoked`.
6. **Disabled user**: disabled-user exception maps to `401 user_disabled`.
7. **Verification infrastructure failure**: certificate-fetch and recognized transport/service exceptions each map to sanitized `503 auth_service_unavailable`.
8. **Unknown verification failure**: an unclassified exception fails closed as sanitized `503 auth_service_unavailable`, never access or a credential-invalid `401`.
9. **Missing UID**: a decoded token without `uid`/`sub` is rejected as invalid.
10. **Sanitization**: response and captured logs do not contain synthetic bearer tokens, private-key markers, credential JSON, authorization headers, or injected sensitive exception text.
11. **Admin initialization**: reuse existing app, initialize with ADC when absent, and fail closed when ADC is unavailable; never instantiate `Certificate` from a repository-relative filename.

### Integration and Preservation Checks

- Exercise one protected read-only endpoint through the client/backend boundary for valid, expired-then-refreshed, malformed, revoked, and refresh-failure scenarios using mocks or an emulator with synthetic data.
- Verify an unauthenticated protected Webhook Intelligence health request remains `401` in local and configured Render-like environments.
- Verify `VITE_WEBHOOK_API_URL` independently resolves localhost and Render-like protected API origins without duplicate slashes.
- Verify `WEBHOOK_BASE_URL` independently generates correct localhost and Render-like webhook callback URLs without duplicate slashes.
- Run a non-echoing secret scanner that excludes known secret-bearing paths such as `.env`, reports only sanitized file names/counts, and never emits matching lines or values while checking changed/tracked non-secret text for credential/private-key markers.
- Confirm all protected route decorators remain present and UID tenancy remains unchanged.
- Confirm `WEBHOOK_LIVE_EXECUTION_ENABLED` and `LEGACY_WEBHOOK_LIVE_ENABLED` defaults remain false and the tenant-safe adapter remains unconfigured.
- Do not send production webhook payloads, authenticate to production, enable trading, or call exchange APIs during validation.

## Requirement Traceability

| Requirement area | Design elements | Primary verification |
|---|---|---|
| Secure Admin initialization | ADC initializer, secret-file path, fail-closed readiness | Backend initialization and sanitization tests |
| Bearer attachment | Client coordinator and immutable attempt snapshot | Valid-token and replay-fidelity tests |
| One expired-token retry | Two-attempt state machine | Expired-success and second-401 tests |
| Loop prevention/reauthentication | Request-local retry flag, idempotent callback | Second-401, invalid, revoked, refresh-failure tests |
| Error distinctions | Backend taxonomy and `WebhookApiError` codes | Frontend/backend classification matrix |
| Localhost/Render configuration | `VITE_WEBHOOK_API_URL`, `WEBHOOK_BASE_URL` | URL configuration tests/build checks |
| Auth preservation | Decorator and verified UID invariants | Protected-route and tenant tests |
| Trading preservation | Explicit unchanged safety invariants | Static/config regression checks |
| Credential non-exposure | Out-of-band provisioning, allowlisted logs | Diff scan and synthetic redaction tests |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Replaying a state-changing request twice | Retry only a backend-classified expiration `401`; auth decorator runs before handler; hard cap of one replay |
| Retry recursion or loops | Iterative/request-local attempt counter inaccessible to callers; max two fetches |
| Signing out on transient network failure | Reauthenticate only for authentication classifications, never transport errors |
| Treating Firebase outage as bad user token | Map recognized infrastructure and unclassified verification exceptions to `503 auth_service_unavailable` |
| Credential disclosure | ADC/secret-file reference only; no content handling; sanitized errors/logs; synthetic tests |
| Revocation-check latency/outage | Test `check_revoked=True`; fail closed with availability classification |
| Concurrent refresh storm | Optional per-user single-flight refresh with request-local replay limits |
| Trading regression | Do not touch ingestion/trading paths; assert flags and fail-closed adapter in validation |

## Rollback

The code rollback is limited to the Admin initialization boundary, authentication classification changes, shared request coordinator, session callback wiring, environment URL wiring, and focused tests. Credential provisioning remains outside source control and must not be copied back during rollback. Rollback must not restore repository-relative service-account loading or remove authentication from protected routes. Trading configuration and safety flags require no migration and remain unchanged throughout.
