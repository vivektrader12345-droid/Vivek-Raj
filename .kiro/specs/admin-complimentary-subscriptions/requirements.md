# Requirements Document

## Introduction

Add end-to-end administrator management of complimentary subscriptions for existing Firebase Authentication users. An authorized billing administrator shall be able to find one existing user by email, select a plan from the server-owned billing catalog, grant access without Razorpay payment, inspect grants, and revoke access. The resulting entitlement shall be reflected consistently in the existing subscription page, dashboard, route guards, and backend premium-feature checks.

### Current architecture baseline

The application uses Firebase Authentication and current-session OTP proof, a Flask billing blueprint under `/api/v1`, server-derived billing administrator status, Firestore Admin SDK persistence, a server-owned `billing_plans` catalog, a canonical `billing_subscriptions/{uid}` paid-subscription record, Razorpay order/payment/webhook flows, `SubscriptionContext`, `SubscriptionRoute`, and `AdminRoute`. Billing collections are denied to direct clients by Firestore Security Rules. The feature shall extend these boundaries rather than creating a parallel client-trusted authorization or plan system.

### Assumptions

1. Firebase Authentication is the authoritative source for resolving an email to an existing UID. The client-writable `users/{uid}/profile` email is display data and is not sufficient identity proof.
2. Email lookup is exact after trimming surrounding whitespace and applying case normalization; aliases, partial strings, domains, and fuzzy matches are not treated as the same account.
3. Only existing Firebase Authentication users may receive grants; this feature does not invite, register, or create users.
4. New grants use an active plan from the canonical catalog. Existing grants retain their server-created plan snapshot if a plan is later edited or deactivated.
5. A complimentary grant takes immediate effective-entitlement priority over a paid subscription. The paid subscription and payment history remain intact, and its calendar expiration continues to elapse while the complimentary grant is active; paid time is not paused or extended.
6. At most one complimentary grant is active for a UID. A new successful grant atomically supersedes the prior active complimentary grant.
7. Revoked, superseded, and expired grant records are retained for audit and can be viewed through status filters; they cannot be reactivated in place.
8. Lifetime grants use an explicit validity type and nullable expiration. All finite date calculations use server UTC; the UI may render those timestamps in the viewer's locale.
9. Existing Firebase custom-claim and verified-email allowlist administration rules remain the only administrator authorization paths in scope.
10. No refund, payment cancellation, credit, invoice mutation, or Razorpay-side change is implied by converting effective access from paid to complimentary.

### Explicitly Out of Scope

- Creating, inviting, deleting, disabling, or changing the email of Firebase Authentication users.
- Defining new plan identifiers, a separate free-plan catalog, or client-controlled plan prices and tiers.
- Refunds, credits, payment cancellation, chargeback management, Razorpay subscription products, or invoice modification.
- Pausing or extending paid subscription time while complimentary access is effective.
- Bulk grants, CSV import/export, partial-email directory search, mass revocation, or public user enumeration.
- User self-service complimentary codes, referrals, coupons as grants, or approval workflows.
- Hard deletion of grant audit history or a new billing-data retention policy.

### Measurable Success Criteria

1. All twenty requirement groups and their acceptance criteria pass automated or documented end-to-end verification.
2. A valid grant becomes visible to the target user's `/api/v1/billing/me` response and effective route authorization on the first post-commit refresh, with zero Razorpay/order/payment records created by the grant.
3. Repeated identical mutations create exactly one state transition, and concurrency tests never produce more than one active complimentary grant per UID.
4. Every effective-entitlement transition produces the deterministic source, tier, and expiration outcome in Requirement 10 while retaining paid payment history byte-for-byte except for independently valid paid-flow updates.
5. Unauthorized API and direct Firestore attempts cannot look up users, list grants, create grants, revoke grants, or read audit data.
6. Existing billing, authentication, preservation, and production build checks remain green, including `npm run test:billing`, `npm run test:backend`, relevant frontend tests, and `npm run build`.

## Glossary

