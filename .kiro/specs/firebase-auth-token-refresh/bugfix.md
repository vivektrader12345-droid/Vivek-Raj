# Firebase Authentication Token Refresh Bugfix

## Current Behavior (Defect)

The Webhook Intelligence client obtains the signed-in user's cached Firebase ID token with `getIdToken()` and sends it as an `Authorization: Bearer <token>` header. The backend verifies that token, but the end-to-end flow does not recover safely when the cached token expires.

1. WHEN a protected Webhook Intelligence request is sent with an expired cached Firebase ID token, THEN the backend returns `401`, the client surfaces the failure, and the client does not force-refresh the token or replay the request.
2. WHEN a protected request has no token, a malformed or otherwise invalid token, an expired token, or a revoked token, THEN the backend collapses those cases into broad authentication responses that do not give the client a safe, machine-readable recovery path.
3. WHEN Firebase Admin initialization cannot use the repository-local `serviceAccountKey.json` file or ambient credentials, THEN the backend may continue without a usable Firebase service while protected routes remain registered, obscuring a server configuration failure as a user authentication failure.
4. WHEN initial token acquisition fails, THEN the client reports the condition as a refresh failure even though no post-`401` refresh was attempted.
5. WHEN the API is unreachable, THEN the client reports a network error, but the current authentication error model does not consistently keep transport failures separate from missing, invalid, expired, revoked, and refresh-failure outcomes.

## Expected Behavior (Correct)

### Requirement 1: Secure Firebase Admin Initialization

1.1 WHEN the backend starts, THEN the system SHALL initialize Firebase Admin exactly once using Application Default Credentials or a service-account file path securely provisioned by the runtime through `GOOGLE_APPLICATION_CREDENTIALS`.

1.2 WHEN Render requires service-account credentials, THEN an authorized operator SHALL provision them through Render's secret-management mechanism outside the repository and SHALL expose only the runtime secret-file path to the application.

1.3 WHEN local development requires service-account credentials, THEN the developer SHALL provision them outside tracked project files and SHALL reference them through a local, uncommitted environment setting or Application Default Credentials.

1.4 WHEN credentials are absent, unreadable, or invalid, THEN the backend SHALL fail closed for protected Webhook Intelligence APIs with a sanitized service-configuration/unavailable result and SHALL NOT treat the request as an authenticated user, fall back to unauthenticated access, or expose credential details.

1.5 THE system SHALL NOT commit, print, log, serialize, return, copy into project artifacts, copy into test fixtures, or expose service-account credential contents, private keys, Firebase ID tokens, refresh tokens, or `Authorization` headers.

1.6 THE implementation SHALL NOT depend on a hardcoded repository-relative `serviceAccountKey.json` path and SHALL NOT inspect Firebase Admin's private `_apps` state to decide whether initialization is required.

### Requirement 2: Protected Request Authentication

2.1 WHEN a Firebase user is signed in and a protected Webhook Intelligence request is issued, THEN the client SHALL obtain that user's Firebase ID token and attach it as exactly one `Authorization: Bearer <token>` header.

2.2 WHEN no Firebase user is signed in, THEN the client SHALL return an `authentication_required` error without sending the protected API request.

2.3 WHEN initial ID-token acquisition fails before a request is sent, THEN the client SHALL return a distinct `token_acquisition_failed` error and SHALL NOT classify the failure as a network error or claim that a post-`401` refresh occurred.

2.4 WHEN the backend receives a protected request without a bearer token, THEN it SHALL return `401` with a stable `authentication_required` code.

2.5 WHEN the backend receives an expired Firebase ID token, THEN it SHALL return `401` with a stable `token_expired` code.

2.6 WHEN the backend receives a malformed, incorrectly signed, wrong-project, or otherwise invalid Firebase ID token, THEN it SHALL return `401` with a stable `invalid_token` code.

2.7 WHEN the backend receives a revoked token, THEN it SHALL return `401 token_revoked`; WHEN it receives a token for a disabled user, THEN it SHALL return `401 user_disabled`; and in both cases it SHALL verify revocation/user status with Firebase Admin rather than accepting signature validity alone.

