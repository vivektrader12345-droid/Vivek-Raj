"""Task 21 release E2E against real Firebase Auth and Firestore emulators.

This suite traverses the authenticated Flask APIs with real emulator-issued ID
Tokens and the real FirestoreBillingStore. It prints a compact evidence record
containing the committed record IDs/counts and payment-domain preservation proof.
"""

from __future__ import annotations

import base64
import json
import os
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

import firebase_admin
from firebase_admin import auth as firebase_auth
from flask import Flask
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore as google_firestore

from billing_api import create_billing_blueprint
from billing_core import EffectiveEntitlementService, PlanCatalog
from billing_store import COLLECTIONS, FirestoreBillingStore
from razorpay_adapter import HmacTestRazorpayAdapter
from webhook_intelligence import create_webhook_blueprint


PROJECT_ID = "demo-complimentary-billing"
PASSWORD = "Task21-emulator-password-1!"
CURSOR_KEY = "task-21-release-cursor-signing-key-at-least-32-bytes"
PAYMENT_DOMAIN_KEYS = (
    "orders",
    "provider_orders",
    "payments",
    "payment_attempts",
    "subscriptions",
    "coupons",
    "coupon_users",
    "redemptions",
    "events",
)
ALL_COLLECTIONS = tuple(dict.fromkeys(COLLECTIONS.values()))


def _jwt_payload(token):
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))