- **Authorized billing administrator:** An authenticated user whom the backend recognizes through the existing server-side rule: literal Firebase custom claim `admin: true`, or an exact normalized verified-email match in startup-captured `BILLING_ADMIN_EMAILS`, with the existing current-session OTP policy satisfied.
- **Canonical plan catalog:** The existing server-owned plan records exposed from `billing_plans` through `StoredPlanCatalog` and the billing API. No plan identifier, price, duration, feature set, or entitlement tier supplied only by the client is authoritative.
- **Complimentary grant:** A server-created, zero-payment entitlement assigning an existing canonical plan's access tier to one existing Firebase UID for a stated validity window.
- **Paid subscription:** Access created by the existing verified Razorpay payment flow and represented by its payment, order, plan snapshot, and subscription state.
- **Effective entitlement:** The single server-computed access result consumed by `/api/v1/billing/me`, frontend route guards, the subscription/dashboard UI, and backend premium-feature authorization after applying the priority rules in Requirement 10.
- **Preset validity:** One of exactly 7, 30, 90, or 365 consecutive 24-hour days beginning at the grant's server-recorded activation time.
- **Custom validity:** A finite administrator-selected expiration date and time later than the server-recorded activation time.
- **Lifetime validity:** A grant with no scheduled expiration; it remains active until revoked or superseded and is represented explicitly as lifetime rather than by a fabricated far-future date.
- **Grant status:** One of `active`, `expired`, `revoked`, or `superseded`, computed or recorded by the server.
- **Revocation:** An administrator action that ends a complimentary grant immediately while retaining its immutable history and audit data. “Remove” in the administration UI means revoke access, not hard-delete the audit record.
- **Superseded grant:** A formerly active complimentary grant replaced atomically by a newer complimentary grant for the same user.
- **Plan snapshot:** The canonical plan identity, name, entitlement tier, features, and catalog revision copied by the server at grant time for stable audit and display; complimentary validity remains independent of the paid plan's catalog duration.
- **Target user:** The existing Firebase Authentication account receiving or losing a complimentary grant.
- **Idempotency key:** An opaque, unique client operation identifier used by the backend to make grant and revoke retries safe.
- **Server time:** An authoritative UTC time generated by the backend or Firestore transaction, never by a client-supplied clock.

## Requirements

### Requirement 1: Authorized administration entry point

**User Story:** As an authorized billing administrator, I want a dedicated complimentary-subscription page so that I can manage free access without exposing the capability to ordinary users.

#### Acceptance Criteria

1.1 WHEN the backend has confirmed `isAdmin: true` and the server-derived `adminCapabilities.complimentarySubscriptions` capability is enabled for the current authenticated session, THE SYSTEM SHALL display a Complimentary Subscriptions navigation entry alongside the existing Plan Admin and Coupon Admin entries.

1.2 WHEN an authorized billing administrator with the enabled complimentary-subscriptions capability opens the complimentary-subscription route, THE SYSTEM SHALL render the management page inside the existing protected layout and `AdminRoute` authorization pattern.

1.3 IF the current session is unauthenticated, missing current OTP proof, not recognized by the backend as an authorized billing administrator, or does not have the enabled complimentary-subscriptions capability, THE SYSTEM SHALL hide the administration navigation entry and deny the route without rendering grant data or controls.

1.4 WHEN frontend state incorrectly claims administrator or complimentary-subscriptions capability access but the backend does not authorize the token and capability, THE SYSTEM SHALL return and display the backend denial and SHALL NOT perform any lookup, list, grant, or revoke operation.

1.5 THE SYSTEM SHALL derive the complimentary-subscriptions capability on the server, expose it to authenticated clients only as a boolean authorization capability, treat an omitted or false value as disabled, and SHALL NOT trust a client-supplied capability value.

### Requirement 2: Existing-user lookup by email

**User Story:** As an authorized billing administrator, I want to find an existing account by email so that I grant access to the intended user.

#### Acceptance Criteria

2.1 WHEN an administrator submits an email lookup, THE SYSTEM SHALL trim and normalize the email on the server and resolve it through Firebase Admin Authentication to exactly one existing Firebase UID.

2.2 WHEN the exact normalized email identifies an existing user, THE SYSTEM SHALL return only the minimum confirmation fields needed for selection: UID, canonical Firebase email, email-verification state, display name when present, account-disabled state, and current effective-entitlement summary.

2.3 IF no Firebase Authentication user has the exact normalized email, THE SYSTEM SHALL return a structured `user_not_found` result and SHALL NOT create an authentication account, Firestore profile, or grant.

