# Task 21 Release Validation Evidence

## Scope and environment

- Spec: `admin-complimentary-subscriptions`
- Task: `21. Run full end-to-end, preservation, build, and release validation`
- Completed UTC: `2026-09-02T09:47:40.5233449Z`
- Repository: `c:\Users\vivek\OneDrive\Documents\vivek-crypto-trader`
- Runtime: Node `v24.18.0`, npm `11.16.0`, Python `3.14.6`, Firebase CLI `15.28.2`, Firestore emulator `v1.22.0`
- Spec type: no `.config` exists, so no `specType: bugfix` handling applies.
- Repository lint/static type check: **N/A**. Task 1 found no declared lint or static type-check script, and Task 21 did not invent one.
- Task 22 traceability validation was not performed.

## Final release gate results

| Command / inspection | Final exit | Result |
|---|---:|---|
| `npm run test:billing` | 0 | 28 passed, 0 failed/skipped. Covers authenticated billing transport, pending reconciliation, subscription timers, frontend tier/capability helpers, and paid/complimentary service contracts. |
| `npm run test:backend` | 0 | 186 passed, 0 failed, 11 emulator-only tests skipped in the non-emulator process. The same 11 tests were run and passed under `npm run test:firestore`. Discovery includes auth, current-session OTP, webhook, coupon, pending/late payment, payment history/invoice, plan/coupon admin, premium-tier, complimentary domain/store/API, preservation, and unrelated backend suites. |
| `npm run test:firestore` | 0 | Real Firebase Auth + Firestore emulators: 5 Node security/rule tests and 11 Python transaction/index/release-E2E tests passed; no skips. |
| `npm run test:complimentary` | 0 | Unit/helper/component: 38 passed; real Chromium browser E2E: 1 passed; bundle/security: 2 passed. Its nested production build also exited 0. |
| `npm run test:preservation` | 0 | 2 passed, 0 failed/skipped. The final run passed after Vite's preservation fixture cache was warm; no preservation code was changed. |
| `npm run build` | 0 | Vite transformed 2,282 modules and completed the production build; APK postbuild verification returned `status: verified`, byte size `5261539`, SHA-256 `0289447d05d13138d512c5419db12e3ceb09db2e31a2a9454d957255c20be70c`. |
| Production artifact secret/internal scan via repository search | pass | No matches in `dist/**/*.{js,css,html,json}` for Firebase Admin credentials/private keys, Razorpay secrets, cursor-signing configuration/key placeholders, `BILLING_ADMIN_EMAILS`, known raw test operation keys, operation/audit internals, or protected complimentary/paid collection names. |
| `node --version; npm --version; python --version; npx firebase --version` | 0 | Recorded runtime versions above. |

## Real emulator positive E2E

`backend/tests/test_billing_firestore_release_emulator.py` uses real emulator-issued Firebase ID tokens, Firebase Admin exact-email lookup, the Flask billing and premium blueprints, and `FirestoreBillingStore`; no Auth, Firestore transaction, query, or rule mock is used.

The successful flow proved:

1. An OTP-proven custom-claim administrator with server capability enabled resolved exact normalized email `target-task21@example.com` to the existing enabled, verified Auth UID `target-task21`.
2. The administrator created a server-catalog `pro` lifetime grant without invoking or writing a payment flow.
3. The target's next authenticated `/api/v1/billing/me` read returned the complimentary grant without paid fallback, reason, actor, operation, or audit leakage.
4. The same real target token entered the Pro-protected `/api/v1/webhooks/endpoints` route.
5. Exact email + plan + active status list filters returned the complete authoritative administrator grant/audit shape.
6. Revocation retained the grant history, restored the original paid `basic` fallback, and the Pro route immediately returned `subscription_required`.

### Committed record evidence

- Grant ID: `ab7c2f339fa74d459cb56d87ff44dddc`
- Complimentary grants: 1 — `ab7c2f339fa74d459cb56d87ff44dddc`
- Complimentary pointers: 1 — `target-task21`
- Complimentary operations: 2 — `6d84f24a6516eba52677901bc6da3d3784fafbaeb4a2ed63eb7992a4c91955a9`, `a91d8acca76b5d26d8a64620e281b2aee9a956dc1a44c748c5bcf657fa1b46af`
- Complimentary audit events: 2 — `187e064f4081479e1b792d684707bc0723a73f8b3c492fd586ac2ef453ca4f17`, `93857cdf84fd819754895ec87bd583cfc70d2fd9aab1e74cc13a289e9e132d4e`
- Final grant status: `revoked`
- Final effective source: `paid`

