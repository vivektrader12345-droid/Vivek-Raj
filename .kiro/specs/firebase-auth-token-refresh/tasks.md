# Firebase Authentication Token Refresh Bugfix Implementation Plan

- [x] 1. Establish secret-safe regression baselines
  - Confirm the protected Webhook Intelligence route inventory and record that each route is guarded by Firebase verification and tenant UID scoping.
  - Record the current defaults and fail-closed behavior for `WEBHOOK_LIVE_EXECUTION_ENABLED`, `LEGACY_WEBHOOK_LIVE_ENABLED`, endpoint-secret checks, risk validation, and the unconfigured tenant-safe live adapter.
  - Add a focused failing client regression test showing that a first `401 token_expired` must force `getIdToken(true)` and replay once.
  - Use mocks and synthetic token labels only; do not read, copy, print, or create any service-account credential or real token.
  - _Requirements: 3.1, 3.2, 3.7, 6.1, 6.3, 6.4, 6.5_

- [x] 2. Implement secure Firebase Admin initialization
  - Replace repository-relative `serviceAccountKey.json` loading and private `_apps` inspection with a reusable initializer based on `get_app()` and Application Default Credentials.
  - Support runtime-provisioned `GOOGLE_APPLICATION_CREDENTIALS` without reading, logging, serializing, returning, or copying the credential contents.
  - Make protected APIs fail closed with a sanitized service-unavailable/configuration result when Firebase Admin cannot initialize; do not permit storage fallback to become authentication fallback.
  - Keep actual local and Render credential provisioning as an explicit out-of-band operator step; source files may contain only variable names and safe placeholders.
  - Add backend initialization tests for existing-app reuse, successful ADC initialization, and unavailable/invalid ADC using mocks only.
  - _Requirements: 1.1-1.6, 2.8, 4.4_

- [x] 3. Return precise fail-closed backend authentication errors
  - Parse missing and empty bearer headers as `401 authentication_required` without calling Firebase verification.
  - Verify Firebase ID tokens with revocation checking enabled and continue deriving tenant identity only from verified `uid`/`sub` claims.
  - Map expired, malformed/invalid, revoked, disabled-user, missing-UID, certificate/transport/service, and unknown verification failures to the stable status/code contract in the design; unknown failures SHALL deterministically fail closed as sanitized `503 auth_service_unavailable`.
  - Sanitize responses and logs so tokens, decoded claims, credential paths/content, authorization headers, private-key material, and sensitive exception text cannot be exposed.
  - Add Flask test-client coverage for valid, missing, expired, malformed, revoked, disabled-user, missing-UID, each selected infrastructure exception, unknown-failure fallback, and sanitization scenarios.
  - _Requirements: 2.4-2.8, 4.3, 4.4, 6.1, 6.2_

- [x] 4. Refactor the frontend request path into a bounded attempt state machine
  - Separate one low-level fetch attempt from the logical `webhookRequest` coordinator while preserving the existing public service API and structured non-authentication errors.
  - Obtain the signed-in user's current token for attempt zero and attach exactly one bearer header; return `authentication_required` before fetch when no user exists.
  - Distinguish initial `getIdToken(false)` failure as `token_acquisition_failed`.
  - Capture the initiating Firebase user object and UID for attempt zero; require the same current user before forced refresh and replay, call both token methods on the captured user, and stop with reauthentication if sign-out or user switching occurs.
  - On the first `401 token_expired` only, call `getIdToken(true)` exactly once and replay an immutable request snapshot exactly once with only the bearer token replaced.
  - Discard any caller/internal `Authorization` value so each attempt sends exactly one service-controlled bearer header.
  - Enforce a request-local maximum of two fetches and make additional refresh/replay impossible after any result from attempt one.
  - Do not retry network errors, timeouts, non-`401` responses, missing/invalid/malformed tokens, revoked/disabled sessions, or refresh failures.
  - _Requirements: 2.1-2.3, 3.1-3.3, 3.6-3.9, 4.1, 4.2, 4.5_

