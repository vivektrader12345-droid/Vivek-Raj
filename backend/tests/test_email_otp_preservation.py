"""Observation-first preservation property for non-bug email OTP behavior."""

import builtins
import os
import random
import unittest
from unittest.mock import Mock, patch

from flask import Flask

from otp_auth import (
    OTP_EXPIRY_SECONDS,
    OTP_MAX_ATTEMPTS,
    OTP_RESEND_SECONDS,
    _otp_digest,
    create_otp_blueprint,
)
from webhook_intelligence import create_webhook_blueprint


PROPERTY_SEED = 0xE1A2
BASELINE_NOW = 1_700_000_000


class FakeSnapshot:
    def __init__(self, value):
        self._value = value
        self.exists = value is not None

    def to_dict(self):
        return dict(self._value or {})


class FakeDocument:
    def __init__(self, database, key):
        self.database = database
        self.key = key

    def get(self, transaction=None):
        if transaction is not None and not transaction.in_progress:
            raise ValueError("Transaction not in progress")
        if self.database.read_error is not None:
            raise self.database.read_error
        return FakeSnapshot(self.database.store.get(self.key))

    def set(self, value):
        self.database.store[self.key] = dict(value)

    def update(self, value):
        self.database.store[self.key].update(value)

    def delete(self):
        self.database.store.pop(self.key, None)


class FakeTransaction:
    def __init__(self):
        self.in_progress = False
        self._writes = []

    def begin(self):
        if self.in_progress:
            raise ValueError("Transaction already in progress")
        self.in_progress = True

    def _stage(self, operation, reference, value=None):
        if not self.in_progress:
            raise ValueError("Transaction not in progress")
        self._writes.append((operation, reference, value))

    def set(self, reference, value):
        self._stage("set", reference, dict(value))

    def update(self, reference, value):
        self._stage("update", reference, dict(value))

    def delete(self, reference):
        self._stage("delete", reference)

    def commit(self):
        if not self.in_progress:
            raise ValueError("Transaction not in progress")
        for operation, reference, value in self._writes:
            if operation == "set":
                reference.set(value)
            elif operation == "update":
                reference.update(value)
            else:
                reference.delete()
        self._writes.clear()
        self.in_progress = False

    def rollback(self):
        self._writes.clear()
        self.in_progress = False


def fake_transactional(callback):
    def wrapped(transaction, *args, **kwargs):
        transaction.begin()
        try:
            result = callback(transaction, *args, **kwargs)
            transaction.commit()
            return result
        except Exception:
            transaction.rollback()
            raise

    return wrapped


class FakeCollection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    def document(self, document_id):
        return FakeDocument(self.database, (self.name, document_id))


class FakeDatabase:
    def __init__(self, read_error=None):
        self.store = {}
        self.read_error = read_error

    def collection(self, name):
        return FakeCollection(self, name)

    def transaction(self):
        return FakeTransaction()


