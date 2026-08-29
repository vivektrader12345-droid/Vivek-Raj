"""Exploration property for the unfixed EmailJS OTP delivery failure."""

import builtins
import os
import random
import unittest
from unittest.mock import Mock, patch

import requests
from flask import Flask

from otp_auth import EMAILJS_ENDPOINT, _send_emailjs_otp, create_otp_blueprint


PROPERTY_SEED = 0xE1A1
MAX_SAFE_RETRY_AFTER = 3600


class FakeResponse:
    def __init__(self, status_code=200, retry_after=None, provider_signal=""):
        self.status_code = status_code
        self.headers = {}
        if retry_after is not None:
            self.headers["Retry-After"] = retry_after
        self.text = provider_signal
        self.content = provider_signal.encode("utf-8")
        self.ok = status_code < 400

    def json(self):
        return {"message": self.text}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(
                "synthetic-exception-canary", response=self
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
            raise RuntimeError("synthetic-cleanup-exception-canary")
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


class EmailJsFailureExplorationProperty(unittest.TestCase):
    def setUp(self):
        self.firebase_app = object()
        self.headers = {"Authorization": "Bearer synthetic-token"}
        self.recipient_canary = "recipient-canary" + chr(64) + "example.invalid"
        self.decoded = {
            "uid": "exploration-user",
            "email": self.recipient_canary,
            "auth_time": 100,
            "firebase": {"sign_in_provider": "password"},
        }
        self.environment = patch.dict(
            os.environ,
            {
                "OTP_HMAC_SECRET": "synthetic-hmac-material-32-bytes!",
                "EMAILJS_SERVICE_ID": "synthetic-service-canary",
                "EMAILJS_TEMPLATE_ID": "synthetic-template-canary",
                "EMAILJS_PUBLIC_KEY": "synthetic-public-key-canary",
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

    def _make_client(self, database):
        app = Flask("emailjs-failure-exploration")
        app.config["TESTING"] = False
        app.register_blueprint(
            create_otp_blueprint(database, firebase_app=self.firebase_app)
        )
        return app, app.test_client()

    def _send_with_provider(self, database, provider, environment=None):
        _app, client = self._make_client(database)
        printed = []
        environment = environment or {}
        with (
            patch.dict(os.environ, environment, clear=False),
            patch("otp_auth.firebase_auth.verify_id_token", return_value=self.decoded),
            patch("otp_auth.secrets.randbelow", return_value=23456),
            patch("otp_auth.requests.post", side_effect=provider) as post,
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
                json={"email": self.recipient_canary},
            )
        return response, printed, post

    @staticmethod
    def _payload(response):
        return response.get_json(silent=True) or {}

    def _safe_output_violations(self, response, printed):
        output = repr(self._payload(response)) + "\n" + "\n".join(printed)
        canaries = (
            self.recipient_canary,
            "synthetic-hmac-material-32-bytes!",
            "synthetic-service-canary",
            "synthetic-template-canary",
            "synthetic-public-key-canary",
            "synthetic-provider-body-canary",
            "synthetic-exception-canary",
            "synthetic-cleanup-exception-canary",
        )
        return ["sensitive_output" for value in canaries if value in output]

    def test_property_1_emailjs_failures_are_safe_classified_and_attempt_scoped(self):
        """Property 1 (Bug Condition).

        **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**
        """
        rng = random.Random(PROPERTY_SEED)
        provider_body = "synthetic-provider-body-canary"
        generated_cases = [
            {
                "id": "configuration",
                "expected": "otp_email_configuration",
                "environment": {"EMAILJS_SERVICE_ID": ""},
                "provider": lambda *_args, **_kwargs: FakeResponse(),
            },
            *[
                {
                    "id": "http-authentication",
                    "expected": "otp_email_authentication",
                    "status": status,
                }
                for status in (401, 403)
            ],
            {"id": "http-template", "expected": "otp_email_template", "status": 404},
            {
                "id": "http-request-contract",
                "expected": "otp_email_request_contract",
                "status": 400,
            },
            {"id": "http-recipient", "expected": "otp_email_recipient", "status": 422},
            {"id": "http-rate-limit", "expected": "otp_email_rate_limit", "status": 429},
            {
                "id": "http-provider-unavailable",
                "expected": "otp_email_provider_unavailable",
                "status": rng.choice((500, 502, 503, 504)),
            },
            {
                "id": "transport-timeout",
                "expected": "otp_email_network",
                "exception": requests.Timeout("synthetic-exception-canary"),
            },
            {
                "id": "transport-connection",
                "expected": "otp_email_network",
                "exception": requests.ConnectionError("synthetic-exception-canary"),
            },
        ]
        rng.shuffle(generated_cases)

        for case in generated_cases:
            with self.subTest(counterexample=case["id"]):
                database = FakeDatabase()
                retry_after = "17" if case.get("status") == 429 else None
                if "provider" in case:
                    provider = case["provider"]
                elif "exception" in case:
                    exception = case["exception"]

                    def provider(*_args, **_kwargs):
                        raise exception
                else:
                    status = case["status"]

                    def provider(*_args, **_kwargs):
                        return FakeResponse(status, retry_after, provider_body)

                response, printed, _post = self._send_with_provider(
                    database, provider, case.get("environment")
                )
                payload = self._payload(response)
                violations = self._safe_output_violations(response, printed)
                if payload.get("diagnosticCode") != case["expected"]:
                    violations.append("missing_or_wrong_diagnostic")
                if ("otp_challenges", "exploration-user") in database.store:
                    violations.append("failed_attempt_still_present")
                if case["id"] == "http-rate-limit":
                    retry = payload.get("retryAfter")
                    if not (
                        isinstance(retry, int)
                        and 0 < retry <= MAX_SAFE_RETRY_AFTER
                        and response.status_code == 429
                    ):
                        violations.append("bounded_retry_guidance_lost")
                self.assertEqual([], violations)

        with self.subTest(counterexample="canonical-request-contract"):
            generated_code = f"{rng.randrange(100000, 1000000):06d}"
            with patch("otp_auth.requests.post", return_value=FakeResponse()) as post:
                _send_emailjs_otp(self.recipient_canary, generated_code)
            violations = []
            if post.call_count != 1:
                violations.append("provider_submission_count")
            call = post.call_args
            kwargs = call.kwargs
            payload = kwargs.get("json", {})
            params = payload.get("template_params", {})
            if call.args != (EMAILJS_ENDPOINT,):
                violations.append("wrong_endpoint")
            if set(payload) != {"service_id", "template_id", "user_id", "template_params"}:
                violations.append("noncanonical_envelope")
            if set(params) != {
                "email",
                "to_email",
                "otp_code",
                "otp",
                "app_name",
                "expiry_minutes",
            }:
                violations.append("missing_template_aliases")
            if params.get("email") != params.get("to_email"):
                violations.append("recipient_alias_mismatch")
            if params.get("otp_code") != params.get("otp"):
                violations.append("otp_alias_mismatch")
            timeout = kwargs.get("timeout")
            if not (
                isinstance(timeout, tuple)
                and len(timeout) == 2
                and all(isinstance(value, (int, float)) and 0 < value <= 30 for value in timeout)
            ):
                violations.append("unbounded_phase_timeouts")
            self.assertEqual([], violations)

        with self.subTest(counterexample="older-failure-deletes-newer-attempt"):
            database = FakeDatabase()
            key = ("otp_challenges", "exploration-user")
            newer = {
                "challengeId": "newer-attempt",
                "deliveryState": "active",
                "sentinel": "unchanged",
            }

            def replace_then_reject(*_args, **_kwargs):
                database.store[key] = dict(newer)
                return FakeResponse(401, provider_signal=provider_body)

            response, printed, _post = self._send_with_provider(
                database, replace_then_reject
            )
            violations = self._safe_output_violations(response, printed)
            if database.store.get(key) != newer:
                violations.append("newer_attempt_mutated")
            if self._payload(response).get("diagnosticCode") != "otp_email_authentication":
                violations.append("missing_or_wrong_diagnostic")
            self.assertEqual([], violations)

        with self.subTest(counterexample="cleanup-failure-remains-verifiable"):
            database = FakeDatabase(fail_deletes=True)
            app, client = self._make_client(database)
            printed = []
            get_user = Mock(return_value=Mock(custom_claims={}))
            update_user = Mock()
            set_claims = Mock()
            with (
                patch("otp_auth.firebase_auth.verify_id_token", return_value=self.decoded),
                patch("otp_auth.firebase_auth.get_user", get_user),
                patch("otp_auth.firebase_auth.update_user", update_user),
                patch("otp_auth.firebase_auth.set_custom_user_claims", set_claims),
                patch("otp_auth.secrets.randbelow", return_value=23456),
                patch(
                    "otp_auth.requests.post",
                    return_value=FakeResponse(401, provider_signal=provider_body),
                ),
                patch.object(
                    builtins,
                    "print",
                    side_effect=lambda *args, **_kwargs: printed.append(
                        " ".join(str(arg) for arg in args)
                    ),
                ),
            ):
                send_response = client.post(
                    "/api/auth/otp/send",
                    headers=self.headers,
                    json={"email": self.recipient_canary},
                )
                verify_response = client.post(
                    "/api/auth/otp/verify",
                    headers=self.headers,
                    json={"code": "123456"},
                )
            violations = self._safe_output_violations(send_response, printed)
            if self._payload(send_response).get("diagnosticCode") != "otp_email_authentication":
                violations.append("original_delivery_diagnostic_lost")
            if not any("otp_challenge_cleanup_" in line for line in printed):
                violations.append("cleanup_failure_not_classified")
            if verify_response.status_code == 200 or any(
                mock.called for mock in (get_user, update_user, set_claims)
            ):
                violations.append("failed_attempt_was_verifiable")
            self.assertEqual([], violations)

        with self.subTest(counterexample="pending-verification-window"):
            database = FakeDatabase()
            app, client = self._make_client(database)
            verification = {}
            get_user = Mock(return_value=Mock(custom_claims={}))
            update_user = Mock()
            set_claims = Mock()

            def verify_while_provider_pending(*_args, **_kwargs):
                with app.test_client() as verification_client:
                    verification["response"] = verification_client.post(
                        "/api/auth/otp/verify",
                        headers=self.headers,
                        json={"code": "123456"},
                    )
                return FakeResponse()

            with (
                patch("otp_auth.firebase_auth.verify_id_token", return_value=self.decoded),
                patch("otp_auth.firebase_auth.get_user", get_user),
                patch("otp_auth.firebase_auth.update_user", update_user),
                patch("otp_auth.firebase_auth.set_custom_user_claims", set_claims),
                patch("otp_auth.secrets.randbelow", return_value=23456),
                patch("otp_auth.requests.post", side_effect=verify_while_provider_pending),
            ):
                client.post(
                    "/api/auth/otp/send",
                    headers=self.headers,
                    json={"email": self.recipient_canary},
                )
            pending_response = verification.get("response")
            violations = []
            if pending_response is None:
                violations.append("pending_window_not_exercised")
            elif pending_response.status_code == 200:
                violations.append("pending_attempt_was_verifiable")
            if any(mock.called for mock in (get_user, update_user, set_claims)):
                violations.append("pending_attempt_reached_firebase_mutation")
            self.assertEqual([], violations)


if __name__ == "__main__":
    unittest.main()
