"""Regression-first contract for in-memory complimentary billing transitions.

Task 4 intentionally specifies the ``ComplimentaryBillingService`` and matching
``MemoryBillingStore`` semantics before Task 5 implements them.  The generated
properties use only seeded standard-library randomness and report the first
counterexample with its seed.
"""

from __future__ import annotations

import hashlib
import random
import unittest
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import billing_core as core


UTC = timezone.utc
FIXED_NOW = datetime(2025, 2, 1, 9, 30, tzinfo=UTC)
CURSOR_KEY = b"task-4-memory-cursor-signing-key"
ACTOR = {"uid": "admin-uid", "email": "admin@example.com"}
TARGET_EMAIL = "person@example.com"
TARGET_UID = "target-uid"


class MutableClock:
    def __init__(self, value=FIXED_NOW):
        self.value = value

    def __call__(self):
        return self.value

    def advance(self, **delta):
        self.value += timedelta(**delta)


@dataclass
class FirebaseUser:
    uid: str
    email: str | None
    email_verified: bool = True
    display_name: str | None = None
    disabled: bool = False


class InjectableFirebaseAdminLookup:
    """Small Firebase Admin seam: exact normalized email in, Auth record out."""

    def __init__(self):
        self.users = {}
        self.calls = []

    def add(self, user):
        self.users[user.email.lower()] = user
        return user

    def __call__(self, normalized_email):
        self.calls.append(normalized_email)
        return self.users.get(normalized_email)


