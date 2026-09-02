# Implementation Plan: Admin Complimentary Subscriptions

## Overview

This 22-task plan delivers administrator-managed complimentary subscriptions through regression-first backend, persistence, API, frontend, security, concurrency, end-to-end, preservation, and traceability work. Tasks follow the approved dependency order while preserving paid billing data and existing authentication, authorization, plan-catalog, and client-access boundaries.

## Execution Rules

- Execute tasks in dependency order. A task may start only after every item in its **Depends on** field has met its completion evidence.
- For every task, the action bullets after **Depends on** are mandatory implementation details and test/validation work; the **Completion evidence** bullet defines the objective proof required before a dependent task may start. Requirement references are acceptance-criteria identifiers from the approved `requirements.md`.
- Keep `billing_subscriptions` paid-only. Complimentary operations must never create or mutate Razorpay orders, payments, invoices, coupon redemptions, provider events, payment attempts, or revenue records.
- Use the existing Python `unittest`/`MemoryBillingStore`/Flask test-client conventions and existing frontend `node:test` conventions. Deterministic generated/property tests must use the existing runtime (for example, seeded standard-library generation) and must not add a property-testing dependency unless separately approved.
- Treat server Firebase Auth, canonical plans, server UTC, persisted billing state, and the shared backend resolver as authoritative. Do not add client-side entitlement proof or direct client Firestore billing access.
- Keep every task unchecked until its implementation and validation evidence exists.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["1"]
    },
    {
      "wave": 2,
      "tasks": ["2"]
    },
    {
      "wave": 3,
      "tasks": ["3"]
    },
    {
      "wave": 4,
      "tasks": ["4"]
    },
    {
      "wave": 5,
      "tasks": ["5"]
    },
    {
      "wave": 6,
      "tasks": ["6"]
    },
    {
      "wave": 7,
      "tasks": ["7"]
    },
    {
      "wave": 8,
      "tasks": ["8"]
    },
    {
      "wave": 9,
      "tasks": ["9"]
    },
    {
      "wave": 10,
      "tasks": ["10"]
    },
    {
      "wave": 11,
      "tasks": ["11", "12", "15"]
    },
    {
      "wave": 12,
      "tasks": ["13", "16"]
    },
    {
      "wave": 13,
      "tasks": ["14", "17"]
    },
    {
      "wave": 14,
      "tasks": ["18"]
    },
    {
      "wave": 15,
      "tasks": ["19", "20"]
    },
    {
      "wave": 16,
      "tasks": ["21"]
    },
    {
      "wave": 17,
      "tasks": ["22"]
    }
  ]
}
```

| Task | Depends on | Primary outcome |
|---|---|---|
| 1 | None | Preservation baseline and focused test locations established |
| 2 | 1 | Regression-first domain/property tests added |
| 3 | 2 | Domain normalizers, public shapes, and resolver implemented |
| 4 | 3 | Memory-store/service transition tests added |
| 5 | 4 | In-memory complimentary service and store semantics implemented |
| 6 | 3, 5 | Firestore store contract/transaction tests added |
| 7 | 6 | Firestore models, transactions, listing, and resolver loader implemented |
| 8 | 3, 5, 7 | Paid activation integrated with shared effective entitlement |
| 9 | 3, 5, 7, 8 | Flask API/auth contract tests added |
| 10 | 9 | Capability policy and admin APIs implemented |
| 11 | 7, 8, 10 | `/billing/me` and shared backend premium authorization integrated |
| 12 | 7, 10 | Firestore indexes, deployment wiring, and direct-client denies added |
| 13 | 7, 8, 10, 11, 12 | Backend unit/API/integration and deterministic property suites completed |
| 14 | 8, 10, 11, 12, 13 | Emulator concurrency, rule, and index suites completed |
| 15 | 10 | `billingService` contract implemented and tested |
| 16 | 11, 15 | `SubscriptionContext` and pure entitlement helpers updated and tested |
| 17 | 16 | User-facing presentation and route/navigation capability gating completed |
| 18 | 15, 16, 17 | Full complimentary administration UI completed |
| 19 | 18 | Frontend helper/component/route/E2E suites completed |
| 20 | 10, 11, 12, 18 | Observability and rollout/rollback compatibility completed |
| 21 | 13, 14, 19, 20 | End-to-end and preservation release validation completed |
| 22 | 21 | Final spec-format and requirements/design/tasks traceability verified |

## Notes

- All tasks remain unchecked until their implementation and completion evidence exist; each **Depends on** entry is a required execution gate.
- Scope excludes unrelated refactoring and any repurposing of paid billing records, alternate authorization or plan systems, or direct client billing access.
- Only the existing condition in Task 20 for compatible metrics instrumentation is optional; it remains contingent on approved existing infrastructure and adds no metrics dependency.

## Tasks

- [x] 1. Establish preservation baselines and focused test locations
  - **Depends on:** None.
  - Run the existing `npm run test:billing`, `npm run test:backend`, and `npm run build` commands before implementation; record pre-existing failures separately so feature work is not credited with or blocked by unrelated unknowns.
  - Identify the focused additions under `backend/tests/test_billing.py` or narrowly named complimentary billing modules under `backend/tests/`, plus `tests/billingService.test.js` and focused frontend helper/contract test modules under `tests/`.
  - Inspect the repository-declared scripts and record whether relevant lint or static type-check commands exist; do not invent a lint/type gate when the repository does not define one.
  - **Completion evidence:** Dated baseline output identifies the exit status and failing test names, if any, for all three commands; the implementation PR/changeset identifies the exact focused test files it will use.
  - _Requirements: 18.1-18.7, 20.6, 20.8_

- [x] 2. Add regression-first tests for domain normalization, public shapes, and effective entitlement
  - **Depends on:** 1.
  - Add fixed-clock tests for exact email normalization, identifiers, bounded reason and idempotency inputs, exact query/filter fields, cursor fields, all four preset durations, offset-aware custom UTC normalization, invalid/elapsed custom values, and explicit lifetime/null-expiration behavior.
  - Add tests for grant validation, computed `active`/`expired`/`revoked`/`superseded` status, immutable canonical plan snapshots, administrator grant shapes, ordinary-user redaction, and backward-compatible paid/inactive subscription shapes.
  - Cover every resolver decision-table row: complimentary priority, finite boundary at `expiresAt == now`, lifetime, paid fallback strictly after `now`, no fallback, malformed paid/grant/pointer records, and repeated evaluation at one supplied UTC time.
  - Add deterministic generated cases using fixed and failure-reported seeds from the existing Python runtime for resolver determinism, complimentary priority, paid restoration, preset duration, lifetime, and paid-preservation properties; do not add Hypothesis or another unapproved package.
  - **Completion evidence:** The focused tests are discoverable by `python -m unittest`; before Task 3 they fail only at the named missing/new behavior, and every test/property name or adjacent comment cites its requirement IDs and reports the seed/counterexample on failure.
  - _Requirements: 3.2-3.5, 4.1-4.5, 6.1, 6.3-6.6, 7.2-7.3, 10.1-10.8, 12.4, 12.7, 14.1-14.3, 16.5-16.7, 17.1-17.3, 19.2, 19.4-19.5, 20.1-20.3_

- [x] 3. Implement backend domain normalizers, canonical public shapes, and the shared resolver in `backend/billing_core.py`
  - **Depends on:** 2.
  - Implement strict top-level and nested allowlists plus normalizers for email, canonical selectors, grant IDs, reasons, idempotency keys, list filters/limits, and validity. Presets accept exactly 7/30/90/365 consecutive UTC 24-hour days; custom values require explicit RFC 3339 offsets and `expiresAt > activationAt`; lifetime stores no fabricated date.
  - Implement validated grant and plan-snapshot domain shapes, computed status at a supplied evaluation time, admin/public redaction, and additive paid/complimentary/inactive subscription shapes without changing legacy paid field meaning.
  - Implement one pure effective-entitlement resolver returning `{ effectiveEntitlement, paidFallback }`, with complimentary priority, independent paid time, strict paid restoration, deterministic outputs, and fail-closed malformed-state handling.
  - Implement versioned signed-cursor encode/decode primitives using a server-only signing key and key/version identifier. Bind normalized filters, fixed first-page `asOf`, and last-scanned `(createdAt, grantId)`; reject tampering, filter mismatch, invalid time, and unsupported versions as `invalid_cursor`.
  - Centralize backend entitlement tier ranking for reuse by billing and premium authorization.
  - **Completion evidence:** Task 2 tests pass; direct shape assertions prove ordinary `/billing/me` data contains no reason, actor, operation, audit, or paid-fallback fields; cursor tests prove bit changes and filter changes are rejected while round trips preserve fixed `asOf` and scan position.
  - _Requirements: 3.2-3.5, 4.1-4.5, 6.1, 6.3-6.6, 7.1-7.5, 10.1-10.8, 12.4, 12.7, 13.3-13.5, 14.1-14.3, 16.5-16.7, 17.1-17.3, 19.2, 19.4-19.5, 20.2_

- [x] 4. Add regression-first tests for the in-memory service and store transitions
  - **Depends on:** 3.
  - Add tests around `MemoryBillingStore` and the complimentary service boundary for injectable Firebase Admin exact-email lookup, unknown/disabled/unverified targets, canonical active-plan selection, lookup summaries, and paid fallback display.
  - Specify in tests the grant, per-UID active-pointer, hashed idempotency-operation, and append-only audit records, including immutable identity/snapshot fields and terminal transition fields.
  - Cover create, supersede, revoke, expiration-on-read, list/filter/pagination, identical replay, key/payload conflict, stale target/plan state, persistence failure, malformed data, and zero payment-domain side effects.
  - Add generated transition-sequence tests for at-most-one-active-grant and idempotency invariants with fixed/reported seeds and no new dependency.
  - **Completion evidence:** Focused tests demonstrate the expected transition records and operation response snapshots and fail only because Task 5 behavior is not yet implemented; fixtures snapshot paid/order/payment/coupon data before each complimentary sequence.
  - _Requirements: 2.1-2.4, 3.1-3.5, 5.1-5.5, 7.1-7.5, 8.2-8.5, 9.1-9.5, 10.1-10.7, 12.1-12.4, 13.2-13.4, 14.4-14.5, 16.1-16.7, 17.1-17.4, 18.2, 18.5-18.7, 20.1-20.3_

- [x] 5. Implement `ComplimentaryBillingService` and equivalent `MemoryBillingStore` semantics
  - **Depends on:** 4.
  - Add injectable Firebase Admin Auth lookup using normalized exact email and return only UID, canonical email, verification, display name, disabled state, eligibility, effective entitlement, and authorized paid fallback.
  - Add in-memory grant, active-pointer, operation, and audit stores under the existing lock. Hash operation identity/payload, replay the original safe response for identical retries, reject changed payloads, and never store or return the raw idempotency key.
  - Atomically create grants, supersede only a still-effective prior grant, revoke only the current effective grant, compute expiration from server time without cleanup, increment pointer revisions, and append one deterministic audit event per committed transition.
  - Re-resolve eligible target and active canonical plan at mutation time; preserve the immutable non-monetary plan snapshot and reject malformed paid fallback instead of overwriting it.
  - Implement deterministic list scanning with exact email/plan filters, status at fixed cursor `asOf`, `(createdAt DESC, grantId DESC)` ordering, and last-scanned rather than last-returned continuation.
  - **Completion evidence:** Task 4 tests pass; identical retries leave collection cardinalities/revisions unchanged; generated transition tests never produce more than one effective active grant; byte snapshots prove all paid/payment-domain fixtures are unchanged.
  - _Requirements: 2.1-2.4, 3.1-3.5, 5.1-5.5, 7.1-7.5, 8.2-8.5, 9.1-9.5, 10.1-10.7, 12.1-12.4, 13.2-13.4, 14.4-14.5, 16.1-16.7, 17.1-17.4, 18.2, 18.5-18.7, 19.2, 20.1-20.3_

- [x] 6. Add Firestore store-contract and transaction regression tests
  - **Depends on:** 3, 5.
  - Add store-contract tests that exercise the same observable create/list/revoke/resolver behavior against memory and Firestore implementations.
  - Specify Firestore reads-before-writes, per-attempt UTC time, operation-first idempotency handling, canonical-plan/paid/pointer/grant rereads, pointer revision, deterministic audit IDs, response snapshots, and no partial writes on failure.
  - Add focused tests for fixed-`asOf` cursor scans where status filtering excludes records, equal creation timestamps require grant-ID tie-breaking, and cursor/filter/signature changes fail safely.
  - Add payment/grant transaction contract cases requiring both operations to observe `billing_complimentary_users/{uid}` and `billing_subscriptions/{uid}` so contention retries to a serializable result.
  - **Completion evidence:** The contract suite identifies the same public result for memory and Firestore fixtures and fails only at missing Task 7 Firestore behavior; transaction fakes/emulator assertions verify all reads precede writes.
  - _Requirements: 5.1, 5.4-5.5, 7.1-7.5, 8.2-8.5, 9.2-9.5, 10.1-10.7, 12.1-12.4, 14.4, 16.1-16.7, 20.2-20.3_

- [x] 7. Implement Firestore grant models, resolver loading, transactions, and listing in `backend/billing_store.py`
  - **Depends on:** 6.
  - Add Admin-SDK-only access to `billing_complimentary_grants`, `billing_complimentary_users`, `billing_complimentary_operations`, and `billing_complimentary_audit`; keep immutable random server grant IDs and the exact approved grant/pointer/operation/audit fields.
  - Implement the store-backed resolver loader that reads and validates the paid record, UID pointer, and referenced grant, then invokes Task 3's resolver; an expired pointer may remain stored but must not grant access.
  - Implement retry-safe create/supersede and revoke transactions with operation replay/conflict, all reads before writes, final-attempt server UTC validation, current plan and target-state inputs, paid consistency, pointer revisions, immutable audit, and atomic effective/fallback response snapshots.
  - Implement list queries for no filter, exact normalized email, plan, and combined filters, deterministic descending order, server-computed status at signed cursor `asOf`, last-scanned continuation, and bounded internal scanning.
  - Preserve immutable grant/audit history, keep all four complimentary billing collections outside account-deletion and user-data cleanup paths unless a separately approved retention policy requires otherwise, and fail closed for missing/malformed identity, plan snapshot, validity, pointer, source, or audit state.
  - **Completion evidence:** Task 6 store-contract tests pass for Firestore; transaction inspection proves no complimentary write targets `billing_subscriptions` or any payment-domain collection; list fixtures show no duplicates/skips across equal timestamps and status-filtered pages; cleanup-path inspection or a focused preservation test proves account deletion does not remove grant, operation, pointer, or audit records.
  - _Requirements: 3.2-3.5, 5.1, 5.4-5.5, 7.1-7.5, 8.2-8.5, 9.2-9.5, 10.1-10.7, 12.1-12.4, 12.6-12.7, 14.4, 16.1-16.7, 17.1-17.3, 18.2, 18.5, 20.2-20.3_

- [x] 8. Integrate paid activation with complimentary priority in both stores
  - **Depends on:** 3, 5, 7.
  - Extend `MemoryBillingStore.activate_payment`, Firestore payment activation, and the existing billing service response path to read the active pointer/referenced grant and resolve the just-committed paid state through the shared resolver.
  - Preserve existing paid extension, plan-change, coupon, signature, webhook, reconciliation, payment-history, and idempotency rules. While a grant is effective, commit paid state normally but return complimentary as effective and paid as authorized fallback.
  - Add fixed-clock tests for browser verification and webhook capture during finite/lifetime grants, paid expiry during overlap, grant expiry/revoke restoration, and no paid restoration at `paid.expiresAt == now`.
  - **Completion evidence:** Payment tests prove the independently valid paid transaction is retained byte-for-byte except for its expected paid-flow changes, resolver output matches final records, and no successful serialization creates ambiguous effective state.
  - _Requirements: 9.2-9.4, 10.1-10.7, 16.3, 18.2, 18.4, 18.6, 19.2, 20.2-20.3, 20.6_

- [x] 9. Add regression-first Flask API, authentication, capability, and integration contract tests
  - **Depends on:** 3, 5, 7, 8.
  - Extend Flask test-client coverage for unauthenticated, invalid/revoked token, stale OTP, non-admin, capability false/omitted/malformed/unavailable, custom-claim admin, and verified allowlist admin cases; assert denial occurs before Firebase target lookup or protected billing/audit reads.
  - Add exact-email lookup tests for normalization, not found, Auth unavailable, disabled, unverified, minimum fields, no partial enumeration, and no account/profile/grant creation.
  - Add list/create/revoke tests for exact fields, unknown fields, stable success/error envelopes and HTTP statuses, request IDs, target re-lookup, inactive plan, validity/reason/ID/key errors, conflicts, duplicate replay, paid fallback, and sanitized internal failures.
  - Add `/api/v1/billing/me` tests for additive `adminCapabilities.complimentarySubscriptions`, paid compatibility, finite/lifetime complimentary shapes, no admin-only leakage, and false/omitted capability behavior.
  - **Completion evidence:** Tests assert every stable design error code at its approved status and demonstrate that request-body/query admin, capability, UID, plan attributes, price, time, source, status, and actor fields cannot authorize or mutate state; failures before Task 10/11 are limited to the named missing behavior.
  - _Requirements: 1.3-1.5, 2.1-2.4, 2.6, 3.2-3.4, 4.1-4.4, 5.3, 7.1-7.5, 8.2-8.5, 9.4-9.5, 11.1-11.5, 13.1-13.5, 14.1-14.5, 17.1-17.5, 18.1, 18.7, 19.1, 19.5, 20.1, 20.5_

- [x] 10. Implement server-derived capability policy and exact lookup/list/create/revoke APIs in `backend/billing_api.py`
  - **Depends on:** 9.
  - Extend the existing `require_auth` boundary with an optional server-derived `complimentarySubscriptions` capability while preserving token revocation checking, current-session OTP, custom-claim/verified-allowlist admin policy, request IDs, readiness, and payload limits for all existing endpoints.
  - Wire a fail-closed server capability flag (the design's `BILLING_COMPLIMENTARY_ADMIN_ENABLED` or the repository's equivalent established config path). False, missing, malformed, or unavailable values must deny before protected reads; request input must never override it.
  - Add `POST /api/v1/admin/billing/users/lookup`, `GET/POST /api/v1/admin/billing/complimentary-grants`, and `POST /api/v1/admin/billing/complimentary-grants/{grantId}/revoke` using the existing `_body`, `_allow_fields`, `BillingError`, Firebase app, catalog, store, clock, and request-ID conventions.
  - Repeat Firebase Admin `get_user_by_email` on create, derive target/actor state server-side, accept only approved selectors and validity/reason/key inputs, and return authoritative grant/effective/fallback/duplicate results.
  - Decode and verify signed cursors only on the server; first-page listing fixes `asOf`, subsequent pages must preserve it and bind identical normalized filters.
  - **Completion evidence:** Task 9 lookup/list/create/revoke and auth-ordering tests pass; every endpoint emits stable errors and request IDs; capability-disabled tests prove zero target/plan/grant/paid/audit reads; existing Plan Admin and Coupon Admin remain governed by their unchanged admin policy.
  - _Requirements: 1.3-1.5, 2.1-2.4, 2.6, 3.1-3.4, 4.1-4.4, 7.1-7.5, 8.2-8.5, 9.4-9.5, 11.1-11.5, 13.1-13.4, 14.1-14.5, 16.1-16.2, 17.1-17.5, 18.1, 18.7, 19.1, 19.5, 20.1, 20.5_

- [x] 11. Route `/api/v1/billing/me` and backend premium authorization through the shared resolver
  - **Depends on:** 7, 8, 10.
  - Replace the paid-only `/billing/me` read with the store-backed effective-entitlement loader while preserving existing `subscription`, `isAdmin`, and `requestId` keys and adding only the server-derived capability object and approved subscription fields.
  - Ensure `/billing/me` excludes paid fallback, reason, actor identity, operation data, and grant/audit history; finite expiry is evaluated at server time and lifetime remains active without a fabricated timestamp.
  - In `backend/webhook_intelligence.py`, inject/reuse the shared entitlement service and centralized tier rank instead of reading `billing_subscriptions` or maintaining a second rank map.
  - Preserve bearer/OTP behavior, health exclusions, Pro/Elite thresholds, `subscription_required`, and fail-closed availability behavior for premium routes.
  - **Completion evidence:** Task 9 `/billing/me` tests pass; premium-route tests prove equivalent paid behavior plus complimentary Pro/Elite access, insufficient-tier denial, finite expiry, lifetime, revoke/paid fallback, malformed-state denial, and unavailable-store denial; static review finds no paid-only premium authorization read.
  - _Requirements: 1.1, 1.3-1.5, 5.3, 6.1-6.6, 10.1-10.8, 12.3-12.4, 13.5, 17.3-17.4, 18.1, 18.3-18.4, 18.7, 19.1-19.2, 19.4-19.5, 20.1-20.2, 20.6_

- [x] 12. Add Firestore indexes, deployment wiring, and explicit direct-client denies
  - **Depends on:** 7, 10.
  - Add or update root `firestore.indexes.json` as needed to declare the three approved composite indexes for exact email, plan, and combined equality filters followed by `createdAt DESC` and `__name__ DESC`; retain built-in no-filter ordering and do not index computed status.
  - Add only the minimal repository deployment/emulator wiring needed to deploy and test that index file; do not add credentials or weaken existing deployment controls.
  - Add explicit `allow read, write: if false` blocks in `firestore.rules` for grant, pointer, operation, and audit collections while preserving existing paid billing denies and final catch-all.
  - Add rules/index tests for ordinary clients and admin-claim clients against every new collection and existing protected billing collections, plus all supported list filter combinations.
  - **Completion evidence:** Emulator/rules output shows all direct reads/writes denied for both identities and all approved backend/Admin SDK query shapes execute without missing-index errors; review confirms no rule grants custom-claim direct billing access.
  - _Requirements: 7.1, 7.4-7.5, 11.3-11.4, 12.5, 16.7, 17.4-17.5, 18.7, 20.5_

- [x] 13. Complete backend unit, deterministic property, Flask API/auth, and integration suites
  - **Depends on:** 7, 8, 10, 11, 12.
  - Consolidate gaps from Tasks 2, 4, 6, and 9 so every normalizer, public shape, resolver row, service transition, stable error, auth/capability permutation, and paid-preservation case in the approved testing strategy is automated.
  - Complete deterministic generated properties for resolver determinism, complimentary priority, paid restoration, exact preset duration, lifetime, at-most-one-active grant, idempotency, and paid preservation using fixed/reported seeds and no unapproved dependency.
  - Cover lookup, all validity options, immediate activation, supersession, revoke, expiration, inactive-plan races, target revalidation, malformed records, duplicate/conflict behavior, fixed-`asOf` signed cursor pagination, and sanitized dependency errors through Flask integration tests.
  - **Completion evidence:** Focused backend modules and `npm run test:backend` pass; the test report maps each named property and API/auth scenario to requirement IDs and contains no skipped complimentary case without an approved blocker.
  - _Requirements: 2.1-2.6, 3.1-3.5, 4.1-4.5, 5.1-5.5, 6.1, 7.1-7.6, 8.2-8.5, 9.1-9.5, 10.1-10.8, 11.1-11.5, 12.1-12.7, 13.1-13.5, 14.1-14.5, 16.1-16.7, 17.1-17.5, 18.1-18.7, 20.1-20.3, 20.5-20.6_

- [x] 14. Complete Firestore emulator concurrency, security-rule, and index verification
  - **Depends on:** 8, 10, 11, 12, 13.
  - Using Firebase Auth and Firestore emulator infrastructure against `FirestoreBillingStore`, run simultaneous grant/grant, grant/revoke, grant/browser-verification, grant/captured-webhook, revoke/payment, expiration-sensitive read/write, and forced transaction-retry scenarios.
  - Assert one current active pointer/effective grant, correct terminal fields, one audit event per transition, one operation record per committed idempotency identity, no replacement-pointer clearing, and resolver output matching serialized records.
  - Assert paid subscription extension and all order/payment/coupon/redemption/history snapshots are preserved except for the independently valid payment transaction.
  - Run direct-client rule denies for ordinary and admin-claim identities and exercise no-filter/email/plan/combined indexes with equal timestamps and status-filter scans.
  - **Completion evidence:** A repeatable emulator command exits zero; concurrency assertions pass across repeated runs; no test uses mocks for Firestore transactions/rules/indexes; the report records emulator versions/config and any deterministic race barriers used.
  - _Requirements: 5.4-5.5, 7.1, 7.4-7.5, 8.2-8.5, 9.2-9.5, 10.5-10.7, 12.2-12.5, 16.1-16.7, 17.5, 18.2, 20.3, 20.5_

- [x] 15. Implement and test authenticated complimentary methods in `src/services/billingService.js`
  - **Depends on:** 10.
  - Add `lookupBillingUser`, `listComplimentaryGrants`, `createComplimentaryGrant`, and `revokeComplimentaryGrant` through the existing authenticated request and `BillingApiError` parser; do not import Firestore or create an alternate transport.
  - Build list queries with `URLSearchParams`, omit empty filters, preserve opaque cursor bytes through encoding, encode grant IDs in paths, and send only approved operation fields.
  - Extend `tests/billingService.test.js` with exact method/URL/body assertions, filters/cursors, path encoding, empty-filter omission, authoritative duplicate response, stable error/request-ID parsing, and hostile extra-field exclusion.
  - **Completion evidence:** `npm run test:billing` passes and request spies prove no UID/admin/capability/plan attributes/price/time/status/actor fields or direct Firestore operations leave the service.
  - _Requirements: 2.5-2.6, 3.2, 7.4-7.5, 13.1-13.6, 14.3, 17.2-17.3, 19.1, 19.5, 20.4-20.5_

- [x] 16. Make `SubscriptionContext` and shared frontend entitlement helpers lifetime-, expiry-, and capability-aware
  - **Depends on:** 11, 15.
  - Extract/test pure helpers for effective active state, tier ranking, source/validity formatting inputs, capability normalization, and timer decisions before integrating them into `src/context/SubscriptionContext.jsx`.
  - Treat access as active only when status is active and either explicit lifetime is true or finite server expiration is in the future; never infer lifetime from missing expiration.
  - Schedule expiry refresh only for finite access and refresh `/billing/me` on timer fire, focus, visibility resume, and successful mutation without requiring sign-out.
  - Preserve initialization, plan loading, pending-payment reconciliation, admin state, and fail-closed retrieval behavior. Expose `adminCapabilities` with false/omitted/malformed values disabled and keep `hasPlan` based on effective tier.
  - **Completion evidence:** Deterministic helper/context tests pass for paid, inactive, finite complimentary, exact expiry boundary, lifetime, source changes, focus/visibility, retrieval failure, and every admin/capability combination; fake timers prove lifetime schedules no expiry timer.
  - _Requirements: 1.1-1.4, 5.3, 6.2, 6.4-6.6, 10.8, 15.6, 18.1, 18.3-18.4, 19.1-19.5, 20.4, 20.6_

- [x] 17. Integrate source-aware user presentation and admin route/navigation capability gating
  - **Depends on:** 16.
  - Update `src/pages/Subscription.jsx`, `src/pages/Dashboard.jsx`, and relevant `src/components/Layout.jsx` status/badge views to label complimentary access, display effective plan/tier, render finite server timestamps with locale/time zone, and render explicit `Lifetime` without `new Date(null)`.
  - Keep `src/components/SubscriptionRoute.jsx` source-agnostic through `hasPlan`; preserve plan purchase, Razorpay success/pending/failure, payment history/invoice, and renewal presentation, and never display a complimentary grant as a payment or charge.
  - Extend `src/components/AdminRoute.jsx` with the optional approved `requiredCapability` behavior while preserving existing Plan Admin and Coupon Admin behavior.
  - Add the lazy `/admin/complimentary-subscriptions` route in `src/App.jsx` and the adjacent Layout navigation item, visible only when backend-confirmed `isAdmin === true` and capability is exactly true; direct navigation waits for context initialization and denies stale/disabled state.
  - **Completion evidence:** Component/route tests prove finite/lifetime/source-aware rendering, tier authorization, payment UI preservation, all admin/capability permutations, stale frontend denial, and unchanged access to existing admin routes.
  - _Requirements: 1.1-1.4, 4.5, 6.2-6.5, 9.3, 10.1, 11.3, 18.2-18.4, 19.1, 19.3-19.4, 20.4, 20.6_

- [x] 18. Build the full complimentary-subscription administration page
  - **Depends on:** 15, 16, 17.
  - Add `src/pages/AdminComplimentarySubscriptions.jsx` using existing form, button, loading, toast, card, responsive layout/table, and confirmation patterns, with small local components/helpers rather than a second global store.
  - Implement independent plan/list loading and retry; exact-email lookup; immediate selected-target/confirmation invalidation on input edits; eligibility display; canonical active plan/tier/features selection; exact preset/custom/lifetime controls; and bounded plain-text reason handling.
  - Implement grant confirmation with target, plan/tier/features, local time-zone validity preview, current effective state, paid fallback, and supersession impact. Generate one cryptographically random idempotency key per accepted unchanged attempt, reuse it after ambiguous retry, and replace it after payload change/success/reset.
  - Implement exact email/plan/status filters, fixed-cursor pagination, explicit empty state, and every approved current/history/audit list field with safe text rendering and server-authoritative status/time.
  - Implement active-row revoke confirmation showing target/plan/validity, stable retry key, operation-specific loading/error state, authoritative row/effective/fallback replacement, and list/context refresh after success.
  - Preserve successful sections when another load fails, keep unrelated safe controls enabled, retain valid inputs after failures, and never claim success before an authoritative response.
  - **Completion evidence:** Component tests exercise all validity choices, lookup invalidation/ineligibility, independent failures/retries, confirmation contents, complete list fields, filters/cursors/empty state, create/supersede/revoke outcomes, idempotency-key lifecycle, text-only reason rendering, and capability/API denial without protected-data rendering.
  - _Requirements: 2.2, 2.4-2.5, 3.1, 4.1-4.5, 7.1-7.6, 8.1, 8.3-8.5, 9.1, 9.4, 14.2, 15.1-15.6, 16.1-16.2, 19.3, 20.4_

- [x] 19. Complete frontend service, helper, context, component, route, and browser E2E coverage
  - **Depends on:** 18.
  - Complete pure reducer/view-model tests for lookup invalidation, section-specific loading/errors, filter resets, cursor accumulation, confirmation summaries, authoritative row replacement, operation control disabling, and deterministic injected idempotency-key behavior.
  - Complete context/component tests for finite expiration refresh, lifetime without timers, fail-closed retrieval, source-aware user presentation, no payment fields for grants, and Plan/Coupon Admin preservation.
  - Add browser E2E coverage for capability-only navigation/route access, stale frontend versus backend 403, exact lookup, canonical plans, all validity controls, grant confirmation, list details/filters/pagination, empty/error/success states, revoke confirmation, and paid-fallback/inactive result.
  - Include static/bundle assertions that frontend code never reads/writes complimentary or paid billing collections directly and renders server text as text rather than HTML.
  - **Completion evidence:** All focused `node:test` and browser E2E commands exit zero; test output covers every Requirement 20.4 item and records no skipped browser scenario without an approved environment blocker.
  - _Requirements: 1.1-1.4, 2.5-2.6, 4.1-4.5, 6.2-6.6, 7.2-7.6, 8.1, 8.5, 13.6, 14.2, 15.1-15.6, 16.1-16.2, 17.3-17.5, 18.3, 19.1, 19.3-19.5, 20.4-20.6_

- [x] 20. Add privacy-safe observability and verify staged rollout/rollback compatibility
  - **Depends on:** 10, 11, 12, 18.
  - Add request-correlated structured logs for lookup/list/grant/revoke/resolver outcomes and transaction retries with operation, result code, duplicate flag, latency, hashed actor/target UID, grant/plan IDs, validity, and transition type; exclude tokens, full emails, reasons, raw keys, features, allowlists, credentials, and environment secrets.
  - Keep revenue analytics sourced only from captured payment records; if the repository already has compatible metrics infrastructure, **optional per approved design:** add separately labeled non-monetary counters/histograms for the suggested grant/resolver/auth/transaction/list signals. Do not add a metrics dependency solely for this feature.
  - Validate rollout order: indexes/rules; resolver/readers; capability-disabled APIs; lifetime-aware frontend; admin page; controlled capability enablement. Treat missing/false capability as disabled.
  - Validate rollback containment: disabling the capability blocks lookup/list/create/revoke before reads while existing grants remain honored by `/billing/me` and premium authorization; do not copy grants into or delete paid/audit data.
  - Update only established backend example/deployment configuration where necessary to document the non-secret capability flag and server-only cursor-signing configuration; never put signing material or allowlists in Vite/client configuration.
  - **Completion evidence:** Captured logs for success, duplicate, conflict, denial, and internal failure contain request IDs and approved fields only; secret scans find no cursor key/admin allowlist/token/raw operation key in client artifacts; capability-off integration tests prove committed entitlement reads continue while all admin operations fail closed.
  - _Requirements: 1.3-1.5, 5.2, 11.3-11.5, 12.5-12.6, 14.5, 17.4, 18.6-18.7, 20.5, 20.8_

- [x] 21. Run full end-to-end, preservation, build, and release validation
  - **Depends on:** 13, 14, 19, 20.
  - Run the approved E2E scenario with emulator/test Firebase Auth and Firestore: OTP-proven capability-enabled admin finds an enabled verified existing user by exact email, creates a canonical grant without payment records, target refreshes `/billing/me` and enters protected access, list shows complete audit fields, revoke occurs, and paid fallback or inactivity is restored.
  - Run negative E2E cases for unknown/disabled/unverified targets, inactive plans, unauthorized/capability-disabled callers, forged UID/admin/capability/plan/price/time/status inputs, direct Firestore access, malformed state, and stale frontend authorization.
  - Run `npm run test:billing`, `npm run test:backend`, all added frontend/browser and emulator suites, existing authentication/OTP/webhook/coupon/pending-payment/payment-history/invoice/plan-admin/coupon-admin/premium-tier/preservation suites, and `npm run build`.
  - Run each relevant repository-declared lint or static type-check command identified in Task 1; if none exists, record that validation as not applicable rather than inventing an unsupported command.
  - Inspect built output for Firebase Admin credentials, Razorpay secrets, cursor-signing secrets, admin allowlists, raw operation keys, audit internals, or direct complimentary collection access.
  - **Completion evidence:** A release-validation record lists every command and zero exit status, E2E record IDs/counts prove no payment-domain documents were created or changed by grant/revoke, preservation snapshots pass, and the production build completes with no exposed secret or unresolved failure.
  - _Requirements: 2.3-2.6, 3.3-3.5, 5.1-5.5, 6.1-6.6, 8.2-8.5, 9.1-9.5, 10.1-10.8, 11.1-11.5, 12.5-12.7, 17.1-17.5, 18.1-18.7, 20.1-20.8_

- [x] 22. Perform final spec-format and requirements/design/tasks traceability validation
  - **Depends on:** 21.
  - Confirm all tasks remain Markdown checkboxes, are dependency ordered, name concrete repository areas/outcomes, contain validation and completion evidence, and cite only Requirement 1-20 acceptance-criteria identifiers present in `requirements.md`.
  - Compare the completed implementation and validation evidence to the approved `design.md` component boundaries, data models, API contracts, resolver properties, security boundaries, rollout, and testing strategy; record any variance as a blocker rather than silently redesigning.
  - Verify every acceptance criterion has at least one implementation task and one validation task, every task traces to at least one requirement, and no optional work exists except the design-approved metrics instrumentation condition in Task 20.
  - Verify the final changeset contains no unrelated refactor/cleanup and no direct client billing access, paid-record repurposing, alternate admin policy, alternate plan catalog, or duplicate tier/resolver implementation.
  - **Completion evidence:** A machine- or reviewer-generated traceability report returns: 20/20 requirement groups covered, 100% acceptance criteria mapped to implementation and validation evidence, 22/22 tasks with dependencies/requirements/completion evidence, zero invalid requirement references, zero dependency cycles, and zero unresolved design variances.
  - _Requirements: 19.1-19.5, 20.1-20.8_

## Requirement Coverage Index

| Requirement group | Implementation tasks | Primary validation tasks |
|---|---|---|
| 1. Authorized administration | 10, 11, 16-18, 20 | 9, 19, 21-22 |
| 2. Existing-user lookup | 5, 10, 15, 18 | 4, 9, 13, 19, 21-22 |
| 3. Canonical plan catalog | 3, 5, 7, 10, 18 | 2, 4, 6, 9, 13, 21-22 |
| 4. Validity choices | 3, 5, 7, 18 | 2, 4, 13, 19, 21-22 |
| 5. Immediate zero-payment activation | 5, 7, 10 | 4, 6, 13-14, 21-22 |
| 6. User-facing subscription status | 3, 11, 16-17 | 2, 9, 13, 19, 21-22 |
| 7. Admin list/details | 3, 5, 7, 10, 15, 18 | 4, 6, 9, 12-14, 19, 21-22 |
| 8. Revoke/remove | 5, 7, 10, 18 | 4, 6, 9, 13-14, 19, 21-22 |
| 9. Paid conversion/preservation | 5, 7-8, 10, 18 | 4, 6, 9, 13-14, 19, 21-22 |
| 10. Priority/restoration | 3, 5, 7-8, 11, 16 | 2, 4, 6, 9, 13-14, 19, 21-22 |
| 11. Server identity/admin auth | 10 | 9, 12-14, 19, 21-22 |
| 12. Persistence model | 5, 7, 12 | 4, 6, 9, 13-14, 21-22 |
| 13. API contracts | 3, 10-11, 15 | 9, 13, 19, 21-22 |
| 14. Validation/errors | 3, 5, 7, 10, 18, 20 | 2, 4, 6, 9, 13, 19, 21-22 |
| 15. UI operation states | 16, 18 | 19, 21-22 |
| 16. Idempotency/concurrency/audit | 3, 5, 7-8, 10, 18 | 4, 6, 9, 13-14, 19, 21-22 |
| 17. Trust boundaries | 3, 5, 7, 10-12, 15-20 | 2, 4, 6, 9, 13-14, 19, 21-22 |
| 18. Preservation | 8, 10-12, 16-17, 20 | 1, 9, 13-14, 19, 21-22 |
| 19. Shared components/functions | 3, 5, 8, 10-18 | 9, 13, 19, 21-22 |
| 20. Verification/build | All implementation tasks | 1-2, 4, 6, 9, 13-14, 19, 21-22 |
