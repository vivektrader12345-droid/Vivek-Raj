import unittest
from unittest.mock import patch

import app as trading_app
from exchange_registry import TenantExchangeRegistry


class FakeExchange:
    def __init__(self, config):
        self.config = config
        self.closed = False

    def fetch_balance(self):
        return {"USDT": {"free": 100}}

    def close(self):
        self.closed = True


class TenantExchangeRegistryTests(unittest.TestCase):
    def setUp(self):
        self.created = []

        def factory(config):
            exchange = FakeExchange(config)
            self.created.append(exchange)
            return exchange

        self.registry = TenantExchangeRegistry(exchange_factory=factory)

    def test_connections_are_isolated_by_tenant(self):
        self.assertTrue(self.registry.connect("user-a", "key-a", "secret-a", True))
        self.assertTrue(self.registry.connect("user-b", "key-b", "secret-b", False))

        user_a = self.registry.get("user-a")
        user_b = self.registry.get("user-b")
        self.assertIsNot(user_a, user_b)
        self.assertEqual(user_a.config["apiKey"], "key-a")
        self.assertEqual(user_b.config["apiKey"], "key-b")
        self.assertTrue(self.registry.metadata("user-a")["testnet"])
        self.assertFalse(self.registry.metadata("user-b")["testnet"])
        self.assertEqual(self.registry.connected_count(), 2)

    def test_failed_reconnect_does_not_replace_existing_tenant_client(self):
        self.assertTrue(self.registry.connect("user-a", "key-a", "secret-a"))
        original = self.registry.get("user-a")

        self.registry._exchange_factory = lambda _config: (_ for _ in ()).throw(
            RuntimeError("connection failed")
        )

        self.assertFalse(self.registry.connect("user-a", "bad", "bad"))
        self.assertIs(self.registry.get("user-a"), original)

    def test_missing_tenant_or_credentials_fail_closed(self):
        self.assertFalse(self.registry.connect("", "key", "secret"))
        self.assertFalse(self.registry.connect("user", "", "secret"))
        self.assertFalse(self.registry.connect("user", "key", ""))
        self.assertIsNone(self.registry.get("unknown"))

    def test_disconnect_only_removes_requested_tenant(self):
        self.registry.connect("user-a", "key-a", "secret-a")
        self.registry.connect("user-b", "key-b", "secret-b")
        user_a = self.registry.get("user-a")

        self.assertTrue(self.registry.disconnect("user-a"))
        self.assertTrue(user_a.closed)
        self.assertIsNone(self.registry.get("user-a"))
        self.assertIsNotNone(self.registry.get("user-b"))


class OrderExchange:
    def __init__(self, order_id):
        self.order_id = order_id
        self.market_orders = []

    def set_leverage(self, leverage, symbol):
        return {"leverage": leverage, "symbol": symbol}

    def create_market_order(self, symbol, side, quantity):
        self.market_orders.append((symbol, side, quantity))
        return {
            "id": self.order_id,
            "average": 50000,
            "filled": quantity,
            "status": "filled",
        }


class LiveTradeIsolationTests(unittest.TestCase):
    def test_request_connection_never_inherits_startup_credentials(self):
        with patch.object(trading_app, "BINANCE_API_KEY", "startup-key"), patch.object(
            trading_app, "BINANCE_API_SECRET", "startup-secret"
        ), patch.object(trading_app.exchange_registry, "connect", return_value=False) as connect:
            result = trading_app.connect_exchange("other-user", "", "", False)

        self.assertFalse(result)
        connect.assert_called_once_with("other-user", "", "", False)

    def test_live_trade_uses_only_requested_tenant_adapter(self):
        user_a_exchange = OrderExchange("order-a")
        user_b_exchange = OrderExchange("order-b")
        adapters = {"user-a": user_a_exchange, "user-b": user_b_exchange}
        trade = {"symbol": "BTC/USDT", "action": "buy", "qty": 0.001, "leverage": 2}

        with patch.object(trading_app.exchange_registry, "get", side_effect=adapters.get), patch.object(
            trading_app, "db", None
        ):
            result = trading_app.execute_live_trade("user-a", trade)

        self.assertEqual(result["status"], "executed")
        self.assertEqual(result["trade"]["orderId"], "order-a")
        self.assertEqual(len(user_a_exchange.market_orders), 1)
        self.assertEqual(user_b_exchange.market_orders, [])

    def test_live_trade_fails_closed_without_tenant_adapter(self):
        with patch.object(trading_app.exchange_registry, "get", return_value=None):
            result = trading_app.execute_live_trade("missing-user", {"qty": 1})

        self.assertEqual(result["status"], "error")
        self.assertIn("this user", result["message"])


if __name__ == "__main__":
    unittest.main()