2.8 WHEN Firebase verification infrastructure is unavailable independently of token validity, or WHEN verification raises an exception that cannot be proven to be a credential-invalid condition, THEN the backend SHALL fail closed with sanitized `503 auth_service_unavailable` rather than incorrectly reporting that the user's token is invalid or allowing access.

### Requirement 3: Bounded Expired-Token Recovery

3.1 WHEN the first response to a protected request is `401` with code `token_expired`, THEN the client SHALL call `getIdToken(true)` for the same signed-in user to force-refresh the Firebase ID token.

3.2 WHEN forced refresh succeeds, THEN the client SHALL replay the original request exactly once with the refreshed bearer token while preserving its URL, method, query parameters, serialized body, and non-authentication headers.

3.3 WHEN the replay succeeds, THEN the client SHALL return the replay response through the existing service interface without exposing the intermediate expired-token response.

3.4 WHEN the replay returns any authentication `401`, THEN the client SHALL NOT refresh or replay again; it SHALL return a `reauthentication_required` result and SHALL sign the user out or invoke the application's reauthentication flow.

3.5 WHEN forced token refresh fails, THEN the client SHALL NOT replay the request; it SHALL return `token_refresh_failed` and SHALL sign the user out or invoke the application's reauthentication flow.

3.6 WHEN the first `401` indicates a missing, malformed, invalid, revoked, or disabled-user credential rather than expiration, THEN the client SHALL NOT retry that request and SHALL request reauthentication as appropriate.

3.7 THE client SHALL permit at most two network attempts for one logical protected request: the initial attempt and one replay after one successful forced refresh. Retry state SHALL be request-local and SHALL make an unbounded or recursive retry loop impossible.

3.8 WHEN multiple logical requests encounter expiration concurrently, THEN any shared refresh coordination SHALL NOT increase the per-request replay limit or allow a request to be replayed more than once.

3.9 WHEN the initiating Firebase user signs out or `auth.currentUser.uid` changes before forced refresh or replay, THEN the client SHALL NOT refresh through or replay as a different user; it SHALL stop the request and return `reauthentication_required`. Both token calls SHALL target the same captured user object and UID.

### Requirement 4: Error Separation and Safe Observability

4.1 WHEN `fetch` cannot reach the configured API, THEN the client SHALL return `network_error` with status `0` and SHALL NOT refresh a token, retry automatically, or sign the user out solely because of the transport failure.

4.2 WHEN a request exceeds its timeout, THEN the client SHALL return `request_timeout` separately from authentication and generic network failures.

4.3 WHEN authentication fails, THEN client and backend responses SHALL distinguish at least: missing sign-in/token, initial token acquisition failure, expired token, invalid/malformed token, revoked/disabled session, forced-refresh failure, second-`401` reauthentication, and backend authentication-service unavailability.

4.4 WHEN authentication or Firebase initialization fails, THEN logs and API responses SHALL contain only safe metadata such as the stable error code, HTTP status, and request ID; they SHALL NOT contain raw tokens, credential values, private keys, credential JSON, authorization headers, or unsanitized exception text.

4.5 WHEN a non-authentication HTTP error occurs, THEN the existing `WebhookApiError` response details and request-ID behavior SHALL CONTINUE TO operate, and the client SHALL NOT trigger token refresh solely because of a non-`401` status.

### Requirement 5: Environment-Configured API URLs

5.1 WHEN the frontend is run locally, THEN the protected API base URL SHALL be configurable with `VITE_WEBHOOK_API_URL` and SHALL support a localhost or `127.0.0.1` Flask backend.

5.2 WHEN the frontend is deployed, THEN `VITE_WEBHOOK_API_URL` SHALL support the Render API origin and SHALL be normalized to avoid duplicate trailing slashes.

5.3 WHEN the backend generates externally visible webhook URLs, THEN `WEBHOOK_BASE_URL` SHALL support the corresponding local or Render origin independently of the frontend API setting.

5.4 THE production API origin SHALL be provided through deployment environment configuration rather than embedding secrets or service-account data in client-visible `VITE_*` variables.

