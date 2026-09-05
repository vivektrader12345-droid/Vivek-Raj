import os
import unittest
from unittest.mock import Mock, patch

import requests
from flask import Flask

from otp_auth import (
    EMAILJS_ENDPOINT,
    EMAILJS_TIMEOUT,
    MAX_SAFE_RETRY_AFTER,
    EmailDeliveryFailure,
    _bounded_retry_after,
    _otp_digest,
    _send_emailjs_otp,
    create_otp_blueprint,
)


class FakeSnapshot:
    def __init__(self, value):
        self._value = value
        self.exists = value is not None

    def to_dict(self):
        return dict(self._value or {})


class FakeDocument:
    def __init__(self, store, key, fail_deletes=False):
        self.store = store
        self.key = key
        self.fail_deletes = fail_deletes

    def get(self, transaction=None):
        if transaction is not None and not transaction.in_progress:
            raise ValueError("Transaction not in progress")
        return FakeSnapshot(self.store.get(self.key))

    def set(self, value):
        self.store[self.key] = dict(value)

    def update(self, value):
        self.store[self.key].update(value)

    def delete(self):
        if self.fail_deletes:
            raise RuntimeError("synthetic cleanup failure")
        self.store.pop(self.key, None)


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
        return FakeDocument(
            self.database.store,
            (self.name, document_id),
            fail_deletes=self.database.fail_deletes,
        )


class FakeDatabase:
    def __init__(self, fail_deletes=False):
        self.store = {}
        self.fail_deletes = fail_deletes

    def collection(self, name):
        return FakeCollection(self, name)

    def transaction(self):
        return FakeTransaction()


class OtpAuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeDatabase()
        self.firebase_app = object()
        app = Flask(__name__)
        app.register_blueprint(
            create_otp_blueprint(self.database, firebase_app=self.firebase_app)
        )
        self.client = app.test_client()
        self.headers = {"Authorization": "Bearer synthetic-token"}
        self.decoded = {
            "uid": "user-1",
            "email": "person@example.invalid",
            "auth_time": 100,
            "firebase": {"sign_in_provider": "password"},
        }
        self.environment = patch.dict(
            os.environ,
            {
                "OTP_HMAC_SECRET": "x" * 32,
                "EMAILJS_SERVICE_ID": "service",
                "EMAILJS_TEMPLATE_ID": "template",
                "EMAILJS_PUBLIC_KEY": "public-key",
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

    @patch("otp_auth._send_emailjs_otp")
    @patch("otp_auth.secrets.randbelow", return_value=23456)
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_send_stores_only_a_session_bound_hash(
        self, verify_token, _random, send_email
    ):
        verify_token.return_value = self.decoded

        response = self.client.post(
            "/api/auth/otp/send",
            headers=self.headers,
            json={"email": "person@example.invalid"},
        )

        self.assertEqual(response.status_code, 200)
        challenge = self.database.store[("otp_challenges", "user-1")]
        self.assertNotIn("code", challenge)
        self.assertNotEqual(challenge["codeHash"], "123456")
        self.assertEqual(challenge["authTime"], 100)
        self.assertEqual(challenge["deliveryState"], "active")
        self.assertIsInstance(challenge["challengeId"], str)
        self.assertTrue(challenge["challengeId"])
        send_email.assert_called_once_with("person@example.invalid", "123456")
        verify_token.assert_called_once_with(
            "synthetic-token", app=self.firebase_app, check_revoked=True
        )

    @patch("otp_auth.firebase_auth.set_custom_user_claims")
    @patch("otp_auth.firebase_auth.update_user")
    @patch("otp_auth.firebase_auth.get_user")
    @patch("otp_auth._send_emailjs_otp")
    @patch("otp_auth.secrets.randbelow", return_value=23456)
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_verify_binds_exact_auth_time_and_consumes_challenge(
        self,
        verify_token,
        _random,
        _send_email,
        get_user,
        update_user,
        set_claims,
    ):
        verify_token.return_value = self.decoded
        get_user.return_value = Mock(custom_claims={"existing": True})
        with patch("otp_auth.time.time", return_value=200):
            sent = self.client.post(
                "/api/auth/otp/send",
                headers=self.headers,
                json={"email": "person@example.invalid"},
            )
            verified = self.client.post(
                "/api/auth/otp/verify",
                headers=self.headers,
                json={"code": "123456"},
            )

        self.assertEqual(sent.status_code, 200)
        self.assertEqual(verified.status_code, 200)
        self.assertNotIn(("otp_challenges", "user-1"), self.database.store)
        update_user.assert_called_once_with(
            "user-1", email_verified=True, app=self.firebase_app
        )
        set_claims.assert_called_once_with(
            "user-1",
            {"existing": True, "otp_auth_time": 100},
            app=self.firebase_app,
        )

    @patch("otp_auth._send_emailjs_otp")
    @patch("otp_auth.secrets.randbelow", return_value=23456)
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_challenge_cannot_be_used_by_a_different_login_session(
        self, verify_token, _random, _send_email
    ):
        verify_token.return_value = self.decoded
        self.client.post(
            "/api/auth/otp/send",
            headers=self.headers,
            json={"email": "person@example.invalid"},
        )
        verify_token.return_value = {**self.decoded, "auth_time": 101}

        response = self.client.post(
            "/api/auth/otp/verify",
            headers=self.headers,
            json={"code": "123456"},
        )

        self.assertEqual(response.status_code, 409)
        self.assertNotIn(("otp_challenges", "user-1"), self.database.store)

    @patch("otp_auth._send_emailjs_otp")
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_rejects_email_mismatch(self, verify_token, send_email):
        verify_token.return_value = self.decoded

        response = self.client.post(
            "/api/auth/otp/send",
            headers=self.headers,
            json={"email": "other@example.invalid"},
        )

        self.assertEqual(response.status_code, 403)
        send_email.assert_not_called()

    @patch("otp_auth._send_emailjs_otp")
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_failed_attempt_cleanup_does_not_mutate_newer_challenge(
        self, verify_token, send_email
    ):
        verify_token.return_value = self.decoded
        key = ("otp_challenges", "user-1")
        newer = {
            "challengeId": "newer-attempt",
            "deliveryState": "active",
            "sentinel": "unchanged",
        }

        def replace_then_fail(_email, _code):
            self.database.store[key] = dict(newer)
            raise EmailDeliveryFailure(
                "authentication",
                "otp_email_authentication",
                False,
                None,
                "HttpResponse",
            )

        send_email.side_effect = replace_then_fail
        response = self.client.post(
            "/api/auth/otp/send",
            headers=self.headers,
            json={"email": "person@example.invalid"},
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.get_json()["diagnosticCode"], "otp_email_authentication"
        )
        self.assertEqual(self.database.store[key], newer)

    @patch("otp_auth._send_emailjs_otp")
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_unknown_provider_status_is_bounded_and_user_visible(
        self, verify_token, send_email
    ):
        verify_token.return_value = self.decoded
        send_email.side_effect = EmailDeliveryFailure(
            "operation_failed",
            "otp_email_operation_failed",
            False,
            None,
            "HttpResponse",
            418,
        )

        response = self.client.post(
            "/api/auth/otp/send",
            headers=self.headers,
            json={"email": "person@example.invalid"},
        )
        payload = response.get_json()

        self.assertEqual(response.status_code, 503)
        self.assertEqual(payload["diagnosticCode"], "otp_email_operation_failed")
        self.assertIn("Provider status: 418.", payload["message"])
        self.assertNotIn(("otp_challenges", "user-1"), self.database.store)

    @patch("otp_auth._send_emailjs_otp")
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_acceptance_cannot_activate_a_newer_challenge(
        self, verify_token, send_email
    ):
        verify_token.return_value = self.decoded
        key = ("otp_challenges", "user-1")
        newer = {
            "challengeId": "newer-attempt",
            "deliveryState": "pending",
            "sentinel": "unchanged",
        }

        def replace_then_accept(_email, _code):
            self.database.store[key] = dict(newer)

        send_email.side_effect = replace_then_accept
        response = self.client.post(
            "/api/auth/otp/send",
            headers=self.headers,
            json={"email": "person@example.invalid"},
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.get_json()["diagnosticCode"], "otp_storage_operation_failed"
        )
        self.assertEqual(self.database.store[key], newer)

    @patch("otp_auth.firebase_auth.set_custom_user_claims")
    @patch("otp_auth.firebase_auth.update_user")
    @patch("otp_auth.firebase_auth.get_user")
    @patch("otp_auth._send_emailjs_otp")
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_cleanup_failure_leaves_pending_attempt_unverifiable(
        self, verify_token, send_email, get_user, update_user, set_claims
    ):
        self.database.fail_deletes = True
        verify_token.return_value = self.decoded
        send_email.side_effect = EmailDeliveryFailure(
            "authentication",
            "otp_email_authentication",
            False,
            None,
            "HttpResponse",
        )

        sent = self.client.post(
            "/api/auth/otp/send",
            headers=self.headers,
            json={"email": "person@example.invalid"},
        )
        challenge = self.database.store[("otp_challenges", "user-1")]
        verified = self.client.post(
            "/api/auth/otp/verify",
            headers=self.headers,
            json={"code": "123456"},
        )

        self.assertEqual(sent.status_code, 503)
        self.assertEqual(challenge["deliveryState"], "pending")
        self.assertNotEqual(verified.status_code, 200)
        get_user.assert_not_called()
        update_user.assert_not_called()
        set_claims.assert_not_called()

    @patch("otp_auth.firebase_auth.set_custom_user_claims")
    @patch("otp_auth.firebase_auth.update_user")
    @patch("otp_auth.firebase_auth.get_user")
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_verification_rejects_explicit_non_active_challenge(
        self, verify_token, get_user, update_user, set_claims
    ):
        verify_token.return_value = self.decoded
        key = ("otp_challenges", "user-1")
        self.database.store[key] = {
            "uid": "user-1",
            "email": "person@example.invalid",
            "authTime": 100,
            "codeHash": "0" * 64,
            "nonce": "nonce",
            "expiresAt": 4_000_000_000,
            "attempts": 0,
            "lastSentAt": 0,
            "verificationPending": False,
            "challengeId": "pending-attempt",
            "deliveryState": "pending",
        }

        response = self.client.post(
            "/api/auth/otp/verify",
            headers=self.headers,
            json={"code": "123456"},
        )

        self.assertEqual(response.status_code, 409)
        self.assertNotIn(key, self.database.store)
        get_user.assert_not_called()
        update_user.assert_not_called()
        set_claims.assert_not_called()

    @patch("otp_auth.firebase_auth.set_custom_user_claims")
    @patch("otp_auth.firebase_auth.update_user")
    @patch("otp_auth.firebase_auth.get_user")
    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_structurally_valid_legacy_challenge_remains_compatible(
        self, verify_token, get_user, update_user, set_claims
    ):
        verify_token.return_value = self.decoded
        get_user.return_value = Mock(custom_claims={})
        key = ("otp_challenges", "user-1")
        nonce = "legacy-nonce"
        self.database.store[key] = {
            "uid": "user-1",
            "email": "person@example.invalid",
            "authTime": 100,
            "codeHash": _otp_digest("x" * 32, "user-1", nonce, "123456"),
            "nonce": nonce,
            "expiresAt": 4_000_000_000,
            "attempts": 0,
            "lastSentAt": 0,
            "verificationPending": False,
        }

        response = self.client.post(
            "/api/auth/otp/verify",
            headers=self.headers,
            json={"code": "123456"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn(key, self.database.store)
        update_user.assert_called_once()
        set_claims.assert_called_once()

    @patch("otp_auth.firebase_auth.verify_id_token")
    def test_missing_server_secret_fails_closed(self, verify_token):
        verify_token.return_value = self.decoded
        with patch.dict(os.environ, {"OTP_HMAC_SECRET": "short"}, clear=False):
            response = self.client.post(
                "/api/auth/otp/send",
                headers=self.headers,
                json={"email": "person@example.invalid"},
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.database.store, {})


class EmailJsAdapterTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(
            os.environ,
            {
                "EMAILJS_SERVICE_ID": "synthetic-service",
                "EMAILJS_TEMPLATE_ID": "synthetic-template",
                "EMAILJS_PUBLIC_KEY": "synthetic-public-key",
                "EMAILJS_PRIVATE_KEY": "synthetic-private-key",
            },
            clear=False,
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    @patch("otp_auth.requests.post")
    def test_adapter_submits_one_canonical_request_with_compatibility_aliases(
        self, post
    ):
        post.return_value = Mock(status_code=200, headers={}, text="")

        _send_emailjs_otp("recipient@example.invalid", "654321")

        post.assert_called_once()
        call = post.call_args
        self.assertEqual(call.args, (EMAILJS_ENDPOINT,))
        self.assertEqual(call.kwargs["timeout"], EMAILJS_TIMEOUT)
        payload = call.kwargs["json"]
        self.assertEqual(
            set(payload),
            {"service_id", "template_id", "user_id", "accessToken", "template_params"},
        )
        self.assertEqual(payload["accessToken"], "synthetic-private-key")
        self.assertEqual(
            payload["template_params"],
            {
                "email": "recipient@example.invalid",
                "to_email": "recipient@example.invalid",
                "otp_code": "654321",
                "otp": "654321",
                "app_name": "Vivek Marco Trader",
                "expiry_minutes": "5",
            },
        )

    def test_adapter_classifies_statuses_without_retaining_provider_content(self):
        cases = (
            (400, "otp_email_request_contract"),
            (401, "otp_email_authentication"),
            (403, "otp_email_authentication"),
            (404, "otp_email_template"),
            (422, "otp_email_recipient"),
            (429, "otp_email_rate_limit"),
            (503, "otp_email_provider_unavailable"),
            (418, "otp_email_operation_failed"),
        )
        provider_canary = "provider-response-canary"
        for status, expected in cases:
            with self.subTest(status=status):
                response = Mock(
                    status_code=status,
                    headers={"Retry-After": "17"},
                    text=provider_canary,
                )
                with (
                    patch("otp_auth.requests.post", return_value=response),
                    self.assertRaises(EmailDeliveryFailure) as raised,
                ):
                    _send_emailjs_otp("recipient@example.invalid", "654321")
                self.assertEqual(raised.exception.diagnostic_code, expected)
                self.assertEqual(
                    raised.exception.provider_status,
                    status if status == 418 else None,
                )
                self.assertNotIn(provider_canary, repr(raised.exception))
                if status == 429:
                    self.assertEqual(raised.exception.retry_after, 17)

    def test_adapter_uses_only_exact_allowlisted_provider_signals(self):
        cases = (
            ("template not found", "otp_email_template"),
            ("recipient rejected", "otp_email_recipient"),
            ("unrecognized provider detail", "otp_email_request_contract"),
        )
        for signal, expected in cases:
            with self.subTest(signal=signal):
                response = Mock(status_code=400, headers={}, text=signal)
                with (
                    patch("otp_auth.requests.post", return_value=response),
                    self.assertRaises(EmailDeliveryFailure) as raised,
                ):
                    _send_emailjs_otp("recipient@example.invalid", "654321")
                self.assertEqual(raised.exception.diagnostic_code, expected)
                self.assertNotIn(signal, repr(raised.exception))

    def test_adapter_classifies_transport_failure_without_exception_text(self):
        exception_canary = "transport-exception-canary"
        with (
            patch(
                "otp_auth.requests.post",
                side_effect=requests.Timeout(exception_canary),
            ),
            self.assertRaises(EmailDeliveryFailure) as raised,
        ):
            _send_emailjs_otp("recipient@example.invalid", "654321")

        self.assertEqual(raised.exception.diagnostic_code, "otp_email_network")
        self.assertTrue(raised.exception.retryable)
        self.assertNotIn(exception_canary, repr(raised.exception))

    @patch("otp_auth.requests.post")
    def test_malformed_configuration_stops_before_provider_call(self, post):
        with patch.dict(os.environ, {"EMAILJS_SERVICE_ID": "bad value"}, clear=False):
            with self.assertRaises(EmailDeliveryFailure) as raised:
                _send_emailjs_otp("recipient@example.invalid", "654321")
        self.assertEqual(
            raised.exception.diagnostic_code, "otp_email_configuration"
        )
        post.assert_not_called()

    def test_retry_after_accepts_only_bounded_positive_decimal_integers(self):
        self.assertEqual(_bounded_retry_after("17"), 17)
        self.assertEqual(_bounded_retry_after(MAX_SAFE_RETRY_AFTER), MAX_SAFE_RETRY_AFTER)
        for unsafe in (None, "", "0", "-1", "1.5", "tomorrow", MAX_SAFE_RETRY_AFTER + 1):
            with self.subTest(value=unsafe):
                self.assertIsNone(_bounded_retry_after(unsafe))


if __name__ == "__main__":
    unittest.main()
