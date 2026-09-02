"""Task 14 real Firestore emulator concurrency and preservation verification.

The suite deliberately uses the Google/Firebase transaction implementation against
FIRESTORE_EMULATOR_HOST. Thread barriers align competing operations; no Firestore
transaction, query, or document mock is used.
"""

from __future__ import annotations

import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone

from google.api_core.exceptions import Aborted
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore as google_firestore

from billing_core import (
    BillingError,
    BillingService,
    PlanCatalog,
    complimentary_grant_status,
    resolve_effective_entitlement,
)
from billing_store import COLLECTIONS, FirestoreBillingStore
from razorpay_adapter import HmacTestRazorpayAdapter


UTC = timezone.utc
PROJECT_ID = "demo-complimentary-billing"
NOW = datetime(2025, 6, 15, 12, 0, tzinfo=UTC)
ACTOR = {"uid": "admin-primary", "email": "admin@example.com"}
SECOND_ACTOR = {"uid": "admin-secondary", "email": "admin2@example.com"}
TARGET = {
    "uid": "target-user",
    "email": "person@example.com",
    "emailNormalized": "person@example.com",
    "emailVerified": True,
    "displayName": "Person",
    "disabled": False,
    "grantEligible": True,
}
PLAN = {
    "id": "pro",
    "name": "Pro",
    "amountPaise": 99900,
    "durationDays": 30,
    "features": ["Advanced analytics", "Priority support"],
    "active": True,
    "sortOrder": 1,
    "entitlementTier": "pro",
    "revision": 7,
    "createdAt": NOW - timedelta(days=30),
    "updatedAt": NOW - timedelta(days=1),
}
ELITE_PLAN = {
    **PLAN,
    "id": "elite",
    "name": "Elite",
    "amountPaise": 199900,
    "entitlementTier": "elite",
    "sortOrder": 2,
}
PAID = {
    "userId": TARGET["uid"],
    "status": "active",
    "planId": "basic",
    "entitlementTier": "basic",
    "startsAt": NOW - timedelta(days=5),
    "expiresAt": NOW + timedelta(days=20),
    "updatedAt": NOW - timedelta(days=1),
    "lastPaymentId": "pay-existing",
    "paymentCount": 2,
}

BILLING_COLLECTIONS = tuple(dict.fromkeys(COLLECTIONS.values()))
PAYMENT_DOMAIN_COLLECTIONS = (
    COLLECTIONS["orders"],
    COLLECTIONS["provider_orders"],
    COLLECTIONS["payments"],
    COLLECTIONS["payment_attempts"],
    COLLECTIONS["coupons"],
    COLLECTIONS["coupon_users"],
    COLLECTIONS["redemptions"],
    COLLECTIONS["events"],
)


class BarrierClock:
    """Align only the first call from each competing operation."""

    def __init__(self, value, parties=2):
        self.value = value
        self.barrier = threading.Barrier(parties, timeout=15)
        self.lock = threading.Lock()
        self.aligned_calls = 0
        self.calls = 0

    def __call__(self):
        with self.lock:
            self.calls += 1
            should_wait = self.aligned_calls < self.barrier.parties
            if should_wait:
                self.aligned_calls += 1
        if should_wait:
            self.barrier.wait()
        return self.value


