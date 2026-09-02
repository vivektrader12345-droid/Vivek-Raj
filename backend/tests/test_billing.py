import json
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

from flask import Flask

from billing_api import create_billing_blueprint
from billing_core import (
    BillingError,
    BillingService,
    EffectiveEntitlementService,
    MAX_CLIENT_FAILURE_ATTEMPTS,
    MemoryBillingStore,
    PlanCatalog,
    normalize_coupon_input,
)
from razorpay_adapter import HmacTestRazorpayAdapter, RazorpayAdapterError
from webhook_intelligence import create_webhook_blueprint


UTC = timezone.utc


class MutableClock:
    def __init__(self):
        self.value = datetime(2025, 1, 1, 12, 0, tzinfo=UTC)

    def __call__(self):
        return self.value


class BillingCoreTests(unittest.TestCase):
    def setUp(self):
        self.clock = MutableClock()
        self.store = MemoryBillingStore()
        self.provider = HmacTestRazorpayAdapter()
        self.service = BillingService(
            self.store, self.provider, PlanCatalog(), checkout_ttl_minutes=20, clock=self.clock
        )

    def coupon(self, code="SAVE10", **overrides):
        data = {
            "code": code,
            "type": "percentage",
            "value": 10,
            "active": True,
            "planIds": [],
        }
        data.update(overrides)
        value = normalize_coupon_input(data)
        self.store.put_coupon(value)
        return value

    def create_order(self, key="checkout-key-0001", plan="basic", coupon=None):
        result, duplicate = self.service.create_order("user-1", plan, coupon, key)
        return result, duplicate

    def capture(self, order, payment_id="pay_1", **overrides):
        payment = {
            "id": payment_id,
            "order_id": order["orderId"],
            "amount": order["amountPaise"],
            "currency": "INR",
            "status": "captured",
            "captured": True,
            "method": "upi",
            "bank": None,
            "wallet": None,
            "vpa": "masked@upi",
            "created_at": 1735732800,
            "fee": 100,
            "tax": 18,
        }
        payment.update(overrides)
        self.provider.payments[payment_id] = payment
        signature = self.provider.checkout_signature(order["orderId"], payment_id)
        return self.service.verify_payment("user-1", order["orderId"], payment_id, signature)

    def select_complimentary_grant(self, *, lifetime=False, expires_at=None):
        grant_id = "grant-overlap-001"
        activation = self.clock.value
        grant = {
            "id": grant_id,
            "targetUid": "user-1",
            "targetEmail": "person@example.invalid",
            "targetEmailNormalized": "person@example.invalid",
            "targetDisplayName": "Person",
            "planId": "pro",
            "planSnapshot": {
                "id": "pro",
                "name": "Pro",
                "entitlementTier": "pro",
                "features": ["Advanced analytics"],
                "revision": 1,
            },
            "validityType": "lifetime" if lifetime else "custom",
            "presetDays": None,
            "activationAt": activation,
            "expiresAt": None if lifetime else expires_at,
            "lifetime": lifetime,
            "storedStatus": "active",
            "createdAt": activation,
            "updatedAt": activation,
            "createdBy": {"uid": "admin-user", "email": "admin@example.invalid"},
            "reason": None,
            "endedAt": None,
            "endReason": None,
            "revokedBy": None,
            "supersededByGrantId": None,
            "supersededBy": None,
            "creationOperationId": "operation-overlap-001",
            "schemaVersion": 1,
        }
        self.store.complimentary_grants[grant_id] = grant
        self.store.complimentary_users["user-1"] = {
            "targetUid": "user-1",
            "activeGrantId": grant_id,
            "revision": 1,
            "updatedAt": activation,
            "schemaVersion": 1,
        }
        return grant

    def capture_from_webhook(self, order, payment_id="pay_webhook_overlap"):
        self.provider.payments[payment_id] = {
            "id": payment_id,
            "order_id": order["orderId"],
            "amount": order["amountPaise"],
            "currency": "INR",
            "status": "captured",
            "captured": True,
            "method": "card",
            "bank": None,
            "wallet": None,
            "vpa": None,
            "created_at": int(self.clock.value.timestamp()),
            "fee": 100,
            "tax": 18,
        }
        return self.service.reconcile_webhook_payment(order["orderId"], payment_id)

    def assert_coupon_error(self, code, expected, plan="basic"):
        with self.assertRaises(BillingError) as raised:
            self.service.validate_coupon("user-1", plan, code)
        self.assertEqual(raised.exception.code, expected)

    def test_normal_order_uses_server_plan_and_is_idempotent(self):
        result, duplicate = self.create_order()
        repeated, repeated_duplicate = self.create_order()

        self.assertFalse(duplicate)
        self.assertEqual(result["amountPaise"], 49900)
        self.assertEqual(result["currency"], "INR")
        self.assertEqual(result["plan"]["durationDays"], 30)
        self.assertEqual(result["orderId"], repeated["orderId"])
        self.assertTrue(repeated_duplicate)
        self.assertEqual(self.provider.create_calls, 1)

    def test_valid_percentage_coupon(self):
        self.coupon()
        validation = self.service.validate_coupon("user-1", "basic", "save10")
        order, _ = self.create_order(coupon="save10")

        self.assertEqual(validation["discountPaise"], 4990)
        self.assertEqual(order["amountPaise"], 44910)
        self.assertEqual(order["coupon"]["code"], "SAVE10")

    def test_invalid_and_missing_coupon_codes_are_precise(self):
        self.assert_coupon_error("MISSING", "coupon_not_found")
        with self.assertRaises(BillingError) as raised:
            self.service.validate_coupon("user-1", "basic", "bad code!")
        self.assertEqual(raised.exception.code, "invalid_coupon_code")

    def test_expired_inactive_and_not_started_coupons(self):
        self.coupon("EXPIRED", expiresAt=(self.clock.value - timedelta(seconds=1)).isoformat())
        self.coupon("INACTIVE", active=False)
        self.coupon("FUTURE", startsAt=(self.clock.value + timedelta(days=1)).isoformat())

        self.assert_coupon_error("EXPIRED", "coupon_expired")
        self.assert_coupon_error("INACTIVE", "coupon_inactive")
        self.assert_coupon_error("FUTURE", "coupon_not_started")

    def test_minimum_and_plan_mismatch(self):
        self.coupon("MINIMUM", minimumAmountInr=500)
        self.coupon("PROONLY", planIds=["pro"])

        self.assert_coupon_error("MINIMUM", "coupon_minimum_not_met")
        self.assert_coupon_error("PROONLY", "coupon_plan_mismatch")

    def test_percentage_max_discount_is_applied_in_paise(self):
        self.coupon("CAPPED", value=50, maxDiscountInr=100)
        result = self.service.validate_coupon("user-1", "basic", "CAPPED")
        self.assertEqual(result["discountPaise"], 10000)
        self.assertEqual(result["amountPaise"], 39900)

    def test_fixed_coupon_and_zero_amount_rejection(self):
        self.coupon("FIXED", type="fixed", value=100)
        self.coupon("FREE", type="fixed", value=499)

        result = self.service.validate_coupon("user-1", "basic", "FIXED")
        self.assertEqual(result["discountPaise"], 10000)
        self.assert_coupon_error("FREE", "zero_amount_not_allowed")
        self.assertEqual(self.provider.create_calls, 0)

    def test_global_and_per_user_usage_reservations_are_race_safe_semantically(self):
        self.coupon("GLOBAL1", globalUsageLimit=1)
        self.service.create_order("user-1", "basic", "GLOBAL1", "global-key-0001")
        with self.assertRaises(BillingError) as global_error:
            self.service.create_order("user-2", "basic", "GLOBAL1", "global-key-0002")
        self.assertEqual(global_error.exception.code, "coupon_global_limit_reached")

        self.coupon("USER1", perUserUsageLimit=1)
        self.service.create_order("user-1", "basic", "USER1", "person-key-0001")
        with self.assertRaises(BillingError) as user_error:
            self.service.create_order("user-1", "basic", "USER1", "person-key-0002")
        self.assertEqual(user_error.exception.code, "coupon_reservation_exists")
        other, _ = self.service.create_order("user-2", "basic", "USER1", "person-key-0003")
        self.assertGreater(other["amountPaise"], 0)

    def test_first_time_coupon_rejects_prior_customer(self):
        order, _ = self.create_order()
        self.capture(order)
        self.coupon("FIRST", firstTimeOnly=True)
        self.assert_coupon_error("FIRST", "coupon_first_time_only")

    def test_failed_attempt_keeps_coupon_reserved_and_retryable(self):
        self.coupon("ONCE", globalUsageLimit=1)
        order, _ = self.create_order(coupon="ONCE")
        self.assertEqual(self.store.coupons["ONCE"]["reservedCount"], 1)

        recorded = self.service.record_failed_attempt("user-1", order["orderId"], "pay_failed")
        repeated, duplicate = self.create_order(coupon="ONCE")

        self.assertEqual(recorded["status"], "reserved")
        self.assertEqual(recorded["failureAttempts"], 1)
        self.assertEqual(self.store.coupons["ONCE"]["usedCount"], 0)
        self.assertEqual(self.store.coupons["ONCE"]["reservedCount"], 1)
        history = self.service.payments("user-1")
        self.assertEqual(history[0]["status"], "failed")
        self.assertEqual(history[0]["providerPaymentId"], "pay_failed")
        self.assertTrue(duplicate)
        self.assertEqual(repeated["orderId"], order["orderId"])

    def test_failed_attempts_are_deduplicated_and_bounded(self):
        order, _ = self.create_order()
        self.service.record_failed_attempt("user-1", order["orderId"])
        self.clock.value += timedelta(seconds=1)
        repeated = self.service.record_failed_attempt("user-1", order["orderId"])
        self.assertEqual(repeated["failureAttempts"], 1)

        for index in range(MAX_CLIENT_FAILURE_ATTEMPTS + 5):
            self.service.record_failed_attempt("user-1", order["orderId"], f"pay_failed_{index}")

        stored = self.store.get_order_for_user("user-1", order["orderId"])
        self.assertEqual(stored["failureAttempts"], MAX_CLIENT_FAILURE_ATTEMPTS)
        self.assertEqual(len(self.store.failed_payments), MAX_CLIENT_FAILURE_ATTEMPTS)
        self.assertEqual(stored["status"], "reserved")

    def test_order_status_expires_non_coupon_reservation(self):
        order, _ = self.create_order()
        self.clock.value += timedelta(minutes=21)

        status = self.service.order_status("user-1", order["orderId"])

        self.assertEqual(status["status"], "expired")

    def test_coupon_create_only_does_not_overwrite_existing_configuration(self):
        original = normalize_coupon_input({"code": "ATOMIC", "type": "percentage", "value": 10})
        replacement = normalize_coupon_input({"code": "ATOMIC", "type": "percentage", "value": 90})
        self.store.put_coupon(original, create_only=True)

        with self.assertRaises(BillingError) as raised:
            self.store.put_coupon(replacement, create_only=True)

        self.assertEqual(raised.exception.code, "coupon_exists")
        self.assertEqual(self.store.get_coupon("ATOMIC")["valueBasisPoints"], 1000)

    def test_duplicate_payment_is_idempotent_and_subscription_activates(self):
        order, _ = self.create_order()
        first = self.capture(order)
        second = self.capture(order)

        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(first["subscription"]["status"], "active")
        self.assertEqual(first["subscription"]["expiresAt"], "2025-01-31T12:00:00Z")
        self.assertEqual(len(self.store.payments), 1)

    # **Validates: Requirements 9.2-9.4, 10.1-10.3, 10.6-10.7, 18.2**
    def test_browser_payment_during_finite_grant_commits_paid_and_restores_it_at_grant_boundary(self):
        grant = self.select_complimentary_grant(
            expires_at=self.clock.value + timedelta(days=7),
        )
        complimentary_before = deepcopy({
            "grants": self.store.complimentary_grants,
            "pointers": self.store.complimentary_users,
        })
        order, _ = self.create_order()

        first = self.capture(order, "pay_browser_overlap")
        duplicate = self.capture(order, "pay_browser_overlap")

        self.assertFalse(first["duplicate"])
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(first["subscription"]["source"], "complimentary")
        self.assertEqual(first["subscription"]["grantId"], grant["id"])
        self.assertEqual(first["paidFallback"]["source"], "paid")
        self.assertEqual(first["paidFallback"]["expiresAt"], "2025-01-31T12:00:00Z")
        self.assertEqual(duplicate["subscription"], first["subscription"])
        self.assertEqual(duplicate["paidFallback"], first["paidFallback"])
        self.assertEqual(self.store.subscriptions["user-1"]["lastPaymentId"], "pay_browser_overlap")
        self.assertEqual(self.store.subscriptions["user-1"]["paymentCount"], 1)
        self.assertEqual(len(self.store.payments), 1)
        self.assertEqual(complimentary_before, {
            "grants": self.store.complimentary_grants,
            "pointers": self.store.complimentary_users,
        })

        self.clock.value = grant["expiresAt"]
        restored = self.store.get_effective_entitlement("user-1", self.clock.value)
        self.assertEqual(restored["effectiveEntitlement"]["source"], "paid")
        self.assertEqual(restored["effectiveEntitlement"], restored["paidFallback"])

    # **Validates: Requirements 10.1-10.4, 10.6-10.7, 18.2, 20.2**
    def test_webhook_payment_paid_expiry_during_finite_overlap_does_not_restore_at_grant_end(self):
        grant = self.select_complimentary_grant(
            expires_at=self.clock.value + timedelta(days=60),
        )
        order, _ = self.create_order(key="webhook-finite-overlap")

        captured = self.capture_from_webhook(order, "pay_webhook_finite")

        self.assertEqual(captured["subscription"]["source"], "complimentary")
        self.assertEqual(captured["paidFallback"]["source"], "paid")
        paid_expiration = self.store.subscriptions["user-1"]["expiresAt"]
        self.clock.value = paid_expiration
        during_overlap = self.store.get_effective_entitlement("user-1", self.clock.value)
        self.assertEqual(during_overlap["effectiveEntitlement"]["source"], "complimentary")
        self.assertEqual(during_overlap["paidFallback"]["status"], "expired")

        self.clock.value = grant["expiresAt"]
        after_grant = self.store.get_effective_entitlement("user-1", self.clock.value)
        self.assertEqual(after_grant["effectiveEntitlement"]["status"], "inactive")
        self.assertIsNone(after_grant["effectiveEntitlement"]["source"])
        self.assertEqual(after_grant["paidFallback"]["status"], "expired")

    # **Validates: Requirements 10.1, 10.3-10.4, 10.6, 20.2**
    def test_webhook_payment_during_lifetime_grant_keeps_priority_at_strict_paid_boundary(self):
        grant = self.select_complimentary_grant(lifetime=True)
        order, _ = self.create_order(key="webhook-lifetime-overlap")

        captured = self.capture_from_webhook(order, "pay_webhook_lifetime")

        self.assertEqual(captured["subscription"]["source"], "complimentary")
        self.assertTrue(captured["subscription"]["lifetime"])
        paid_expiration = self.store.subscriptions["user-1"]["expiresAt"]
        self.clock.value = paid_expiration
        boundary = self.store.get_effective_entitlement("user-1", self.clock.value)
        self.assertEqual(boundary["effectiveEntitlement"]["source"], "complimentary")
        self.assertEqual(boundary["paidFallback"]["status"], "expired")

        grant.update({
            "storedStatus": "revoked",
            "updatedAt": self.clock.value,
            "endedAt": self.clock.value,
            "endReason": "Access ended",
            "revokedBy": {"uid": "admin-user", "email": "admin@example.invalid"},
        })
        pointer = self.store.complimentary_users["user-1"]
        pointer.update({
            "activeGrantId": None,
            "revision": 2,
            "updatedAt": self.clock.value,
        })
        after_revoke = self.store.get_effective_entitlement("user-1", self.clock.value)
        self.assertEqual(after_revoke["effectiveEntitlement"]["status"], "inactive")
        self.assertIsNone(after_revoke["effectiveEntitlement"]["source"])

    def test_subscription_extension_starts_at_existing_expiry(self):
        first_order, _ = self.create_order()
        first = self.capture(first_order)
        second_order, _ = self.service.create_order("user-1", "basic", None, "second-order-001")
        second = self.capture(second_order, "pay_2")

        self.assertEqual(second["payment"]["subscriptionStartsAt"], first["subscription"]["expiresAt"])
        self.assertEqual(second["subscription"]["expiresAt"], "2025-03-02T12:00:00Z")

    def test_active_subscription_rejects_cross_plan_checkout(self):
        first_order, _ = self.create_order()
        self.capture(first_order)

        with self.assertRaises(BillingError) as raised:
            self.service.create_order("user-1", "pro", None, "different-plan-001")

        self.assertEqual(raised.exception.code, "active_subscription_plan_conflict")
        self.assertEqual(self.provider.create_calls, 1)

    def test_precreated_cross_plan_capture_changes_plan_immediately(self):
        basic_order, _ = self.create_order()
        pro_order, _ = self.service.create_order("user-1", "pro", None, "precreated-pro-001")
        self.capture(basic_order)

        changed = self.capture(pro_order, "pay_plan_change")

        self.assertEqual(changed["subscription"]["planId"], "pro")
        self.assertEqual(changed["payment"]["subscriptionStartsAt"], "2025-01-01T12:00:00Z")
        self.assertEqual(changed["subscription"]["expiresAt"], "2025-04-01T12:00:00Z")
        self.assertTrue(changed["payment"]["planChangeImmediate"])

    def test_expired_subscription_allows_a_different_plan(self):
        first_order, _ = self.create_order()
        self.capture(first_order)
        self.clock.value += timedelta(days=31)

        order, duplicate = self.service.create_order("user-1", "pro", None, "expired-plan-001")

        self.assertFalse(duplicate)
        self.assertEqual(order["plan"]["id"], "pro")

    def test_payment_signature_and_provider_fields_are_verified(self):
        order, _ = self.create_order()
        with self.assertRaises(RazorpayAdapterError) as signature_error:
            self.service.verify_payment("user-1", order["orderId"], "pay_bad", "wrong")
        self.assertEqual(signature_error.exception.code, "invalid_payment_signature")

        self.provider.payments["pay_bad_amount"] = {
            "id": "pay_bad_amount", "order_id": order["orderId"], "amount": 1,
            "currency": "INR", "status": "captured", "captured": True,
        }
        signature = self.provider.checkout_signature(order["orderId"], "pay_bad_amount")
        with self.assertRaises(BillingError) as amount_error:
            self.service.verify_payment("user-1", order["orderId"], "pay_bad_amount", signature)
        self.assertEqual(amount_error.exception.code, "payment_amount_mismatch")

    def test_same_provider_payment_cannot_attach_to_another_order(self):
        first_order, _ = self.create_order()
        self.capture(first_order, "pay_unique")
        second_order, _ = self.service.create_order("user-1", "basic", None, "other-order-001")
        forged = dict(self.provider.payments["pay_unique"], order_id=second_order["orderId"])
        self.provider.payments["pay_unique"] = forged
        signature = self.provider.checkout_signature(second_order["orderId"], "pay_unique")
        with self.assertRaises(BillingError) as raised:
            self.service.verify_payment("user-1", second_order["orderId"], "pay_unique", signature)
        self.assertEqual(raised.exception.code, "payment_already_claimed")
    def test_captured_payment_recovers_after_failed_attempt(self):
        self.coupon("RECOVER", globalUsageLimit=1)
        order, _ = self.create_order(coupon="RECOVER")
        self.service.record_failed_attempt("user-1", order["orderId"], "pay_failed")

        result = self.capture(order, "pay_recovered")

        self.assertEqual(result["subscription"]["status"], "active")
        self.assertEqual(self.store.coupons["RECOVER"]["usedCount"], 1)
        self.assertEqual(self.store.coupons["RECOVER"]["reservedCount"], 0)

    def test_captured_order_honors_immutable_coupon_snapshot(self):
        self.coupon("SNAPSHOT", globalUsageLimit=1)
        order, _ = self.create_order(coupon="SNAPSHOT")
        self.store.coupons["SNAPSHOT"]["active"] = False
        self.store.coupons["SNAPSHOT"]["expiresAt"] = self.clock.value - timedelta(seconds=1)

        result = self.capture(order, "pay_snapshot")

        self.assertEqual(result["payment"]["discountPaise"], order["discountPaise"])
        self.assertEqual(result["subscription"]["status"], "active")

    def test_late_coupon_capture_keeps_its_reserved_capacity(self):
        self.coupon("LATE", globalUsageLimit=1)
        order, _ = self.create_order(coupon="LATE")
        self.clock.value += timedelta(minutes=21)
        self.store.cleanup_expired(self.clock.value)

        self.assertEqual(self.store.coupons["LATE"]["reservedCount"], 1)
        with self.assertRaises(BillingError) as replacement:
            self.service.create_order("user-2", "basic", "LATE", "late-replace-001")
        self.assertEqual(replacement.exception.code, "coupon_global_limit_reached")

        result = self.capture(order, "pay_late")

        self.assertTrue(result["payment"]["lateCapture"])
        self.assertEqual(result["subscription"]["status"], "active")
        self.assertEqual(self.store.coupons["LATE"]["usedCount"], 1)
        self.assertEqual(self.store.coupons["LATE"]["reservedCount"], 0)

    def test_one_user_cannot_hold_multiple_live_reservations_for_same_coupon(self):
        self.coupon("ONECHECKOUT", globalUsageLimit=10)
        self.create_order(coupon="ONECHECKOUT")
        with self.assertRaises(BillingError) as raised:
            self.service.create_order("user-1", "pro", "ONECHECKOUT", "another-live-001")
        self.assertEqual(raised.exception.code, "coupon_reservation_exists")

    def test_payment_record_retains_verified_user_email(self):
        order, _ = self.service.create_order(
            "user-1", "basic", None, "email-order-001", user_email="person@example.invalid"
        )
        result = self.capture(order, "pay_email")
        self.assertEqual(result["payment"]["userEmail"], "person@example.invalid")

    def test_coupon_start_must_precede_expiry(self):
        with self.assertRaises(BillingError) as raised:
            normalize_coupon_input({
                "code": "BADWINDOW", "type": "percentage", "value": 10,
                "startsAt": self.clock.value.isoformat(),
                "expiresAt": (self.clock.value - timedelta(seconds=1)).isoformat(),
            })
        self.assertEqual(raised.exception.code, "invalid_coupon_window")

    def test_stale_webhook_claim_can_be_retried(self):
        payload_hash = "a" * 64
        self.assertTrue(self.store.claim_event("event-stale", payload_hash, self.clock.value))
        with self.assertRaises(BillingError) as processing:
            self.store.claim_event("event-stale", payload_hash, self.clock.value)
        self.assertEqual(processing.exception.code, "webhook_event_processing")
        self.clock.value += timedelta(minutes=6)
        self.assertTrue(self.store.claim_event("event-stale", payload_hash, self.clock.value))
        self.assertEqual(self.store.events["event-stale"]["attempts"], 2)

    def test_coupon_provider_order_keeps_capacity_after_checkout_ttl(self):
        self.coupon("EXPIRING", globalUsageLimit=1)
        self.create_order(coupon="EXPIRING")
        self.clock.value += timedelta(minutes=21)

        with self.assertRaises(BillingError) as raised:
            self.service.create_order("user-2", "basic", "EXPIRING", "expired-retry-01")

        self.assertEqual(raised.exception.code, "coupon_global_limit_reached")
        self.assertEqual(self.store.coupons["EXPIRING"]["reservedCount"], 1)

    def test_provider_order_is_recovered_by_stable_receipt(self):
        plan = PlanCatalog().get("basic")
        internal, _ = self.store.reserve_order(
            "user-1", "recover-key-001", plan, None, self.clock.value,
            self.clock.value + timedelta(minutes=20), False,
        )
        accepted = self.provider.create_order(internal["amountPaise"], internal["id"][:40])
        result, duplicate = self.service.create_order("user-1", "basic", None, "recover-key-001")
        self.assertTrue(duplicate)
        self.assertEqual(result["orderId"], accepted["id"])
        self.assertEqual(self.provider.create_calls, 1)

    def test_provider_failure_releases_reserved_coupon(self):
        self.coupon("RELEASE", globalUsageLimit=1)
        self.provider.create_order = Mock(side_effect=RazorpayAdapterError())
        with self.assertRaises(BillingError) as raised:
            self.create_order(coupon="RELEASE")
        self.assertEqual(raised.exception.code, "provider_unavailable")
        self.assertEqual(self.store.coupons["RELEASE"]["reservedCount"], 0)

    def test_malformed_catalog_and_coupon_scalars_are_rejected(self):
        with self.assertRaises(ValueError):
            PlanCatalog.from_json(json.dumps([{
                "id": "basic", "name": "Basic", "amountPaise": 499.5,
                "durationDays": 30, "features": ["Feature"],
            }]))
        with self.assertRaises(BillingError) as active_error:
            normalize_coupon_input({"code": "STRICT", "type": "fixed", "value": 10, "active": "false"})
        self.assertEqual(active_error.exception.code, "invalid_active")
        with self.assertRaises(BillingError) as limit_error:
            normalize_coupon_input({"code": "STRICT", "type": "fixed", "value": 10, "globalUsageLimit": 1.5})
        self.assertEqual(limit_error.exception.code, "invalid_global_usage_limit")


