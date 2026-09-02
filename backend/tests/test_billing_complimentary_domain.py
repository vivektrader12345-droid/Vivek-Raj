"""Regression-first domain contract for administrator-managed complimentary access.

These tests intentionally describe the Task 3 API before its implementation.  They
use only ``unittest`` and seeded standard-library generation so they remain part of
the repository's normal backend discovery command.
"""

from __future__ import annotations

import random
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import billing_core as core


UTC = timezone.utc
FIXED_NOW = datetime(2025, 1, 15, 12, 0, 0, tzinfo=UTC)


class FixedClock:
    def __init__(self, value=FIXED_NOW):
        self.value = value

    def __call__(self):
        return self.value


class ComplimentaryDomainFixtures:
    """Shared fixed-clock records and assertions for the focused domain tests."""

    def setUp(self):
        self.clock = FixedClock()

    def require_domain_api(self, name):
        value = getattr(core, name, None)
        if value is None:
            self.fail("Task 3 missing billing_core.%s" % name)
        return value

    def assert_billing_error(self, code, function, *args, field=None, **kwargs):
        with self.assertRaises(core.BillingError) as raised:
            function(*args, **kwargs)
        self.assertEqual(raised.exception.code, code)
        if field is not None:
            self.assertEqual((raised.exception.details or {}).get("field"), field)

    def plan_record(self, **overrides):
        record = {
            "id": "pro",
            "name": "Pro",
            "amountPaise": 99900,
            "durationDays": 90,
            "features": ["Advanced analytics", "Priority support"],
            "active": True,
            "sortOrder": 1,
            "entitlementTier": "pro",
            "revision": 7,
            "createdAt": FIXED_NOW - timedelta(days=100),
            "updatedAt": FIXED_NOW - timedelta(days=2),
        }
        record.update(overrides)
        return record

    def plan_snapshot(self, **overrides):
        snapshot = {
            "id": "pro",
            "name": "Pro",
            "entitlementTier": "pro",
            "features": ["Advanced analytics", "Priority support"],
            "revision": 7,
        }
        snapshot.update(overrides)
        return snapshot

    def paid_record(self, expires_at=None, **overrides):
        record = {
            "userId": "target-uid",
            "status": "active",
            "planId": "basic",
            "entitlementTier": "basic",
            "startsAt": FIXED_NOW - timedelta(days=10),
            "expiresAt": expires_at or FIXED_NOW + timedelta(days=20),
            "updatedAt": FIXED_NOW - timedelta(days=1),
            "lastPaymentId": "pay_preserved",
            "paymentCount": 3,
        }
        record.update(overrides)
        return record

    def grant_record(self, **overrides):
        record = {
            "id": "grant_0123456789abcdef",
            "targetUid": "target-uid",
            "targetEmail": "person@example.com",
            "targetEmailNormalized": "person@example.com",
            "targetDisplayName": "Person",
            "planId": "pro",
            "planSnapshot": self.plan_snapshot(),
            "validityType": "preset",
            "presetDays": 30,
            "activationAt": FIXED_NOW - timedelta(days=1),
            "expiresAt": FIXED_NOW + timedelta(days=29),
            "lifetime": False,
            "storedStatus": "active",
            "createdAt": FIXED_NOW - timedelta(days=1),
            "updatedAt": FIXED_NOW - timedelta(days=1),
            "createdBy": {"uid": "admin-uid", "email": "admin@example.com"},
            "reason": "Customer support resolution",
            "endedAt": None,
            "endReason": None,
            "revokedBy": None,
            "supersededByGrantId": None,
            "supersededBy": None,
            "creationOperationId": "operation-hash",
            "schemaVersion": 1,
        }
        record.update(overrides)
        return record


