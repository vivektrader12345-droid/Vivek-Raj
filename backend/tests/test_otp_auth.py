import os
import unittest
from unittest.mock import Mock, patch

from flask import Flask

from otp_auth import create_otp_blueprint


class FakeSnapshot:
    def __init__(self, value):
        self._value = value
        self.exists = value is not None

    def to_dict(self):
        return dict(self._value or {})


class FakeDocument:
    def __init__(self, store, key):
        self.store = store
        self.key = key

    def get(self, transaction=None):
        return FakeSnapshot(self.store.get(self.key))

    def set(self, value):
        self.store[self.key] = dict(value)

    def update(self, value):
        self.store[self.key].update(value)

    def delete(self):
        self.store.pop(self.key, None)


class FakeTransaction:
    def set(self, reference, value):
        reference.set(value)

    def update(self, reference, value):
        reference.update(value)

    def delete(self, reference):
        reference.delete()

    def commit(self):
        return None


class FakeCollection:
    def __init__(self, store, name):
        self.store = store
        self.name = name

    def document(self, document_id):
        return FakeDocument(self.store, (self.name, document_id))


class FakeDatabase:
    def __init__(self):
        self.store = {}

    def collection(self, name):
        return FakeCollection(self.store, name)

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


if __name__ == "__main__":
    unittest.main()