2.4 IF the resolved account is disabled or does not have a verified email, THE SYSTEM SHALL identify that state and prevent grant submission.

2.5 WHILE the administrator edits the lookup email after a result is returned, THE SYSTEM SHALL clear the selected target UID and require a new successful lookup before grant submission.

2.6 THE SYSTEM SHALL NOT provide partial-email search, account enumeration, bulk user export, or lookup results to unauthorized callers.

### Requirement 3: Reuse the canonical plan catalog

**User Story:** As an administrator, I want to choose from the same plans used by paid billing so that complimentary access grants the correct existing entitlement.

#### Acceptance Criteria

3.1 WHEN the grant form loads, THE SYSTEM SHALL retrieve active plans from the existing server-owned canonical plan catalog and display the server-returned plan name, entitlement tier, and features.

3.2 WHEN a grant is submitted, THE SYSTEM SHALL accept a plan identifier only as a selector and SHALL resolve all plan attributes from the canonical catalog on the server within the grant operation.

3.3 IF the selected plan does not exist or is inactive when the server processes the grant, THE SYSTEM SHALL reject the operation with a structured plan error and SHALL NOT create or alter a grant.

3.4 THE SYSTEM SHALL NOT define a new hard-coded complimentary plan list, invent plan identifiers, or trust client-supplied price, duration, features, plan name, entitlement tier, or catalog revision.

3.5 WHEN the server creates a grant, THE SYSTEM SHALL persist a plan snapshot from the resolved canonical record and SHALL preserve that snapshot for historical display after later catalog edits.

### Requirement 4: Supported validity choices

**User Story:** As an administrator, I want standard and flexible validity options so that I can grant access for the intended period.

#### Acceptance Criteria

4.1 WHEN the administrator selects preset validity, THE SYSTEM SHALL offer exactly 7, 30, 90, and 365 days and SHALL calculate expiration as activation server time plus the selected number of consecutive 24-hour days.

4.2 WHEN the administrator selects custom validity, THE SYSTEM SHALL require a valid date-time strictly later than the server's activation time and SHALL store the normalized UTC expiration returned by the backend.

4.3 WHEN the administrator selects lifetime validity, THE SYSTEM SHALL store `validityType` as lifetime and no expiration timestamp, and SHALL NOT synthesize an arbitrary future expiration date.

4.4 IF validity is missing, unsupported, malformed, non-finite, already elapsed, or internally inconsistent, THE SYSTEM SHALL reject the grant with a field-specific validation error and make no durable change.

4.5 WHEN the client displays a finite expiration, THE SYSTEM SHALL use the server-returned timestamp and indicate the viewer's time zone or locale; WHEN it displays lifetime validity, THE SYSTEM SHALL show “Lifetime” rather than a date.

### Requirement 5: Immediate zero-payment activation

**User Story:** As an administrator, I want a successful grant to activate immediately without payment so that the user can use the selected access at once.

#### Acceptance Criteria

5.1 WHEN a valid grant request commits, THE SYSTEM SHALL set its activation time from server time, mark it active, and make its entitlement effective in the same atomic operation.

5.2 WHEN a complimentary grant activates, THE SYSTEM SHALL NOT create a Razorpay order, payment, invoice, coupon redemption, payment attempt, provider event, or monetary analytics entry.

5.3 WHEN the target user's next authenticated entitlement read occurs after the commit, THE SYSTEM SHALL return active access for the granted canonical plan without requiring logout, a payment callback, or a Razorpay webhook.

5.4 WHEN the target user already has another active complimentary grant, THE SYSTEM SHALL atomically mark the prior grant superseded and activate the new grant so that no successful state contains two active complimentary grants for that UID.

5.5 IF persistence fails before commit, THE SYSTEM SHALL report failure and leave the prior paid subscription, prior complimentary grant, and effective entitlement unchanged.

### Requirement 6: Correct user-facing subscription status

**User Story:** As a recipient, I want my dashboard and subscription status to reflect complimentary access accurately so that I understand my plan and validity.

#### Acceptance Criteria

6.1 WHEN `/api/v1/billing/me` returns an active complimentary effective entitlement, THE SYSTEM SHALL include status, canonical plan ID, entitlement tier, source `complimentary`, activation time, validity type, expiration when finite, and a lifetime indicator when applicable.