class ComplimentaryDomainContract(ComplimentaryDomainFixtures, unittest.TestCase):
    """Fixed-clock examples for strict normalization and public domain shapes."""

    # **Validates: Requirements 2.1, 14.1, 17.1**
    def test_exact_email_normalization_is_trimmed_case_normalized_and_strict(self):
        normalize = self.require_domain_api("normalize_email")

        self.assertEqual(normalize("  Person+tag@Example.COM  "), "person+tag@example.com")
        for invalid in (None, 42, "", "person", "@example.com", "person@", "a\n@example.com", "a" * 255):
            with self.subTest(invalid=invalid):
                self.assert_billing_error("invalid_email", normalize, invalid, field="email")

    # **Validates: Requirements 3.2-3.4, 14.3, 17.2**
    def test_plan_and_grant_identifiers_are_bounded_canonical_selectors(self):
        normalize_plan = self.require_domain_api("normalize_plan_selector")
        normalize_grant = self.require_domain_api("normalize_grant_id")

        self.assertEqual(normalize_plan(" pro "), "pro")
        self.assertEqual(normalize_grant(" grant_0123456789abcdef "), "grant_0123456789abcdef")
        for invalid in (None, True, "", "PRO", "a", "pro/elite", "x" * 33):
            with self.subTest(kind="plan", invalid=invalid):
                self.assert_billing_error("invalid_plan_id", normalize_plan, invalid, field="planId")
        for invalid in (None, True, "", "short", "grant/escape", "x" * 201):
            with self.subTest(kind="grant", invalid=invalid):
                self.assert_billing_error("invalid_grant_id", normalize_grant, invalid, field="grantId")

    # **Validates: Requirements 13.2, 14.2-14.3, 16.1-16.2**
    def test_reason_and_idempotency_inputs_are_trimmed_bounded_and_plain_text(self):
        normalize_reason = self.require_domain_api("normalize_reason")
        normalize_key = self.require_domain_api("normalize_idempotency_key")

        self.assertIsNone(normalize_reason(None))
        self.assertEqual(normalize_reason("  resolved for customer  "), "resolved for customer")
        self.assertEqual(normalize_reason("é" * 500), "é" * 500)
        for invalid in (7, "x" * 501, "unsafe<script>", "line\u0000break"):
            with self.subTest(kind="reason", invalid=invalid):
                self.assert_billing_error("invalid_reason", normalize_reason, invalid, field="reason")

        self.assertEqual(normalize_key(" operation-key-0001 "), "operation-key-0001")
        for invalid in (None, True, "", "short", "space is invalid", "x" * 201):
            with self.subTest(kind="idempotency", invalid=invalid):
                self.assert_billing_error("invalid_idempotency_key", normalize_key, invalid, field="idempotencyKey")

    # **Validates: Requirements 7.4-7.5, 13.2, 14.3**
    def test_list_query_accepts_only_exact_filter_limit_and_cursor_fields(self):
        normalize = self.require_domain_api("normalize_grant_list_query")
        raw = {
            "limit": "50",
            "email": " Person@Example.COM ",
            "planId": "pro",
            "status": "active",
            "cursor": "opaque.signed.cursor",
        }

        self.assertEqual(
            normalize(raw),
            {
                "limit": 50,
                "email": "person@example.com",
                "planId": "pro",
                "status": "active",
                "cursor": "opaque.signed.cursor",
            },
        )
        self.assertEqual(
            normalize({}),
            {"limit": 25, "email": None, "planId": None, "status": None, "cursor": None},
        )
        invalid_cases = (
            ({"partialEmail": "person"}, "unexpected_fields"),
            ({"limit": 0}, "invalid_limit"),
            ({"limit": 101}, "invalid_limit"),
            ({"status": "pending"}, "invalid_filter"),
            ({"cursor": ["not", "opaque"]}, "invalid_cursor"),
        )
        for query, code in invalid_cases:
            with self.subTest(query=query):
                self.assert_billing_error(code, normalize, query)

    # **Validates: Requirements 4.1, 4.4, 17.1**
    def test_all_four_presets_are_exact_consecutive_utc_days(self):
        normalize = self.require_domain_api("normalize_validity")
        for days in (7, 30, 90, 365):
            with self.subTest(days=days):
                result = normalize({"type": "preset", "days": days}, self.clock())
                self.assertEqual(result["validityType"], "preset")
                self.assertEqual(result["presetDays"], days)
                self.assertEqual(result["activationAt"], FIXED_NOW)
                self.assertEqual(result["expiresAt"], FIXED_NOW + timedelta(days=days))
                self.assertFalse(result["lifetime"])

        for invalid in (1, 29, 366, 30.0, True, "30"):
            with self.subTest(invalid_days=invalid):
                self.assert_billing_error(
                    "invalid_validity", normalize, {"type": "preset", "days": invalid}, FIXED_NOW, field="validity"
                )
        self.assert_billing_error(
            "invalid_validity",
            normalize,
            {"type": "preset", "days": 30, "expiresAt": FIXED_NOW.isoformat()},
            FIXED_NOW,
            field="validity",
        )

    # **Validates: Requirements 4.2-4.5, 6.5, 19.4**
    def test_custom_expiration_normalizes_to_utc_and_lifetime_has_no_expiration(self):
        normalize = self.require_domain_api("normalize_validity")

        custom = normalize({"type": "custom", "expiresAt": "2025-01-16T18:30:00+05:30"}, FIXED_NOW)
        self.assertEqual(custom["validityType"], "custom")
        self.assertEqual(custom["expiresAt"], datetime(2025, 1, 16, 13, 0, tzinfo=UTC))
        self.assertIsNone(custom["presetDays"])
        self.assertFalse(custom["lifetime"])

        lifetime = normalize({"type": "lifetime"}, FIXED_NOW)
        self.assertEqual(lifetime["validityType"], "lifetime")
        self.assertIsNone(lifetime["expiresAt"])
        self.assertIsNone(lifetime["presetDays"])
        self.assertTrue(lifetime["lifetime"])
        self.assertNotIn("days", lifetime)

        invalid_custom = (
            "2025-01-15T12:00:00Z",
            "2025-01-15T11:59:59Z",
            "2025-01-16T12:00:00",
            "2025-01-16",
            "not-a-date",
            "Infinity",
        )
        for expires_at in invalid_custom:
            with self.subTest(expires_at=expires_at):
                self.assert_billing_error(
                    "invalid_expiration",
                    normalize,
                    {"type": "custom", "expiresAt": expires_at},
                    FIXED_NOW,
                    field="validity.expiresAt",
                )
        for invalid in (None, [], {}, {"type": "forever"}, {"type": "lifetime", "expiresAt": None}):
            with self.subTest(invalid=invalid):
                self.assert_billing_error("invalid_validity", normalize, invalid, FIXED_NOW, field="validity")

    # **Validates: Requirements 3.2-3.5, 16.5, 16.7, 17.2**
    def test_canonical_plan_snapshot_is_non_monetary_and_immutable(self):
        snapshot_from_plan = self.require_domain_api("canonical_plan_snapshot")
        source = self.plan_record()
        result = snapshot_from_plan(source)

        self.assertEqual(result, self.plan_snapshot())
        for forbidden in ("amountPaise", "amountInr", "currency", "durationDays", "active", "sortOrder"):
            self.assertNotIn(forbidden, result)

        source["name"] = "Edited Pro"
        source["features"].append("Later catalog feature")
        source["revision"] = 8
        self.assertEqual(result, self.plan_snapshot())

        for malformed in (
            self.plan_record(entitlementTier=None),
            self.plan_record(features=[]),
            self.plan_record(revision=-1),
            self.plan_record(id="client-invented", active=False),
        ):
            with self.subTest(malformed=malformed):
                self.assert_billing_error("billing_data_inconsistent", snapshot_from_plan, malformed)

    # **Validates: Requirements 4.3-4.4, 12.4, 12.7, 16.5-16.7**
    def test_grant_validation_and_status_cover_active_expired_revoked_and_superseded(self):
        validate = self.require_domain_api("validate_complimentary_grant")
        status = self.require_domain_api("complimentary_grant_status")

        active = validate(self.grant_record())
        self.assertEqual(status(active, FIXED_NOW), "active")
        self.assertEqual(status(self.grant_record(expiresAt=FIXED_NOW), FIXED_NOW), "expired")
        self.assertEqual(status(self.grant_record(expiresAt=FIXED_NOW - timedelta(microseconds=1)), FIXED_NOW), "expired")
        self.assertEqual(
            status(
                self.grant_record(
                    validityType="lifetime", presetDays=None, expiresAt=None, lifetime=True
                ),
                FIXED_NOW,
            ),
            "active",
        )
        self.assertEqual(
            status(
                self.grant_record(
                    storedStatus="revoked",
                    endedAt=FIXED_NOW - timedelta(minutes=1),
                    endReason="Removed",
                    revokedBy={"uid": "admin-uid", "email": "admin@example.com"},
                ),
                FIXED_NOW,
            ),
            "revoked",
        )
        self.assertEqual(
            status(
                self.grant_record(
                    storedStatus="superseded",
                    endedAt=FIXED_NOW - timedelta(minutes=1),
                    endReason="Replaced",
                    supersededByGrantId="grant_fedcba9876543210",
                    supersededBy={"uid": "admin-uid", "email": "admin@example.com"},
                ),
                FIXED_NOW,
            ),
            "superseded",
        )

        malformed_records = (
            self.grant_record(targetUid=None),
            self.grant_record(planSnapshot={"id": "pro"}),
            self.grant_record(validityType="lifetime", lifetime=True),
            self.grant_record(validityType="preset", presetDays=30, expiresAt=None),
            self.grant_record(storedStatus="unknown"),
            self.grant_record(createdBy={"uid": "admin-uid"}),
        )
        for malformed in malformed_records:
            with self.subTest(malformed=malformed):
                self.assert_billing_error("billing_data_inconsistent", validate, malformed)

    # **Validates: Requirements 6.1, 6.3, 7.2-7.3, 13.5, 16.5-16.7, 17.4**
    def test_admin_grant_shape_is_complete_while_ordinary_shape_is_redacted(self):
        public = self.require_domain_api("complimentary_grant_public")
        grant = self.grant_record()

        administrator = public(grant, FIXED_NOW, admin=True)
        self.assertEqual(administrator["id"], grant["id"])
        self.assertEqual(administrator["targetUid"], "target-uid")
        self.assertEqual(administrator["targetEmail"], "person@example.com")
        self.assertEqual(administrator["planName"], "Pro")
        self.assertEqual(administrator["entitlementTier"], "pro")
        self.assertEqual(administrator["status"], "active")
        self.assertEqual(administrator["createdBy"], grant["createdBy"])
        self.assertEqual(administrator["reason"], grant["reason"])
        self.assertEqual(administrator["activationAt"], "2025-01-14T12:00:00Z")
        self.assertEqual(administrator["expiresAt"], "2025-02-13T12:00:00Z")

        ordinary = public(grant, FIXED_NOW, admin=False)
        self.assertEqual(ordinary["source"], "complimentary")
        self.assertTrue(ordinary["complimentary"])
        for forbidden in (
            "targetUid",
            "targetEmail",
            "targetEmailNormalized",
            "createdBy",
            "reason",
            "endedAt",
            "endReason",
            "revokedBy",
            "supersededBy",
            "creationOperationId",
            "schemaVersion",
            "paidFallback",
            "idempotencyKey",
            "audit",
        ):
            self.assertNotIn(forbidden, ordinary)

    # **Validates: Requirements 6.1, 10.4, 13.5, 18.4, 19.4**
    def test_paid_and_inactive_public_subscription_shapes_remain_backward_compatible(self):
        paid = core.subscription_public(self.paid_record(), FIXED_NOW)
        self.assertEqual(paid["status"], "active")
        self.assertEqual(paid["planId"], "basic")
        self.assertEqual(paid["entitlementTier"], "basic")
        self.assertEqual(paid["expiresAt"], "2025-02-04T12:00:00Z")
        self.assertEqual(paid["lastPaymentId"], "pay_preserved")
        self.assertEqual(paid["paymentCount"], 3)
        self.assertEqual(paid.get("source"), "paid", "Task 3 must add paid source metadata")
        self.assertEqual(paid.get("validityType"), "finite", "Task 3 must add finite paid validity metadata")
        self.assertFalse(paid.get("lifetime"), "Task 3 must mark paid access as non-lifetime")
        self.assertIsNone(paid.get("grantId"))
        self.assertFalse(paid.get("complimentary"), "Task 3 must mark paid access as non-complimentary")

        boundary = core.subscription_public(self.paid_record(expires_at=FIXED_NOW), FIXED_NOW)
        self.assertEqual(boundary["status"], "expired")
        self.assertEqual(boundary["source"], "paid")

        inactive = core.subscription_public(None, FIXED_NOW)
        self.assertEqual(inactive["status"], "inactive")
        self.assertIsNone(inactive["planId"])
        self.assertIsNone(inactive["expiresAt"])
        self.assertIsNone(inactive["source"])
        self.assertFalse(inactive["lifetime"])
        self.assertIsNone(inactive["grantId"])
        self.assertFalse(inactive["complimentary"])

    # **Validates: Requirements 10.1-10.7, 12.4, 18.4, 20.2**
    def test_resolver_covers_every_decision_row_and_strict_time_boundary(self):
        resolve = self.require_domain_api("resolve_effective_entitlement")
        active_paid = self.paid_record()
        expired_paid = self.paid_record(expires_at=FIXED_NOW)
        finite = self.grant_record()
        lifetime = self.grant_record(validityType="lifetime", presetDays=None, expiresAt=None, lifetime=True)
        expired_grant = self.grant_record(expiresAt=FIXED_NOW)
        revoked = self.grant_record(
            storedStatus="revoked",
            endedAt=FIXED_NOW,
            endReason="Removed",
            revokedBy={"uid": "admin-uid", "email": "admin@example.com"},
        )
        superseded = self.grant_record(
            storedStatus="superseded",
            endedAt=FIXED_NOW,
            endReason="Replaced",
            supersededByGrantId="grant_fedcba9876543210",
            supersededBy={"uid": "admin-uid", "email": "admin@example.com"},
        )

        for grant in (finite, lifetime):
            for paid in (active_paid, expired_paid, None):
                with self.subTest(row="complimentary priority", grant=grant["validityType"], paid=paid):
                    result = resolve(paid, grant, FIXED_NOW)
                    self.assertEqual(result["effectiveEntitlement"]["source"], "complimentary")
                    self.assertEqual(result["effectiveEntitlement"]["planId"], "pro")

        for grant in (None, expired_grant, revoked, superseded):
            with self.subTest(row="paid restoration", grant=grant):
                result = resolve(active_paid, grant, FIXED_NOW)
                self.assertEqual(result["effectiveEntitlement"]["source"], "paid")
                self.assertEqual(result["paidFallback"]["source"], "paid")

        for grant in (None, expired_grant, revoked, superseded):
            for paid in (None, expired_paid):
                with self.subTest(row="inactive", grant=grant, paid=paid):
                    result = resolve(paid, grant, FIXED_NOW)
                    self.assertIn(result["effectiveEntitlement"]["status"], ("inactive", "expired"))
                    self.assertIsNone(result["effectiveEntitlement"]["source"])

        first = resolve(active_paid, finite, FIXED_NOW)
        second = resolve(deepcopy(active_paid), deepcopy(finite), FIXED_NOW)
        self.assertEqual(first, second)

    # **Validates: Requirements 10.1, 10.3-10.4, 12.7, 17.3, 19.2, 19.5**
    def test_malformed_paid_grant_and_pointer_records_fail_closed(self):
        resolve = self.require_domain_api("resolve_effective_entitlement")
        validate_pointer = self.require_domain_api("validate_complimentary_pointer")
        malformed_paid = self.paid_record(expiresAt="not-a-datetime")
        malformed_grant = self.grant_record(planSnapshot={"id": "pro"})

        # A separately valid active grant retains priority even when paid fallback is unusable.
        result = resolve(malformed_paid, self.grant_record(), FIXED_NOW)
        self.assertEqual(result["effectiveEntitlement"]["source"], "complimentary")
        self.assertIsNone(result["paidFallback"])

        self.assert_billing_error("billing_data_inconsistent", resolve, malformed_paid, None, FIXED_NOW)
        self.assert_billing_error("billing_data_inconsistent", resolve, self.paid_record(), malformed_grant, FIXED_NOW)
        self.assert_billing_error(
            "billing_data_inconsistent",
            validate_pointer,
            {"targetUid": "other-uid", "activeGrantId": self.grant_record()["id"], "revision": 1, "schemaVersion": 1},
            "target-uid",
        )
        self.assert_billing_error(
            "billing_data_inconsistent",
            validate_pointer,
            {"targetUid": "target-uid", "activeGrantId": 123, "revision": -1, "schemaVersion": 1},
            "target-uid",
        )


