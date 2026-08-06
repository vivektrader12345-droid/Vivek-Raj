"""Thread-safe, process-local exchange adapters isolated by Firebase user ID."""

from __future__ import annotations

import threading
from typing import Callable, Dict, Optional

import ccxt


class TenantExchangeRegistry:
    """Own one exchange client per authenticated tenant without persisting keys."""

    def __init__(self, exchange_factory: Optional[Callable] = None):
        self._exchange_factory = exchange_factory or ccxt.binance
        self._clients: Dict[str, object] = {}
        self._metadata: Dict[str, dict] = {}
        self._lock = threading.RLock()

    def connect(self, user_id, api_key, api_secret, testnet=False) -> bool:
        tenant_id = str(user_id or "").strip()
        if not tenant_id or not api_key or not api_secret:
            return False

        try:
            client = self._exchange_factory({
                "apiKey": api_key,
                "secret": api_secret,
                "sandbox": bool(testnet),
                "options": {"defaultType": "future"},
                "enableRateLimit": True,
            })
            client.fetch_balance()
        except Exception:
            return False

        with self._lock:
            self._clients[tenant_id] = client
            self._metadata[tenant_id] = {"testnet": bool(testnet)}
        return True

    def get(self, user_id):
        tenant_id = str(user_id or "").strip()
        if not tenant_id:
            return None
        with self._lock:
            return self._clients.get(tenant_id)

    def disconnect(self, user_id) -> bool:
        tenant_id = str(user_id or "").strip()
        with self._lock:
            client = self._clients.pop(tenant_id, None)
            self._metadata.pop(tenant_id, None)
        if client is None:
            return False
        close = getattr(client, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
        return True

    def is_connected(self, user_id) -> bool:
        return self.get(user_id) is not None

    def connected_count(self) -> int:
        with self._lock:
            return len(self._clients)

    def metadata(self, user_id) -> dict:
        tenant_id = str(user_id or "").strip()
        with self._lock:
            return dict(self._metadata.get(tenant_id, {}))