6.2 WHEN the application receives an active complimentary entitlement, `SubscriptionContext`, `hasPlan`, `SubscriptionRoute`, the subscription page, dashboard indicators, and backend premium route checks SHALL grant the same tier-based access as the corresponding canonical paid plan.

6.3 WHEN a complimentary grant is effective, THE SYSTEM SHALL label it as complimentary/free access and SHALL NOT display a paid amount, Razorpay payment ID, invoice, or misleading renewal charge for that grant.

6.4 WHEN a finite complimentary grant reaches its server-defined expiration, THE SYSTEM SHALL cease using it no later than the next entitlement evaluation and SHALL update active UI state reactively without requiring a full sign-out.

6.5 WHEN a lifetime complimentary grant is active, THE SYSTEM SHALL treat it as active despite having no expiration timestamp and SHALL keep existing finite-expiry timer logic from incorrectly marking it inactive.

6.6 IF entitlement retrieval fails, THE SYSTEM SHALL preserve the existing fail-closed access behavior, display a retryable error, and SHALL NOT infer complimentary access from client storage or stale form state.

### Requirement 7: Administrator grant list and details

**User Story:** As an administrator, I want a searchable grant history so that I can identify current and past complimentary access.

#### Acceptance Criteria

7.1 WHEN an authorized administrator requests the grant list, THE SYSTEM SHALL return paginated records in deterministic descending creation-time order with a stable tie-breaker.

7.2 FOR EACH listed grant, THE SYSTEM SHALL display grant ID, target UID, canonical target email snapshot, target display name when available, plan ID, plan name, entitlement tier, validity type, activation time, expiration or Lifetime, computed status, created time, granting administrator UID and email, last-updated time, and administrator reason when present.

7.3 WHEN a grant is revoked or superseded, THE SYSTEM SHALL additionally display its end time, end reason, and revoking or superseding administrator identity or replacement grant ID as applicable.

7.4 WHEN an administrator filters the list, THE SYSTEM SHALL support exact normalized email, plan ID, and status filters without exposing records to an unauthorized caller.

7.5 IF a page cursor or filter is invalid, THE SYSTEM SHALL return a structured validation error rather than silently returning misleading results.

7.6 WHEN no records match, THE SYSTEM SHALL show an explicit empty state rather than a loading indicator or error.

### Requirement 8: Revoke or remove complimentary access

**User Story:** As an administrator, I want to remove complimentary access so that an unintended or completed grant stops immediately.

#### Acceptance Criteria

8.1 WHEN an administrator initiates removal of an active grant, THE SYSTEM SHALL show the target email, plan, and validity and require explicit confirmation before sending the revoke request.

8.2 WHEN a valid revoke commits, THE SYSTEM SHALL record status `revoked`, server revocation time, revoking administrator UID and email, and an optional bounded reason, and SHALL stop that grant from contributing to effective entitlement immediately.

8.3 WHEN the UI says a grant was removed, THE SYSTEM SHALL retain the historical grant and audit fields and SHALL NOT hard-delete the Firestore record.

8.4 IF a grant is already revoked, expired, or superseded, THE SYSTEM SHALL perform no additional entitlement mutation and SHALL return either the original idempotent result for the same request or a structured state-conflict response.

8.5 IF revocation fails, THE SYSTEM SHALL retain the grant's prior status, display an actionable error, and keep the revoke action available for retry.

### Requirement 9: Paid-to-complimentary conversion

**User Story:** As an administrator, I want to grant complimentary access to a paid subscriber so that their effective access changes without corrupting payment history.

#### Acceptance Criteria

9.1 WHEN the selected target has an active or expired paid subscription, THE SYSTEM SHALL show that paid plan, status, and finite expiration in the lookup confirmation before the administrator grants complimentary access.

9.2 WHEN a complimentary grant is committed for a user with paid history, THE SYSTEM SHALL activate the complimentary grant according to Requirement 10 and SHALL retain every existing Razorpay order, payment, invoice, coupon redemption, paid plan snapshot, payment count, and provider identifier unchanged.

9.3 WHEN conversion occurs, THE SYSTEM SHALL NOT issue a refund, cancel a provider order, modify a captured payment, generate a zero-value payment, or count the grant as paid revenue.

