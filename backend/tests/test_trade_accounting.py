import copy
import unittest
from unittest.mock import patch

import app as trading_app
from google.api_core.exceptions import Aborted


class FakeSnapshot:
    def __init__(self, path, value):
        self.id = path[-1] if path else ""
        self._value = copy.deepcopy(value)
        self.exists = value is not None

    def to_dict(self):
        return copy.deepcopy(self._value or {})


class FakeTransaction:
    def __init__(self, database):
        self.database = database
        self.operations = []

    def set(self, reference, value, merge=False):
        self.operations.append(("set", reference.path, copy.deepcopy(value), merge))

    def update(self, reference, value):
        self.operations.append(("update", reference.path, copy.deepcopy(value), True))

    def commit(self):
        if self.database.abort_commits > 0:
            self.database.abort_commits -= 1
            raise Aborted("synthetic contention")
        if self.database.fail_commit:
            raise RuntimeError("synthetic commit failure")
        for operation, path, value, merge in self.operations:
            if operation == "set" and not merge:
                self.database.store[path] = value
            else:
                current = dict(self.database.store.get(path) or {})
                current.update(value)
                self.database.store[path] = current
        self.database.commits += 1


class FakeQuery:
    def __init__(self, database, path):
        self.database = database
        self.path = path
        self.filter = None

    def where(self, field, operator, value):
        self.filter = (field, operator, value)
        return self

    def order_by(self, field, direction=None):
        self.database.last_order = (field, direction)
        return self

    def limit(self, value):
        self.database.last_limit = value
        return self

    def get(self):
        expected_length = len(self.path) + 1
        snapshots = [
            FakeSnapshot(path, value)
            for path, value in self.database.store.items()
            if path[:len(self.path)] == self.path and len(path) == expected_length
        ]
        if self.filter:
            field, operator, expected = self.filter
            if operator != "==":
                return []
            snapshots = [
                snapshot for snapshot in snapshots
                if snapshot.to_dict().get(field) == expected
            ]
        return snapshots


class FakeDocument:
    def __init__(self, database, path):
        self.database = database
        self.path = path

    def collection(self, name):
        return FakeCollection(self.database, self.path + (name,))

    def get(self, transaction=None):
        return FakeSnapshot(self.path, self.database.store.get(self.path))


class FakeCollection(FakeQuery):
    def document(self, document_id):
        return FakeDocument(self.database, self.path + (document_id,))


class FakeDatabase:
    def __init__(self):
        self.store = {}
        self.fail_commit = False
        self.abort_commits = 0
        self.commits = 0
        self.last_order = None
        self.last_limit = None

    def collection(self, name):
        return FakeCollection(self, (name,))

    def transaction(self):
        return FakeTransaction(self)


class FakeLiveExchange:
    def __init__(self):
        self.market_orders = []

    def fetch_ticker(self, symbol):
        return {"last": 100}

    def create_market_order(self, symbol, side, quantity):
        self.market_orders.append((symbol, side, quantity))
        return {"id": "order-1", "average": 100, "filled": quantity, "status": "filled"}

    def set_leverage(self, leverage, symbol):
        return None


class DriftedFillExchange(FakeLiveExchange):
    def __init__(self):
        super().__init__()
        self.follow_up_orders = []

    def create_market_order(self, symbol, side, quantity):
        self.market_orders.append((symbol, side, quantity))
        return {"id": "entry-1", "average": 102, "filled": quantity, "status": "filled"}

    def create_order(self, symbol, order_type, side, quantity, price, params):
        self.follow_up_orders.append((symbol, order_type, side, quantity, price, params))
        return {"id": "emergency-close-1"}


class TradeValidationAndAccountingTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeDatabase()

    def test_demo_entry_persists_trade_and_portfolio_atomically(self):
        with patch.object(trading_app, "db", self.database):
            result = trading_app.execute_demo_trade("user-a", {
                "symbol": "BTCUSDT",
                "action": "buy",
                "price": 50000,
                "qty": 0.01,
                "leverage": 5,
            })

        self.assertEqual(result["status"], "executed")
        trade_id = result["trade"]["id"]
        self.assertIn(("users", "user-a", "webhook_trades", trade_id), self.database.store)
        portfolio = self.database.store[("users", "user-a", "data", "portfolio")]
        self.assertEqual(portfolio["openPositions"], 1)
        self.assertEqual(portfolio["totalTrades"], 1)
        self.assertEqual(self.database.commits, 1)

    def test_failed_entry_transaction_writes_nothing(self):
        self.database.fail_commit = True
        with patch.object(trading_app, "db", self.database):
            result = trading_app.execute_demo_trade("user-a", {
                "price": 50000,
                "qty": 0.01,
                "leverage": 5,
            })

        self.assertEqual(result["status"], "error")
        self.assertEqual(self.database.store, {})

    def test_contention_retries_with_fresh_transaction(self):
        self.database.abort_commits = 1
        with patch.object(trading_app, "db", self.database):
            result = trading_app.execute_demo_trade("user-a", {
                "price": 50000,
                "qty": 0.01,
                "leverage": 5,
            })

        self.assertEqual(result["status"], "executed")
        self.assertEqual(self.database.abort_commits, 0)
        self.assertEqual(self.database.commits, 1)

    def test_invalid_order_values_are_rejected_before_execution(self):
        cases = (
            {"price": 50000, "qty": 0, "leverage": 5},
            {"price": 50000, "qty": 1, "leverage": -1},
            {"price": float("nan"), "qty": 1, "leverage": 5},
            {"price": 50000, "qty": 1, "leverage": 126},
            {"price": 50000, "qty": 1, "leverage": 5, "sl": -10},
            {"price": True, "qty": 1, "leverage": 5},
            {"price": 50000, "qty": True, "leverage": 5},
            {"price": 50000, "qty": 1, "leverage": True},
            {"price": 1, "qty": 0.001, "leverage": 125},
        )
        with patch.object(trading_app, "db", self.database):
            for payload in cases:
                with self.subTest(payload=payload):
                    result = trading_app.execute_demo_trade("user-a", payload)
                    self.assertEqual(result["status"], "error")
        self.assertEqual(self.database.store, {})

    def test_inverted_live_protection_is_rejected_before_market_order(self):
        exchange = FakeLiveExchange()
        with patch.object(trading_app.exchange_registry, "get", return_value=exchange):
            result = trading_app.execute_live_trade("user-a", {
                "symbol": "BTC/USDT",
                "action": "buy",
                "qty": 1,
                "leverage": 2,
                "sl": 110,
                "tp": 90,
            })

        self.assertEqual(result["status"], "error")
        self.assertEqual(exchange.market_orders, [])

    def test_fill_slippage_inversion_triggers_reduce_only_unwind(self):
        exchange = DriftedFillExchange()
        with patch.object(trading_app.exchange_registry, "get", return_value=exchange):
            result = trading_app.execute_live_trade("user-a", {
                "symbol": "BTC/USDT",
                "action": "buy",
                "qty": 1,
                "leverage": 2,
                "sl": 90,
                "tp": 101,
            })

        self.assertEqual(result["status"], "error")
        self.assertTrue(result["emergencyClosed"])
        self.assertEqual(len(exchange.market_orders), 1)
        self.assertEqual(len(exchange.follow_up_orders), 1)
        self.assertEqual(exchange.follow_up_orders[0][1:3], ("market", "sell"))
        self.assertEqual(exchange.follow_up_orders[0][5], {"reduceOnly": True})

    def test_keyed_webhook_rejects_null_before_alert_or_trade(self):
        self.database.store[("users", "user-a")] = {
            "webhookKey": "user-key",
            "tradingMode": "demo",
        }
        client = trading_app.app.test_client()
        with patch.object(trading_app, "db", self.database):
            response = client.post(
                "/webhook/user-key", data="null", content_type="application/json"
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            [path for path in self.database.store if "webhook_alerts" in path], []
        )

    def test_close_is_atomic_and_cannot_double_apply_portfolio_delta(self):
        trade_path = ("users", "user-a", "webhook_trades", "trade-1")
        portfolio_path = ("users", "user-a", "data", "portfolio")
        self.database.store[trade_path] = {
            "status": "open",
            "side": "buy",
            "entryPrice": 100,
            "quantity": 2,
            "margin": 20,
        }
        self.database.store[portfolio_path] = {
            "usedMargin": 20,
            "availableMargin": 980,
            "balance": 1000,
            "openPositions": 1,
            "realizedPnl": 0,
            "totalPnl": 0,
            "wins": 0,
            "losses": 0,
            "totalTrades": 1,
        }

        with patch.object(trading_app, "db", self.database):
            with trading_app.app.test_request_context(
                "/api/trades/user-a/trade-1/close", method="POST", json={"exitPrice": 110}
            ):
                first = trading_app.close_trade.__wrapped__("user-a", "trade-1")
            with trading_app.app.test_request_context(
                "/api/trades/user-a/trade-1/close", method="POST", json={"exitPrice": 120}
            ):
                second = trading_app.close_trade.__wrapped__("user-a", "trade-1")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second[1], 409)
        self.assertEqual(self.database.store[trade_path]["exitPrice"], 110)
        self.assertEqual(self.database.store[portfolio_path]["balance"], 1020)
        self.assertEqual(self.database.store[portfolio_path]["wins"], 1)

    def test_trade_query_uses_firestore_descending_constant(self):
        self.database.store[("users", "user-a", "webhook_trades", "trade-1")] = {
            "id": "trade-1"
        }
        with patch.object(trading_app, "db", self.database):
            with trading_app.app.test_request_context("/api/trades/user-a"):
                response = trading_app.get_user_trades.__wrapped__("user-a")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.database.last_order,
            ("openedAt", trading_app.firestore.Query.DESCENDING),
        )
        self.assertEqual(self.database.last_limit, 100)


if __name__ == "__main__":
    unittest.main()
