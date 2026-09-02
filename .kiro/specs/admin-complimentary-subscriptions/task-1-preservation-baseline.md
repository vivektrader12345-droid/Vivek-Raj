# Task 1 Preservation Baseline

## Scope and environment

- Spec: `admin-complimentary-subscriptions`
- Task: `1. Establish preservation baselines and focused test locations`
- Baseline date (UTC): 2026-09-02
- Working directory: `c:\Users\vivek\OneDrive\Documents\vivek-crypto-trader`
- The spec directory has no `.config` file, so no `specType: "bugfix"` marker is present.
- The working tree already contained unrelated modified and untracked files before this task. These results describe that pre-implementation working tree; no later complimentary-subscription task was implemented.

## Required command results

| Command | Started (UTC) | Ended (UTC) | Exit status | Result | Pre-existing failures |
|---|---|---|---:|---|---|
| `npm run test:billing` | `2026-09-02T03:39:47.8418851Z` | `2026-09-02T03:40:04.6556805Z` | 0 | 13 tests passed; 0 failed, cancelled, skipped, or todo | None |
| `npm run test:backend` | `2026-09-02T03:39:55.9316363Z` | `2026-09-02T03:40:18.9833078Z` | 0 | 98 tests passed; `unittest` reported `OK` | None |
| `npm run build` | `2026-09-02T03:40:55.6152591Z` | `2026-09-02T03:42:07.4652319Z` | 0 | Vite production build completed after transforming 2,279 modules; postbuild APK artifact verification returned `status: verified` | None |

The backend run emitted application-level `[LIVE]`, `[DEMO]`, `[WARN]`, and intentionally exercised `[ERROR]` log lines from existing tests. They were not test failures: the command ended with `Ran 98 tests ... OK` and exit status 0. No failing test names exist to record for any required command.

## Existing preservation coverage represented by the baseline

| Requirement | Baseline location/evidence |
|---|---|
| 18.1 | `npm run test:backend` discovers `backend/tests/test_firebase_auth.py`, `backend/tests/test_otp_auth.py`, and `backend/tests/test_email_otp_preservation.py`; the full backend discovery run passed. The production frontend also compiled successfully. |
| 18.2 | `backend/tests/test_billing.py` covers server-priced orders, coupons, signatures, webhook capture, retries, payment history state, and paid subscription extension; it passed through `npm run test:backend`. |
| 18.3 | `tests/billingContracts.test.js` preserves subscription, payment pending, premium route, and admin route contracts; it passed through `npm run test:billing`. The production route graph compiled successfully. |
| 18.4 | Existing paid/inactive entitlement behavior in `backend/tests/test_billing.py`, `tests/billingService.test.js`, and `tests/billingContracts.test.js` passed before complimentary behavior exists. |
| 18.5 | Existing plan/coupon administration and canonical billing behavior in `backend/tests/test_billing.py` passed. |
| 18.6 | Existing payment/coupon accounting behavior in `backend/tests/test_billing.py` passed. No complimentary analytics code exists in this baseline. |
| 18.7 | Existing structured errors, request IDs, payload allowlists, webhook authorization ordering, and fail-closed premium checks in `backend/tests/test_billing.py` and `tests/billingService.test.js` passed. |
| 20.6 | The required backend discovery and focused billing suites passed, preserving the repository's current auth/OTP, billing, coupon, webhook, pending reconciliation, subscription timer, premium-tier, and route contract checks included by these commands. Broader named suites remain release-validation work for Task 21 rather than Task 1 implementation. |
| 20.8 | `npm run test:billing`, `npm run test:backend`, and `npm run build` all exited 0 on the pre-implementation tree. No unresolved baseline failure was observed. |

## Exact focused test locations for subsequent tasks

These are the designated locations for later tasks. New files listed below are locations only and were not created by Task 1.

### Backend

- `backend/tests/test_billing_complimentary_domain.py`: strict normalizers, public shapes, grant status, signed cursor primitives, pure effective-entitlement resolver, and deterministic generated properties (Tasks 2-3).
- `backend/tests/test_billing_complimentary_service.py`: Firebase exact-email lookup boundary, `MemoryBillingStore`, grant/supersede/revoke transitions, idempotency, listing, audit, and paid-preservation properties (Tasks 4-5).
- `backend/tests/test_billing_complimentary_store.py`: memory/Firestore store contract, transaction ordering, resolver loading, cursor scans, payment interaction, and cleanup preservation (Tasks 6-8).
- `backend/tests/test_billing_complimentary_api.py`: Flask authentication/capability ordering, lookup/list/create/revoke contracts, `/billing/me`, stable errors, and sanitized failures (Tasks 9-13).
- `backend/tests/test_billing_complimentary_emulator.py`: real Firestore emulator concurrency, rule, and index cases when emulator infrastructure is added (Tasks 12-14 and 21).
- `backend/tests/test_billing.py`: preserve and extend only existing paid activation/browser-webhook interaction and backend premium-tier regression cases where co-location with the current billing fixtures is necessary (Tasks 8 and 11). Complimentary domain/API coverage should remain in the narrowly named modules above.

All backend modules remain discoverable by the existing `python -m unittest discover -s backend/tests -t backend -p "test_*.py"` command.

### Frontend

- `tests/billingService.test.js`: exact request URL/query/body/path encoding, authenticated transport, duplicate responses, and `BillingApiError` behavior for the four complimentary service methods (Task 15). This file is already included by `npm run test:billing`.
- `tests/complimentaryEntitlement.test.js`: pure lifetime/finite-active, tier, capability, formatting, and timer-decision helpers used by `SubscriptionContext` (Task 16).
- `tests/adminComplimentaryRoutes.test.js`: `AdminRoute`, navigation, stale capability denial, existing Plan/Coupon Admin preservation, and source-aware route/presentation contracts (Tasks 17 and 19).
- `tests/adminComplimentarySubscriptions.test.js`: admin page reducer/view-model, lookup invalidation, independent loading/error state, validity controls, confirmation, filters/cursors, idempotency-key lifecycle, row replacement, and safe rendering (Tasks 18-19).
- `tests/adminComplimentarySubscriptions.e2e.test.js`: browser-level authorized/denied administration flow, grant/list/revoke states, target refresh, and paid fallback/inactivity (Tasks 19 and 21).
- `tests/billingContracts.test.js`: retain source/static contracts for paid routes, payment UI preservation, no client secrets, and no direct client billing-collection access (Tasks 17, 19, and 21).
- `tests/preservation/preservation.characterization.test.js`: retain the existing broad unrelated UI characterization baseline for final preservation validation; complimentary-specific behavior does not belong in this file.

Later tasks must add explicit runnable scripts for focused frontend/browser or emulator suites only when those tasks establish the required infrastructure. Task 1 does not invent or add those scripts.

## Lint and static type-check availability

Inspection of the root `package.json` scripts found no repository-declared `lint`, `eslint`, `typecheck`, `type-check`, `check-types`, or equivalent static type-check command. There is also no project-root ESLint configuration or `tsconfig.json`; matches found under `node_modules` or generated Vite caches are dependency/generated metadata, not repository validation gates.

Result for Task 1 and the later Task 21 release checklist: **lint/static type-check command: not applicable unless a later approved task adds a repository-declared command.** No unsupported gate should be invented.