9.4 WHEN the conversion response is returned, THE SYSTEM SHALL identify both the new effective complimentary entitlement and the preserved paid-subscription fallback state.

9.5 IF an existing paid record is malformed or cannot be read consistently during conversion, THE SYSTEM SHALL reject the grant atomically with a structured consistency error rather than overwrite or discard the paid state.

### Requirement 10: Deterministic paid-versus-complimentary priority and restoration

**User Story:** As a user with paid and complimentary access, I want deterministic access transitions so that revocation and expiration never produce ambiguous entitlement.

#### Acceptance Criteria

10.1 WHILE an active complimentary grant exists, THE SYSTEM SHALL select it as the effective entitlement regardless of whether an active paid subscription exists, and SHALL expose the paid subscription only as preserved fallback metadata to authorized contexts.

10.2 WHILE a complimentary grant is active, THE SYSTEM SHALL allow its finite validity and the paid subscription's original calendar expiration to advance independently and SHALL NOT pause, extend, shorten, or otherwise mutate paid time because of overlap.

10.3 WHEN the effective complimentary grant expires or is revoked, THE SYSTEM SHALL restore the preserved paid subscription as effective only if its original paid expiration is strictly later than current server time.

10.4 WHEN the effective complimentary grant expires or is revoked and the preserved paid subscription is absent or no longer active, THE SYSTEM SHALL return an inactive or expired effective entitlement and SHALL deny premium access.

10.5 WHEN a new complimentary grant supersedes an active complimentary grant, THE SYSTEM SHALL make only the new grant effective and SHALL NOT restore paid access between the two atomic transitions.

10.6 WHEN a Razorpay payment is captured while complimentary access is effective, THE SYSTEM SHALL process and preserve the paid subscription using existing payment rules, keep the complimentary grant effective until it ends, and then apply criteria 10.3–10.4.

10.7 WHEN effective entitlement is evaluated repeatedly from the same paid and complimentary records at the same server time, THE SYSTEM SHALL return the same source, plan, tier, status, and validity result.

10.8 THE SYSTEM SHALL use one shared server-side effective-entitlement resolver for `/billing/me` and backend premium authorization so that frontend and backend access decisions cannot diverge.

### Requirement 11: Server-side identity and administrator authorization

**User Story:** As a platform owner, I want identity and authorization established on the server so that users cannot grant themselves free access.

#### Acceptance Criteria

11.1 WHEN any complimentary administration API is called, THE SYSTEM SHALL verify the Firebase bearer token with revocation checking, require current-session OTP proof under the existing policy, and derive the caller UID, email, verification state, and administrator status from the verified token and server configuration.

11.2 WHEN an operation targets a user, THE SYSTEM SHALL derive the target UID from the server-side Firebase Admin email lookup or a previously server-returned opaque target reference and SHALL NOT trust a client-supplied email-to-UID association.

11.3 IF the caller is not an authorized billing administrator, THE SYSTEM SHALL return 401 or 403 as applicable before reading or mutating user lookup, plan, grant, paid-subscription, or audit data.

11.4 THE SYSTEM SHALL NOT accept `isAdmin`, administrator email, actor UID, target verification state, OTP proof, or custom claims from a request body as authorization evidence.

11.5 WHEN authorization fails, THE SYSTEM SHALL return a sanitized structured error with a request ID and SHALL NOT reveal the admin allowlist, whether another user has a grant, or internal token details.

### Requirement 12: Firestore and persistence model

**User Story:** As a maintainer, I want auditable and isolated persistence so that complimentary grants coexist safely with paid billing.

#### Acceptance Criteria

12.1 WHEN the feature is deployed, THE SYSTEM SHALL store complimentary grant history in a dedicated Admin-SDK-only billing collection keyed by immutable grant ID and SHALL associate each record with exactly one Firebase UID.

12.2 THE SYSTEM SHALL preserve paid Razorpay state separately from complimentary grant state and SHALL provide enough persisted state to recompute the deterministic effective entitlement defined by Requirement 10.

12.3 WHEN an effective entitlement projection is persisted or cached for route performance, THE SYSTEM SHALL update it in the same transaction as grant activation, supersession, or revocation and SHALL make the source grant ID and source type traceable.

