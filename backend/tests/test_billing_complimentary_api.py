"""Regression-first Flask contracts for complimentary subscription administration.

Task 9 intentionally specifies the Task 10 administrator API/capability boundary
and Task 11 ``/billing/me`` resolver integration before those routes are wired.
The tests use the real in-memory billing store and complimentary transition logic;
only Firebase token verification and Firebase Admin user lookup are replaced at the
external boundary.
"""

import json
import os
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

from firebase_admin import auth as firebase_auth
from flask import Flask

from billing_api import create_billing_blueprint
from billing_core import ComplimentaryBillingService, MemoryBillingStore, PlanCatalog
from razorpay_adapter import HmacTestRazorpayAdapter


UTC = timezone.utc
FIXED_NOW = datetime(2030, 1, 15, 12, 0, tzinfo=UTC)
TARGET_EMAIL = "person@example.com"
TARGET_UID = "target-user-1"
ADMIN_UID = "admin-user-1"
ADMIN_EMAIL = "claim-admin@example.com"
ALLOWLIST_EMAIL = "allowlisted-admin@example.com"
CAPABILITY_ENV = "BILLING_COMPLIMENTARY_ADMIN_ENABLED"
CURSOR_ENV = "BILLING_COMPLIMENTARY_CURSOR_SIGNING_KEY"
OMITTED = object()

ADMIN_GRANT_FIELDS = {
    "id", "targetUid", "targetEmail", "targetDisplayName", "planId",
    "planName", "entitlementTier", "features", "validityType",
    "presetDays", "activationAt", "expiresAt", "lifetime", "status",
    "createdAt", "updatedAt", "createdBy", "reason", "endedAt",
    "endReason", "revokedBy", "supersededByGrantId", "supersededBy",
    "source", "complimentary",
}
MUTATION_FIELDS = {
    "grant", "effectiveEntitlement", "paidFallback", "duplicate", "requestId",
}


class FixedClock:
    def __init__(self, value=FIXED_NOW):
        self.value = value

    def __call__(self):
        return self.value


class ObservedMemoryBillingStore(MemoryBillingStore):
    """Records only reads/mutations protected by complimentary authorization."""

    def __init__(self):
        super().__init__()
        self.protected_calls = []

    def get_effective_entitlement(self, uid, now, require_valid_paid=True):
        self.protected_calls.append(("effective", uid))
        return super().get_effective_entitlement(uid, now, require_valid_paid)

    def create_complimentary_grant(self, **kwargs):
        self.protected_calls.append(("create", kwargs.get("target", {}).get("uid")))
        return super().create_complimentary_grant(**kwargs)

    def revoke_complimentary_grant(self, **kwargs):
        self.protected_calls.append(("revoke", kwargs.get("grant_id")))
        return super().revoke_complimentary_grant(**kwargs)

    def list_complimentary_grants(self, **kwargs):
        self.protected_calls.append(("list", deepcopy(kwargs.get("filters"))))
        return super().list_complimentary_grants(**kwargs)


class ComplimentaryApiContractFixtures:
    def setUp(self):
        self.clock = FixedClock()
        self.store = ObservedMemoryBillingStore()
        self.provider = HmacTestRazorpayAdapter()
        self.catalog = PlanCatalog.from_json(json.dumps([
            {
                "id": "basic", "name": "Basic", "amountPaise": 49900,
                "durationDays": 30, "features": ["Trading dashboard"],
                "active": True, "sortOrder": 0, "entitlementTier": "basic",
            },
            {
                "id": "pro", "name": "Pro", "amountPaise": 99900,
                "durationDays": 90, "features": ["Advanced analytics"],
                "active": True, "sortOrder": 1, "entitlementTier": "pro",
            },
            {
                "id": "retired", "name": "Retired", "amountPaise": 19900,
                "durationDays": 7, "features": ["Historical feature"],
                "active": False, "sortOrder": 2, "entitlementTier": "basic",
            },
        ]))
        self.users = {
            TARGET_EMAIL: self.firebase_user(TARGET_UID, TARGET_EMAIL),
            "disabled@example.com": self.firebase_user(
                "disabled-user", "disabled@example.com", disabled=True,
            ),
            "unverified@example.com": self.firebase_user(
                "unverified-user", "unverified@example.com", email_verified=False,
            ),
        }
        self.app, self.client = self.make_client()

    @staticmethod
    def firebase_user(uid, email, *, email_verified=True, disabled=False, display_name="Person"):
        return SimpleNamespace(
            uid=uid,
            email=email,
            email_verified=email_verified,
            disabled=disabled,
            display_name=display_name,
        )

    @staticmethod
    def admin_token(*, claim=True, email=ADMIN_EMAIL):
        value = {
            "uid": ADMIN_UID,
            "email": email,
            "email_verified": True,
            "firebase": {"sign_in_provider": "google.com"},
        }
        if claim:
            value["admin"] = True
        return value

    @staticmethod
    def ordinary_token():
        return {
            "uid": "ordinary-user",
            "email": "ordinary@example.com",
            "email_verified": True,
            "firebase": {"sign_in_provider": "google.com"},
        }

    def make_client(self, capability="true"):
        firebase_app = object()
        environment = {
            "BILLING_ADMIN_EMAILS": ALLOWLIST_EMAIL,
            CURSOR_ENV: "task-9-test-cursor-key-with-at-least-32-bytes",
        }
        if capability is not OMITTED:
            environment[CAPABILITY_ENV] = str(capability)
        with patch.dict(os.environ, environment, clear=False):
            if capability is OMITTED:
                os.environ.pop(CAPABILITY_ENV, None)
            with patch("billing_api.utc_now", self.clock):
                app = Flask("complimentary-api-%s" % id(self))
                app.config["TESTING"] = True
                app.config["TASK9_FIREBASE_APP"] = firebase_app
                app.register_blueprint(create_billing_blueprint(
                    None,
                    firebase_app=firebase_app,
                    store=self.store,
                    provider=self.provider,
                    catalog=self.catalog,
                ))
        return app, app.test_client()

    @staticmethod
    def headers():
        return {"Authorization": "Bearer task-9-token"}

    def firebase_lookup(self, normalized_email, app=None):
        del app
        return self.users.get(normalized_email)

    def request_as(self, token, method, path, *, json_body=None, lookup=None, client=None):
        selected_client = client or self.client
        with patch("billing_api.firebase_auth.verify_id_token", return_value=token) as verify:
            with patch(
                "billing_api.firebase_auth.get_user_by_email",
                side_effect=lookup or self.firebase_lookup,
                create=True,
            ) as get_user:
                response = selected_client.open(
                    path,
                    method=method,
                    headers=self.headers(),
                    json=json_body,
                )
        return response, verify, get_user

    def admin_request(self, method, path, *, json_body=None, lookup=None, client=None, token=None):
        return self.request_as(
            token or self.admin_token(), method, path,
            json_body=json_body, lookup=lookup, client=client,
        )[0]

    def assert_error(self, response, status, code, field=None):
        self.assertEqual(response.status_code, status, response.get_data(as_text=True))
        payload = response.get_json()
        self.assertIsInstance(
            payload, dict,
            "Expected structured JSON error envelope, got: %s" % response.get_data(as_text=True),
        )
        self.assertEqual(set(payload), {"error", "requestId"})
        self.assertEqual(payload["error"]["code"], code)
        self.assertIsInstance(payload["error"]["message"], str)
        self.assertTrue(payload["requestId"])
        if field is not None:
            self.assertEqual(payload["error"].get("details", {}).get("field"), field)
        self.assertNotIn("task-9-token", response.get_data(as_text=True))
        return payload

    def paid_record(self, uid=TARGET_UID):
        return {
            "userId": uid,
            "status": "active",
            "planId": "basic",
            "entitlementTier": "basic",
            "startsAt": FIXED_NOW - timedelta(days=5),
            "expiresAt": FIXED_NOW + timedelta(days=20),
            "updatedAt": FIXED_NOW - timedelta(days=1),
            "lastPaymentId": "pay-preserved",
            "paymentCount": 2,
        }

    def create_direct_grant(self, *, validity=None, key="direct-grant-key-001"):
        service = ComplimentaryBillingService(
            self.store,
            self.catalog,
            lambda email: self.users.get(email),
            clock=self.clock,
            cursor_signing_key="task-9-test-cursor-key-with-at-least-32-bytes",
            cursor_key_id="v1",
        )
        return service.create_grant(
            actor={"uid": ADMIN_UID, "email": ADMIN_EMAIL},
            target_email=TARGET_EMAIL,
            plan_id="pro",
            validity=validity or {"type": "preset", "days": 30},
            reason="Support resolution",
            idempotency_key=key,
        )