class BillingBlueprintTests(unittest.TestCase):
    def setUp(self):
        self.clock = MutableClock()
        self.store = MemoryBillingStore()
        self.provider = HmacTestRazorpayAdapter()
        self.catalog = PlanCatalog()
        app = Flask(__name__)
        app.config["TESTING"] = True
        app.register_blueprint(
            create_billing_blueprint(
                None, firebase_app=object(), store=self.store,
                provider=self.provider, catalog=self.catalog,
            )
        )
        self.client = app.test_client()
        self.headers = {"Authorization": "Bearer token"}
        self.decoded = {
            "uid": "user-1",
            "email": "person@example.invalid",
            "email_verified": True,
            "firebase": {"sign_in_provider": "google.com"},
        }

    @patch("billing_api.firebase_auth.verify_id_token")
    def test_user_order_rejects_client_amount_uid_and_status(self, verify):
        verify.return_value = self.decoded
        response = self.client.post(
            "/api/v1/billing/orders",
            headers=self.headers,
            json={"planId": "basic", "idempotencyKey": "browser-key-0001", "amount": 1, "uid": "other", "status": "paid"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"]["code"], "unexpected_fields")
        self.assertEqual(self.provider.create_calls, 0)

    def test_invalid_webhook_signature_is_rejected_before_json_or_writes(self):
        raw = b"not-json"
        response = self.client.post(
            "/api/v1/billing/webhooks/razorpay",
            data=raw,
            content_type="application/json",
            headers={"X-Razorpay-Signature": "wrong"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"]["code"], "invalid_webhook_signature")
        self.assertEqual(self.store.events, {})

    @patch("billing_api.utc_now", return_value=datetime(2025, 1, 1, 12, 0, tzinfo=UTC))
    @patch("billing_api.firebase_auth.verify_id_token")
    def test_captured_webhook_activates_without_browser_callback_and_is_retry_safe(self, verify, _now):
        verify.return_value = self.decoded
        created = self.client.post(
            "/api/v1/billing/orders",
            headers=self.headers,
            json={"planId": "basic", "idempotencyKey": "webhook-key-001"},
        ).get_json()
        payment_id = "pay_webhook"
        self.provider.payments[payment_id] = {
            "id": payment_id, "order_id": created["orderId"], "amount": created["amountPaise"],
            "currency": "INR", "status": "captured", "captured": True, "method": "card",
        }
        payload = {
            "event": "payment.captured",
            "payload": {"payment": {"entity": {"id": payment_id, "order_id": created["orderId"]}}},
        }
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = {
            "X-Razorpay-Signature": self.provider.webhook_signature(raw),
            "X-Razorpay-Event-Id": "event-1",
        }

        first = self.client.post("/api/v1/billing/webhooks/razorpay", data=raw, content_type="application/json", headers=headers)
        second = self.client.post("/api/v1/billing/webhooks/razorpay", data=raw, content_type="application/json", headers=headers)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["outcome"], "payment_activated")
        self.assertTrue(second.get_json()["duplicate"])
        self.assertEqual(self.store.subscriptions["user-1"]["status"], "active")
        self.assertEqual(len(self.store.payments), 1)

    @patch("billing_api.firebase_auth.verify_id_token")
    def test_unexpected_storage_failure_is_structured_and_retryable(self, verify):
        verify.return_value = self.decoded
        self.store.get_effective_entitlement = Mock(side_effect=RuntimeError("sensitive-storage-detail"))
        response = self.client.get("/api/v1/billing/me", headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["error"]["code"], "billing_unavailable")
        self.assertIn("requestId", response.get_json())
        self.assertNotIn("sensitive-storage-detail", response.get_data(as_text=True))

    @patch("billing_api.firebase_auth.verify_id_token")
    def test_admin_requires_claim_not_frontend_assertion(self, verify):
        verify.return_value = self.decoded
        denied = self.client.get("/api/v1/admin/billing/coupons", headers=self.headers)
        verify.return_value = {**self.decoded, "admin": True}
        allowed = self.client.get("/api/v1/admin/billing/coupons", headers=self.headers)

        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.get_json()["error"]["code"], "admin_required")
        self.assertEqual(allowed.status_code, 200)


class _UnavailableEntitlementService:
    def require_entitlement(self, _uid, _minimum_tier, now=None):
        del now
        raise RuntimeError("sensitive-storage-detail")


class PremiumBackendEntitlementTests(unittest.TestCase):
    def setUp(self):
        self.clock = MutableClock()
        self.store = MemoryBillingStore()
        self.token = {
            "uid": "premium-user",
            "firebase": {"sign_in_provider": "google.com"},
        }

    def paid(self, tier="pro", expires_at=None):
        self.store.subscriptions[self.token["uid"]] = {
            "status": "active",
            "planId": tier,
            "entitlementTier": tier,
            "startsAt": self.clock.value - timedelta(days=1),
            "expiresAt": expires_at or self.clock.value + timedelta(days=30),
            "updatedAt": self.clock.value,
        }

    def select_grant(self, tier="pro", *, lifetime=False, expires_at=None):
        grant_id = "grant-premium-001"
        activation = self.clock.value - timedelta(days=1)
        self.store.complimentary_grants[grant_id] = {
            "id": grant_id,
            "targetUid": self.token["uid"],
            "targetEmail": "premium@example.invalid",
            "targetEmailNormalized": "premium@example.invalid",
            "targetDisplayName": "Premium User",
            "planId": tier,
            "planSnapshot": {
                "id": tier,
                "name": tier.title(),
                "entitlementTier": tier,
                "features": ["Premium webhooks"],
                "revision": 1,
            },
            "validityType": "lifetime" if lifetime else "custom",
            "presetDays": None,
            "activationAt": activation,
            "expiresAt": None if lifetime else (expires_at or self.clock.value + timedelta(days=30)),
            "lifetime": lifetime,
            "storedStatus": "active",
            "createdAt": activation,
            "updatedAt": activation,
            "createdBy": {"uid": "admin-user", "email": "admin@example.invalid"},
            "reason": None,
            "endedAt": None,
            "endReason": None,
            "revokedBy": None,
            "supersededByGrantId": None,
            "supersededBy": None,
            "creationOperationId": "operation-premium-001",
            "schemaVersion": 1,
        }
        self.store.complimentary_users[self.token["uid"]] = {
            "targetUid": self.token["uid"],
            "activeGrantId": grant_id,
            "revision": 1,
            "updatedAt": self.clock.value,
            "schemaVersion": 1,
        }
        return grant_id

    def request(self, entitlement_service=None, path="/api/v1/webhooks/endpoints"):
        service = entitlement_service or EffectiveEntitlementService(
            self.store,
            clock=self.clock,
        )
        app = Flask("premium-entitlement-%s" % id(service))
        app.register_blueprint(create_webhook_blueprint(
            None,
            firebase_app=object(),
            enforce_entitlements=True,
            entitlement_service=service,
        ))
        with patch("webhook_intelligence.auth.verify_id_token", return_value=self.token):
            return app.test_client().get(
                path,
                headers={"Authorization": "Bearer token"},
            )

    # **Validates: Requirements 6.2, 18.3-18.4, 19.2, 20.6**
    def test_paid_pro_and_elite_are_allowed_while_basic_is_denied(self):
        for tier, expected_status in (("pro", 200), ("elite", 200), ("basic", 403)):
            with self.subTest(tier=tier):
                self.store.subscriptions.clear()
                self.paid(tier)
                response = self.request()
                self.assertEqual(response.status_code, expected_status, response.get_data(as_text=True))
                if expected_status == 403:
                    self.assertEqual(response.get_json()["error"]["code"], "subscription_required")

    # **Validates: Requirements 6.2, 6.4-6.5, 10.1, 17.3, 19.2**
    def test_complimentary_pro_and_elite_support_finite_and_lifetime_access(self):
        for tier in ("pro", "elite"):
            for lifetime in (False, True):
                with self.subTest(tier=tier, lifetime=lifetime):
                    self.store.complimentary_grants.clear()
                    self.store.complimentary_users.clear()
                    self.select_grant(tier, lifetime=lifetime)
                    response = self.request()
                    self.assertEqual(response.status_code, 200, response.get_data(as_text=True))

    # **Validates: Requirements 6.4, 10.3-10.4, 12.4, 19.2**
    def test_expired_grant_denies_without_active_paid_fallback(self):
        self.select_grant("elite", expires_at=self.clock.value)
        response = self.request()
        self.assertEqual(response.status_code, 403, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["error"]["code"], "subscription_required")

    # **Validates: Requirements 8.2, 10.3-10.4, 18.4, 20.2**
    def test_revoke_restores_only_still_active_paid_fallback(self):
        grant_id = self.select_grant("elite", lifetime=True)
        self.paid("pro")
        self.store.complimentary_users[self.token["uid"]].update({
            "activeGrantId": None,
            "revision": 2,
            "updatedAt": self.clock.value,
        })
        grant = self.store.complimentary_grants[grant_id]
        grant.update({
            "storedStatus": "revoked",
            "updatedAt": self.clock.value,
            "endedAt": self.clock.value,
            "endReason": "Access no longer required",
            "revokedBy": {"uid": "admin-user", "email": "admin@example.invalid"},
        })
        self.assertEqual(self.request().status_code, 200)

        self.paid("pro", expires_at=self.clock.value)
        denied = self.request()
        self.assertEqual(denied.status_code, 403, denied.get_data(as_text=True))
        self.assertEqual(denied.get_json()["error"]["code"], "subscription_required")

    # **Validates: Requirements 6.6, 12.7, 18.7, 19.2**
    def test_malformed_and_unavailable_entitlement_state_fail_closed(self):
        self.store.complimentary_users[self.token["uid"]] = {
            "targetUid": self.token["uid"],
            "activeGrantId": "missing-grant-001",
            "revision": 1,
            "updatedAt": self.clock.value,
            "schemaVersion": 1,
        }
        malformed = self.request()
        self.assertEqual(malformed.status_code, 503, malformed.get_data(as_text=True))
        self.assertEqual(
            malformed.get_json()["error"]["code"],
            "subscription_service_unavailable",
        )
        self.assertNotIn("missing-grant-001", malformed.get_data(as_text=True))

        unavailable = self.request(_UnavailableEntitlementService())
        self.assertEqual(unavailable.status_code, 503, unavailable.get_data(as_text=True))
        self.assertEqual(
            unavailable.get_json()["error"]["code"],
            "subscription_service_unavailable",
        )
        self.assertNotIn("sensitive-storage-detail", unavailable.get_data(as_text=True))

    # **Validates: Requirements 18.1, 18.3, 18.7**
    def test_health_route_remains_excluded_from_premium_authorization(self):
        response = self.request(
            _UnavailableEntitlementService(),
            path="/api/v1/webhooks/health",
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
