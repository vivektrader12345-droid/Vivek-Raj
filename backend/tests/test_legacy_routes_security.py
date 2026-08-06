import unittest
from unittest.mock import patch

import app as trading_app


class LegacyRouteSecurityTests(unittest.TestCase):
    def setUp(self):
        trading_app.memory_alerts.clear()
        trading_app.memory_trades.clear()
        self.client = trading_app.app.test_client()

    def tearDown(self):
        trading_app.memory_alerts.clear()
        trading_app.memory_trades.clear()

    def test_bare_legacy_webhook_is_disabled_by_default(self):
        with patch.object(trading_app, "LEGACY_ROUTES_ENABLED", False):
            response = self.client.post("/webhook", json={"action": "buy"})

        self.assertEqual(response.status_code, 410)
        self.assertEqual(trading_app.memory_alerts, [])
        self.assertEqual(trading_app.memory_trades, [])

    def test_enabled_legacy_webhook_requires_server_secret(self):
        with patch.object(trading_app, "LEGACY_ROUTES_ENABLED", True), patch.object(
            trading_app, "LEGACY_WEBHOOK_SECRET", "compat-secret"
        ):
            missing = self.client.post("/webhook", json={"action": "buy"})
            wrong = self.client.post(
                "/webhook",
                headers={"X-Legacy-Webhook-Secret": "wrong"},
                json={"action": "buy"},
            )

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(trading_app.memory_alerts, [])

    def test_anonymous_trade_is_rejected_even_with_compatibility_secret(self):
        with patch.object(trading_app, "LEGACY_ROUTES_ENABLED", True), patch.object(
            trading_app, "LEGACY_WEBHOOK_SECRET", "compat-secret"
        ), patch.object(trading_app, "db", None):
            response = self.client.post(
                "/webhook",
                headers={"X-Legacy-Webhook-Secret": "compat-secret"},
                json={"action": "buy", "symbol": "BTCUSDT"},
            )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(trading_app.memory_trades, [])

    def test_payload_sanitizer_redacts_nested_credentials_and_bounds_text(self):
        sanitized = trading_app.sanitize_legacy_payload({
            "action": "buy",
            "secret": "sensitive",
            "nested": {
                "apiKey": "sensitive-key",
                "apiSecret": "sensitive-secret",
                "api_secret": "sensitive-secret-variant",
                "accessToken": "sensitive-token",
                "private-key": "sensitive-private-key",
                "note": "x" * 3000,
            },
        })

        self.assertEqual(sanitized["secret"], "[redacted]")
        self.assertEqual(sanitized["nested"]["apiKey"], "[redacted]")
        self.assertEqual(sanitized["nested"]["apiSecret"], "[redacted]")
        self.assertEqual(sanitized["nested"]["api_secret"], "[redacted]")
        self.assertEqual(sanitized["nested"]["accessToken"], "[redacted]")
        self.assertEqual(sanitized["nested"]["private-key"], "[redacted]")
        self.assertEqual(len(sanitized["nested"]["note"]), 2048)

    @patch("app.firebase_auth.verify_id_token")
    def test_memory_reads_require_auth_and_filter_by_tenant(self, verify_token):
        verify_token.return_value = {
            "uid": "user-a",
            "firebase": {"sign_in_provider": "google.com"},
        }
        trading_app.memory_alerts.extend([
            {"id": "a", "userId": "user-a"},
            {"id": "b", "userId": "user-b"},
            {"id": "legacy-anonymous"},
        ])
        trading_app.memory_trades.extend([
            {"id": "a", "userId": "user-a"},
            {"id": "b", "userId": "user-b"},
        ])

        missing = self.client.get("/alerts")
        with patch.object(trading_app, "firebase_app", object()):
            alerts = self.client.get(
                "/alerts", headers={"Authorization": "Bearer valid-token"}
            )
            trades = self.client.get(
                "/trades", headers={"Authorization": "Bearer valid-token"}
            )

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(alerts.status_code, 200)
        self.assertEqual([item["id"] for item in alerts.get_json()["alerts"]], ["a"])
        self.assertEqual(trades.status_code, 200)
        self.assertEqual([item["id"] for item in trades.get_json()["trades"]], ["a"])


if __name__ == "__main__":
    unittest.main()