class ComplimentaryApiAuthorizationContracts(
    ComplimentaryApiContractFixtures, unittest.TestCase,
):
    LOOKUP_PATH = "/api/v1/admin/billing/users/lookup"

    # **Validates: Requirements 11.1, 11.3, 11.5, 18.1, 18.7**
    def test_unauthenticated_invalid_expired_and_revoked_tokens_fail_before_reads(self):
        missing = self.client.post(self.LOOKUP_PATH, json={"email": TARGET_EMAIL})
        self.assert_error(missing, 401, "authentication_required")

        failures = (
            (firebase_auth.InvalidIdTokenError("sensitive-invalid"), 401, "invalid_token"),
            (firebase_auth.ExpiredIdTokenError("expired", RuntimeError("cause")), 401, "token_expired"),
            (firebase_auth.RevokedIdTokenError("sensitive-revoked"), 401, "token_revoked"),
        )
        for error, status, code in failures:
            with self.subTest(code=code):
                with patch("billing_api.firebase_auth.verify_id_token", side_effect=error) as verify:
                    with patch(
                        "billing_api.firebase_auth.get_user_by_email", create=True,
                    ) as get_user:
                        response = self.client.post(
                            self.LOOKUP_PATH,
                            headers=self.headers(),
                            json={"email": TARGET_EMAIL},
                        )
                self.assert_error(response, status, code)
                verify.assert_called_once_with(
                    "task-9-token",
                    app=self.app.config["TASK9_FIREBASE_APP"],
                    check_revoked=True,
                )
                get_user.assert_not_called()
        self.assertEqual(self.store.protected_calls, [])

    # **Validates: Requirements 1.3-1.5, 11.1, 11.3-11.5, 20.1**
    def test_stale_otp_non_admin_and_each_disabled_capability_shape_fail_closed(self):
        stale_otp = {
            "uid": ADMIN_UID,
            "email": ADMIN_EMAIL,
            "email_verified": True,
            "admin": True,
            "auth_time": 200,
            "otp_auth_time": 199,
            "firebase": {"sign_in_provider": "password"},
        }
        response, _, get_user = self.request_as(
            stale_otp, "POST", self.LOOKUP_PATH, json_body={"email": TARGET_EMAIL},
        )
        self.assert_error(response, 403, "otp_required")
        get_user.assert_not_called()

        response, _, get_user = self.request_as(
            self.ordinary_token(), "POST", self.LOOKUP_PATH,
            json_body={"email": TARGET_EMAIL},
        )
        self.assert_error(response, 403, "admin_required")
        get_user.assert_not_called()

        for capability in ("false", OMITTED, "not-a-boolean", ""):
            with self.subTest(capability=repr(capability)):
                _, client = self.make_client(capability)
                response, _, get_user = self.request_as(
                    self.admin_token(), "POST", self.LOOKUP_PATH,
                    json_body={"email": TARGET_EMAIL}, client=client,
                )
                self.assert_error(response, 403, "admin_capability_required")
                get_user.assert_not_called()
        self.assertEqual(self.store.protected_calls, [])

    # **Validates: Requirements 1.4-1.5, 2.6, 7.4, 11.3-11.5, 20.5**
    def test_capability_denial_precedes_every_target_plan_grant_paid_or_audit_read(self):
        _, client = self.make_client("false")
        requests = (
            ("POST", self.LOOKUP_PATH, {"email": TARGET_EMAIL}),
            ("GET", "/api/v1/admin/billing/complimentary-grants", None),
            ("POST", "/api/v1/admin/billing/complimentary-grants", {
                "targetEmail": TARGET_EMAIL,
                "planId": "pro",
                "validity": {"type": "lifetime"},
                "idempotencyKey": "capability-denial-key-001",
            }),
            ("POST", "/api/v1/admin/billing/complimentary-grants/grant-12345678/revoke", {
                "idempotencyKey": "capability-denial-key-002",
            }),
        )
        with patch("billing_api.firebase_auth.verify_id_token", return_value=self.admin_token()):
            with patch(
                "billing_api.firebase_auth.get_user_by_email", create=True,
            ) as get_user:
                for method, path, body in requests:
                    with self.subTest(method=method, path=path):
                        response = client.open(
                            path, method=method, headers=self.headers(), json=body,
                        )
                        self.assert_error(response, 403, "admin_capability_required")
        get_user.assert_not_called()
        self.assertEqual(self.store.protected_calls, [])

    # **Validates: Requirements 1.5, 11.4, 14.3, 17.1-17.2, 20.5**
    def test_forged_admin_capability_uid_plan_price_time_status_and_actor_are_rejected(self):
        base = {
            "targetEmail": TARGET_EMAIL,
            "planId": "pro",
            "validity": {"type": "preset", "days": 30},
            "idempotencyKey": "forged-field-key-0001",
        }
        forged_fields = {
            "isAdmin": True,
            "adminCapabilities": {"complimentarySubscriptions": True},
            "complimentarySubscriptions": True,
            "targetUid": TARGET_UID,
            "uid": TARGET_UID,
            "planName": "Elite",
            "entitlementTier": "elite",
            "features": ["Everything"],
            "price": 0,
            "amountPaise": 0,
            "activationAt": "2000-01-01T00:00:00Z",
            "expiresAt": "2099-01-01T00:00:00Z",
            "source": "complimentary",
            "status": "active",
            "actor": {"uid": ADMIN_UID},
            "createdBy": {"uid": ADMIN_UID, "email": ADMIN_EMAIL},
        }
        for field, value in forged_fields.items():
            with self.subTest(field=field):
                before = deepcopy(self.store.complimentary_grants)
                response = self.admin_request(
                    "POST", "/api/v1/admin/billing/complimentary-grants",
                    json_body={**base, field: value},
                )
                payload = self.assert_error(response, 400, "unexpected_fields")
                self.assertEqual(payload["error"]["details"]["fields"], [field])
                self.assertEqual(self.store.complimentary_grants, before)

    # **Validates: Requirements 11.1, 11.3, 17.1, 18.1**
    def test_custom_claim_and_verified_allowlist_admins_are_both_authorized(self):
        cases = (
            self.admin_token(claim=True),
            self.admin_token(claim=False, email="  %s  " % ALLOWLIST_EMAIL.upper()),
        )
        for token in cases:
            with self.subTest(token=token):
                response, verify, get_user = self.request_as(
                    token, "POST", self.LOOKUP_PATH,
                    json_body={"email": "  PERSON@EXAMPLE.COM  "},
                )
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                verify.assert_called_once()
                self.assertTrue(verify.call_args.kwargs["check_revoked"])
                get_user.assert_called_once()