- [x] 5. Integrate bounded reauthentication behavior
  - Add or reuse an idempotent sign-out/reauthentication boundary that does not couple transport code to UI rendering details.
  - Trigger reauthentication once after forced-refresh failure, `token_revoked`, `user_disabled`, `invalid_token`, an auth-state/user change during recovery, or any authentication `401` from the single replay.
  - Preserve the signed-in session for network failures, timeouts, and non-authentication HTTP errors.
  - Ensure concurrent failed requests cannot create refresh, sign-out, navigation, or notification loops; if a single-flight refresh is used, retain each request's independent one-replay cap.
  - _Requirements: 3.4-3.9, 4.1-4.3_

- [x] 6. Configure local and Render API origins without exposing secrets
  - Use `VITE_WEBHOOK_API_URL` for the frontend API origin, supporting `http://localhost:5000` or `http://127.0.0.1:5000` in development and the Render API origin in deployment.
  - Normalize trailing slashes and ensure service paths are appended exactly once; require explicit production configuration rather than silently targeting localhost.
  - Preserve `WEBHOOK_BASE_URL` as the independent backend origin for generated webhook callback URLs.
  - Update only necessary environment examples/deployment references with non-secret variable names and placeholder URLs; never put server credentials in `VITE_*` variables.
  - _Requirements: 5.1-5.5, 1.5_

- [x] 7. Complete frontend authentication and retry coverage
  - Add deterministic tests for valid token, no user, initial acquisition failure, expired-then-success, expired-then-second-`401`, user sign-out/switch between attempts, malformed/invalid token, `token_revoked`, `user_disabled`, and forced-refresh failure.
  - Assert exact calls on the captured user to `getIdToken(false)`/`getIdToken(true)`, exact single-header bearer replacement (including a hostile preexisting `Authorization` value), fetch counts, and sign-out/reauthentication counts.
  - Add network, timeout, `503 auth_service_unavailable`, non-authentication HTTP, and POST/PATCH replay-fidelity tests; explicitly assert network status `0`, preserved server details/request IDs, and no refresh or sign-out for service unavailability.
  - If concurrency coordination is implemented, test shared refresh settlement and prove each request still performs at most one replay.
  - If a frontend test dependency is necessary, pin an exact compatible version and add a finite non-watch test command.
  - _Requirements: 2.1-2.8, 3.1-3.9, 4.1-4.5_

- [x] 8. Validate end-to-end security and preservation boundaries
  - Run the targeted backend and frontend test commands in finite, non-watch mode and run the frontend production build.
  - Verify the valid, missing, expired, malformed, revoked, disabled-user, user-change, second-`401`, refresh-failure, network-failure, timeout, and Firebase-unavailable matrix matches `bugfix.md`.
  - Verify `VITE_WEBHOOK_API_URL` independently resolves localhost and Render-like protected API origins, and verify `WEBHOOK_BASE_URL` independently generates correct localhost and Render-like callback URLs, all without duplicate slashes; do not authenticate to or mutate production during tests.
  - Run a non-echoing scan over changed/tracked non-secret text for accidental credential/private-key markers; exclude known secret-bearing paths such as `.env`, report only sanitized file names/counts, and never print matching lines, real bearer/refresh tokens, authorization values, or credential contents.
  - Confirm all protected routes and verified-UID tenant boundaries remain intact.
  - Confirm webhook secret validation, rate limits, replay protection, idempotency, risk checks, `WEBHOOK_LIVE_EXECUTION_ENABLED=false`, `LEGACY_WEBHOOK_LIVE_ENABLED=false`, and fail-closed live adapter behavior remain unchanged.
  - Confirm validation did not connect an exchange, submit a webhook alert, execute a trade, enable live mode, or change production data/configuration.
  - _Requirements: 1.5, 4.3-4.5, 5.1-5.5, 6.1-6.5_
