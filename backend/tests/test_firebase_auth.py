import contextlib
import inspect
import io
import unittest
from unittest.mock import Mock, patch

from flask import Flask
from firebase_admin import auth

import firebase_admin_setup
from webhook_intelligence import create_webhook_blueprint


class FirebaseAdminSetupTests(unittest.TestCase):
    @patch("firebase_admin_setup.firestore.client")
    @patch("firebase_admin_setup.firebase_admin.initialize_app")
    @patch("firebase_admin_setup.firebase_admin.get_app")
    def test_reuses_existing_default_app(self, get_app, initialize_app, firestore_client):
        existing_app = object()
        database = object()
        get_app.return_value = existing_app
        firestore_client.return_value = database

        result = firebase_admin_setup.initialize_firebase_services("project-id")

        self.assertIs(result.app, existing_app)
        self.assertIs(result.db, database)
        self.assertTrue(result.auth_ready)
        initialize_app.assert_not_called()
        firestore_client.assert_called_once_with(app=existing_app)

    @patch("firebase_admin_setup.firestore.client")
    @patch("firebase_admin_setup.firebase_admin.initialize_app")
    @patch("firebase_admin_setup.firebase_admin.get_app")
    def test_initializes_with_adc_and_non_secret_project_option(
        self, get_app, initialize_app, firestore_client
    ):
        initialized_app = object()
        get_app.side_effect = ValueError("default app missing")
        initialize_app.return_value = initialized_app

        result = firebase_admin_setup.initialize_firebase_services("project-id")

        self.assertIs(result.app, initialized_app)
        initialize_app.assert_called_once_with(options={"projectId": "project-id"})
        firestore_client.assert_called_once_with(app=initialized_app)

    @patch("firebase_admin_setup.firebase_admin.initialize_app")
    @patch("firebase_admin_setup.firebase_admin.get_app")
    def test_initialization_failure_is_sanitized_and_fails_closed(
        self, get_app, initialize_app
    ):
        get_app.side_effect = ValueError("default app missing")
        initialize_app.side_effect = RuntimeError("synthetic-sensitive-value")
        output = io.StringIO()

        with contextlib.redirect_stdout(output):
            result = firebase_admin_setup.initialize_firebase_services("project-id")

        self.assertFalse(result.auth_ready)
        self.assertIsNone(result.app)
        self.assertIsNone(result.db)
        self.assertEqual(result.error_code, "firebase_admin_initialization_failed")
        self.assertIn("RuntimeError", output.getvalue())
        self.assertNotIn("synthetic-sensitive-value", output.getvalue())

    def test_initializer_has_no_certificate_file_loading(self):
        source = inspect.getsource(firebase_admin_setup.initialize_firebase_services)
        self.assertNotIn("Certificate", source)
        self.assertNotIn("serviceAccountKey", source)


class ProtectedWebhookAuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.firebase_app = object()
        app = Flask(__name__)
        app.register_blueprint(
            create_webhook_blueprint(None, firebase_app=self.firebase_app)
        )
        self.client = app.test_client()
        self.url = "/api/v1/webhooks/health"

    def get(self, token="synthetic-token"):
        headers = {} if token is None else {"Authorization": "Bearer %s" % token}
        return self.client.get(self.url, headers=headers)

    @patch("webhook_intelligence.auth.verify_id_token")
    def test_valid_token_uses_revocation_check_and_verified_uid(self, verify):
        verify.return_value = {
            "uid": "synthetic-user",
            "firebase": {"sign_in_provider": "google.com"},
        }

        response = self.get()

        self.assertEqual(response.status_code, 200)
        verify.assert_called_once_with(
            "synthetic-token", app=self.firebase_app, check_revoked=True
        )

    @patch("webhook_intelligence.auth.verify_id_token")
    def test_password_session_requires_current_otp_proof(self, verify):
        verify.return_value = {
            "uid": "synthetic-user",
            "auth_time": 100,
            "firebase": {"sign_in_provider": "password"},
        }

        response = self.get()

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["error"]["code"], "otp_required")

    @patch("webhook_intelligence.auth.verify_id_token")
    def test_password_session_accepts_exact_auth_time_proof(self, verify):
        verify.return_value = {
            "uid": "synthetic-user",
            "auth_time": 100,
            "otp_auth_time": 100,
            "firebase": {"sign_in_provider": "password"},
        }

        response = self.get()

        self.assertEqual(response.status_code, 200)

    @patch("webhook_intelligence.auth.verify_id_token")
    def test_missing_and_malformed_headers_are_distinct_and_not_verified(self, verify):
        missing = self.get(token=None)
        malformed = self.client.get(
            self.url, headers={"Authorization": "Basic synthetic-value"}
        )
        empty = self.client.get(self.url, headers={"Authorization": "Bearer "})

        for response in (missing, malformed, empty):
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.get_json()["error"]["code"], "authentication_required")
        verify.assert_not_called()

    def assert_verification_error(self, error, expected_status, expected_code):
        with patch(
            "webhook_intelligence.auth.verify_id_token", side_effect=error
        ) as verify:
            response = self.get()

        self.assertEqual(response.status_code, expected_status)
        payload = response.get_json()
        self.assertEqual(payload["error"]["code"], expected_code)
        self.assertIn("requestId", payload)
        self.assertNotIn("synthetic-token", response.get_data(as_text=True))
        verify.assert_called_once_with(
            "synthetic-token", app=self.firebase_app, check_revoked=True
        )

    def test_expired_token(self):
        self.assert_verification_error(
            auth.ExpiredIdTokenError("expired", RuntimeError("synthetic-cause")),
            401,
            "token_expired",
        )

    def test_malformed_or_invalid_token(self):
        self.assert_verification_error(
            auth.InvalidIdTokenError("synthetic-sensitive-value"),
            401,
            "invalid_token",
        )

    def test_revoked_token(self):
        self.assert_verification_error(
            auth.RevokedIdTokenError("synthetic-sensitive-value"),
            401,
            "token_revoked",
        )

    def test_disabled_user(self):
        self.assert_verification_error(
            auth.UserDisabledError("synthetic-sensitive-value"),
            401,
            "user_disabled",
        )

    def test_deleted_user_is_treated_as_revoked_session(self):
        self.assert_verification_error(
            auth.UserNotFoundError("synthetic-sensitive-value"),
            401,
            "token_revoked",
        )

    def test_certificate_failure_is_service_unavailable(self):
        self.assert_verification_error(
            auth.CertificateFetchError("unavailable", RuntimeError("synthetic-cause")),
            503,
            "auth_service_unavailable",
        )

    def test_unknown_verification_failure_is_service_unavailable(self):
        self.assert_verification_error(
            RuntimeError("synthetic-sensitive-value"),
            503,
            "auth_service_unavailable",
        )

    @patch("webhook_intelligence.auth.verify_id_token")
    def test_missing_uid_is_invalid(self, verify):
        verify.return_value = {"email": "placeholder@example.invalid"}

        response = self.get()

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.get_json()["error"]["code"], "invalid_token")

    @patch("webhook_intelligence.auth.verify_id_token")
    def test_webhook_base_url_supports_local_and_render_origins(self, verify):
        verify.return_value = {
            "uid": "synthetic-url-user",
            "firebase": {"sign_in_provider": "google.com"},
        }
        cases = (
            ("http://localhost:5000///", "http://localhost:5000/webhook/v1/"),
            (
                "https://vivek-raj.onrender.com/",
                "https://vivek-raj.onrender.com/webhook/v1/",
            ),
        )

        for index, (base_url, expected_prefix) in enumerate(cases):
            with self.subTest(base_url=base_url):
                app = Flask("base-url-%s" % index)
                app.register_blueprint(
                    create_webhook_blueprint(
                        None,
                        base_url=base_url,
                        firebase_app=self.firebase_app,
                    )
                )
                response = app.test_client().post(
                    "/api/v1/webhooks/endpoints",
                    headers={"Authorization": "Bearer synthetic-token"},
                    json={"name": "Synthetic", "strategy": "Synthetic"},
                )

                self.assertEqual(response.status_code, 201)
                self.assertTrue(
                    response.get_json()["webhookUrl"].startswith(expected_prefix)
                )

    @patch("webhook_intelligence.auth.verify_id_token")
    def test_unavailable_admin_app_fails_closed_before_verification(self, verify):
        app = Flask("unavailable-admin")
        app.register_blueprint(create_webhook_blueprint(None, firebase_app=None))

        client = app.test_client()
        missing_response = client.get(self.url)
        unavailable_response = client.get(
            self.url, headers={"Authorization": "Bearer synthetic-token"}
        )

        self.assertEqual(missing_response.status_code, 401)
        self.assertEqual(
            missing_response.get_json()["error"]["code"],
            "authentication_required",
        )
        self.assertEqual(unavailable_response.status_code, 503)
        self.assertEqual(
            unavailable_response.get_json()["error"]["code"],
            "auth_service_unavailable",
        )
        verify.assert_not_called()


if __name__ == "__main__":
    unittest.main()