class ComplimentaryLookupContracts(ComplimentaryApiContractFixtures, unittest.TestCase):
    PATH = "/api/v1/admin/billing/users/lookup"

    # **Validates: Requirements 2.1-2.4, 2.6, 9.1, 9.4, 13.3-13.4, 20.1**
    def test_exact_lookup_normalizes_and_returns_only_minimum_fields_with_fallback(self):
        self.store.subscriptions[TARGET_UID] = self.paid_record()
        response, _, get_user = self.request_as(
            self.admin_token(), "POST", self.PATH,
            json_body={"email": "  PERSON@EXAMPLE.COM  "},
        )
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()
        self.assertEqual(
            set(payload),
            {"user", "effectiveEntitlement", "paidFallback", "requestId"},
        )
        self.assertEqual(set(payload["user"]), {
            "uid", "email", "emailVerified", "displayName", "disabled", "grantEligible",
        })
        self.assertEqual(payload["user"]["uid"], TARGET_UID)
        self.assertEqual(payload["user"]["email"], TARGET_EMAIL)
        self.assertTrue(payload["user"]["grantEligible"])
        self.assertEqual(payload["effectiveEntitlement"]["source"], "paid")
        self.assertEqual(payload["paidFallback"]["planId"], "basic")
        get_user.assert_called_once_with(TARGET_EMAIL, app=unittest.mock.ANY)

    # **Validates: Requirements 2.3, 2.6, 13.4, 14.1, 20.1**
    def test_lookup_rejects_invalid_unknown_fields_not_found_and_partial_enumeration(self):
        invalid_values = (None, 7, "", "not-an-email", "x" * 255 + "@example.com")
        for value in invalid_values:
            with self.subTest(value=repr(value)):
                response = self.admin_request("POST", self.PATH, json_body={"email": value})
                self.assert_error(response, 400, "invalid_email", "email")

        unexpected = self.admin_request(
            "POST", self.PATH, json_body={"email": TARGET_EMAIL, "uid": TARGET_UID},
        )
        self.assert_error(unexpected, 400, "unexpected_fields")

        not_found = self.admin_request(
            "POST", self.PATH, json_body={"email": "person@example.co"},
        )
        self.assert_error(not_found, 404, "user_not_found")

        partial = self.admin_request("GET", self.PATH + "?email=person")
        self.assertEqual(partial.status_code, 405)

    # **Validates: Requirements 2.3-2.4, 5.2, 13.4, 14.5, 20.1**
    def test_lookup_reports_ineligible_users_and_creates_no_account_profile_or_grant(self):
        before = deepcopy({
            "grants": self.store.complimentary_grants,
            "users": self.store.complimentary_users,
            "operations": self.store.complimentary_operations,
            "audit": self.store.complimentary_audit,
        })
        cases = (
            ("disabled@example.com", True, True),
            ("unverified@example.com", False, False),
        )
        for email, disabled, verified in cases:
            with self.subTest(email=email):
                response = self.admin_request("POST", self.PATH, json_body={"email": email})
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                user = response.get_json()["user"]
                self.assertEqual(user["disabled"], disabled)
                self.assertEqual(user["emailVerified"], verified)
                self.assertFalse(user["grantEligible"])
        after = {
            "grants": self.store.complimentary_grants,
            "users": self.store.complimentary_users,
            "operations": self.store.complimentary_operations,
            "audit": self.store.complimentary_audit,
        }
        self.assertEqual(after, before)

    # **Validates: Requirements 2.3, 11.5, 13.4, 14.5**
    def test_lookup_auth_dependency_failure_is_sanitized(self):
        response = self.admin_request(
            "POST", self.PATH,
            json_body={"email": TARGET_EMAIL},
            lookup=Mock(side_effect=RuntimeError("firebase-secret-detail")),
        )
        self.assert_error(response, 503, "auth_service_unavailable")
        self.assertNotIn("firebase-secret-detail", response.get_data(as_text=True))