12.4 WHEN a finite grant is read after expiration, THE SYSTEM SHALL compute it as expired from server time even if no scheduled cleanup job has updated its stored status.

12.5 WHEN Firestore Security Rules are evaluated for browser or mobile clients, THE SYSTEM SHALL deny direct reads and writes to complimentary grants, effective-entitlement internals, paid billing records, and audit fields; all access SHALL go through the authenticated backend API.

12.6 WHEN account deletion or other existing user-data cleanup runs, THE SYSTEM SHALL not silently delete immutable billing/grant audit records unless a separately approved retention policy requires it.

12.7 IF stored grant data lacks required identity, plan snapshot, validity, source, or audit fields, THE SYSTEM SHALL fail closed for access and return a sanitized consistency error to authorized administration views.

### Requirement 13: Backend and frontend API contracts

**User Story:** As a client developer, I want structured APIs so that lookup, grant, list, revoke, and entitlement refresh are predictable.

#### Acceptance Criteria

13.1 THE SYSTEM SHALL expose authenticated, versioned administrator billing endpoints under the existing `/api/v1/admin/billing` namespace for exact-email lookup, paginated grant listing, grant creation, and grant revocation.

13.2 WHEN a grant or revoke request is submitted, THE SYSTEM SHALL require an idempotency key and only the operation inputs needed by the server: selected server-resolved target, canonical plan selector, validity selection, optional reason, and grant identifier for revocation.

13.3 WHEN an API operation succeeds, THE SYSTEM SHALL return a structured JSON result containing the authoritative grant, effective entitlement summary, duplicate indicator where applicable, and request ID.

13.4 WHEN an API operation fails, THE SYSTEM SHALL use a stable machine-readable error code, safe human-readable message, appropriate HTTP status, optional field details, and request ID consistent with the existing `BillingApiError` contract.

13.5 WHEN `/api/v1/billing/me` is requested by the target user, THE SYSTEM SHALL return the effective entitlement without exposing administrator-only notes, actor emails, idempotency keys, or unrelated grant history.

13.6 THE SYSTEM SHALL extend the existing authenticated billing service rather than use direct Firestore access or an unauthenticated alternate transport from the administration page.

### Requirement 14: Input validation and safe error handling

**User Story:** As an administrator, I want invalid input rejected clearly so that I do not create an unintended grant.

#### Acceptance Criteria

14.1 WHEN an email is submitted, THE SYSTEM SHALL reject empty, malformed, oversized, or non-string values before user lookup and identify the email field as invalid.

14.2 WHEN a reason is supplied, THE SYSTEM SHALL trim it, enforce a documented maximum of 500 Unicode characters, store it as plain text, and reject executable markup or control content rather than render it as HTML.

14.3 WHEN plan, validity, grant ID, cursor, filter, or idempotency inputs contain unexpected fields, unsupported types, or values outside their defined contract, THE SYSTEM SHALL reject the request before mutation.

14.4 WHEN the target, plan, paid state, or existing grant changes after the UI confirmation but before commit, THE SYSTEM SHALL validate the current server state in the transaction and return a conflict or the authoritative committed result.

14.5 WHEN an internal error occurs, THE SYSTEM SHALL log request-correlated diagnostic detail server-side, return a sanitized error to the client, and SHALL NOT expose credentials, tokens, environment values, stack traces, or another user's private data.

### Requirement 15: Loading, confirmation, success, empty, and error states

**User Story:** As an administrator, I want clear operation feedback so that I know whether access changed.

#### Acceptance Criteria

15.1 WHILE user lookup, plan retrieval, grant listing, grant creation, or revocation is in progress, THE SYSTEM SHALL show an operation-specific loading state, disable duplicate submission of that operation, and keep unrelated safe controls usable.

15.2 BEFORE grant submission, THE SYSTEM SHALL show a confirmation summary containing target email, plan name and entitlement tier, validity, computed finite expiration when available, and the current paid/complimentary state that will be affected.

15.3 WHEN a grant succeeds, THE SYSTEM SHALL show a success message, render the authoritative active grant and effective entitlement returned by the server, clear stale form state, and refresh the grant list.