class ComplimentaryMemoryFixtures:
    def setUp(self):
        self.clock = MutableClock()
        self.store = core.MemoryBillingStore()
        self.catalog = core.StoredPlanCatalog(self.store)
        self.firebase_lookup = InjectableFirebaseAdminLookup()
        self.target = self.firebase_lookup.add(
            FirebaseUser(TARGET_UID, TARGET_EMAIL, display_name="Person")
        )
        self.firebase_lookup.add(
            FirebaseUser("second-uid", "second@example.com", display_name="Second")
        )
        self.firebase_lookup.add(
            FirebaseUser("disabled-uid", "disabled@example.com", disabled=True)
        )
        self.firebase_lookup.add(
            FirebaseUser("unverified-uid", "unverified@example.com", email_verified=False)
        )
        self._seed_plans()
        self._seed_payment_domains()
        self.payment_domain_before = self.payment_domain_snapshot()

        service_type = getattr(core, "ComplimentaryBillingService", None)
        self.service = None
        if service_type is not None:
            self.service = service_type(
                store=self.store,
                catalog=self.catalog,
                firebase_user_lookup=self.firebase_lookup,
                clock=self.clock,
                cursor_signing_key=CURSOR_KEY,
                cursor_key_id="test-v1",
            )

    def _seed_plans(self):
        self.store.put_plan(
            {
                "id": "basic",
                "name": "Basic",
                "amountPaise": 49900,
                "durationDays": 30,
                "features": ["Trading dashboard"],
                "active": True,
                "sortOrder": 0,
                "entitlementTier": "basic",
            },
            create_only=True,
        )
        self.store.put_plan(
            {
                "id": "pro",
                "name": "Pro",
                "amountPaise": 99900,
                "durationDays": 90,
                "features": ["Advanced analytics", "Priority support"],
                "active": True,
                "sortOrder": 1,
                "entitlementTier": "pro",
            },
            create_only=True,
        )
        self.store.put_plan(
            {
                "id": "retired",
                "name": "Retired",
                "amountPaise": 19900,
                "durationDays": 7,
                "features": ["Historical feature"],
                "active": False,
                "sortOrder": 2,
                "entitlementTier": "basic",
            },
            create_only=True,
        )

    def _seed_payment_domains(self):
        paid = {
            "userId": TARGET_UID,
            "status": "active",
            "planId": "basic",
            "entitlementTier": "basic",
            "startsAt": FIXED_NOW - timedelta(days=5),
            "expiresAt": FIXED_NOW + timedelta(days=20),
            "updatedAt": FIXED_NOW - timedelta(days=1),
            "lastPaymentId": "pay_preserved",
            "paymentCount": 2,
        }
        self.store.subscriptions[TARGET_UID] = paid
        self.store.orders["order-preserved"] = {
            "id": "order-preserved",
            "userId": TARGET_UID,
            "status": "paid",
            "amountPaise": 49900,
            "couponCode": "KEEP10",
        }
        self.store.payments["pay_preserved"] = {
            "id": "pay_preserved",
            "userId": TARGET_UID,
            "provider": "razorpay",
            "providerOrderId": "provider-order-preserved",
            "status": "captured",
            "amountPaise": 44910,
            "discountPaise": 4990,
            "createdAt": FIXED_NOW - timedelta(days=5),
        }
        self.store.coupons["KEEP10"] = {
            "code": "KEEP10",
            "active": True,
            "reservedCount": 0,
            "usedCount": 1,
        }
        self.store.user_coupon[(TARGET_UID, "KEEP10")] = {
            "reservedCount": 0,
            "usedCount": 1,
        }
        self.store.redemptions["order-preserved"] = {
            "id": "order-preserved",
            "userId": TARGET_UID,
            "couponCode": "KEEP10",
            "providerPaymentId": "pay_preserved",
        }

    def require_service(self):
        if self.service is None:
            self.fail("Task 5 missing billing_core.ComplimentaryBillingService")
        return self.service

    def require_store_collections(self):
        expected = (
            "complimentary_grants",
            "complimentary_users",
            "complimentary_operations",
            "complimentary_audit",
        )
        for name in expected:
            self.assertTrue(
                hasattr(self.store, name),
                "Task 5 missing MemoryBillingStore.%s" % name,
            )
        return tuple(getattr(self.store, name) for name in expected)

    def payment_domain_snapshot(self):
        return deepcopy(
            {
                "subscriptions": self.store.subscriptions,
                "orders": self.store.orders,
                "order_by_provider": self.store.order_by_provider,
                "payments": self.store.payments,
                "failed_payments": self.store.failed_payments,
                "coupons": self.store.coupons,
                "user_coupon": self.store.user_coupon,
                "redemptions": self.store.redemptions,
                "events": self.store.events,
            }
        )

    def assert_payment_domains_unchanged(self, before=None):
        self.assertEqual(self.payment_domain_snapshot(), before or self.payment_domain_before)

    def assert_billing_error(self, code, function, *args, **kwargs):
        with self.assertRaises(core.BillingError) as raised:
            function(*args, **kwargs)
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def create_grant(
        self,
        *,
        email=TARGET_EMAIL,
        plan_id="pro",
        validity=None,
        reason="Customer support resolution",
        key="grant-operation-0001",
    ):
        return self.require_service().create_grant(
            actor=deepcopy(ACTOR),
            target_email=email,
            plan_id=plan_id,
            validity=validity or {"type": "preset", "days": 30},
            reason=reason,
            idempotency_key=key,
        )

    def revoke_grant(self, grant_id, *, key="revoke-operation-0001", reason="Access ended"):
        return self.require_service().revoke_grant(
            actor=deepcopy(ACTOR),
            grant_id=grant_id,
            reason=reason,
            idempotency_key=key,
        )

    @staticmethod
    def operation_id(operation_type, key):
        value = ACTOR["uid"] + "\0" + operation_type + "\0" + key
        return hashlib.sha256(value.encode("utf-8")).hexdigest()

    @staticmethod
    def contains_value(value, expected):
        if isinstance(value, dict):
            return any(
                item == expected or ComplimentaryMemoryFixtures.contains_value(item, expected)
                for item in value.values()
            )
        if isinstance(value, (list, tuple, set)):
            return any(
                item == expected or ComplimentaryMemoryFixtures.contains_value(item, expected)
                for item in value
            )
        return False