class ComplimentaryMutationAndListContracts(
    ComplimentaryApiContractFixtures, unittest.TestCase,
):
    COLLECTION = "/api/v1/admin/billing/complimentary-grants"

    def valid_create(self, **overrides):
        value = {
            "targetEmail": TARGET_EMAIL,
            "planId": "pro",
            "validity": {"type": "preset", "days": 30},
            "reason": "  Customer support resolution  ",
            "idempotencyKey": "grant-api-operation-0001",
        }
        value.update(overrides)
        return value

    # **Validates: Requirements 3.2-3.4, 4.1-4.4, 13.2-13.4, 14.1-14.3, 17.2**
    def test_create_validation_errors_have_exact_codes_statuses_and_fields(self):
        cases = (
            ({"targetEmail": None}, 400, "invalid_email", "email"),
            ({"planId": "bad plan"}, 400, "invalid_plan_id", "planId"),
            ({"validity": None}, 400, "invalid_validity", "validity"),
            ({"validity": {"type": "preset", "days": 29}}, 400, "invalid_validity", "validity"),
            ({"validity": {"type": "custom", "expiresAt": "2020-01-01T00:00:00Z"}}, 400, "invalid_expiration", "validity.expiresAt"),
            ({"reason": "unsafe<script>"}, 400, "invalid_reason", "reason"),
            ({"idempotencyKey": "short"}, 400, "invalid_idempotency_key", "idempotencyKey"),
        )
        for override, status, code, field in cases:
            with self.subTest(code=code, override=override):
                response = self.admin_request(
                    "POST", self.COLLECTION,
                    json_body=self.valid_create(**override),
                )
                self.assert_error(response, status, code, field)
        self.assertEqual(self.store.complimentary_grants, {})

    # **Validates: Requirements 3.3, 9.5, 13.4, 14.4, 20.1**
    def test_create_relooks_up_target_and_rechecks_inactive_plan_and_paid_consistency(self):
        first = self.admin_request(
            "POST", self.COLLECTION,
            json_body=self.valid_create(idempotencyKey="target-relookup-key-001"),
        )
        self.assertEqual(first.status_code, 201, first.get_data(as_text=True))

        self.users[TARGET_EMAIL].disabled = True
        disabled = self.admin_request(
            "POST", self.COLLECTION,
            json_body=self.valid_create(idempotencyKey="target-relookup-key-002"),
        )
        self.assert_error(disabled, 409, "target_disabled")
        self.users[TARGET_EMAIL].disabled = False

        inactive = self.admin_request(
            "POST", self.COLLECTION,
            json_body=self.valid_create(
                planId="retired", idempotencyKey="inactive-plan-key-001",
            ),
        )
        self.assert_error(inactive, 409, "plan_inactive")

        self.store.subscriptions[TARGET_UID] = self.paid_record()
        self.store.subscriptions[TARGET_UID]["expiresAt"] = "malformed-sensitive-paid-state"
        inconsistent = self.admin_request(
            "POST", self.COLLECTION,
            json_body=self.valid_create(idempotencyKey="paid-conflict-key-001"),
        )
        self.assert_error(inconsistent, 503, "billing_data_inconsistent")
        self.assertNotIn("malformed-sensitive-paid-state", inconsistent.get_data(as_text=True))

    # **Validates: Requirements 2.3-2.4, 3.3, 4.1-4.4, 5.1, 9.5, 13.3-13.4, 14.4, 20.1**
    def test_create_accepts_every_validity_and_reports_target_plan_race_errors(self):
        validity_cases = (
            ({"type": "preset", "days": 7}, "preset", 7, "2030-01-22T12:00:00Z"),
            ({"type": "preset", "days": 30}, "preset", 30, "2030-02-14T12:00:00Z"),
            ({"type": "preset", "days": 90}, "preset", 90, "2030-04-15T12:00:00Z"),
            ({"type": "preset", "days": 365}, "preset", 365, "2031-01-15T12:00:00Z"),
            ({"type": "custom", "expiresAt": "2030-02-01T18:30:00+05:30"}, "custom", None, "2030-02-01T13:00:00Z"),
            ({"type": "lifetime"}, "lifetime", None, None),
        )
        for iteration, (validity, expected_type, expected_days, expected_expiry) in enumerate(validity_cases):
            with self.subTest(validity=validity):
                self.store.complimentary_grants.clear()
                self.store.complimentary_users.clear()
                self.store.complimentary_operations.clear()
                self.store.complimentary_audit.clear()
                response = self.admin_request(
                    "POST", self.COLLECTION,
                    json_body=self.valid_create(
                        validity=validity,
                        idempotencyKey="all-validity-api-%03d" % iteration,
                    ),
                )
                self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
                payload = response.get_json()
                self.assertEqual(payload["grant"]["activationAt"], "2030-01-15T12:00:00Z")
                self.assertEqual(payload["grant"]["validityType"], expected_type)
                self.assertEqual(payload["grant"]["presetDays"], expected_days)
                self.assertEqual(payload["grant"]["expiresAt"], expected_expiry)
                self.assertEqual(payload["grant"]["lifetime"], expected_type == "lifetime")
                self.assertEqual(payload["effectiveEntitlement"]["source"], "complimentary")

        error_cases = (
            (
                self.valid_create(
                    planId="missing-plan",
                    idempotencyKey="missing-plan-api-key-001",
                ),
                None,
                404,
                "plan_not_found",
            ),
            (
                self.valid_create(
                    targetEmail="unverified@example.com",
                    idempotencyKey="unverified-api-key-001",
                ),
                None,
                409,
                "target_email_unverified",
            ),
            (
                self.valid_create(idempotencyKey="target-race-api-key-001"),
                lambda _email, app=None: self.firebase_user(
                    TARGET_UID, "changed@example.com",
                ),
                409,
                "target_state_conflict",
            ),
            (
                self.valid_create(idempotencyKey="missing-email-api-key-001"),
                lambda _email, app=None: self.firebase_user(TARGET_UID, None),
                409,
                "target_email_missing",
            ),
        )
        for request, lookup, status, code in error_cases:
            with self.subTest(code=code):
                before = deepcopy((
                    self.store.complimentary_grants,
                    self.store.complimentary_users,
                    self.store.complimentary_operations,
                    self.store.complimentary_audit,
                ))
                response = self.admin_request(
                    "POST", self.COLLECTION, json_body=request, lookup=lookup,
                )
                self.assert_error(response, status, code)
                self.assertEqual((
                    self.store.complimentary_grants,
                    self.store.complimentary_users,
                    self.store.complimentary_operations,
                    self.store.complimentary_audit,
                ), before)

    # **Validates: Requirements 5.3, 8.2, 9.4, 13.2-13.4, 16.1-16.2**
    def test_create_and_revoke_success_replay_conflict_and_paid_fallback_contracts(self):
        self.store.subscriptions[TARGET_UID] = self.paid_record()
        request = self.valid_create(validity={"type": "lifetime"})
        created = self.admin_request("POST", self.COLLECTION, json_body=request)
        replay = self.admin_request("POST", self.COLLECTION, json_body=request)

        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        self.assertEqual(replay.status_code, 200, replay.get_data(as_text=True))
        first = created.get_json()
        duplicate = replay.get_json()
        self.assertEqual(set(first), MUTATION_FIELDS)
        self.assertEqual(set(first["grant"]), ADMIN_GRANT_FIELDS)
        self.assertFalse(first["duplicate"])
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(first["grant"], duplicate["grant"])
        self.assertEqual(first["effectiveEntitlement"]["source"], "complimentary")
        self.assertTrue(first["effectiveEntitlement"]["lifetime"])
        self.assertEqual(first["paidFallback"]["source"], "paid")
        self.assertNotEqual(first["requestId"], duplicate["requestId"])

        conflict = self.admin_request(
            "POST", self.COLLECTION,
            json_body={**request, "planId": "basic"},
        )
        self.assert_error(conflict, 409, "idempotency_conflict")

        grant_id = first["grant"]["id"]
        revoke_path = "%s/%s/revoke" % (self.COLLECTION, grant_id)
        revoke_body = {
            "reason": "No longer required",
            "idempotencyKey": "revoke-api-operation-001",
        }
        revoked = self.admin_request("POST", revoke_path, json_body=revoke_body)
        revoked_replay = self.admin_request("POST", revoke_path, json_body=revoke_body)
        self.assertEqual(revoked.status_code, 200, revoked.get_data(as_text=True))
        self.assertEqual(revoked_replay.status_code, 200, revoked_replay.get_data(as_text=True))
        self.assertEqual(set(revoked.get_json()), MUTATION_FIELDS)
        self.assertEqual(revoked.get_json()["grant"]["status"], "revoked")
        self.assertEqual(revoked.get_json()["effectiveEntitlement"]["source"], "paid")
        self.assertFalse(revoked.get_json()["duplicate"])
        self.assertTrue(revoked_replay.get_json()["duplicate"])

        ended_conflict = self.admin_request(
            "POST", revoke_path,
            json_body={**revoke_body, "idempotencyKey": "revoke-api-operation-002"},
        )
        self.assert_error(ended_conflict, 409, "grant_state_conflict")

    # **Validates: Requirements 8.2-8.5, 13.2-13.4, 14.2-14.3**
    def test_revoke_strict_fields_identifier_key_and_not_found_errors(self):
        cases = (
            ("bad id", {"idempotencyKey": "valid-revoke-key-001"}, 400, "invalid_grant_id", "grantId"),
            ("grant-12345678", {"idempotencyKey": "short"}, 400, "invalid_idempotency_key", "idempotencyKey"),
            ("grant-12345678", {"idempotencyKey": "valid-revoke-key-001", "actor": ADMIN_UID}, 400, "unexpected_fields", None),
            ("grant-12345678", {"idempotencyKey": "valid-revoke-key-001"}, 404, "grant_not_found", None),
        )
        for grant_id, body, status, code, field in cases:
            with self.subTest(code=code):
                response = self.admin_request(
                    "POST", "%s/%s/revoke" % (self.COLLECTION, grant_id),
                    json_body=body,
                )
                self.assert_error(response, status, code, field)

    # **Validates: Requirements 7.1-7.6, 13.3-13.4, 14.3**
    def test_list_exact_fields_filters_empty_state_and_validation_errors(self):
        empty = self.admin_request("GET", self.COLLECTION + "?limit=25")
        self.assertEqual(empty.status_code, 200, empty.get_data(as_text=True))
        self.assertEqual(empty.get_json()["grants"], [])
        self.assertEqual(set(empty.get_json()), {"grants", "page", "requestId"})
        self.assertEqual(set(empty.get_json()["page"]), {"limit", "nextCursor", "asOf"})

        self.create_direct_grant(validity={"type": "lifetime"})
        listed = self.admin_request(
            "GET",
            self.COLLECTION + "?limit=1&email=PERSON%40EXAMPLE.COM&planId=pro&status=active",
        )
        self.assertEqual(listed.status_code, 200, listed.get_data(as_text=True))
        payload = listed.get_json()
        self.assertEqual(len(payload["grants"]), 1)
        self.assertEqual(set(payload["grants"][0]), ADMIN_GRANT_FIELDS)
        self.assertEqual(payload["grants"][0]["targetEmail"], TARGET_EMAIL)
        self.assertEqual(payload["grants"][0]["status"], "active")

        invalid_cases = (
            ("?unexpected=true", 400, "unexpected_fields", None),
            ("?limit=0", 400, "invalid_limit", "limit"),
            ("?status=pending", 400, "invalid_filter", "status"),
            ("?planId=bad%20plan", 400, "invalid_plan_id", "planId"),
            ("?cursor=not-a-signed-cursor", 400, "invalid_cursor", "cursor"),
        )
        for query, status, code, field in invalid_cases:
            with self.subTest(query=query):
                response = self.admin_request("GET", self.COLLECTION + query)
                self.assert_error(response, status, code, field)

    # **Validates: Requirements 7.1, 7.4-7.5, 12.4, 13.3-13.4, 14.3**
    def test_list_signed_cursor_preserves_asof_scan_position_and_filter_binding(self):
        created_ids = []
        for iteration in range(3):
            self.clock.value = FIXED_NOW + timedelta(seconds=iteration)
            created = self.create_direct_grant(
                validity={"type": "preset", "days": 7},
                key="api-cursor-grant-key-%03d" % iteration,
            )
            created_ids.append(created["grant"]["id"])

        first = self.admin_request("GET", self.COLLECTION + "?limit=1")
        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))
        first_payload = first.get_json()
        cursor = first_payload["page"]["nextCursor"]
        self.assertIsNotNone(cursor)
        self.assertEqual(
            [grant["id"] for grant in first_payload["grants"]],
            [created_ids[-1]],
        )
        fixed_as_of = first_payload["page"]["asOf"]

        self.clock.value = FIXED_NOW + timedelta(days=365)
        second = self.admin_request(
            "GET", self.COLLECTION + "?limit=1&cursor=" + cursor,
        )
        self.assertEqual(second.status_code, 200, second.get_data(as_text=True))
        second_payload = second.get_json()
        self.assertEqual(second_payload["page"]["asOf"], fixed_as_of)
        self.assertEqual(
            [grant["id"] for grant in second_payload["grants"]],
            [created_ids[-2]],
        )
        self.assertNotEqual(
            first_payload["grants"][0]["id"],
            second_payload["grants"][0]["id"],
        )

        mismatch = self.admin_request(
            "GET", self.COLLECTION + "?limit=1&status=active&cursor=" + cursor,
        )
        self.assert_error(mismatch, 400, "invalid_cursor", "cursor")
        tampered = cursor[:-1] + ("A" if cursor[-1] != "A" else "B")
        rejected = self.admin_request(
            "GET", self.COLLECTION + "?limit=1&cursor=" + tampered,
        )
        self.assert_error(rejected, 400, "invalid_cursor", "cursor")

    # **Validates: Requirements 11.5, 13.4, 14.5, 18.7**
    def test_internal_mutation_and_list_failures_are_sanitized_and_request_correlated(self):
        scenarios = (
            ("create_complimentary_grant", "POST", self.COLLECTION, self.valid_create()),
            ("list_complimentary_grants", "GET", self.COLLECTION, None),
        )
        for method_name, http_method, path, body in scenarios:
            with self.subTest(method=method_name):
                with patch.object(
                    self.store, method_name,
                    side_effect=RuntimeError("database-secret-stack-detail"),
                ):
                    response = self.admin_request(http_method, path, json_body=body)
                self.assert_error(response, 503, "persistence_unavailable")
                self.assertNotIn("database-secret-stack-detail", response.get_data(as_text=True))


