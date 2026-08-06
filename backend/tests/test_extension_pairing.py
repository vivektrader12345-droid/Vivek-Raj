import unittest
from unittest.mock import patch

from flask import Flask

from extension_pairing import PairingCodeError, create_extension_pairing_blueprint


class FakePairingStore:
    def __init__(self):
        self.codes = {}

    def create(self, uid):
        code = "one-time-pairing-code"
        self.codes[code] = uid
        return code

    def consume(self, code):
        uid = self.codes.pop(code, None)
        if not uid:
            raise PairingCodeError()
        return uid


class ExtensionPairingTests(unittest.TestCase):
    def setUp(self):
        self.firebase_app = object()
        self.store = FakePairingStore()
        app = Flask(__name__)
        app.register_blueprint(create_extension_pairing_blueprint(
            object(), firebase_app=self.firebase_app, pairing_store=self.store
        ))
        self.client = app.test_client()

    def auth_headers(self):
        return {"Authorization": "Bearer current-session-token"}

    @patch("extension_pairing.firebase_auth.verify_id_token")
    def test_current_otp_session_creates_short_lived_pairing_code(self, verify):
        verify.return_value = {
            "uid": "user-1",
            "auth_time": 100,
            "otp_auth_time": 100,
            "firebase": {"sign_in_provider": "password"},
        }

        response = self.client.post("/api/auth/extension/pair", headers=self.auth_headers())

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["pairingCode"], "one-time-pairing-code")
        self.assertEqual(self.store.codes["one-time-pairing-code"], "user-1")
        verify.assert_called_once_with(
            "current-session-token", app=self.firebase_app, check_revoked=True
        )

    @patch("extension_pairing.firebase_auth.verify_id_token")
    def test_pairing_requires_current_otp_proof(self, verify):
        verify.return_value = {
            "uid": "user-1",
            "auth_time": 100,
            "firebase": {"sign_in_provider": "password"},
        }

        response = self.client.post("/api/auth/extension/pair", headers=self.auth_headers())

        self.assertEqual(response.status_code, 403)
        self.assertNotIn("one-time-pairing-code", self.store.codes)

    @patch("extension_pairing.firebase_auth.create_custom_token")
    def test_code_is_consumed_once_and_mints_only_extension_claim(self, create_token):
        self.store.codes["one-time-pairing-code"] = "user-1"
        create_token.return_value = b"firebase-custom-token"

        first = self.client.post(
            "/api/auth/extension/redeem", json={"pairingCode": "one-time-pairing-code"}
        )
        replay = self.client.post(
            "/api/auth/extension/redeem", json={"pairingCode": "one-time-pairing-code"}
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["customToken"], "firebase-custom-token")
        self.assertEqual(replay.status_code, 400)
        create_token.assert_called_once_with(
            "user-1",
            developer_claims={"extension_session": True},
            app=self.firebase_app,
        )

    def test_missing_or_oversized_codes_fail_closed(self):
        missing = self.client.post("/api/auth/extension/redeem", json={})
        oversized = self.client.post(
            "/api/auth/extension/redeem", json={"pairingCode": "x" * 129}
        )

        self.assertEqual(missing.status_code, 400)
        self.assertEqual(oversized.status_code, 400)


if __name__ == "__main__":
    unittest.main()