def _auth_request(path, payload, *, form=False):
    host = os.environ["FIREBASE_AUTH_EMULATOR_HOST"]
    body = urlencode(payload).encode("utf-8") if form else json.dumps(payload).encode("utf-8")
    request = Request(
        "http://%s/%s" % (host, path),
        data=body,
        headers={
            "Content-Type": (
                "application/x-www-form-urlencoded"
                if form else "application/json"
            ),
        },
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


@unittest.skipUnless(
    os.environ.get("FIRESTORE_EMULATOR_HOST")
    and os.environ.get("FIREBASE_AUTH_EMULATOR_HOST"),
    "Firebase Auth and Firestore emulators are required for release E2E",
)
class ComplimentaryReleaseEmulatorE2ETests(unittest.TestCase):
    """Run the approved positive and negative Task 21 release scenario."""

    @classmethod
    def setUpClass(cls):
        cls.firebase_app = firebase_admin.initialize_app(
            options={"projectId": PROJECT_ID},
            name="task21-release-%s" % uuid4().hex,
        )
        cls.database = google_firestore.Client(
            project=os.environ.get("GCLOUD_PROJECT", PROJECT_ID),
            credentials=AnonymousCredentials(),
        )
        cls.store = FirestoreBillingStore(cls.database)
        cls.catalog = PlanCatalog.from_json(json.dumps([
            {
                "id": "basic",
                "name": "Basic",
                "amountPaise": 49900,
                "durationDays": 30,
                "features": ["Dashboard"],
                "active": True,
                "sortOrder": 0,
                "entitlementTier": "basic",
            },
            {
                "id": "pro",
                "name": "Pro",
                "amountPaise": 99900,
                "durationDays": 90,
                "features": ["Advanced analytics"],
                "active": True,
                "sortOrder": 1,
                "entitlementTier": "pro",
            },
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
        ]))
        cls._clear_database()
        cls._seed_plans_and_payment_domain()
        cls.users = {}
        cls.tokens = {}
        cls._create_auth_fixtures()
        cls.enabled_app = cls._make_app(capability_enabled=True)
        cls.disabled_app = cls._make_app(capability_enabled=False)
        cls.client = cls.enabled_app.test_client()
        cls.disabled_client = cls.disabled_app.test_client()

    @classmethod
    def tearDownClass(cls):
        for uid in cls.users.values():
            try:
                firebase_auth.delete_user(uid, app=cls.firebase_app)
            except Exception:
                pass
        cls._clear_database()
        cls.database.close()
        firebase_admin.delete_app(cls.firebase_app)

    @classmethod
    def _clear_database(cls):
        for collection_name in ALL_COLLECTIONS:
            collection = cls.database.collection(collection_name)
            while True:
                snapshots = list(collection.limit(200).stream())
                if not snapshots:
                    break
                batch = cls.database.batch()
                for snapshot in snapshots:
                    batch.delete(snapshot.reference)
                batch.commit()

    @classmethod
    def _seed_plans_and_payment_domain(cls):
        now = datetime.now(timezone.utc)
        plan_values = {
            "basic": {
                "id": "basic", "name": "Basic", "amountPaise": 49900,
                "durationDays": 30, "features": ["Dashboard"], "active": True,
                "sortOrder": 0, "entitlementTier": "basic", "revision": 1,
                "createdAt": now - timedelta(days=30), "updatedAt": now,
            },
            "pro": {
                "id": "pro", "name": "Pro", "amountPaise": 99900,
                "durationDays": 90, "features": ["Advanced analytics"], "active": True,
                "sortOrder": 1, "entitlementTier": "pro", "revision": 3,
                "createdAt": now - timedelta(days=30), "updatedAt": now,
            },
            "retired": {
                "id": "retired", "name": "Retired", "amountPaise": 19900,
                "durationDays": 7, "features": ["Historical feature"], "active": False,
                "sortOrder": 2, "entitlementTier": "basic", "revision": 2,
                "createdAt": now - timedelta(days=30), "updatedAt": now,
            },
        }
        for plan_id, value in plan_values.items():
            cls.database.collection(COLLECTIONS["plans"]).document(plan_id).set(value)

        # Marker documents make zero-payment preservation stronger than an
        # empty-collection count check. The target paid record must remain the
        # effective fallback after revocation.
        cls.database.collection(COLLECTIONS["subscriptions"]).document("target-task21").set({
            "userId": "target-task21",
            "status": "active",
            "planId": "basic",
            "entitlementTier": "basic",
            "startsAt": now - timedelta(days=2),
            "expiresAt": now + timedelta(days=20),
            "updatedAt": now - timedelta(days=1),
            "lastPaymentId": "payment-marker",
            "paymentCount": 1,
        })
        markers = {
            "orders": ("order-marker", {"status": "paid", "createdAt": now}),
            "provider_orders": ("provider-order-marker", {"billingOrderId": "order-marker", "createdAt": now}),
            "payments": ("payment-marker", {"userId": "target-task21", "status": "captured", "amountPaise": 49900, "createdAt": now}),
            "payment_attempts": ("attempt-marker", {"userId": "target-task21", "status": "failed", "createdAt": now}),
            "coupons": ("COUPON-MARKER", {"active": True, "usedCount": 1, "updatedAt": now}),
            "coupon_users": ("coupon-user-marker", {"userId": "target-task21", "usedCount": 1, "updatedAt": now}),
            "redemptions": ("redemption-marker", {"userId": "target-task21", "discountPaise": 100, "createdAt": now}),
            "events": ("event-marker", {"status": "completed", "createdAt": now}),
        }
        for key, (document_id, value) in markers.items():
            cls.database.collection(COLLECTIONS[key]).document(document_id).set(value)

    @classmethod
    def _create_user(cls, label, email, *, verified=True, disabled=False, admin=False):
        user = firebase_auth.create_user(
            uid="%s-task21" % label,
            email=email,
            password=PASSWORD,
            email_verified=verified,
            disabled=disabled,
            display_name=label.replace("-", " ").title(),
            app=cls.firebase_app,
        )
        cls.users[label] = user.uid
        if not disabled:
            signed_in = _auth_request(
                "identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key",
                {"email": email, "password": PASSWORD, "returnSecureToken": True},
            )
            auth_time = int(_jwt_payload(signed_in["idToken"])["auth_time"])
            claims = {"otp_auth_time": auth_time}
            if admin:
                claims["admin"] = True
            firebase_auth.set_custom_user_claims(user.uid, claims, app=cls.firebase_app)
            refreshed = _auth_request(
                "securetoken.googleapis.com/v1/token?key=demo-key",
                {
                    "grant_type": "refresh_token",
                    "refresh_token": signed_in["refreshToken"],
                },
                form=True,
            )
            cls.tokens[label] = refreshed.get("id_token") or refreshed["idToken"]
        return user

    @classmethod
    def _create_auth_fixtures(cls):
        cls._create_user("admin", "admin-task21@example.com", admin=True)
        cls._create_user("target", "target-task21@example.com")
        cls._create_user("ordinary", "ordinary-task21@example.com")
        cls._create_user("disabled", "disabled-task21@example.com", disabled=True)
        cls._create_user("unverified", "unverified-task21@example.com", verified=False)

    @classmethod
    def _make_app(cls, *, capability_enabled):
        prior = {
            "BILLING_COMPLIMENTARY_ADMIN_ENABLED": os.environ.get("BILLING_COMPLIMENTARY_ADMIN_ENABLED"),
            "BILLING_COMPLIMENTARY_CURSOR_SIGNING_KEY": os.environ.get("BILLING_COMPLIMENTARY_CURSOR_SIGNING_KEY"),
            "BILLING_COMPLIMENTARY_CURSOR_KEY_ID": os.environ.get("BILLING_COMPLIMENTARY_CURSOR_KEY_ID"),
        }
        os.environ["BILLING_COMPLIMENTARY_ADMIN_ENABLED"] = "true" if capability_enabled else "false"
        os.environ["BILLING_COMPLIMENTARY_CURSOR_SIGNING_KEY"] = CURSOR_KEY
        os.environ["BILLING_COMPLIMENTARY_CURSOR_KEY_ID"] = "task21"
        try:
            app = Flask("task21-release-%s-%s" % (capability_enabled, uuid4().hex))
            app.config["TESTING"] = True
            app.register_blueprint(create_billing_blueprint(
                cls.database,
                firebase_app=cls.firebase_app,
                store=cls.store,
                provider=HmacTestRazorpayAdapter(),
                catalog=cls.catalog,
            ))
            app.register_blueprint(create_webhook_blueprint(
                cls.database,
                firebase_app=cls.firebase_app,
                enforce_entitlements=True,
                entitlement_service=EffectiveEntitlementService(cls.store),
            ))
            return app
        finally:
            for key, value in prior.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    @staticmethod
    def _headers(token):
        return {"Authorization": "Bearer %s" % token}

    @classmethod
    def _documents(cls, key):
        return {
            snapshot.id: deepcopy(snapshot.to_dict() or {})
            for snapshot in cls.database.collection(COLLECTIONS[key]).stream()
        }

    @classmethod
    def _payment_snapshot(cls):
        return {key: cls._documents(key) for key in PAYMENT_DOMAIN_KEYS}

    @staticmethod
    def _assert_error(test_case, response, status, code):
        test_case.assertEqual(response.status_code, status, response.get_data(as_text=True))
        payload = response.get_json()
        test_case.assertEqual(payload["error"]["code"], code)
        test_case.assertTrue(payload["requestId"])

    def test_positive_real_auth_firestore_api_premium_list_revoke_and_preservation(self):
        """Validates Requirements 5.1-5.3, 7.1-7.3, 8.2-8.3, 9.2-9.4, 20.7-20.8."""
        admin_headers = self._headers(self.tokens["admin"])
        target_headers = self._headers(self.tokens["target"])
        payment_before = self._payment_snapshot()

        lookup = self.client.post(
            "/api/v1/admin/billing/users/lookup",
            headers=admin_headers,
            json={"email": "  TARGET-TASK21@EXAMPLE.COM  "},
        )
        self.assertEqual(lookup.status_code, 200, lookup.get_data(as_text=True))
        self.assertEqual(lookup.get_json()["user"]["uid"], "target-task21")
        self.assertTrue(lookup.get_json()["user"]["grantEligible"])
        self.assertEqual(lookup.get_json()["effectiveEntitlement"]["source"], "paid")

        created = self.client.post(
            "/api/v1/admin/billing/complimentary-grants",
            headers=admin_headers,
            json={
                "targetEmail": "target-task21@example.com",
                "planId": "pro",
                "validity": {"type": "lifetime"},
                "reason": "Task 21 controlled release canary",
                "idempotencyKey": "task21-positive-grant-key-0001",
            },
        )
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        created_body = created.get_json()
        grant_id = created_body["grant"]["id"]
        self.assertEqual(created_body["effectiveEntitlement"]["source"], "complimentary")
        self.assertEqual(created_body["effectiveEntitlement"]["entitlementTier"], "pro")
        self.assertEqual(created_body["paidFallback"]["source"], "paid")

        entitlement = self.client.get("/api/v1/billing/me", headers=target_headers)
        self.assertEqual(entitlement.status_code, 200, entitlement.get_data(as_text=True))
        self.assertEqual(entitlement.get_json()["subscription"]["grantId"], grant_id)
        self.assertEqual(entitlement.get_json()["subscription"]["source"], "complimentary")
        self.assertNotIn("paidFallback", entitlement.get_json())
        self.assertNotIn("reason", entitlement.get_json()["subscription"])

        premium = self.client.get("/api/v1/webhooks/endpoints", headers=target_headers)
        self.assertEqual(premium.status_code, 200, premium.get_data(as_text=True))

        listed = self.client.get(
            "/api/v1/admin/billing/complimentary-grants?email=target-task21%40example.com&planId=pro&status=active",
            headers=admin_headers,
        )
        self.assertEqual(listed.status_code, 200, listed.get_data(as_text=True))
        self.assertEqual([item["id"] for item in listed.get_json()["grants"]], [grant_id])
        self.assertEqual(listed.get_json()["grants"][0]["reason"], "Task 21 controlled release canary")

        revoked = self.client.post(
            "/api/v1/admin/billing/complimentary-grants/%s/revoke" % grant_id,
            headers=admin_headers,
            json={
                "reason": "Task 21 canary completed",
                "idempotencyKey": "task21-positive-revoke-key-001",
            },
        )
        self.assertEqual(revoked.status_code, 200, revoked.get_data(as_text=True))
        self.assertEqual(revoked.get_json()["grant"]["status"], "revoked")
        self.assertEqual(revoked.get_json()["effectiveEntitlement"]["source"], "paid")

        restored = self.client.get("/api/v1/billing/me", headers=target_headers)
        self.assertEqual(restored.status_code, 200, restored.get_data(as_text=True))
        self.assertEqual(restored.get_json()["subscription"]["source"], "paid")
        denied = self.client.get("/api/v1/webhooks/endpoints", headers=target_headers)
        self._assert_error(self, denied, 403, "subscription_required")

        payment_after = self._payment_snapshot()
        self.assertEqual(payment_after, payment_before)
        grants = self._documents("complimentary_grants")
        pointers = self._documents("complimentary_users")
        operations = self._documents("complimentary_operations")
        audits = self._documents("complimentary_audit")
        self.assertEqual(set(grants), {grant_id})
        self.assertEqual(grants[grant_id]["storedStatus"], "revoked")
        self.assertEqual(pointers["target-task21"]["activeGrantId"], None)
        self.assertEqual(len(operations), 2)
        self.assertEqual(len(audits), 2)

        evidence = {
            "grantId": grant_id,
            "complimentaryRecordIds": {
                "grants": sorted(grants),
                "pointers": sorted(pointers),
                "operations": sorted(operations),
                "audit": sorted(audits),
            },
            "complimentaryCounts": {
                "grants": len(grants),
                "pointers": len(pointers),
                "operations": len(operations),
                "audit": len(audits),
            },
            "paymentDomainRecordIds": {
                key: sorted(values) for key, values in payment_after.items()
            },
            "paymentDomainCounts": {
                key: len(values) for key, values in payment_after.items()
            },
            "paymentDomainPreserved": payment_after == payment_before,
            "restoredSource": restored.get_json()["subscription"]["source"],
        }
        print("TASK21_E2E_EVIDENCE=" + json.dumps(evidence, sort_keys=True))

    def test_negative_real_auth_firestore_api_cases_fail_closed(self):
        """Validates Requirements 2.3-2.4, 3.3, 11.3-11.5, 14.3-14.5, 20.5, 20.7."""
        admin_headers = self._headers(self.tokens["admin"])
        ordinary_headers = self._headers(self.tokens["ordinary"])
        payment_before = self._payment_snapshot()
        grants_before = self._documents("complimentary_grants")

        unauthorized = self.client.post(
            "/api/v1/admin/billing/users/lookup",
            headers=ordinary_headers,
            json={"email": "target-task21@example.com"},
        )
        self._assert_error(self, unauthorized, 403, "admin_required")

        disabled_capability = self.disabled_client.post(
            "/api/v1/admin/billing/users/lookup",
            headers=admin_headers,
            json={"email": "target-task21@example.com"},
        )
        self._assert_error(self, disabled_capability, 403, "admin_capability_required")

        unknown = self.client.post(
            "/api/v1/admin/billing/users/lookup",
            headers=admin_headers,
            json={"email": "unknown-task21@example.com"},
        )
        self._assert_error(self, unknown, 404, "user_not_found")

        for label, expected_code in (
            ("disabled", "target_disabled"),
            ("unverified", "target_email_unverified"),
        ):
            response = self.client.post(
                "/api/v1/admin/billing/complimentary-grants",
                headers=admin_headers,
                json={
                    "targetEmail": "%s-task21@example.com" % label,
                    "planId": "pro",
                    "validity": {"type": "lifetime"},
                    "idempotencyKey": "task21-negative-%s-key-001" % label,
                },
            )
            self._assert_error(self, response, 409, expected_code)

        inactive = self.client.post(
            "/api/v1/admin/billing/complimentary-grants",
            headers=admin_headers,
            json={
                "targetEmail": "target-task21@example.com",
                "planId": "retired",
                "validity": {"type": "lifetime"},
                "idempotencyKey": "task21-negative-inactive-key-01",
            },
        )
        self._assert_error(self, inactive, 409, "plan_inactive")

        forged_fields = {
            "isAdmin": True,
            "adminCapabilities": {"complimentarySubscriptions": True},
            "targetUid": "target-task21",
            "planName": "Elite",
            "price": 0,
            "activationAt": "2000-01-01T00:00:00Z",
            "status": "active",
        }
        for index, (field, value) in enumerate(forged_fields.items()):
            forged = self.client.post(
                "/api/v1/admin/billing/complimentary-grants",
                headers=admin_headers,
                json={
                    "targetEmail": "target-task21@example.com",
                    "planId": "pro",
                    "validity": {"type": "lifetime"},
                    "idempotencyKey": "task21-forged-field-key-%03d" % index,
                    field: value,
                },
            )
            self._assert_error(self, forged, 400, "unexpected_fields")

        self.assertEqual(self._documents("complimentary_grants"), grants_before)
        self.assertEqual(self._payment_snapshot(), payment_before)

        # A malformed selected grant/pointer fails closed on the authenticated
        # target entitlement read and never falls through to its paid fallback.
        now = datetime.now(timezone.utc)
        self.database.collection(COLLECTIONS["complimentary_users"]).document("target-task21").set({
            "targetUid": "target-task21",
            "activeGrantId": "missing-task21-grant",
            "revision": 3,
            "updatedAt": now,
            "schemaVersion": 1,
        })
        try:
            malformed = self.client.get(
                "/api/v1/billing/me",
                headers=self._headers(self.tokens["target"]),
            )
            self._assert_error(self, malformed, 503, "billing_data_inconsistent")
        finally:
            self.database.collection(COLLECTIONS["complimentary_users"]).document("target-task21").delete()


if __name__ == "__main__":
    unittest.main()