class BillingMeComplimentaryContracts(ComplimentaryApiContractFixtures, unittest.TestCase):
    PATH = "/api/v1/billing/me"

    # **Validates: Requirements 6.1, 13.5, 18.4, 18.7**
    def test_paid_subscription_shape_remains_backward_compatible(self):
        self.store.subscriptions[TARGET_UID] = self.paid_record()
        token = {
            "uid": TARGET_UID,
            "email": TARGET_EMAIL,
            "email_verified": True,
            "firebase": {"sign_in_provider": "google.com"},
        }
        response, _, _ = self.request_as(token, "GET", self.PATH)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()
        self.assertEqual(payload["subscription"]["status"], "active")
        self.assertEqual(payload["subscription"]["planId"], "basic")
        self.assertEqual(payload["subscription"]["source"], "paid")
        self.assertEqual(payload["subscription"]["validityType"], "finite")
        self.assertFalse(payload["subscription"]["lifetime"])
        self.assertFalse(payload["subscription"]["complimentary"])
        self.assertIsNone(payload["subscription"]["grantId"])
        self.assertIn("requestId", payload)

    # **Validates: Requirements 1.5, 11.4, 13.5, 17.1**
    def test_me_exposes_only_server_derived_additive_capability_state(self):
        enabled = self.admin_request("GET", self.PATH)
        self.assertEqual(enabled.status_code, 200, enabled.get_data(as_text=True))
        enabled_payload = enabled.get_json()
        self.assertIn("adminCapabilities", enabled_payload)
        self.assertEqual(
            enabled_payload["adminCapabilities"],
            {"complimentarySubscriptions": True},
        )

        for capability in ("false", OMITTED, "malformed"):
            with self.subTest(capability=repr(capability)):
                _, client = self.make_client(capability)
                response = self.admin_request("GET", self.PATH, client=client)
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                capabilities = response.get_json().get("adminCapabilities", {})
                self.assertIsInstance(capabilities, dict)
                self.assertIsNot(capabilities.get("complimentarySubscriptions"), True)

        forged, _, _ = self.request_as(
            self.ordinary_token(),
            "GET",
            self.PATH + "?adminCapabilities.complimentarySubscriptions=true",
        )
        self.assertNotEqual(
            (forged.get_json() or {}).get("adminCapabilities", {}).get("complimentarySubscriptions"),
            True,
        )

    # **Validates: Requirements 5.3, 6.1, 6.3-6.5, 10.1, 13.5, 19.2**
    def test_me_uses_shared_resolver_for_finite_and_lifetime_complimentary_shapes(self):
        token = {
            "uid": TARGET_UID,
            "email": TARGET_EMAIL,
            "email_verified": True,
            "firebase": {"sign_in_provider": "google.com"},
        }
        for validity, lifetime in (
            ({"type": "preset", "days": 30}, False),
            ({"type": "lifetime"}, True),
        ):
            with self.subTest(validity=validity):
                self.store.complimentary_grants.clear()
                self.store.complimentary_users.clear()
                self.store.complimentary_operations.clear()
                self.store.complimentary_audit.clear()
                self.create_direct_grant(
                    validity=validity,
                    key="me-shape-key-%s" % ("life" if lifetime else "finite"),
                )
                response, _, _ = self.request_as(token, "GET", self.PATH)
                self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
                subscription = response.get_json()["subscription"]
                self.assertEqual(subscription["source"], "complimentary")
                self.assertEqual(subscription["planId"], "pro")
                self.assertEqual(subscription["entitlementTier"], "pro")
                self.assertEqual(subscription["validityType"], "lifetime" if lifetime else "preset")
                self.assertEqual(subscription["lifetime"], lifetime)
                if lifetime:
                    self.assertIsNone(subscription["expiresAt"])
                else:
                    self.assertIsNotNone(subscription["expiresAt"])

    # **Validates: Requirements 6.4-6.5, 10.3-10.4, 12.4, 13.5**
    def test_me_evaluates_finite_expiry_and_lifetime_at_server_time(self):
        token = {
            "uid": TARGET_UID,
            "email": TARGET_EMAIL,
            "email_verified": True,
            "firebase": {"sign_in_provider": "google.com"},
        }
        self.create_direct_grant(
            validity={"type": "preset", "days": 7},
            key="me-expiry-key-001",
        )
        self.clock.value = FIXED_NOW + timedelta(days=7)
        expired, _, _ = self.request_as(token, "GET", self.PATH)
        self.assertEqual(expired.status_code, 200, expired.get_data(as_text=True))
        self.assertEqual(expired.get_json()["subscription"]["status"], "inactive")
        self.assertIsNone(expired.get_json()["subscription"]["source"])

        self.store.complimentary_grants.clear()
        self.store.complimentary_users.clear()
        self.store.complimentary_operations.clear()
        self.store.complimentary_audit.clear()
        self.clock.value = FIXED_NOW
        self.create_direct_grant(
            validity={"type": "lifetime"},
            key="me-lifetime-key-001",
        )
        self.clock.value = FIXED_NOW + timedelta(days=3650)
        lifetime, _, _ = self.request_as(token, "GET", self.PATH)
        self.assertEqual(lifetime.status_code, 200, lifetime.get_data(as_text=True))
        subscription = lifetime.get_json()["subscription"]
        self.assertEqual(subscription["status"], "active")
        self.assertEqual(subscription["source"], "complimentary")
        self.assertTrue(subscription["lifetime"])
        self.assertIsNone(subscription["expiresAt"])

    # **Validates: Requirements 6.3, 11.5, 13.5, 14.5, 17.4**
    def test_me_redacts_admin_notes_actor_operations_fallback_and_grant_history(self):
        self.store.subscriptions[TARGET_UID] = self.paid_record()
        self.create_direct_grant(validity={"type": "lifetime"})
        token = {
            "uid": TARGET_UID,
            "email": TARGET_EMAIL,
            "email_verified": True,
            "firebase": {"sign_in_provider": "google.com"},
        }
        response, _, _ = self.request_as(token, "GET", self.PATH)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        payload = response.get_json()
        serialized = response.get_data(as_text=True)
        for forbidden in (
            "reason", "createdBy", "revokedBy", "supersededBy",
            "idempotencyKey", "operationId", "audit", "paidFallback",
            "admin@example.com", "Support resolution",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(
            set(payload),
            {"subscription", "isAdmin", "adminCapabilities", "requestId"},
        )


class ComplimentaryObservabilityAndRollbackContracts(
    ComplimentaryApiContractFixtures, unittest.TestCase,
):
    COLLECTION = "/api/v1/admin/billing/complimentary-grants"
    LOG_FIELDS = {
        "requestId", "operation", "resultCode", "duplicate", "latencyMs",
        "actorUidHash", "targetUidHash", "grantId", "planId",
        "validityType", "transitionType",
    }

    @staticmethod
    def log_events(records):
        return [json.loads(record.split(":", 2)[-1]) for record in records]

    def valid_create(self, **overrides):
        value = {
            "targetEmail": TARGET_EMAIL,
            "planId": "pro",
            "validity": {"type": "lifetime"},
            "reason": "Private support reason",
            "idempotencyKey": "task-20-log-key-0001",
        }
        value.update(overrides)
        return value

    # **Validates: Requirements 5.2, 14.5, 16.1-16.2, 20.5, 20.8**
    def test_success_duplicate_and_conflict_logs_are_correlated_and_allowlisted(self):
        request = self.valid_create()
        with self.assertLogs("billing.complimentary", level="INFO") as captured:
            created = self.admin_request("POST", self.COLLECTION, json_body=request)
            replay = self.admin_request("POST", self.COLLECTION, json_body=request)
            conflict = self.admin_request(
                "POST", self.COLLECTION,
                json_body={**request, "planId": "basic"},
            )

        self.assertEqual(created.status_code, 201)
        self.assertEqual(replay.status_code, 200)
        self.assert_error(conflict, 409, "idempotency_conflict")
        events = self.log_events(captured.output)
        grant_events = [event for event in events if event["operation"] == "grant"]
        self.assertEqual(
            [event["resultCode"] for event in grant_events],
            ["success", "duplicate", "idempotency_conflict"],
        )
        self.assertEqual(
            [event["duplicate"] for event in grant_events],
            [False, True, False],
        )
        for event in grant_events:
            self.assertLessEqual(set(event), self.LOG_FIELDS)
            self.assertTrue(event["requestId"])
            self.assertRegex(event["actorUidHash"], r"^[0-9a-f]{64}$")
            self.assertNotEqual(event["actorUidHash"], ADMIN_UID)
            self.assertNotEqual(event.get("targetUidHash"), TARGET_UID)

        serialized = "\n".join(captured.output)
        for private_value in (
            TARGET_EMAIL, ADMIN_EMAIL, request["reason"],
            request["idempotencyKey"], "task-9-token",
        ):
            self.assertNotIn(private_value, serialized)

    # **Validates: Requirements 1.3-1.5, 11.3-11.5, 14.5, 18.7, 20.5**
    def test_denial_and_internal_failure_logs_are_safe_and_request_correlated(self):
        _, disabled_client = self.make_client("false")
        with self.assertLogs("billing.complimentary", level="INFO") as captured:
            denied = self.admin_request(
                "POST", "/api/v1/admin/billing/users/lookup",
                json_body={"email": TARGET_EMAIL}, client=disabled_client,
            )
            with patch.object(
                self.store,
                "list_complimentary_grants",
                side_effect=RuntimeError("database-secret-stack-detail"),
            ):
                unavailable = self.admin_request("GET", self.COLLECTION)

        self.assert_error(denied, 403, "admin_capability_required")
        self.assert_error(unavailable, 503, "persistence_unavailable")
        events = self.log_events(captured.output)
        self.assertEqual(
            [(event["operation"], event["resultCode"]) for event in events],
            [
                ("lookup", "admin_capability_required"),
                ("list", "persistence_unavailable"),
            ],
        )
        for event in events:
            self.assertLessEqual(set(event), self.LOG_FIELDS)
            self.assertTrue(event["requestId"])
        serialized = "\n".join(captured.output)
        self.assertNotIn(TARGET_EMAIL, serialized)
        self.assertNotIn("database-secret-stack-detail", serialized)
        self.assertNotIn("task-9-token", serialized)

    # **Validates: Requirements 1.3-1.5, 5.3, 10.1, 17.4, 18.7, 20.5**
    def test_capability_off_blocks_admin_reads_but_keeps_committed_entitlement_reads(self):
        grant = self.create_direct_grant(validity={"type": "lifetime"})
        _, disabled_client = self.make_client("false")
        target_token = {
            "uid": TARGET_UID,
            "email": TARGET_EMAIL,
            "email_verified": True,
            "firebase": {"sign_in_provider": "google.com"},
        }

        with self.assertLogs("billing.complimentary", level="INFO") as captured:
            me, _, _ = self.request_as(
                target_token, "GET", "/api/v1/billing/me", client=disabled_client,
            )
        self.assertEqual(me.status_code, 200, me.get_data(as_text=True))
        self.assertEqual(me.get_json()["subscription"]["source"], "complimentary")
        self.assertEqual(me.get_json()["subscription"]["grantId"], grant["grant"]["id"])
        resolver_events = self.log_events(captured.output)
        self.assertEqual(resolver_events[-1]["operation"], "resolver")
        self.assertEqual(resolver_events[-1]["resultCode"], "resolved_complimentary")

        protected_after_entitlement = deepcopy(self.store.protected_calls)
        requests = (
            ("POST", "/api/v1/admin/billing/users/lookup", {"email": TARGET_EMAIL}),
            ("GET", self.COLLECTION, None),
            ("POST", self.COLLECTION, self.valid_create(idempotencyKey="rollback-key-0000001")),
            ("POST", self.COLLECTION + "/%s/revoke" % grant["grant"]["id"], {
                "idempotencyKey": "rollback-key-0000002",
            }),
        )
        with patch("billing_api.firebase_auth.verify_id_token", return_value=self.admin_token()):
            with patch("billing_api.firebase_auth.get_user_by_email", create=True) as get_user:
                for method, path, body in requests:
                    response = disabled_client.open(
                        path, method=method, headers=self.headers(), json=body,
                    )
                    self.assert_error(response, 403, "admin_capability_required")
        get_user.assert_not_called()
        self.assertEqual(self.store.protected_calls, protected_after_entitlement)
        self.assertEqual(
            self.store.complimentary_grants[grant["grant"]["id"]]["storedStatus"],
            "active",
        )

    # **Validates: Requirements 5.2, 18.6, 20.8**
    def test_complimentary_records_do_not_enter_revenue_analytics(self):
        self.create_direct_grant(validity={"type": "lifetime"})
        self.store.payments["pay-task-20"] = {
            "id": "pay-task-20", "userId": TARGET_UID, "status": "captured",
            "amountPaise": 12345, "discountPaise": 345,
        }
        result = self.store.analytics()
        self.assertEqual(result["capturedPayments"], 1)
        self.assertEqual(result["grossRevenuePaise"], 12345)
        self.assertEqual(result["discountsPaise"], 345)


if __name__ == "__main__":
    unittest.main()