class ComplimentaryMemoryServiceContract(ComplimentaryMemoryFixtures, unittest.TestCase):
    """Focused examples for lookup, transitions, persistence, and preservation."""

    # **Validates: Requirements 12.1-12.3, 16.5-16.7**
    def test_memory_store_declares_isolated_grant_pointer_operation_and_audit_domains(self):
        grants, users, operations, audit = self.require_store_collections()
        self.assertEqual(grants, {})
        self.assertEqual(users, {})
        self.assertEqual(operations, {})
        self.assertEqual(audit, {})
        self.assert_payment_domains_unchanged()

    # **Validates: Requirements 2.1-2.4, 9.1, 11.2, 17.1, 20.1**
    def test_injectable_firebase_admin_lookup_is_exact_and_reports_ineligible_targets(self):
        service = self.require_service()

        lookup = service.lookup_user("  Person@Example.COM  ")
        self.assertEqual(self.firebase_lookup.calls, [TARGET_EMAIL])
        self.assertEqual(
            lookup["user"],
            {
                "uid": TARGET_UID,
                "email": TARGET_EMAIL,
                "emailVerified": True,
                "displayName": "Person",
                "disabled": False,
                "grantEligible": True,
            },
        )

        self.assert_billing_error("user_not_found", service.lookup_user, "unknown@example.com")
        disabled = service.lookup_user("disabled@example.com")
        unverified = service.lookup_user("unverified@example.com")
        self.assertFalse(disabled["user"]["grantEligible"])
        self.assertTrue(disabled["user"]["disabled"])
        self.assertFalse(unverified["user"]["grantEligible"])
        self.assertFalse(unverified["user"]["emailVerified"])
        self.assert_payment_domains_unchanged()

    # **Validates: Requirements 3.1-3.5, 5.1, 14.4, 17.1-17.2, 18.5**
    def test_create_uses_only_the_current_active_canonical_plan_and_freezes_its_snapshot(self):
        active_ids = [plan["id"] for plan in self.catalog.all()]
        self.assertEqual(active_ids, ["basic", "pro"])
        self.assertNotIn("retired", active_ids)
        self.assert_billing_error(
            "plan_inactive",
            self.create_grant,
            plan_id="retired",
            key="inactive-plan-key-01",
        )

        result = self.create_grant()
        stored = self.store.complimentary_grants[result["grant"]["id"]]
        self.assertEqual(
            stored["planSnapshot"],
            {
                "id": "pro",
                "name": "Pro",
                "entitlementTier": "pro",
                "features": ["Advanced analytics", "Priority support"],
                "revision": 1,
            },
        )
        for forbidden in ("amountPaise", "durationDays", "currency", "active", "sortOrder"):
            self.assertNotIn(forbidden, stored["planSnapshot"])

        self.store.plans["pro"]["name"] = "Edited later"
        self.store.plans["pro"]["features"].append("Later feature")
        self.store.plans["pro"]["revision"] += 1
        self.assertEqual(stored["planSnapshot"]["name"], "Pro")
        self.assertNotIn("Later feature", stored["planSnapshot"]["features"])
        self.assert_payment_domains_unchanged()

    # **Validates: Requirements 2.2, 9.1, 9.4, 10.1, 10.7, 13.3**
    def test_lookup_and_create_return_effective_and_preserved_paid_fallback_summaries(self):
        service = self.require_service()
        lookup = service.lookup_user(TARGET_EMAIL)
        self.assertEqual(lookup["effectiveEntitlement"]["source"], "paid")
        self.assertEqual(lookup["effectiveEntitlement"]["planId"], "basic")
        self.assertEqual(lookup["paidFallback"], lookup["effectiveEntitlement"])

        created = self.create_grant(validity={"type": "lifetime"})
        self.assertEqual(created["effectiveEntitlement"]["source"], "complimentary")
        self.assertEqual(created["effectiveEntitlement"]["planId"], "pro")
        self.assertTrue(created["effectiveEntitlement"]["lifetime"])
        self.assertEqual(created["paidFallback"]["source"], "paid")
        self.assertEqual(created["paidFallback"]["planId"], "basic")

        selected_again = service.lookup_user(TARGET_EMAIL)
        self.assertEqual(selected_again["effectiveEntitlement"], created["effectiveEntitlement"])
        self.assertEqual(selected_again["paidFallback"], created["paidFallback"])
        self.assert_payment_domains_unchanged()

    # **Validates: Requirements 5.1-5.2, 12.1-12.3, 16.1, 16.5-16.7, 17.2**
    def test_create_persists_exact_grant_pointer_hashed_operation_and_append_only_audit_shapes(self):
        self.require_store_collections()
        raw_key = "grant-operation-0001"
        result = self.create_grant(key=raw_key)
        grant_id = result["grant"]["id"]
        grant = self.store.complimentary_grants[grant_id]
        pointer = self.store.complimentary_users[TARGET_UID]
        operation_id = self.operation_id("grant", raw_key)
        operation = self.store.complimentary_operations[operation_id]
        events = list(self.store.complimentary_audit.values())

        self.assertEqual(set(grant), {
            "id", "targetUid", "targetEmail", "targetEmailNormalized", "targetDisplayName",
            "planId", "planSnapshot", "validityType", "presetDays", "activationAt", "expiresAt",
            "lifetime", "storedStatus", "createdAt", "updatedAt", "createdBy", "reason", "endedAt",
            "endReason", "revokedBy", "supersededByGrantId", "supersededBy", "creationOperationId",
            "schemaVersion",
        })
        self.assertEqual(grant["id"], grant_id)
        self.assertEqual(grant["targetUid"], TARGET_UID)
        self.assertEqual(grant["targetEmail"], TARGET_EMAIL)
        self.assertEqual(grant["createdBy"], ACTOR)
        self.assertEqual(grant["activationAt"], FIXED_NOW)
        self.assertEqual(grant["createdAt"], FIXED_NOW)
        self.assertEqual(grant["storedStatus"], "active")
        self.assertEqual(grant["creationOperationId"], operation_id)
        core.validate_complimentary_grant(grant)

        self.assertEqual(set(pointer), {"targetUid", "activeGrantId", "revision", "updatedAt", "schemaVersion"})
        self.assertEqual(pointer["targetUid"], TARGET_UID)
        self.assertEqual(pointer["activeGrantId"], grant_id)
        self.assertEqual(pointer["revision"], 1)
        self.assertEqual(pointer["updatedAt"], FIXED_NOW)
        core.validate_complimentary_pointer(pointer, TARGET_UID)

        self.assertEqual(set(operation), {
            "actorUid", "operationType", "idempotencyKeyHash", "payloadHash", "status",
            "targetUid", "grantId", "responseSnapshot", "createdAt", "schemaVersion",
        })
        self.assertEqual(operation["actorUid"], ACTOR["uid"])
        self.assertEqual(operation["operationType"], "grant")
        self.assertEqual(operation["idempotencyKeyHash"], hashlib.sha256(raw_key.encode("utf-8")).hexdigest())
        self.assertEqual(len(operation["payloadHash"]), 64)
        self.assertEqual(operation["responseSnapshot"], result)
        self.assertFalse(operation["responseSnapshot"]["duplicate"])
        self.assertFalse(self.contains_value(operation, raw_key), "raw idempotency keys must never be stored")

        self.assertEqual(len(events), 1)
        self.assertEqual(set(events[0]), {
            "eventId", "eventType", "grantId", "targetUid", "actor", "replacementGrantId",
            "reason", "occurredAt", "operationId", "schemaVersion",
        })
        self.assertEqual(events[0]["eventType"], "granted")
        self.assertEqual(events[0]["grantId"], grant_id)
        self.assertEqual(events[0]["operationId"], operation_id)
        self.assert_payment_domains_unchanged()

    # **Validates: Requirements 5.4, 8.2-8.4, 10.3-10.5, 12.3, 16.4-16.7**
    def test_supersede_and_revoke_preserve_immutable_history_and_append_terminal_audits(self):
        first = self.create_grant(key="supersede-first-001")
        first_id = first["grant"]["id"]
        immutable_before = deepcopy({
            key: self.store.complimentary_grants[first_id][key]
            for key in (
                "id", "targetUid", "targetEmail", "targetEmailNormalized", "targetDisplayName",
                "planId", "planSnapshot", "validityType", "presetDays", "activationAt", "createdAt",
                "createdBy", "creationOperationId", "schemaVersion",
            )
        })

        self.clock.advance(seconds=1)
        second = self.create_grant(plan_id="basic", key="supersede-second-01")
        second_id = second["grant"]["id"]
        old = self.store.complimentary_grants[first_id]
        pointer = self.store.complimentary_users[TARGET_UID]
        self.assertEqual(old["storedStatus"], "superseded")
        self.assertEqual(old["endedAt"], self.clock.value)
        self.assertEqual(old["supersededByGrantId"], second_id)
        self.assertEqual(old["supersededBy"], ACTOR)
        self.assertEqual(
            {key: old[key] for key in immutable_before},
            immutable_before,
        )
        self.assertEqual(pointer["activeGrantId"], second_id)
        self.assertEqual(pointer["revision"], 2)
        self.assertEqual(second["effectiveEntitlement"]["grantId"], second_id)

        self.clock.advance(seconds=1)
        revoked = self.revoke_grant(second_id)
        ended = self.store.complimentary_grants[second_id]
        pointer = self.store.complimentary_users[TARGET_UID]
        self.assertEqual(ended["storedStatus"], "revoked")
        self.assertEqual(ended["endedAt"], self.clock.value)
        self.assertEqual(ended["revokedBy"], ACTOR)
        self.assertIsNone(pointer["activeGrantId"])
        self.assertEqual(pointer["revision"], 3)
        self.assertEqual(revoked["effectiveEntitlement"]["source"], "paid")
        self.assertEqual(revoked["paidFallback"]["source"], "paid")

        event_types = [event["eventType"] for event in self.store.complimentary_audit.values()]
        self.assertEqual(event_types.count("granted"), 2)
        self.assertEqual(event_types.count("superseded"), 1)
        self.assertEqual(event_types.count("revoked"), 1)
        self.assertEqual(len(self.store.complimentary_grants), 2, "terminal grants remain append-only history")
        self.assert_payment_domains_unchanged()

    # **Validates: Requirements 5.3, 8.4, 10.3-10.4, 12.4, 20.2**
    def test_finite_expiration_is_computed_on_read_without_cleanup_or_pointer_mutation(self):
        created = self.create_grant(validity={"type": "preset", "days": 7})
        grant_id = created["grant"]["id"]
        pointer_before = deepcopy(self.store.complimentary_users[TARGET_UID])
        audit_before = deepcopy(self.store.complimentary_audit)

        self.clock.advance(days=7)
        lookup = self.require_service().lookup_user(TARGET_EMAIL)
        listed = self.require_service().list_grants({"status": "expired", "limit": 25})

        self.assertEqual(lookup["effectiveEntitlement"]["source"], "paid")
        self.assertEqual(lookup["paidFallback"]["source"], "paid")
        self.assertEqual([grant["id"] for grant in listed["grants"]], [grant_id])
        self.assertEqual(listed["grants"][0]["status"], "expired")
        self.assertEqual(self.store.complimentary_grants[grant_id]["storedStatus"], "active")
        self.assertEqual(self.store.complimentary_users[TARGET_UID], pointer_before)
        self.assertEqual(self.store.complimentary_audit, audit_before)
        self.assert_payment_domains_unchanged()

    # **Validates: Requirements 7.1-7.5, 12.4, 13.3, 14.3**
    def test_list_supports_exact_filters_stable_tie_break_pagination_and_fixed_as_of(self):
        first = self.create_grant(key="list-first-key-001")
        second = self.create_grant(
            email="second@example.com", plan_id="basic", key="list-second-key-01"
        )
        same_time_ids = sorted([first["grant"]["id"], second["grant"]["id"]], reverse=True)

        self.clock.advance(seconds=1)
        third = self.create_grant(plan_id="basic", key="list-third-key-001")
        first_page = self.require_service().list_grants({"limit": 2})
        self.assertEqual(first_page["grants"][0]["id"], third["grant"]["id"])
        self.assertEqual(first_page["grants"][1]["id"], same_time_ids[0])
        self.assertIsNotNone(first_page["page"]["nextCursor"])
        as_of = first_page["page"]["asOf"]

        self.clock.advance(days=40)
        second_page = self.require_service().list_grants(
            {"limit": 2, "cursor": first_page["page"]["nextCursor"]}
        )
        self.assertEqual([grant["id"] for grant in second_page["grants"]], [same_time_ids[1]])
        self.assertEqual(second_page["page"]["asOf"], as_of)
        self.assertIsNone(second_page["page"]["nextCursor"])

        by_email = self.require_service().list_grants({"email": " PERSON@EXAMPLE.COM ", "limit": 25})
        self.assertEqual({grant["targetEmail"] for grant in by_email["grants"]}, {TARGET_EMAIL})
        by_plan = self.require_service().list_grants({"planId": "pro", "limit": 25})
        self.assertEqual({grant["planId"] for grant in by_plan["grants"]}, {"pro"})
        expired = self.require_service().list_grants({"status": "expired", "limit": 25})
        self.assertEqual(len(expired["grants"]), 2)
        superseded = self.require_service().list_grants({"status": "superseded", "limit": 25})
        self.assertEqual([grant["id"] for grant in superseded["grants"]], [first["grant"]["id"]])
        self.assert_payment_domains_unchanged()

    # **Validates: Requirements 8.4, 13.2-13.4, 16.1-16.2, 20.3**
    def test_identical_grant_and_revoke_replays_return_snapshots_without_new_writes(self):
        raw_grant_key = "replay-grant-key-01"
        first = self.create_grant(key=raw_grant_key)
        state_after_first = deepcopy((
            self.store.complimentary_grants,
            self.store.complimentary_users,
            self.store.complimentary_operations,
            self.store.complimentary_audit,
        ))
        replay = self.create_grant(key=raw_grant_key)
        self.assertTrue(replay["duplicate"])
        self.assertEqual({**replay, "duplicate": False}, first)
        self.assertEqual(
            (
                self.store.complimentary_grants,
                self.store.complimentary_users,
                self.store.complimentary_operations,
                self.store.complimentary_audit,
            ),
            state_after_first,
        )

        before_conflict = deepcopy(state_after_first)
        self.assert_billing_error(
            "idempotency_conflict",
            self.create_grant,
            key=raw_grant_key,
            plan_id="basic",
        )
        self.assertEqual(
            (
                self.store.complimentary_grants,
                self.store.complimentary_users,
                self.store.complimentary_operations,
                self.store.complimentary_audit,
            ),
            before_conflict,
        )

        grant_id = first["grant"]["id"]
        revoked = self.revoke_grant(grant_id, key="replay-revoke-key-1")
        state_after_revoke = deepcopy((
            self.store.complimentary_grants,
            self.store.complimentary_users,
            self.store.complimentary_operations,
            self.store.complimentary_audit,
        ))
        revoke_replay = self.revoke_grant(grant_id, key="replay-revoke-key-1")
        self.assertTrue(revoke_replay["duplicate"])
        self.assertEqual({**revoke_replay, "duplicate": False}, revoked)
        self.assertEqual(
            (
                self.store.complimentary_grants,
                self.store.complimentary_users,
                self.store.complimentary_operations,
                self.store.complimentary_audit,
            ),
            state_after_revoke,
        )
        self.assert_billing_error(
            "grant_state_conflict",
            self.revoke_grant,
            grant_id,
            key="different-revoke-key-1",
        )
        self.assert_payment_domains_unchanged()

    # **Validates: Requirements 2.4, 3.3, 5.5, 9.5, 14.4-14.5, 17.1**
    def test_stale_target_plan_persistence_failure_and_malformed_state_are_atomic(self):
        service = self.require_service()
        service.lookup_user(TARGET_EMAIL)
        self.target.disabled = True
        before = self.payment_domain_snapshot()
        self.assert_billing_error(
            "target_disabled",
            self.create_grant,
            key="stale-target-key-01",
        )
        self.assertEqual(self.firebase_lookup.calls[-1], TARGET_EMAIL)
        self.assertEqual(len(self.firebase_lookup.calls), 2, "create must repeat Firebase Admin lookup")
        self.assert_payment_domains_unchanged(before)
        self.target.disabled = False

        self.store.deactivate_plan("pro")
        self.assert_billing_error(
            "plan_inactive",
            self.create_grant,
            key="stale-plan-key-0001",
        )
        self.store.plans["pro"]["active"] = True

        complimentary_before = deepcopy((
            self.store.complimentary_grants,
            self.store.complimentary_users,
            self.store.complimentary_operations,
            self.store.complimentary_audit,
        ))
        with patch.object(
            self.store,
            "create_complimentary_grant",
            side_effect=RuntimeError("sensitive-persistence-detail"),
        ):
            error = self.assert_billing_error(
                "persistence_unavailable",
                self.create_grant,
                key="persistence-key-001",
            )
        self.assertNotIn("sensitive-persistence-detail", error.message)
        self.assertEqual(
            (
                self.store.complimentary_grants,
                self.store.complimentary_users,
                self.store.complimentary_operations,
                self.store.complimentary_audit,
            ),
            complimentary_before,
        )

        self.store.subscriptions[TARGET_UID]["expiresAt"] = "malformed"
        malformed_before = self.payment_domain_snapshot()
        self.assert_billing_error(
            "billing_data_inconsistent",
            self.create_grant,
            key="malformed-paid-key-1",
        )
        self.assert_payment_domains_unchanged(malformed_before)

    # **Validates: Requirements 5.2, 9.2-9.3, 10.2, 12.2, 18.2, 18.6, 20.2**
    def test_create_supersede_revoke_and_expiry_have_zero_payment_domain_side_effects(self):
        before = self.payment_domain_snapshot()
        first = self.create_grant(key="zero-side-effect-001")
        self.clock.advance(seconds=1)
        second = self.create_grant(key="zero-side-effect-002")
        self.clock.advance(seconds=1)
        self.revoke_grant(second["grant"]["id"], key="zero-side-revoke-01")
        self.clock.advance(days=365)
        self.require_service().lookup_user(TARGET_EMAIL)

        self.assert_payment_domains_unchanged(before)
        self.assertEqual(len(self.store.complimentary_grants), 2)
        for grant in self.store.complimentary_grants.values():
            for forbidden in (
                "amountPaise", "currency", "paymentId", "providerPaymentId", "orderId",
                "couponCode", "invoiceId", "paymentCount",
            ):
                self.assertNotIn(forbidden, grant)
        self.assertNotEqual(first["grant"]["id"], second["grant"]["id"])