class EmailOtpPreservationProperty(unittest.TestCase):
    def setUp(self):
        self.rng = random.Random(PROPERTY_SEED)
        self.firebase_app = object()
        self.token_canary = "synthetic-preservation-token"
        self.headers = {"Authorization": f"Bearer {self.token_canary}"}
        self.recipient = "preservation-user" + chr(64) + "example.invalid"
        self.uid = "preservation-user"
        self.auth_time = 700
        self.decoded = {
            "uid": self.uid,
            "email": self.recipient,
            "auth_time": self.auth_time,
            "firebase": {"sign_in_provider": "password"},
        }
        self.hmac_canary = "synthetic-preservation-hmac-material"
        self.environment_canaries = (
            "synthetic-preservation-service",
            "synthetic-preservation-template",
            "synthetic-preservation-public-key",
        )
        self.environment = patch.dict(
            os.environ,
            {
                "OTP_HMAC_SECRET": self.hmac_canary,
                "EMAILJS_SERVICE_ID": self.environment_canaries[0],
                "EMAILJS_TEMPLATE_ID": self.environment_canaries[1],
                "EMAILJS_PUBLIC_KEY": self.environment_canaries[2],
            },
            clear=False,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.transactional = patch(
            "otp_auth.firestore.transactional", new=fake_transactional
        )
        self.transactional.start()
        self.addCleanup(self.transactional.stop)

    def _make_client(self, database, firebase_app=None):
        app = Flask("email-otp-preservation")
        app.register_blueprint(
            create_otp_blueprint(
                database,
                firebase_app=self.firebase_app if firebase_app is None else firebase_app,
            )
        )
        return app.test_client()

    @staticmethod
    def _payload(response):
        return response.get_json(silent=True) or {}

    def _assert_safe_output(self, response, printed=(), extra_canaries=()):
        visible = response.get_data(as_text=True) + "\n" + "\n".join(printed)
        canaries = (
            self.token_canary,
            self.recipient,
            self.hmac_canary,
            *self.environment_canaries,
            *extra_canaries,
        )
        for canary in canaries:
            self.assertNotIn(canary, visible)

    def _legacy_challenge(self, code, **overrides):
        nonce = "synthetic-preservation-nonce"
        challenge = {
            "uid": self.uid,
            "email": self.recipient,
            "authTime": self.auth_time,
            "codeHash": _otp_digest(
                self.hmac_canary, self.uid, nonce, code
            ),
            "nonce": nonce,
            "expiresAt": BASELINE_NOW + OTP_EXPIRY_SECONDS,
            "attempts": 0,
            "lastSentAt": BASELINE_NOW,
            "verificationPending": False,
        }
        challenge.update(overrides)
        return challenge

    def test_property_2_non_bug_otp_security_and_application_behavior(self):
        """Property 2: Preservation - Non-Bug OTP Security and Application Behavior.

        **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
        """
        authentication_cases = [
            {
                "id": "missing-header",
                "headers": {},
                "decoded": self.decoded,
                "expected": (401, {"success": False, "message": "Authentication required"}),
                "verified": False,
            },
            {
                "id": "malformed-header",
                "headers": {"Authorization": "Basic synthetic"},
                "decoded": self.decoded,
                "expected": (401, {"success": False, "message": "Authentication required"}),
                "verified": False,
            },
            {
                "id": "invalid-or-revoked-token",
                "headers": self.headers,
                "verification_error": RuntimeError("synthetic-auth-error-canary"),
                "expected": (401, {"success": False, "message": "Invalid or expired token"}),
                "verified": True,
            },
            {
                "id": "missing-token-identity",
                "headers": self.headers,
                "decoded": {"email": self.recipient},
                "expected": (401, {"success": False, "message": "Invalid token"}),
                "verified": True,
            },
            {
                "id": "invalid-auth-time",
                "headers": self.headers,
                "decoded": {**self.decoded, "auth_time": 0},
                "expected": (401, {"success": False, "message": "Invalid token"}),
                "verified": True,
            },
        ]
        self.rng.shuffle(authentication_cases)
        for case in authentication_cases:
            with self.subTest(observation=case["id"]):
                database = FakeDatabase()
                client = self._make_client(database)
                verify_kwargs = (
                    {"side_effect": case["verification_error"]}
                    if "verification_error" in case
                    else {"return_value": case["decoded"]}
                )
                with (
                    patch("otp_auth.firebase_auth.verify_id_token", **verify_kwargs) as verify,
                    patch("otp_auth._send_emailjs_otp") as provider,
                ):
                    response = client.post(
                        "/api/auth/otp/send",
                        headers=case["headers"],
                        json={"email": self.recipient},
                    )
                expected_status, expected_payload = case["expected"]
                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(self._payload(response), expected_payload)
                self.assertEqual(verify.called, case["verified"])
                provider.assert_not_called()
                self.assertEqual(database.store, {})
                self._assert_safe_output(
                    response, extra_canaries=("synthetic-auth-error-canary",)
                )

        pre_provider_cases = [
            {
                "id": "identity-mismatch",
                "database": FakeDatabase(),
                "environment": {},
                "email": "different-user" + chr(64) + "example.invalid",
                "expected": (
                    403,
                    {
                        "success": False,
                        "message": "Email does not match authenticated user",
                    },
                ),
            },
            {
                "id": "missing-hmac",
                "database": FakeDatabase(),
                "environment": {"OTP_HMAC_SECRET": "short"},
                "email": self.recipient,
                "expected": (
                    503,
                    {
                        "success": False,
                        "message": "OTP service unavailable",
                        "diagnosticCode": "otp_hmac_unavailable",
                    },
                ),
            },
            {
                "id": "missing-storage-client",
                "database": None,
                "environment": {},
                "email": self.recipient,
                "expected": (
                    503,
                    {
                        "success": False,
                        "message": "OTP service unavailable",
                        "diagnosticCode": "otp_storage_client_unavailable",
                    },
                ),
            },
            {
                "id": "challenge-storage-failure",
                "database": FakeDatabase(
                    read_error=RuntimeError("synthetic-storage-error-canary")
                ),
                "environment": {},
                "email": self.recipient,
                "expected": (
                    503,
                    {
                        "success": False,
                        "message": "OTP service unavailable",
                        "diagnosticCode": "otp_storage_operation_failed",
                    },
                ),
            },
        ]
        self.rng.shuffle(pre_provider_cases)
        for case in pre_provider_cases:
            with self.subTest(observation=case["id"]):
                client = self._make_client(case["database"])
                printed = []
                with (
                    patch.dict(os.environ, case["environment"], clear=False),
                    patch(
                        "otp_auth.firebase_auth.verify_id_token",
                        return_value=self.decoded,
                    ),
                    patch("otp_auth._send_emailjs_otp") as provider,
                    patch.object(
                        builtins,
                        "print",
                        side_effect=lambda *args, **_kwargs: printed.append(
                            " ".join(str(arg) for arg in args)
                        ),
                    ),
                ):
                    response = client.post(
                        "/api/auth/otp/send",
                        headers=self.headers,
                        json={"email": case["email"]},
                    )
                expected_status, expected_payload = case["expected"]
                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(self._payload(response), expected_payload)
                provider.assert_not_called()
                if case["database"] is not None:
                    self.assertEqual(case["database"].store, {})
                self._assert_safe_output(
                    response,
                    printed,
                    (case["email"], "synthetic-storage-error-canary"),
                )

        cooldown_offsets = list(range(0, OTP_RESEND_SECONDS, 7))
        self.rng.shuffle(cooldown_offsets)
        for elapsed in cooldown_offsets:
            with self.subTest(observation="cooldown", elapsed=elapsed):
                database = FakeDatabase()
                key = ("otp_challenges", self.uid)
                existing = {
                    "lastSentAt": BASELINE_NOW - elapsed,
                    "sentinel": "existing-challenge-remains-unchanged",
                }
                database.store[key] = dict(existing)
                client = self._make_client(database)
                with (
                    patch("otp_auth.time.time", return_value=BASELINE_NOW),
                    patch(
                        "otp_auth.firebase_auth.verify_id_token",
                        return_value=self.decoded,
                    ),
                    patch("otp_auth._send_emailjs_otp") as provider,
                ):
                    response = client.post(
                        "/api/auth/otp/send",
                        headers=self.headers,
                        json={"email": self.recipient},
                    )
                retry_after = OTP_RESEND_SECONDS - elapsed
                self.assertEqual(response.status_code, 429)
                self.assertEqual(
                    self._payload(response),
                    {
                        "success": False,
                        "message": "Please wait before requesting another OTP",
                        "retryAfter": retry_after,
                    },
                )
                self.assertEqual(response.headers.get("Retry-After"), str(retry_after))
                self.assertEqual(database.store[key], existing)
                provider.assert_not_called()
                self._assert_safe_output(response)

        with self.subTest(observation="accepted-provider-send-and-keyed-digest"):
            database = FakeDatabase()
            client = self._make_client(database)
            random_offset = self.rng.randrange(900000)
            generated_code = f"{random_offset + 100000:06d}"
            nonce = "synthetic-success-nonce"
            get_user = Mock()
            update_user = Mock()
            set_claims = Mock()
            with (
                patch("otp_auth.time.time", return_value=BASELINE_NOW),
                patch("otp_auth.secrets.randbelow", return_value=random_offset),
                patch("otp_auth.secrets.token_urlsafe", return_value=nonce),
                patch(
                    "otp_auth.firebase_auth.verify_id_token",
                    return_value=self.decoded,
                ) as verify_token,
                patch("otp_auth.firebase_auth.get_user", get_user),
                patch("otp_auth.firebase_auth.update_user", update_user),
                patch("otp_auth.firebase_auth.set_custom_user_claims", set_claims),
                patch("otp_auth._send_emailjs_otp") as provider,
            ):
                response = client.post(
                    "/api/auth/otp/send",
                    headers=self.headers,
                    json={"email": self.recipient.upper()},
                )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                self._payload(response),
                {"success": True, "message": "OTP sent successfully"},
            )
            self.assertNotIn("retryAfter", self._payload(response))
            provider.assert_called_once_with(self.recipient, generated_code)
            verify_token.assert_called_once_with(
                self.token_canary, app=self.firebase_app, check_revoked=True
            )
            self.assertFalse(any(mock.called for mock in (get_user, update_user, set_claims)))
            challenge = database.store[("otp_challenges", self.uid)]
            self.assertNotIn("code", challenge)
            self.assertNotIn("otp", challenge)
            self.assertNotIn(generated_code, repr(challenge))
            self.assertEqual(challenge["uid"], self.uid)
            self.assertEqual(challenge["authTime"], self.auth_time)
            self.assertEqual(
                challenge["codeHash"],
                _otp_digest(
                    self.hmac_canary, self.uid, challenge["nonce"], generated_code
                ),
            )
            self.assertEqual(
                set(challenge) - {"challengeId", "deliveryState"},
                {
                    "uid",
                    "email",
                    "authTime",
                    "codeHash",
                    "nonce",
                    "expiresAt",
                    "attempts",
                    "lastSentAt",
                    "verificationPending",
                },
            )
            self._assert_safe_output(response, extra_canaries=(generated_code,))

        verification_code = f"{self.rng.randrange(100000, 1000000):06d}"
        wrong_code = str((int(verification_code) + 1) % 1_000_000).zfill(6)
        verification_cases = [
            {
                "id": "different-sign-in-session",
                "challenge": self._legacy_challenge(verification_code),
                "decoded": {**self.decoded, "auth_time": self.auth_time + 1},
                "submitted": verification_code,
                "expected": (
                    409,
                    {
                        "success": False,
                        "message": "OTP belongs to another sign-in session. Request a new one.",
                    },
                ),
                "remaining_attempts": None,
            },
            {
                "id": "expired",
                "challenge": self._legacy_challenge(
                    verification_code, expiresAt=BASELINE_NOW - 1
                ),
                "decoded": self.decoded,
                "submitted": verification_code,
                "expected": (
                    410,
                    {
                        "success": False,
                        "message": "OTP expired. Please request a new one.",
                    },
                ),
                "remaining_attempts": None,
            },
            {
                "id": "attempt-limit-already-reached",
                "challenge": self._legacy_challenge(
                    verification_code, attempts=OTP_MAX_ATTEMPTS
                ),
                "decoded": self.decoded,
                "submitted": wrong_code,
                "expected": (
                    429,
                    {
                        "success": False,
                        "message": "Too many attempts. Please request a new OTP.",
                    },
                ),
                "remaining_attempts": None,
            },
            {
                "id": "invalid-before-attempt-limit",
                "challenge": self._legacy_challenge(
                    verification_code, attempts=OTP_MAX_ATTEMPTS - 2
                ),
                "decoded": self.decoded,
                "submitted": wrong_code,
                "expected": (
                    401,
                    {"success": False, "message": "Invalid OTP. Please try again."},
                ),
                "remaining_attempts": OTP_MAX_ATTEMPTS - 1,
            },
            {
                "id": "invalid-reaches-attempt-limit",
                "challenge": self._legacy_challenge(
                    verification_code, attempts=OTP_MAX_ATTEMPTS - 1
                ),
                "decoded": self.decoded,
                "submitted": wrong_code,
                "expected": (
                    429,
                    {
                        "success": False,
                        "message": "Too many attempts. Please request a new OTP.",
                    },
                ),
                "remaining_attempts": None,
            },
        ]
        self.rng.shuffle(verification_cases)
        for case in verification_cases:
            with self.subTest(observation=case["id"]):
                database = FakeDatabase()
                key = ("otp_challenges", self.uid)
                database.store[key] = dict(case["challenge"])
                client = self._make_client(database)
                get_user = Mock()
                update_user = Mock()
                set_claims = Mock()
                with (
                    patch("otp_auth.time.time", return_value=BASELINE_NOW),
                    patch(
                        "otp_auth.firebase_auth.verify_id_token",
                        return_value=case["decoded"],
                    ),
                    patch("otp_auth.firebase_auth.get_user", get_user),
                    patch("otp_auth.firebase_auth.update_user", update_user),
                    patch("otp_auth.firebase_auth.set_custom_user_claims", set_claims),
                ):
                    response = client.post(
                        "/api/auth/otp/verify",
                        headers=self.headers,
                        json={"code": case["submitted"]},
                    )
                expected_status, expected_payload = case["expected"]
                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(self._payload(response), expected_payload)
                self.assertFalse(any(mock.called for mock in (get_user, update_user, set_claims)))
                if case["remaining_attempts"] is None:
                    self.assertNotIn(key, database.store)
                else:
                    self.assertEqual(
                        database.store[key]["attempts"], case["remaining_attempts"]
                    )
                self._assert_safe_output(
                    response, extra_canaries=(verification_code, wrong_code)
                )

        with self.subTest(observation="legacy-challenge-verifies-once-with-firebase-effects"):
            database = FakeDatabase()
            key = ("otp_challenges", self.uid)
            database.store[key] = self._legacy_challenge(verification_code)
            self.assertNotIn("deliveryState", database.store[key])
            client = self._make_client(database)
            get_user = Mock(return_value=Mock(custom_claims={"existing": True}))
            update_user = Mock()
            set_claims = Mock()
            with (
                patch("otp_auth.time.time", return_value=BASELINE_NOW),
                patch(
                    "otp_auth.firebase_auth.verify_id_token",
                    return_value=self.decoded,
                ),
                patch("otp_auth.firebase_auth.get_user", get_user),
                patch("otp_auth.firebase_auth.update_user", update_user),
                patch("otp_auth.firebase_auth.set_custom_user_claims", set_claims),
            ):
                first = client.post(
                    "/api/auth/otp/verify",
                    headers=self.headers,
                    json={"code": verification_code},
                )
                replay = client.post(
                    "/api/auth/otp/verify",
                    headers=self.headers,
                    json={"code": verification_code},
                )
            self.assertEqual(first.status_code, 200)
            self.assertEqual(
                self._payload(first),
                {
                    "success": True,
                    "message": "Email verified successfully",
                    "refreshToken": True,
                },
            )
            self.assertEqual(replay.status_code, 404)
            self.assertEqual(
                self._payload(replay),
                {"success": False, "message": "No OTP found. Please request a new one."},
            )
            self.assertNotIn(key, database.store)
            get_user.assert_called_once_with(self.uid, app=self.firebase_app)
            update_user.assert_called_once_with(
                self.uid, email_verified=True, app=self.firebase_app
            )
            set_claims.assert_called_once_with(
                self.uid,
                {"existing": True, "otp_auth_time": self.auth_time},
                app=self.firebase_app,
            )
            self._assert_safe_output(first, extra_canaries=(verification_code,))
            self._assert_safe_output(replay, extra_canaries=(verification_code,))

        unrelated_auth_cases = [
            {
                "id": "google-session",
                "decoded": {
                    "uid": self.uid,
                    "firebase": {"sign_in_provider": "google.com"},
                },
                "expected_status": 200,
                "expected_error": None,
            },
            {
                "id": "password-session-without-otp-proof",
                "decoded": {
                    "uid": self.uid,
                    "auth_time": self.auth_time,
                    "firebase": {"sign_in_provider": "password"},
                },
                "expected_status": 403,
                "expected_error": "otp_required",
            },
            {
                "id": "password-session-with-otp-proof",
                "decoded": {
                    "uid": self.uid,
                    "auth_time": self.auth_time,
                    "otp_auth_time": self.auth_time,
                    "firebase": {"sign_in_provider": "password"},
                },
                "expected_status": 200,
                "expected_error": None,
            },
        ]
        self.rng.shuffle(unrelated_auth_cases)
        for case in unrelated_auth_cases:
            with self.subTest(observation=f"unrelated-auth-{case['id']}"):
                app = Flask(f"unrelated-auth-{case['id']}")
                app.register_blueprint(
                    create_webhook_blueprint(None, firebase_app=self.firebase_app)
                )
                with (
                    patch(
                        "webhook_intelligence.auth.verify_id_token",
                        return_value=case["decoded"],
                    ),
                    patch("otp_auth._send_emailjs_otp") as provider,
                ):
                    response = app.test_client().get(
                        "/api/v1/webhooks/health", headers=self.headers
                    )
                self.assertEqual(response.status_code, case["expected_status"])
                if case["expected_error"] is not None:
                    self.assertEqual(
                        self._payload(response)["error"]["code"],
                        case["expected_error"],
                    )
                provider.assert_not_called()
                self._assert_safe_output(response)


if __name__ == "__main__":
    unittest.main()