15.4 WHEN a revoke succeeds, THE SYSTEM SHALL show a success message, update the affected row to its authoritative status, and display the restored paid or inactive effective-entitlement outcome.

15.5 IF any operation fails, THE SYSTEM SHALL preserve valid administrator input where safe, show an actionable error associated with the failed operation, and provide a retry path without claiming success.

15.6 WHEN the page first loads and one data source fails while another succeeds, THE SYSTEM SHALL preserve the successful data, identify the unavailable section, and allow a section-specific retry.

### Requirement 16: Idempotency, concurrency, and auditability

**User Story:** As a platform owner, I want retry-safe and race-safe mutations so that every access change is explainable and occurs once.

#### Acceptance Criteria

16.1 WHEN the same administrator repeats a grant or revoke request with the same idempotency key and identical normalized payload, THE SYSTEM SHALL return the original committed result without creating another grant, duplicate audit event, or second state transition.

16.2 IF an idempotency key is reused with a different normalized payload, THE SYSTEM SHALL reject it with an idempotency conflict and SHALL NOT mutate state.

16.3 WHEN concurrent grant, supersede, revoke, paid-payment activation, or expiration-sensitive reads affect the same UID, THE SYSTEM SHALL use Firestore transaction or equivalent compare-and-set semantics so that the final records satisfy Requirements 5 and 10.

16.4 WHEN two different valid grant requests race for the same UID, THE SYSTEM SHALL serialize them deterministically: exactly one latest committed grant is active, any displaced active grant is superseded, and no paid or grant history is lost.

16.5 FOR EACH grant, THE SYSTEM SHALL persist immutable grant ID, target UID and email snapshot, canonical plan snapshot and revision when available, validity type, activation and expiration, created and updated server timestamps, creator UID and email, normalized idempotency identity, status, and optional reason.

16.6 WHEN a grant is revoked or superseded, THE SYSTEM SHALL append or persist immutable transition audit fields identifying transition type, server time, actor UID and email for administrator actions, reason, and replacement grant ID when applicable.

16.7 THE SYSTEM SHALL NOT allow client requests to overwrite creation identity, server timestamps, historical plan snapshot, revocation actor, or prior audit transitions.

### Requirement 17: Trust boundaries for identity, plan, price, and entitlement

**User Story:** As a security owner, I want server-owned billing decisions so that manipulated clients cannot obtain or assign access.

#### Acceptance Criteria

17.1 THE SYSTEM SHALL derive administrator identity from a verified Firebase token, target identity from Firebase Admin Authentication, plan data from the canonical server catalog, and current time from the server.

17.2 THE SYSTEM SHALL ignore or reject client-supplied amount, currency, price, paid status, payment count, plan name, features, entitlement tier, activation time, computed expiration, effective source, target account state, or audit actor fields.

17.3 WHEN a complimentary grant is evaluated for premium access, THE SYSTEM SHALL use server-persisted grant and plan-snapshot data and SHALL NOT use local storage, URL parameters, frontend context alone, or client-writable user profile fields as proof.

17.4 THE SYSTEM SHALL keep Firebase Admin credentials, Razorpay secrets, `BILLING_ADMIN_EMAILS`, grant audit internals, and bearer tokens out of client bundles and public API responses.

17.5 WHEN direct Firestore access is attempted against billing or complimentary collections, THE SYSTEM SHALL deny it regardless of a client-provided administrator flag.

### Requirement 18: Preserve existing authentication, payment, subscription, and routes

**User Story:** As an existing user, I want complimentary management added without disrupting current product behavior.

#### Acceptance Criteria

18.1 WHILE this feature is enabled, THE SYSTEM SHALL preserve existing email/password plus OTP authentication, Google authentication, token refresh, account hydration, logout, and server-side OTP enforcement behavior.

18.2 WHEN a non-complimentary user purchases or renews a plan, THE SYSTEM SHALL preserve existing server-priced Razorpay order creation, coupon validation, signature verification, webhook reconciliation, late capture, pending-order reconciliation, invoice, payment history, and paid-subscription extension behavior.

18.3 WHEN existing routes are requested, THE SYSTEM SHALL preserve `/subscription`, payment success/pending/failure, payment history, Plan Admin, Coupon Admin, dashboard, premium routes, and all unrelated application routes and route guards.