5.5 WHEN environment examples or deployment configuration are updated, THEN they SHALL contain names and non-secret placeholder URLs only; they SHALL NOT contain credentials, ID tokens, refresh tokens, private keys, or real service-account JSON.

### Requirement 6: Authentication and Trading Safety Preservation

6.1 WHEN the fix is applied, THEN every existing protected `/api/v1/webhooks/*` management, health, event, error, execution, and overview route SHALL remain protected by verified Firebase identity and tenant-scoped UID access.

6.2 THE fix SHALL NOT add an authentication bypass, accept identity from request bodies or query strings, trust an unverified UID, downgrade token verification, or convert an authentication failure into anonymous access.

6.3 THE webhook-ingestion secret checks, endpoint ownership checks, replay-window checks, idempotency behavior, risk validation, and rate limiting SHALL CONTINUE TO operate unchanged.

6.4 THE `WEBHOOK_LIVE_EXECUTION_ENABLED` and `LEGACY_WEBHOOK_LIVE_ENABLED` safety flags SHALL CONTINUE TO default to `false`, and the v1 live execution path SHALL CONTINUE TO fail closed while no tenant-safe adapter is configured.

6.5 Authentication tests and validation SHALL NOT submit a live order, enable live execution, connect an exchange, weaken testnet settings, or mutate production trading data.

## Required Scenarios

| Scenario | Backend result | Client behavior | Maximum API attempts |
|---|---|---|---:|
| Valid current token | Protected response succeeds | Return success; no forced refresh | 1 |
| No signed-in user / missing bearer token | `401 authentication_required` when sent directly | Do not send from client when user is absent; request sign-in | 0 client / 1 direct backend |
| Expired token, refresh succeeds | First response `401 token_expired`; replay succeeds | Force-refresh and replay exactly once | 2 |
| Expired token, replay gets second `401` | Authentication `401` | Stop, sign out or request reauthentication | 2 |
| Malformed or invalid token | `401 invalid_token` | Do not retry; request reauthentication | 1 |
| Revoked token | `401 token_revoked` | Do not retry; sign out or request reauthentication | 1 |
| Disabled user | `401 user_disabled` | Do not retry; sign out or request reauthentication | 1 |
| Forced refresh fails | First response `401 token_expired` | Return `token_refresh_failed`; do not replay; reauthenticate | 1 |
| Network unavailable | No HTTP response | Return `network_error`; do not refresh or sign out | 1 |
| Request timeout | No response before deadline | Return `request_timeout`; do not refresh automatically | 1 |
| Firebase Admin unavailable | `503 auth_service_unavailable` | Surface server availability/configuration error; do not treat token as invalid | 1 |

## Unchanged Behavior (Regression Prevention)

1. WHEN a signed-in user's current token is valid, THEN the system SHALL CONTINUE TO complete protected Webhook Intelligence requests with one API call.
2. WHEN the API returns a non-authentication `4xx` or `5xx`, THEN the client SHALL CONTINUE TO surface the server's structured error without an authentication retry.
3. WHEN the API is unreachable or slow, THEN the client SHALL CONTINUE TO enforce bounded timeouts and distinguish timeout from network failure.
4. WHEN protected routes access Firestore data, THEN the backend SHALL CONTINUE TO derive tenant identity only from the verified token UID.
5. WHEN webhook ingestion receives an alert, THEN all existing authentication, validation, duplicate, risk, paper-trading, and fail-closed live-trading controls SHALL CONTINUE TO apply.

## Constraints

- The change is limited to Firebase Admin initialization, protected-route token classification, the shared Webhook Intelligence request client, environment examples/deployment wiring needed for URL and credential references, authentication/session integration, and focused automated tests.
- Actual credential material must be provisioned out of band by an authorized user; implementation and tests use mocks, emulators, or synthetic placeholders only.
- No service-account credential file or value may be generated, moved, copied, inspected, printed, committed, or embedded by this work.
- No retry is allowed for network failures, timeouts, non-authentication errors, revoked tokens, malformed tokens, missing tokens, or failed refreshes.
- No existing trading safety flag may be enabled, removed, renamed, or bypassed.