### Payment-domain preservation proof

The test seeded one marker in every payment-domain collection, snapshotted all fields before grant, and compared all documents after grant and revoke. The complete nested snapshots were equal (`paymentDomainPreserved: true`). Counts and IDs before/after were unchanged:

| Collection | Count | IDs |
|---|---:|---|
| `billing_orders` | 1 | `order-marker` |
| `billing_provider_orders` | 1 | `provider-order-marker` |
| `billing_payments` | 1 | `payment-marker` |
| `billing_payment_attempts` | 1 | `attempt-marker` |
| `billing_subscriptions` | 1 | `target-task21` |
| `billing_coupons` | 1 | `COUPON-MARKER` |
| `billing_coupon_user_usage` | 1 | `coupon-user-marker` |
| `billing_coupon_redemptions` | 1 | `redemption-marker` |
| `billing_webhook_events` | 1 | `event-marker` |

Therefore grant/revoke created or changed zero payment-domain documents; the paid subscription and all seeded payment/order/coupon/redemption/event data were byte-for-byte preserved.

## Negative E2E and security evidence

The real Auth/Firestore release E2E verified fail-closed outcomes for ordinary callers, server capability disabled, unknown exact email, disabled target, unverified target, inactive canonical plan, malformed selected grant/pointer state, and forged request fields (`isAdmin`, capability object, target UID, plan name, price, activation time, status). Every failed mutation left complimentary grants and all payment-domain snapshots unchanged.

The real emulator rule suite additionally proved that ordinary authenticated clients, admin-claim clients, and a real Auth emulator session cannot read, list, or write any complimentary or existing protected billing collection. The real index suite exercised no-filter, exact-email, plan, combined email+plan, equal-timestamp tie-breaking, and status-filter pagination. Transaction suites covered grant/grant, grant/revoke, grant/browser verification, grant/captured webhook, revoke/payment, expiration-sensitive operations, and forced retries while preserving payment history.

The Chromium E2E covered stale frontend authorization versus backend denial, hidden/denied navigation permutations, lookup invalidation, canonical plan rendering, all validity controls, confirmation content, list details/filters/cursor pagination, empty/error/success states, revoke confirmation, lifetime timers, finite expiration refresh, paid fallback display, and existing Plan/Coupon Admin navigation.

## Failure and rerun record

| Attempt | Exit | Finding and disposition |
|---|---:|---|
| Initial `npm run test:backend` | 1 | One cursor-tampering case exposed that non-canonical base64url text with different unused trailing bits could decode to the same signed bytes. Fixed `_b64url_decode` to require canonical re-encoding. Final full backend run passed. |
| Initial `npm run test:firestore` | 1 | New release E2E expected `billing_unavailable` instead of established `billing_data_inconsistent`; failed assertion prevented malformed-pointer cleanup and contaminated the following positive case. Corrected assertion and guaranteed cleanup with `finally`. |
| First emulator rerun | 1 | Stale Firestore emulator Java process retained port 8085 after the failed run. The process was identified as `cloud-firestore-emulator-v1.22.0.jar`, stopped, and the unchanged emulator command then passed. |
| Initial parallel `npm run test:preservation` | 1 | Vite fixture HTTP startup timed out under concurrent emulator/backend load. |
| First sequential `npm run test:preservation` | 1 | Cold fixture transform did not set readiness within the 20-second harness wait; direct fixture/module diagnostic returned HTTP 200 and a valid transformed module, with no runtime exception. |
| Final `npm run test:preservation` | 0 | Warm-cache rerun passed both preservation tests. No unrelated preservation source or timeout was changed. |

## Skips and completion assessment

- Lint/static type checks: N/A because the repository declares none.
- Backend non-emulator run: 11 emulator-only classes skipped by their environment guards; all 11 executed and passed in the required real-emulator command.
- Browser/E2E scenarios: none skipped.
- Direct-client rule/index cases: none skipped.
- Secret/internal scan categories: none skipped; all listed Task 21 categories were inspected.

**Task 21 completion evidence is satisfied.** Every final required command exits zero, the approved positive/negative real-infrastructure E2E flows pass, record IDs/counts prove zero grant/revoke payment-domain mutation, preservation and production build gates pass, and built artifacts contain none of the listed secrets, audit internals, raw test operation keys, or direct protected-collection access. Task status metadata was not edited, and Task 22 was not performed.