@unittest.skipUnless(
    os.environ.get("FIRESTORE_EMULATOR_HOST"),
    "Firestore emulator is required for concurrency verification",
)
class FirestoreComplimentaryConcurrencyEmulatorTests(unittest.TestCase):
    """Exercise FirestoreBillingStore with real emulator transactions."""

    @classmethod
    def setUpClass(cls):
        cls.database = google_firestore.Client(
            project=os.environ.get("GCLOUD_PROJECT", PROJECT_ID),
            credentials=AnonymousCredentials(),
        )
        cls.store = FirestoreBillingStore(cls.database)

    @classmethod
    def tearDownClass(cls):
        cls._clear_database()
        cls.database.close()

    @classmethod
    def _clear_database(cls):
        for collection_name in BILLING_COLLECTIONS:
            collection = cls.database.collection(collection_name)
            while True:
                snapshots = list(collection.limit(200).stream())
                if not snapshots:
                    break
                batch = cls.database.batch()
                for snapshot in snapshots:
                    batch.delete(snapshot.reference)
                batch.commit()

    def setUp(self):
        self._clear_database()
        self._put(COLLECTIONS["plans"], PLAN["id"], PLAN)
        self._put(COLLECTIONS["plans"], ELITE_PLAN["id"], ELITE_PLAN)
        self._put(COLLECTIONS["subscriptions"], TARGET["uid"], PAID)
        self._seed_payment_markers()

    def tearDown(self):
        self._clear_database()

    def _put(self, collection, document_id, value):
        self.database.collection(collection).document(document_id).set(deepcopy(value))

    def _get(self, collection, document_id):
        snapshot = self.database.collection(collection).document(document_id).get()
        return deepcopy(snapshot.to_dict()) if snapshot.exists else None

    def _documents(self, collection):
        return {snapshot.id: deepcopy(snapshot.to_dict() or {}) for snapshot in self.database.collection(collection).stream()}

    def _seed_payment_markers(self):
        marker_time = NOW - timedelta(days=10)
        fixtures = {
            COLLECTIONS["orders"]: {"marker-order": {"status": "paid", "createdAt": marker_time}},
            COLLECTIONS["provider_orders"]: {"marker-provider-order": {"billingOrderId": "marker-order", "createdAt": marker_time}},
            COLLECTIONS["payments"]: {"pay-existing": {"userId": TARGET["uid"], "status": "captured", "amountPaise": 49900, "createdAt": marker_time}},
            COLLECTIONS["payment_attempts"]: {"attempt-marker": {"userId": TARGET["uid"], "status": "failed", "createdAt": marker_time}},
            COLLECTIONS["coupons"]: {"COUPON-MARKER": {"active": True, "usedCount": 1, "updatedAt": marker_time}},
            COLLECTIONS["coupon_users"]: {"usage-marker": {"userId": TARGET["uid"], "usedCount": 1, "updatedAt": marker_time}},
            COLLECTIONS["redemptions"]: {"redemption-marker": {"userId": TARGET["uid"], "discountPaise": 100, "createdAt": marker_time}},
            COLLECTIONS["events"]: {"event-marker": {"status": "completed", "createdAt": marker_time}},
        }
        for collection, documents in fixtures.items():
            for document_id, value in documents.items():
                self._put(collection, document_id, value)

    def _payment_domain_snapshot(self):
        return {collection: self._documents(collection) for collection in PAYMENT_DOMAIN_COLLECTIONS}

    def _create(self, key, *, actor=ACTOR, target=TARGET, plan_id="pro", validity=None, clock=None):
        return self.store.create_complimentary_grant(
            actor=deepcopy(actor),
            target=deepcopy(target),
            plan_id=plan_id,
            validity=deepcopy(validity or {"type": "lifetime"}),
            reason="Task 14 race verification",
            idempotency_key=key,
            plan_loader=lambda selected: self.store.get_plan(selected, include_inactive=True),
            clock=clock or (lambda: NOW),
        )

    def _revoke(self, grant_id, key, *, clock=None):
        return self.store.revoke_complimentary_grant(
            actor=deepcopy(SECOND_ACTOR),
            grant_id=grant_id,
            reason="Task 14 concurrent revoke",
            idempotency_key=key,
            clock=clock or (lambda: NOW),
        )

    @staticmethod
    def _capture_call(callable_):
        try:
            return ("ok", callable_())
        except Exception as error:  # asserted by the race-specific caller
            return ("error", error)

    def _run_pair(self, left, right):
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="task14-race") as executor:
            left_future = executor.submit(self._capture_call, left)
            right_future = executor.submit(self._capture_call, right)
            return left_future.result(timeout=30), right_future.result(timeout=30)

    def _assert_final_invariants(self, uid, now, *, expected_operations=None):
        pointer = self._get(COLLECTIONS["complimentary_users"], uid)
        grants = {
            grant_id: value
            for grant_id, value in self._documents(COLLECTIONS["complimentary_grants"]).items()
            if value.get("targetUid") == uid
        }
        effective_grants = [
            value for value in grants.values()
            if complimentary_grant_status(value, now) == "active"
        ]
        self.assertLessEqual(len(effective_grants), 1)
        if effective_grants:
            self.assertIsNotNone(pointer)
            self.assertEqual(pointer["activeGrantId"], effective_grants[0]["id"])
        elif pointer is not None:
            self.assertIsNone(pointer["activeGrantId"])

        operations = self._documents(COLLECTIONS["complimentary_operations"])
        if expected_operations is not None:
            self.assertEqual(len(operations), expected_operations)
        self.assertTrue(all(value.get("status") == "committed" for value in operations.values()))
        for operation in operations.values():
            self.assertNotIn("idempotencyKey", operation)
            self.assertRegex(operation.get("idempotencyKeyHash", ""), r"^[0-9a-f]{64}$")

        audits = self._documents(COLLECTIONS["complimentary_audit"])
        self.assertEqual(len(audits), len(set(audits)))
        for event_id, event in audits.items():
            self.assertEqual(event_id, event["eventId"])
            self.assertIn(event["grantId"], grants)

        paid = self._get(COLLECTIONS["subscriptions"], uid)
        selected = grants.get(pointer.get("activeGrantId")) if pointer and pointer.get("activeGrantId") else None
        expected = resolve_effective_entitlement(paid, selected, now)
        actual = self.store.get_effective_entitlement(uid, now, require_valid_paid=True)
        self.assertEqual(actual, expected)
        return {"pointer": pointer, "grants": grants, "audits": audits, "operations": operations, "entitlement": actual}

    def _seed_order(self, suffix):
        billing_order_id = f"billing-order-{suffix}"
        provider_order_id = f"provider-order-{suffix}"
        order = {
            "id": billing_order_id,
            "userId": TARGET["uid"],
            "userEmail": TARGET["email"],
            "idempotencyKeyHash": f"hash-{suffix}",
            "planId": "basic",
            "planSnapshot": {
                "id": "basic",
                "name": "Basic",
                "amountPaise": 49900,
                "durationDays": 30,
                "features": ["Dashboard"],
                "entitlementTier": "basic",
            },
            "couponCode": None,
            "couponSnapshot": None,
            "amountPaise": 49900,
            "originalAmountPaise": 49900,
            "discountPaise": 0,
            "currency": "INR",
            "status": "reserved",
            "reservationExpiresAt": NOW + timedelta(minutes=20),
            "createdAt": NOW - timedelta(minutes=1),
            "updatedAt": NOW - timedelta(minutes=1),
            "providerOrderId": provider_order_id,
        }
        self._put(COLLECTIONS["orders"], billing_order_id, order)
        self._put(COLLECTIONS["provider_orders"], provider_order_id, {
            "billingOrderId": billing_order_id,
            "userId": TARGET["uid"],
            "createdAt": NOW - timedelta(minutes=1),
        })
        return order

    def _payment_service(self, suffix, clock):
        order = self._seed_order(suffix)
        payment_id = f"payment-{suffix}"
        provider = HmacTestRazorpayAdapter()
        provider.payments[payment_id] = {
            "id": payment_id,
            "order_id": order["providerOrderId"],
            "amount": order["amountPaise"],
            "currency": "INR",
            "status": "captured",
            "captured": True,
            "method": "card",
            "bank": None,
            "wallet": None,
            "vpa": None,
            "created_at": int(NOW.timestamp()),
            "fee": 100,
            "tax": 18,
        }
        return BillingService(self.store, provider, PlanCatalog(), clock=clock), order, payment_id

    def _assert_payment_race_preservation(self, before, suffix):
        after = self._payment_domain_snapshot()
        immutable_collections = set(PAYMENT_DOMAIN_COLLECTIONS) - {COLLECTIONS["orders"], COLLECTIONS["payments"]}
        for collection in immutable_collections:
            self.assertEqual(after[collection], before[collection], collection)

        billing_order_id = f"billing-order-{suffix}"
        payment_id = f"payment-{suffix}"
        self.assertEqual(after[COLLECTIONS["orders"]]["marker-order"], before[COLLECTIONS["orders"]]["marker-order"])
        self.assertEqual(after[COLLECTIONS["payments"]]["pay-existing"], before[COLLECTIONS["payments"]]["pay-existing"])
        self.assertEqual(after[COLLECTIONS["orders"]][billing_order_id]["status"], "paid")
        self.assertEqual(after[COLLECTIONS["orders"]][billing_order_id]["providerPaymentId"], payment_id)
        self.assertEqual(after[COLLECTIONS["payments"]][payment_id]["status"], "captured")
        self.assertEqual(set(after[COLLECTIONS["payments"]]), {"pay-existing", payment_id})

    def test_simultaneous_grant_grant_serializes_to_one_active_grant(self):
        """Validates Requirements 5.4-5.5, 10.5, 16.3-16.7, 20.3."""
        paid_before = deepcopy(self._get(COLLECTIONS["subscriptions"], TARGET["uid"]))
        payment_before = self._payment_domain_snapshot()
        clock = BarrierClock(NOW)
        first, second = self._run_pair(
            lambda: self._create("grant-race-key-0001", actor=ACTOR, clock=clock),
            lambda: self._create("grant-race-key-0002", actor=SECOND_ACTOR, clock=clock),
        )
        self.assertEqual([first[0], second[0]], ["ok", "ok"])
        state = self._assert_final_invariants(TARGET["uid"], NOW, expected_operations=2)
        self.assertEqual(len(state["grants"]), 2)
        self.assertEqual(sorted(value["storedStatus"] for value in state["grants"].values()), ["active", "superseded"])
        self.assertEqual(sorted(value["eventType"] for value in state["audits"].values()), ["granted", "granted", "superseded"])
        self.assertEqual(state["pointer"]["revision"], 2)
        self.assertGreaterEqual(clock.calls, 2)
        self.assertEqual(self._get(COLLECTIONS["subscriptions"], TARGET["uid"]), paid_before)
        self.assertEqual(self._payment_domain_snapshot(), payment_before)

    def test_simultaneous_grant_revoke_never_clears_replacement_pointer(self):
        """Validates Requirements 8.2-8.5, 10.5, 16.3, 20.3."""
        prior = self._create("prior-grant-key-0001")
        prior_id = prior["grant"]["id"]
        payment_before = self._payment_domain_snapshot()
        clock = BarrierClock(NOW + timedelta(seconds=1))
        created, revoked = self._run_pair(
            lambda: self._create("replacement-key-0001", clock=clock),
            lambda: self._revoke(prior_id, "revoke-race-key-001", clock=clock),
        )
        self.assertEqual(created[0], "ok")
        if revoked[0] == "error":
            self.assertIsInstance(revoked[1], BillingError)
            self.assertEqual(revoked[1].code, "grant_state_conflict")
        state = self._assert_final_invariants(TARGET["uid"], NOW + timedelta(seconds=1))
        self.assertEqual(state["pointer"]["activeGrantId"], created[1]["grant"]["id"])
        self.assertEqual(state["grants"][created[1]["grant"]["id"]]["storedStatus"], "active")
        self.assertIn(state["grants"][prior_id]["storedStatus"], {"revoked", "superseded"})
        self.assertEqual(state["pointer"]["revision"], 3 if revoked[0] == "ok" else 2)
        self.assertEqual(self._payment_domain_snapshot(), payment_before)

    def test_grant_racing_browser_verification_preserves_payment_and_priority(self):
        """Validates Requirements 9.2-9.5, 10.6, 16.3, 18.2, 20.3."""
        clock = BarrierClock(NOW)
        service, order, payment_id = self._payment_service("browser", clock)
        before = self._payment_domain_snapshot()
        grant_result, payment_result = self._run_pair(
            lambda: self._create("grant-browser-key-01", clock=clock),
            lambda: service.verify_payment(
                TARGET["uid"],
                order["providerOrderId"],
                payment_id,
                service.provider.checkout_signature(order["providerOrderId"], payment_id),
            ),
        )
        self.assertEqual([grant_result[0], payment_result[0]], ["ok", "ok"])
        state = self._assert_final_invariants(TARGET["uid"], NOW, expected_operations=1)
        self.assertEqual(state["entitlement"]["effectiveEntitlement"]["source"], "complimentary")
        self.assertEqual(state["entitlement"]["paidFallback"]["paymentCount"], 3)
        self._assert_payment_race_preservation(before, "browser")

    def test_grant_racing_captured_webhook_preserves_payment_and_priority(self):
        """Validates Requirements 9.2-9.5, 10.6, 16.3, 18.2, 20.3."""
        clock = BarrierClock(NOW)
        service, order, payment_id = self._payment_service("webhook", clock)
        before = self._payment_domain_snapshot()
        grant_result, payment_result = self._run_pair(
            lambda: self._create("grant-webhook-key-01", clock=clock),
            lambda: service.reconcile_webhook_payment(order["providerOrderId"], payment_id),
        )
        self.assertEqual([grant_result[0], payment_result[0]], ["ok", "ok"])
        state = self._assert_final_invariants(TARGET["uid"], NOW, expected_operations=1)
        self.assertEqual(state["entitlement"]["effectiveEntitlement"]["source"], "complimentary")
        self.assertEqual(state["entitlement"]["paidFallback"]["lastPaymentId"], payment_id)
        self._assert_payment_race_preservation(before, "webhook")

    def test_revoke_racing_payment_restores_independently_committed_paid_state(self):
        """Validates Requirements 8.2, 9.2-9.5, 10.3, 16.3, 20.3."""
        grant = self._create("grant-before-revoke-01")
        clock = BarrierClock(NOW + timedelta(seconds=1))
        service, order, payment_id = self._payment_service("revoke-payment", clock)
        before = self._payment_domain_snapshot()
        revoke_result, payment_result = self._run_pair(
            lambda: self._revoke(grant["grant"]["id"], "revoke-payment-key1", clock=clock),
            lambda: service.verify_payment(
                TARGET["uid"], order["providerOrderId"], payment_id,
                service.provider.checkout_signature(order["providerOrderId"], payment_id),
            ),
        )
        self.assertEqual([revoke_result[0], payment_result[0]], ["ok", "ok"])
        state = self._assert_final_invariants(TARGET["uid"], NOW + timedelta(seconds=1), expected_operations=2)
        self.assertEqual(state["grants"][grant["grant"]["id"]]["storedStatus"], "revoked")
        self.assertIsNone(state["pointer"]["activeGrantId"])
        self.assertEqual(state["entitlement"]["effectiveEntitlement"]["source"], "paid")
        self.assertEqual(state["entitlement"]["effectiveEntitlement"]["lastPaymentId"], payment_id)
        self._assert_payment_race_preservation(before, "revoke-payment")

    def test_expiration_sensitive_read_and_write_use_server_boundary_without_cleanup(self):
        """Validates Requirements 10.3-10.4, 12.4, 16.3, 20.3."""
        expiry = NOW + timedelta(seconds=1)
        expired = self._create(
            "expiring-grant-key-01",
            validity={"type": "custom", "expiresAt": expiry.isoformat()},
        )
        replacement_clock = BarrierClock(expiry, parties=2)

        def read_at_boundary():
            replacement_clock()
            return self.store.get_effective_entitlement(TARGET["uid"], expiry, require_valid_paid=True)

        replacement, observed = self._run_pair(
            lambda: self._create("after-expiry-key-0001", clock=replacement_clock),
            read_at_boundary,
        )
        self.assertEqual([replacement[0], observed[0]], ["ok", "ok"])
        self.assertIn(observed[1]["effectiveEntitlement"]["source"], {"paid", "complimentary"})
        state = self._assert_final_invariants(TARGET["uid"], expiry, expected_operations=2)
        self.assertEqual(state["pointer"]["activeGrantId"], replacement[1]["grant"]["id"])
        self.assertEqual(state["grants"][expired["grant"]["id"]]["storedStatus"], "active")
        self.assertEqual(complimentary_grant_status(state["grants"][expired["grant"]["id"]], expiry), "expired")
        self.assertNotIn("superseded", [event["eventType"] for event in state["audits"].values()])

    def test_forced_real_transaction_retry_rereads_and_store_consumes_result(self):
        """Validates Requirements 5.5, 16.3-16.7, 20.3."""
        plan_ref = self.database.collection(COLLECTIONS["plans"]).document(PLAN["id"])
        barrier = threading.Barrier(2, timeout=15)
        attempts = {"left": 0, "right": 0}
        attempts_lock = threading.Lock()

        def increment_revision(worker):
            transaction = self.database.transaction(max_attempts=5)

            @google_firestore.transactional
            def update(active_transaction):
                snapshot = plan_ref.get(transaction=active_transaction)
                with attempts_lock:
                    attempts[worker] += 1
                    first_attempt = attempts[worker] == 1
                if first_attempt:
                    barrier.wait()
                value = snapshot.to_dict() or {}
                active_transaction.set(plan_ref, {
                    "revision": int(value["revision"]) + 1,
                    "updatedAt": NOW,
                }, merge=True)

            update(transaction)

        def retry_serially():
            transaction = self.database.transaction(max_attempts=5)

            @google_firestore.transactional
            def update(active_transaction):
                snapshot = plan_ref.get(transaction=active_transaction)
                value = snapshot.to_dict() or {}
                active_transaction.set(plan_ref, {
                    "revision": int(value["revision"]) + 1,
                    "updatedAt": NOW,
                }, merge=True)

            update(transaction)

        left, right = self._run_pair(
            lambda: increment_revision("left"),
            lambda: increment_revision("right"),
        )
        results = (left, right)
        errors = [result[1] for result in results if result[0] == "error"]
        self.assertLessEqual(len(errors), 1, [repr(error) for error in errors])
        for error in errors:
            self.assertTrue(
                isinstance(error, Aborted)
                or "ABORTED" in repr(error).upper()
                or "LOCK TIMEOUT" in repr(error).upper(),
                repr(error),
            )
            retry_serially()
        self.assertTrue(errors or sum(attempts.values()) >= 3, "the contention probe did not force a retry")
        self.assertEqual(self._get(COLLECTIONS["plans"], PLAN["id"])["revision"], 9)

        result = self._create("forced-retry-key-0001")
        self.assertEqual(result["grant"]["planId"], PLAN["id"])
        stored_grant = self._get(COLLECTIONS["complimentary_grants"], result["grant"]["id"])
        self.assertEqual(stored_grant["planSnapshot"]["revision"], 9)
        state = self._assert_final_invariants(TARGET["uid"], NOW, expected_operations=1)
        self.assertEqual(state["pointer"]["revision"], 1)
        self.assertEqual(len(state["grants"]), 1)
        self.assertEqual(len(state["audits"]), 1)

    def test_real_store_indexes_equal_timestamp_ties_and_status_filtered_pages(self):
        """Validates Requirements 7.1, 7.4-7.5, 12.4-12.5, 17.5."""
        fixtures = [
            ("list-key-00000001", TARGET, "pro", {"type": "lifetime"}),
            ("list-key-00000002", {**TARGET, "uid": "target-two"}, "pro", {"type": "custom", "expiresAt": (NOW + timedelta(days=1)).isoformat()}),
            ("list-key-00000003", {**TARGET, "uid": "target-three"}, "elite", {"type": "lifetime"}),
            ("list-key-00000004", {**TARGET, "uid": "target-four", "email": "other@example.com", "emailNormalized": "other@example.com"}, "pro", {"type": "lifetime"}),
            ("list-key-00000005", {**TARGET, "uid": "target-five"}, "pro", {"type": "lifetime"}),
        ]
        created = []
        for key, target, plan_id, validity in fixtures:
            created.append(self._create(key, target=target, plan_id=plan_id, validity=validity))

        as_of = NOW + timedelta(days=2)
        records = {item["grant"]["id"]: item["grant"] for item in created}
        expected_all = sorted(records, reverse=True)
        cases = (
            ({"email": None, "planId": None, "status": None}, expected_all),
            ({"email": TARGET["email"], "planId": None, "status": None}, sorted([grant_id for grant_id, grant in records.items() if grant["targetEmail"] == TARGET["email"]], reverse=True)),
            ({"email": None, "planId": "pro", "status": None}, sorted([grant_id for grant_id, grant in records.items() if grant["planId"] == "pro"], reverse=True)),
            ({"email": TARGET["email"], "planId": "pro", "status": None}, sorted([grant_id for grant_id, grant in records.items() if grant["targetEmail"] == TARGET["email"] and grant["planId"] == "pro"], reverse=True)),
        )
        for filters, expected in cases:
            with self.subTest(filters=filters):
                page = self.store.list_complimentary_grants(filters=filters, limit=100, as_of=as_of)
                self.assertEqual([grant["id"] for grant in page["grants"]], expected)

        active_filters = {"email": None, "planId": None, "status": "active"}
        expected_active = sorted([
            grant_id for grant_id, grant in records.items()
            if grant["lifetime"] is True
        ], reverse=True)
        combined = []
        last_scanned = None
        for _page_number in range(10):
            page = self.store.list_complimentary_grants(
                filters=active_filters,
                limit=2,
                as_of=as_of,
                last_scanned=last_scanned,
            )
            combined.extend(grant["id"] for grant in page["grants"])
            if not page["hasMore"]:
                break
            self.assertIsNotNone(page["lastScanned"])
            last_scanned = page["lastScanned"]
        else:
            self.fail("status-filter pagination did not terminate")
        self.assertEqual(combined, expected_active)
        self.assertEqual(len(combined), len(set(combined)))


if __name__ == "__main__":
    unittest.main()