class ComplimentaryDomainGeneratedProperties(ComplimentaryDomainFixtures, unittest.TestCase):
    """Deterministic generated properties; no external property package is used."""

    def run_generated(self, seed, count, generate, check):
        rng = random.Random(seed)
        for iteration in range(count):
            case = generate(rng, iteration)
            try:
                check(case)
            except Exception as error:
                self.fail(
                    "seed=%r iteration=%d counterexample=%r error=%r"
                    % (seed, iteration, case, error)
                )

    # **Validates: Requirements 10.7, 19.2**
    def test_property_resolver_determinism_fixed_seed_10407(self):
        resolve = self.require_domain_api("resolve_effective_entitlement")
        seed = 10407

        def generate(rng, _iteration):
            paid_delta = rng.randint(-30 * 86400, 30 * 86400)
            grant_kind = rng.choice(("absent", "finite", "lifetime", "revoked", "superseded"))
            paid = None if rng.random() < 0.25 else self.paid_record(expires_at=FIXED_NOW + timedelta(seconds=paid_delta))
            if grant_kind == "absent":
                grant = None
            elif grant_kind == "lifetime":
                grant = self.grant_record(validityType="lifetime", presetDays=None, expiresAt=None, lifetime=True)
            elif grant_kind == "revoked":
                grant = self.grant_record(storedStatus="revoked", endedAt=FIXED_NOW, endReason="Removed", revokedBy={"uid": "admin-uid", "email": "admin@example.com"})
            elif grant_kind == "superseded":
                grant = self.grant_record(storedStatus="superseded", endedAt=FIXED_NOW, endReason="Replaced", supersededByGrantId="grant_fedcba9876543210", supersededBy={"uid": "admin-uid", "email": "admin@example.com"})
            else:
                grant = self.grant_record(expiresAt=FIXED_NOW + timedelta(seconds=rng.randint(-86400, 30 * 86400)))
            return paid, grant

        def check(case):
            paid, grant = case
            self.assertEqual(
                resolve(deepcopy(paid), deepcopy(grant), FIXED_NOW),
                resolve(deepcopy(paid), deepcopy(grant), FIXED_NOW),
            )

        self.run_generated(seed, 100, generate, check)

    # **Validates: Requirements 10.1-10.2, 10.6, 20.2**
    def test_property_complimentary_priority_fixed_seed_1001(self):
        resolve = self.require_domain_api("resolve_effective_entitlement")
        seed = 1001

        def generate(rng, iteration):
            paid = None if iteration % 5 == 0 else self.paid_record(
                expires_at=FIXED_NOW + timedelta(seconds=rng.randint(-10 * 86400, 40 * 86400)),
                planId=rng.choice(("basic", "pro", "elite")),
                entitlementTier=rng.choice(("basic", "pro", "elite")),
            )
            if rng.choice((True, False)):
                grant = self.grant_record(expiresAt=FIXED_NOW + timedelta(seconds=rng.randint(1, 40 * 86400)))
            else:
                grant = self.grant_record(validityType="lifetime", presetDays=None, expiresAt=None, lifetime=True)
            return paid, grant

        def check(case):
            paid, grant = case
            result = resolve(paid, grant, FIXED_NOW)
            self.assertEqual(result["effectiveEntitlement"]["source"], "complimentary")
            self.assertEqual(result["effectiveEntitlement"]["grantId"], grant["id"])

        self.run_generated(seed, 100, generate, check)

    # **Validates: Requirements 10.3-10.4, 20.2**
    def test_property_paid_restoration_is_strictly_after_now_fixed_seed_1003(self):
        resolve = self.require_domain_api("resolve_effective_entitlement")
        seed = 1003

        def generate(rng, iteration):
            delta = 0 if iteration == 0 else rng.randint(-30 * 86400, 30 * 86400)
            grant = rng.choice((
                None,
                self.grant_record(expiresAt=FIXED_NOW),
                self.grant_record(storedStatus="revoked", endedAt=FIXED_NOW, endReason="Removed", revokedBy={"uid": "admin-uid", "email": "admin@example.com"}),
            ))
            return delta, self.paid_record(expires_at=FIXED_NOW + timedelta(seconds=delta)), grant

        def check(case):
            delta, paid, grant = case
            result = resolve(paid, grant, FIXED_NOW)
            expected_source = "paid" if delta > 0 else None
            self.assertEqual(result["effectiveEntitlement"]["source"], expected_source)

        self.run_generated(seed, 120, generate, check)

    # **Validates: Requirements 4.1, 17.1**
    def test_property_preset_duration_is_exact_fixed_seed_401(self):
        normalize = self.require_domain_api("normalize_validity")
        seed = 401

        def generate(rng, iteration):
            offset_seconds = rng.randint(-15 * 365 * 86400, 15 * 365 * 86400)
            activation = FIXED_NOW + timedelta(seconds=offset_seconds, microseconds=iteration % 997)
            return activation, rng.choice((7, 30, 90, 365))

        def check(case):
            activation, days = case
            result = normalize({"type": "preset", "days": days}, activation)
            self.assertEqual(result["expiresAt"] - result["activationAt"], timedelta(days=days))

        self.run_generated(seed, 120, generate, check)

    # **Validates: Requirements 4.3, 6.5, 10.1, 19.4**
    def test_property_lifetime_never_has_expiration_and_remains_active_fixed_seed_403(self):
        normalize = self.require_domain_api("normalize_validity")
        status = self.require_domain_api("complimentary_grant_status")
        seed = 403

        def generate(rng, iteration):
            activation = FIXED_NOW - timedelta(days=rng.randint(0, 3650), microseconds=iteration)
            evaluation = activation + timedelta(days=rng.randint(0, 36500), seconds=rng.randint(0, 86399))
            return activation, evaluation

        def check(case):
            activation, evaluation = case
            validity = normalize({"type": "lifetime"}, activation)
            grant = self.grant_record(**validity)
            self.assertIsNone(validity["expiresAt"])
            self.assertTrue(validity["lifetime"])
            self.assertEqual(status(grant, evaluation), "active")

        self.run_generated(seed, 100, generate, check)

    # **Validates: Requirements 9.2-9.3, 10.2, 10.6, 17.2, 20.2**
    def test_property_resolver_preserves_paid_records_byte_for_byte_fixed_seed_902(self):
        resolve = self.require_domain_api("resolve_effective_entitlement")
        seed = 902

        def generate(rng, iteration):
            paid = self.paid_record(
                expires_at=FIXED_NOW + timedelta(seconds=rng.randint(-30 * 86400, 30 * 86400)),
                paymentCount=rng.randint(1, 500),
                lastPaymentId="pay_%d_%d" % (iteration, rng.getrandbits(32)),
            )
            grant = self.grant_record(
                expiresAt=FIXED_NOW + timedelta(seconds=rng.randint(1, 30 * 86400))
            )
            return paid, grant

        def check(case):
            paid, grant = case
            paid_before = deepcopy(paid)
            grant_before = deepcopy(grant)
            resolve(paid, grant, FIXED_NOW)
            self.assertEqual(paid, paid_before)
            self.assertEqual(grant, grant_before)

        self.run_generated(seed, 100, generate, check)


if __name__ == "__main__":
    unittest.main()