class ComplimentaryMemoryGeneratedProperties(ComplimentaryMemoryFixtures, unittest.TestCase):
    """Seeded transition properties for Task 5's eventual in-memory semantics."""

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

    # **Validates: Requirements 5.4, 8.2-8.4, 10.5, 16.3-16.4, 20.3**
    def test_property_generated_sequences_have_at_most_one_effective_active_grant_fixed_seed_51604(self):
        self.require_service()
        seed = 51604

        def generate(rng, iteration):
            return [rng.choice(("grant", "grant", "revoke", "read")) for _ in range(12 + iteration % 9)]

        def check(actions):
            current_id = None
            for step, action in enumerate(actions):
                if action == "grant":
                    response = self.create_grant(
                        plan_id="pro" if step % 2 else "basic",
                        validity={"type": "lifetime"},
                        key="generated-grant-%04d-%04d" % (len(self.store.complimentary_operations), step),
                    )
                    current_id = response["grant"]["id"]
                elif action == "revoke" and current_id is not None:
                    try:
                        self.revoke_grant(
                            current_id,
                            key="generated-revoke-%04d-%04d" % (len(self.store.complimentary_operations), step),
                        )
                    except core.BillingError as error:
                        self.assertEqual(error.code, "grant_state_conflict")
                    current_id = self.store.complimentary_users[TARGET_UID]["activeGrantId"]
                else:
                    self.require_service().lookup_user(TARGET_EMAIL)

                active = [
                    grant for grant in self.store.complimentary_grants.values()
                    if grant["targetUid"] == TARGET_UID
                    and core.complimentary_grant_status(grant, self.clock.value) == "active"
                ]
                pointer = self.store.complimentary_users.get(TARGET_UID)
                self.assertLessEqual(len(active), 1)
                self.assertEqual(pointer["activeGrantId"] if pointer else None, active[0]["id"] if active else None)
                self.assert_payment_domains_unchanged()

        self.run_generated(seed, 32, generate, check)

    # **Validates: Requirements 9.2-9.3, 10.2, 16.1-16.2, 18.2, 20.3**
    def test_property_generated_identical_replays_are_idempotent_and_preserve_paid_domains_fixed_seed_16102(self):
        self.require_service()
        seed = 16102

        def generate(rng, iteration):
            return {
                "planId": rng.choice(("basic", "pro")),
                "days": rng.choice((7, 30, 90, 365)),
                "reason": "generated reason %d" % rng.randint(0, 9999),
                "key": "property-replay-%04d-%08x" % (iteration, rng.getrandbits(32)),
            }

        def check(case):
            first = self.create_grant(
                plan_id=case["planId"],
                validity={"type": "preset", "days": case["days"]},
                reason=case["reason"],
                key=case["key"],
            )
            state = deepcopy((
                self.store.complimentary_grants,
                self.store.complimentary_users,
                self.store.complimentary_operations,
                self.store.complimentary_audit,
            ))
            replay = self.create_grant(
                plan_id=case["planId"],
                validity={"type": "preset", "days": case["days"]},
                reason=case["reason"],
                key=case["key"],
            )
            self.assertTrue(replay["duplicate"])
            self.assertEqual({**replay, "duplicate": False}, first)
            self.assertEqual(
                (
                    self.store.complimentary_grants,
                    self.store.complimentary_users,
                    self.store.complimentary_operations,
                    self.store.complimentary_audit,
                ),
                state,
            )

            self.assert_billing_error(
                "idempotency_conflict",
                self.create_grant,
                plan_id="pro" if case["planId"] == "basic" else "basic",
                validity={"type": "preset", "days": case["days"]},
                reason=case["reason"],
                key=case["key"],
            )
            self.assertEqual(
                (
                    self.store.complimentary_grants,
                    self.store.complimentary_users,
                    self.store.complimentary_operations,
                    self.store.complimentary_audit,
                ),
                state,
            )
            self.assert_payment_domains_unchanged()

        self.run_generated(seed, 32, generate, check)

    # **Validates: Requirements 5.2, 9.2-9.3, 10.2, 12.2, 18.2, 18.6, 20.2-20.3**
    def test_property_generated_transition_sequences_preserve_paid_domains_fixed_seed_90213(self):
        self.require_service()
        seed = 90213
        paid_before = self.payment_domain_snapshot()

        def generate(rng, iteration):
            return {
                "iteration": iteration,
                "actions": [
                    rng.choice(("grant", "grant", "revoke", "read", "advance"))
                    for _ in range(10 + iteration % 7)
                ],
                "plans": [rng.choice(("basic", "pro")) for _ in range(17)],
                "validities": [
                    rng.choice((
                        {"type": "preset", "days": 7},
                        {"type": "preset", "days": 30},
                        {"type": "lifetime"},
                    ))
                    for _ in range(17)
                ],
            }

        def check(case):
            self.store.complimentary_grants.clear()
            self.store.complimentary_users.clear()
            self.store.complimentary_operations.clear()
            self.store.complimentary_audit.clear()
            self.clock.value = FIXED_NOW
            grant_number = 0
            revoke_number = 0
            for step, action in enumerate(case["actions"]):
                if action == "grant":
                    self.create_grant(
                        plan_id=case["plans"][grant_number],
                        validity=case["validities"][grant_number],
                        key="paid-preserve-grant-%03d-%03d" % (
                            case["iteration"], grant_number,
                        ),
                    )
                    grant_number += 1
                elif action == "revoke":
                    pointer = self.store.complimentary_users.get(TARGET_UID) or {}
                    grant_id = pointer.get("activeGrantId")
                    grant = self.store.complimentary_grants.get(grant_id)
                    if grant and core.complimentary_grant_status(grant, self.clock.value) == "active":
                        self.revoke_grant(
                            grant_id,
                            key="paid-preserve-revoke-%03d-%03d" % (
                                case["iteration"], revoke_number,
                            ),
                        )
                        revoke_number += 1
                    else:
                        self.require_service().lookup_user(TARGET_EMAIL)
                elif action == "advance":
                    self.clock.advance(days=8)
                    self.require_service().lookup_user(TARGET_EMAIL)
                else:
                    self.require_service().lookup_user(TARGET_EMAIL)
                self.assertEqual(
                    self.payment_domain_snapshot(),
                    paid_before,
                    "complimentary action %r changed a payment domain" % action,
                )

        self.run_generated(seed, 40, generate, check)


if __name__ == "__main__":
    unittest.main()