18.4 WHEN a user has no complimentary grant, THE SYSTEM SHALL return and enforce the same paid or inactive entitlement semantics as before this feature.

18.5 WHEN an existing billing plan is edited, reordered, or deactivated, THE SYSTEM SHALL preserve Plan Admin behavior and historical paid and complimentary snapshots.

18.6 WHEN analytics are calculated, THE SYSTEM SHALL exclude complimentary grants from gross revenue, discounts, coupon use, captured payment count, and Razorpay-derived metrics unless a separately labeled non-monetary grant metric is added.

18.7 THE SYSTEM SHALL preserve current structured billing errors, request IDs, readiness behavior, payload limits, and fail-closed authorization boundaries.

### Requirement 19: Reuse existing components and shared functions

**User Story:** As a maintainer, I want this feature integrated with established abstractions so that authorization and entitlement logic remain consistent.

#### Acceptance Criteria

19.1 THE SYSTEM SHALL reuse or extend `AdminRoute`, the layout's `isAdmin` navigation gating, `billingService`, `SubscriptionContext`, canonical plan normalization/catalog functions, and existing billing authentication/error helpers rather than duplicate their responsibilities.

19.2 THE SYSTEM SHALL centralize effective-entitlement resolution and use it from `/billing/me`, payment activation interactions, complimentary mutations, and every backend premium-feature authorization check.

19.3 THE SYSTEM SHALL reuse existing visual form, button, loading, toast, card, responsive layout, and confirmation patterns where they satisfy these requirements.

19.4 IF an existing helper cannot support lifetime validity or dual paid/complimentary state, THE SYSTEM SHALL extend it with backward-compatible fields and SHALL NOT encode lifetime as an invalid finite subscription.

19.5 THE SYSTEM SHALL avoid a second admin-authorization implementation, a second plan catalog, direct client Firestore billing access, or duplicated tier-ranking rules that can drift from existing behavior.

### Requirement 20: End-to-end verification and build quality

**User Story:** As a release owner, I want automated and end-to-end evidence so that complimentary access is safe to deploy.

#### Acceptance Criteria

20.1 WHEN backend tests run, THE SYSTEM SHALL verify authorized and unauthorized exact-email lookup; unknown, disabled, and unverified users; canonical active-plan enforcement; every validity option; lifetime behavior; immediate activation; revoke; supersede; and sanitized errors.

20.2 WHEN transition tests run, THE SYSTEM SHALL verify no paid subscription, active paid, expired paid, grant over paid, grant expiry, grant revocation, paid expiry during grant, payment capture during grant, and paid restoration outcomes exactly as defined by Requirement 10.

20.3 WHEN idempotency and concurrency tests run, THE SYSTEM SHALL verify duplicate retries, key-payload conflicts, two racing grants, grant-versus-revoke, and grant-versus-payment activation without duplicate active grants, lost payment history, or divergent effective entitlement.

20.4 WHEN frontend tests run, THE SYSTEM SHALL verify admin-only navigation and route behavior, lookup invalidation, canonical plan rendering, all validity controls, confirmation content, loading/empty/success/error states, list fields and filters, revoke confirmation, lifetime status, and post-mutation refresh.

20.5 WHEN security tests run, THE SYSTEM SHALL prove that request-body admin flags, target UIDs not bound by server lookup, client plan attributes, prices, times, statuses, and direct Firestore writes cannot create, alter, or expose complimentary access.

20.6 WHEN preservation tests run, THE SYSTEM SHALL verify existing authentication/OTP flows, Razorpay/coupon/webhook/payment history/invoice behavior, plan and coupon administration, subscription timers, pending reconciliation, premium route tiers, and unrelated routes remain passing.

20.7 WHEN an end-to-end test runs with Firebase/Auth and Firestore test infrastructure, THE SYSTEM SHALL demonstrate: an authorized administrator finds an existing user by email, grants a canonical plan without a payment, the user's next entitlement refresh and protected access become active, the admin list shows complete audit fields, revocation takes effect, and paid fallback or inactivity is restored according to Requirement 10.

20.8 WHEN release validation runs, `npm run test:billing`, `npm run test:backend`, the relevant frontend test suite, and `npm run build` SHALL complete successfully with no new client-exposed secrets, direct billing-collection access, or unresolved test failures.
