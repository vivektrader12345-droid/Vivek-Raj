"""Secure TradingView webhook ingestion and control APIs.

This module is deliberately self-contained: it uses only Flask, firebase_admin,
and the Python standard library. Live execution is fail-closed until a tenant-safe
server-side exchange adapter is implemented.
"""

from __future__ import print_function

import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from functools import wraps

from flask import Blueprint, g, jsonify, request
from firebase_admin import auth, firestore

from auth_policy import has_current_otp_proof


MAX_PAYLOAD_BYTES = 256 * 1024
MAX_FETCH = 500
_MEMORY_LOCK = threading.RLock()
_MEMORY = {
    "registry": {},
    "endpoints": defaultdict(dict),
    "events": defaultdict(dict),
    "executions": defaultdict(dict),
    "errors": defaultdict(dict),
    "audit": defaultdict(dict),
    "webhook_trades": defaultdict(dict),
    "trades": defaultdict(dict),
}
_ACTIONS = {
    "buy": ("buy", "long", "entry"),
    "long": ("buy", "long", "entry"),
    "entry_long": ("buy", "long", "entry"),
    "sell": ("sell", "short", "entry"),
    "short": ("sell", "short", "entry"),
    "entry_short": ("sell", "short", "entry"),
    "exit_long": ("exit_long", "long", "exit"),
    "exit_short": ("exit_short", "short", "exit"),
    "close": ("close", None, "exit"),
    "close_position": ("close", None, "exit"),
}
_TRIGGER_PATTERNS = (
    (r"\bgolden\s+cross\b", "Golden Cross"),
    (r"\bdeath\s+cross\b", "Death Cross"),
    (r"\bfake\s+break(?:out)?\b", "Fake Breakout"),
    (r"\bliquidity\s+sweep\b", "Liquidity Sweep"),
    (r"\border\s+block\b", "Order Block"),
    (r"\bfair\s+value\s+gap\b|\bfvg\b", "Fair Value Gap"),
    (r"\bhigher\s+high\b", "Higher High"),
    (r"\blower\s+low\b", "Lower Low"),
    (r"\bsuper\s*trend\b", "SuperTrend"),
    (r"\bchoch\b|change\s+of\s+character", "CHOCH"),
    (r"\bbos\b|break\s+of\s+structure", "BOS"),
    (r"\bbreak\s*out\b", "Breakout"),
    (r"\breversal\b", "Reversal"),
    (r"\bmacd\b", "MACD"),
    (r"\brsi\b", "RSI"),
    (r"\bvwap\b", "VWAP"),
    (r"\bema\b", "EMA"),
    (r"\bsma\b", "SMA"),
)


def _now():
    return datetime.now(timezone.utc)


def _iso(value=None):
    return (value or _now()).isoformat().replace("+00:00", "Z")


def _request_id():
    return getattr(g, "request_id", uuid.uuid4().hex)


def _error(code, message, status, details=None):
    body = {"error": {"code": code, "message": message}, "requestId": _request_id()}
    if details:
        body["error"]["details"] = details
    return jsonify(body), status


def _json_safe(value):
    if isinstance(value, datetime):
        return _iso(value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc))
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _bounded_json(value, depth=0):
    """Recursively bound untrusted JSON and remove credential-like fields."""
    if depth > 5:
        return "[truncated]"
    if isinstance(value, dict):
        result = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 100:
                result["_truncated"] = True
                break
            clean_key = str(key)[:128]
            if clean_key.lower() in {
                "secret", "token", "authorization", "password", "apikey",
                "api_key", "apisecret", "api_secret",
            }:
                result[clean_key] = "[redacted]"
            else:
                result[clean_key] = _bounded_json(item, depth + 1)
        return result
    if isinstance(value, list):
        result = [_bounded_json(item, depth + 1) for item in value[:100]]
        if len(value) > 100:
            result.append("[truncated]")
        return result
    if isinstance(value, str):
        return value[:2048]
    if isinstance(value, (bool, int)) or value is None:
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return str(value)[:2048]


def _pick(data, *keys):
    for key in keys:
        if key in data and data[key] not in (None, ""):
            return data[key]
    return None


def _number(value, default=None):
    if value in (None, ""):
        return default
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else default
    except (TypeError, ValueError):
        return default


def _int(value, default=None):
    parsed = _number(value, None)
    return int(parsed) if parsed is not None and parsed.is_integer() else default


def _parse_time(value):
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)) or str(value).strip().replace(".", "", 1).isdigit():
            stamp = float(value)
            if stamp > 100000000000:
                stamp /= 1000.0
            return datetime.fromtimestamp(stamp, timezone.utc)
        text = str(value).strip().replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (ValueError, TypeError, OSError, OverflowError):
        return None


def _normalize_symbol(value):
    return str(value or "").strip().upper().replace(" ", "")[:64]


def _normalize_action(value):
    key = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return _ACTIONS.get(key)


def _detect_trigger(data):
    explicit = _pick(data, "trigger", "signal", "condition", "triggerName", "trigger_name")
    if explicit:
        return str(explicit)[:256], "explicit"
    searchable = " ".join(
        str(value) for key, value in data.items()
        if key.lower() not in {"secret", "token"} and isinstance(value, (str, int, float))
    )
    for pattern, name in _TRIGGER_PATTERNS:
        if re.search(pattern, searchable, re.IGNORECASE):
            return name, "inferred_from_text"
    return "Unspecified", "not_provided"


def _hash_secret(secret):
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _secret_matches(provided, expected_hash):
    if not isinstance(provided, str) or not isinstance(expected_hash, str):
        return False
    return hmac.compare_digest(_hash_secret(provided), expected_hash)


def _ip_allowed(address, whitelist):
    if not whitelist:
        return True
    try:
        candidate = ipaddress.ip_address(address)
        for item in whitelist:
            try:
                if "/" in str(item):
                    if candidate in ipaddress.ip_network(str(item), strict=False):
                        return True
                elif candidate == ipaddress.ip_address(str(item)):
                    return True
            except ValueError:
                continue
    except ValueError:
        return False
    return False


def _doc_id():
    return uuid.uuid4().hex


def _user_collection(db, uid, name):
    return db.collection("users").document(uid).collection(name)


def _memory_collection(collection):
    return {
        "webhook_endpoints": "endpoints",
        "webhook_events": "events",
        "webhook_executions": "executions",
        "webhook_errors": "errors",
        "webhook_audit_logs": "audit",
    }.get(collection, collection)


def _safe_set(db, uid, collection, doc_id, data, merge=False):
    clean = _json_safe(data)
    memory_collection = _memory_collection(collection)
    with _MEMORY_LOCK:
        _MEMORY[memory_collection][uid][doc_id] = dict(clean)
    if db is not None:
        try:
            _user_collection(db, uid, collection).document(doc_id).set(clean, merge=merge)
            return True
        except Exception:
            pass
    return False


def _safe_update(db, uid, collection, doc_id, updates):
    clean = _json_safe(updates)
    memory_collection = _memory_collection(collection)
    with _MEMORY_LOCK:
        existing = _MEMORY[memory_collection][uid].setdefault(doc_id, {})
        existing.update(clean)
    if db is not None:
        try:
            _user_collection(db, uid, collection).document(doc_id).set(clean, merge=True)
            return True
        except Exception:
            pass
    return False


def _fetch_user_docs(db, uid, collection, limit=MAX_FETCH):
    records = {}
    order_field = {
        "webhook_endpoints": "createdAt",
        "webhook_events": "receivedTimestamp",
        "webhook_executions": "createdAt",
        "webhook_errors": "createdAt",
        "webhook_audit_logs": "createdAt",
        "webhook_trades": "openedAt",
        "trades": "createdAt",
    }.get(collection)
    if db is not None:
        collection_ref = _user_collection(db, uid, collection)
        try:
            query = collection_ref
            if order_field:
                query = query.order_by(order_field, direction=firestore.Query.DESCENDING)
            for snap in query.limit(min(limit, MAX_FETCH)).stream():
                records[snap.id] = {"id": snap.id, **_json_safe(snap.to_dict() or {})}
        except Exception:
            try:
                for snap in collection_ref.limit(min(limit, MAX_FETCH)).stream():
                    records[snap.id] = {"id": snap.id, **_json_safe(snap.to_dict() or {})}
            except Exception:
                pass
    memory_collection = _memory_collection(collection)
    with _MEMORY_LOCK:
        for doc_id, data in _MEMORY[memory_collection][uid].items():
            records.setdefault(doc_id, {"id": doc_id, **_json_safe(data)})
    values = list(records.values())
    if order_field:
        values.sort(key=lambda item: str(item.get(order_field) or ""), reverse=True)
    return values[:limit]


def _get_user_doc(db, uid, collection, doc_id):
    if db is not None:
        try:
            snap = _user_collection(db, uid, collection).document(doc_id).get()
            if snap.exists:
                return {"id": snap.id, **_json_safe(snap.to_dict() or {})}
        except Exception:
            pass
    memory_collection = _memory_collection(collection)
    with _MEMORY_LOCK:
        data = _MEMORY[memory_collection][uid].get(doc_id)
        return {"id": doc_id, **_json_safe(data)} if data is not None else None


def _public_endpoint(endpoint):
    if not endpoint:
        return None
    return {key: value for key, value in endpoint.items() if key not in {"secretHash", "userId"}}


def _get_endpoint(db, endpoint_id):
    if db is not None:
        try:
            snap = db.collection("webhook_endpoint_registry").document(endpoint_id).get()
            if snap.exists:
                return {"id": snap.id, **_json_safe(snap.to_dict() or {})}
        except Exception:
            pass
    with _MEMORY_LOCK:
        data = _MEMORY["registry"].get(endpoint_id)
        return {"id": endpoint_id, **dict(data)} if data else None


def _save_endpoint(db, uid, endpoint_id, data, merge=False):
    clean = _json_safe(data)
    registry_data = {**clean, "userId": uid}
    with _MEMORY_LOCK:
        if merge:
            _MEMORY["registry"].setdefault(endpoint_id, {}).update(registry_data)
            _MEMORY["endpoints"][uid].setdefault(endpoint_id, {}).update(clean)
        else:
            _MEMORY["registry"][endpoint_id] = dict(registry_data)
            _MEMORY["endpoints"][uid][endpoint_id] = dict(clean)
    if db is not None:
        try:
            batch = db.batch()
            batch.set(db.collection("webhook_endpoint_registry").document(endpoint_id), registry_data, merge=merge)
            batch.set(_user_collection(db, uid, "webhook_endpoints").document(endpoint_id), clean, merge=merge)
            batch.commit()
            return True
        except Exception:
            return False
    return False


def _audit(db, uid, action, resource_id=None, details=None):
    audit_id = _doc_id()
    _safe_set(db, uid, "webhook_audit_logs", audit_id, {
        "action": action,
        "resourceId": resource_id,
        "details": _bounded_json(details or {}),
        "requestId": _request_id(),
        "createdAt": _iso(),
    })


def _log_error(db, uid, code, message, endpoint_id=None, event_id=None, status=400):
    error_id = _doc_id()
    record = {
        "code": code,
        "message": message,
        "httpStatus": status,
        "endpointId": endpoint_id,
        "eventId": event_id,
        "requestId": _request_id(),
        "createdAt": _iso(),
    }
    _safe_set(db, uid, "webhook_errors", error_id, record)


def _save_execution(db, uid, event_id, endpoint_id, stages, status, details=None, suffix=None):
    execution_id = event_id if suffix is None else "%s_%s" % (event_id, suffix)
    record = {
        "eventId": event_id,
        "endpointId": endpoint_id,
        "status": status,
        "stages": stages,
        "details": _bounded_json(details or {}),
        "createdAt": stages[0]["timestamp"] if stages else _iso(),
        "updatedAt": _iso(),
    }
    _safe_set(db, uid, "webhook_executions", execution_id, record)


def _stage(stages, name, status="completed", detail=None):
    item = {"sequence": len(stages) + 1, "stage": name, "status": status, "timestamp": _iso()}
    if detail:
        item["detail"] = str(detail)[:256]
    stages.append(item)


def _complete_skipped_stages(stages, outcome, detail=None):
    present = {item["stage"] for item in stages}
    for name in ("risk_checked", "order_created", "execution_blocked"):
        if name not in present:
            _stage(stages, name, "skipped")
    _stage(stages, outcome, "completed", detail)
    if outcome != "completed":
        _stage(stages, "completed", "completed", outcome)


def _idempotency_id(endpoint_id, data, canonical):
    explicit = _pick(data, "idempotencyKey", "idempotency_key", "alertId", "alert_id", "uuid")
    if explicit is not None:
        basis = {"endpointId": endpoint_id, "explicit": str(explicit)}
    else:
        # TradingView retries normally arrive close together. Scope derived keys
        # to a bounded five-minute window so a later legitimate alert with the
        # same symbol, price, and message is not suppressed forever.
        received = _parse_time(canonical.get("receivedTimestamp")) or _now()
        basis = {
            "endpointId": endpoint_id,
            "deduplicationWindow": int(received.timestamp() // 300),
            "symbol": canonical["symbol"],
            "action": canonical["action"],
            "strategy": canonical.get("strategy"),
            "timeframe": canonical.get("timeframe"),
            "triggerTimestamp": canonical.get("triggerTimestamp"),
            "price": canonical.get("price"),
            "quantity": canonical.get("quantity"),
            "message": canonical.get("message"),
        }
    raw = json.dumps(basis, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _claim_event(db, uid, event_id, record):
    """Claim an idempotency key.

    Returns True when claimed, False for a known duplicate, and None when the
    durable store is unavailable. A configured database failure must never be
    treated as a successfully persisted event.
    """
    key = "%s:%s" % (uid, event_id)
    with _MEMORY_LOCK:
        if key in _MEMORY.setdefault("idempotency", {}):
            return False
        _MEMORY["idempotency"][key] = True
    if db is not None:
        ref = _user_collection(db, uid, "webhook_events").document(event_id)
        try:
            ref.create(_json_safe(record))
        except Exception:
            try:
                if ref.get().exists:
                    return False
            except Exception:
                pass
            with _MEMORY_LOCK:
                _MEMORY["idempotency"].pop(key, None)
            return None
    with _MEMORY_LOCK:
        _MEMORY["events"][uid][event_id] = _json_safe(record)
    return True


def _release_event_claim(db, uid, event_id):
    """Release a retryable failed claim so TradingView can safely retry."""
    key = "%s:%s" % (uid, event_id)
    with _MEMORY_LOCK:
        _MEMORY.setdefault("idempotency", {}).pop(key, None)
        _MEMORY["events"][uid].pop(event_id, None)
    if db is not None:
        try:
            _user_collection(db, uid, "webhook_events").document(event_id).delete()
        except Exception:
            return False
    return True


def _update_event(db, uid, event_id, updates):
    _safe_update(db, uid, "webhook_events", event_id, updates)


def _mark_duplicate(db, uid, event_id):
    now = _iso()
    with _MEMORY_LOCK:
        event = _MEMORY["events"][uid].setdefault(event_id, {})
        event["duplicateCount"] = int(event.get("duplicateCount", 0) or 0) + 1
        event["lastDuplicateAt"] = now
    if db is not None:
        try:
            _user_collection(db, uid, "webhook_events").document(event_id).set({
                "duplicateCount": firestore.Increment(1), "lastDuplicateAt": now,
            }, merge=True)
        except Exception:
            pass


def _increment_endpoint(db, uid, endpoint_id, counter):
    now = _iso()
    with _MEMORY_LOCK:
        for bucket in (_MEMORY["registry"], _MEMORY["endpoints"][uid]):
            endpoint = bucket.setdefault(endpoint_id, {})
            endpoint[counter] = int(endpoint.get(counter, 0) or 0) + 1
            endpoint["lastActivityAt"] = now
    if db is not None:
        updates = {counter: firestore.Increment(1), "lastActivityAt": now}
        try:
            db.collection("webhook_endpoint_registry").document(endpoint_id).set(updates, merge=True)
            _user_collection(db, uid, "webhook_endpoints").document(endpoint_id).set(updates, merge=True)
        except Exception:
            pass


def _canonical_event(data, endpoint, endpoint_id, action_info, received_at, source_ip):
    action, direction, action_type = action_info
    supplied_direction = str(_pick(data, "direction", "side", "positionSide") or "").lower()
    if direction is None and supplied_direction in ("long", "buy"):
        direction = "long"
    elif direction is None and supplied_direction in ("short", "sell"):
        direction = "short"
    trigger, trigger_source = _detect_trigger(data)
    trigger_time = _parse_time(_pick(data, "timestamp", "triggerTimestamp", "trigger_time", "alertTimestamp", "triggeredAt"))
    execution_time = _parse_time(_pick(data, "executionTimestamp", "executedAt"))
    price = _number(_pick(data, "price", "entryPrice", "entry_price", "close"))
    quantity = _number(_pick(data, "qty", "quantity", "amount", "size", "contracts"))
    candle_open = _pick(data, "candleOpenTime", "candle_open_time", "barOpenTime", "time_open")
    candle_close = _pick(data, "candleCloseTime", "candle_close_time", "barCloseTime", "time_close")
    raw = _bounded_json(data)
    return {
        "alertId": _pick(data, "alertId", "alert_id", "id"),
        "uuid": _pick(data, "uuid", "alertUuid"),
        "targetTradeId": _pick(data, "tradeId", "trade_id", "positionId", "position_id"),
        "userId": endpoint["userId"],
        "strategy": str(_pick(data, "strategy", "strategyName") or endpoint.get("strategy") or "Unspecified")[:128],
        "strategyVersion": str(_pick(data, "strategyVersion", "version") or "")[:64] or None,
        "symbol": _normalize_symbol(_pick(data, "symbol", "ticker", "pair")),
        "exchange": str(_pick(data, "exchange", "venue") or "")[:64] or None,
        "marketType": str(_pick(data, "marketType", "market_type", "instrumentType") or "")[:32] or None,
        "spotFutures": str(_pick(data, "spotFutures", "spot_futures", "market") or "")[:32] or None,
        "timeframe": str(_pick(data, "timeframe", "interval", "resolution") or "")[:32] or None,
        "candleOpenTime": _iso(_parse_time(candle_open)) if _parse_time(candle_open) else candle_open,
        "candleCloseTime": _iso(_parse_time(candle_close)) if _parse_time(candle_close) else candle_close,
        "triggerTimestamp": _iso(trigger_time) if trigger_time else None,
        "receivedTimestamp": _iso(received_at),
        "executionTimestamp": _iso(execution_time) if execution_time else None,
        "receiveLatencyMs": max(0, int((received_at - trigger_time).total_seconds() * 1000)) if trigger_time else None,
        "executionLatencyMs": None,
        "action": action,
        "actionType": action_type,
        "direction": direction,
        "price": price,
        "entryPrice": _number(_pick(data, "entryPrice", "entry_price"), price),
        "exitPrice": _number(_pick(data, "exitPrice", "exit_price"), price if action_type == "exit" else None),
        "stopLoss": _number(_pick(data, "sl", "stopLoss", "stop_loss")),
        "takeProfit": _number(_pick(data, "tp", "takeProfit", "take_profit")),
        "riskPercent": _number(_pick(data, "riskPct", "riskPercent", "risk_percent")),
        "riskAmount": _number(_pick(data, "riskAmount", "risk_amount")),
        "size": _number(_pick(data, "size", "positionSize", "position_size"), quantity),
        "quantity": quantity,
        "leverage": _number(_pick(data, "leverage"), 1.0),
        "orderType": str(_pick(data, "orderType", "order_type") or "market")[:32].lower(),
        "message": str(_pick(data, "message", "comment", "notes") or "")[:2048] or None,
        "rawPayload": raw,
        "pineVariables": _bounded_json(_pick(data, "pineVariables", "pine_variables", "variables") or {}),
        "status": "received",
        "tradeStatus": str(_pick(data, "tradeStatus", "trade_status") or "pending")[:32],
        "triggerName": trigger,
        "triggerDetection": trigger_source,
        "sourceIp": source_ip,
        "userAgent": str(request.user_agent.string or "")[:512],
        "mode": endpoint.get("mode", "paper"),
        "endpointId": endpoint_id,
        "endpointName": endpoint.get("name"),
        "requestId": _request_id(),
    }


def _risk_errors(event, endpoint):
    errors = []
    if event["actionType"] == "entry":
        if event.get("price") is None or event["price"] <= 0:
            errors.append("price must be positive for entry actions")
        if event.get("quantity") is None or event["quantity"] <= 0:
            errors.append("quantity must be positive for entry actions")
    elif event.get("exitPrice") is None or event["exitPrice"] <= 0:
        errors.append("exit price must be positive for exit actions")
    leverage = event.get("leverage")
    if leverage is None or leverage < 1 or leverage > 125:
        errors.append("leverage must be between 1 and 125")
    risk = event.get("riskPercent")
    if risk is not None and (risk < 0 or risk > 100):
        errors.append("riskPercent must be between 0 and 100")
    max_risk = _number(endpoint.get("maxRiskPercent"))
    if event["actionType"] == "entry" and max_risk is not None and risk is None:
        errors.append("riskPercent is required when the endpoint enforces a maximum risk")
    if event["actionType"] == "entry" and risk is not None and max_risk is not None and risk > max_risk:
        errors.append("riskPercent exceeds endpoint maximum")
    max_leverage = _number(endpoint.get("maxLeverage"))
    if max_leverage is not None and leverage is not None and leverage > max_leverage:
        errors.append("leverage exceeds endpoint maximum")
    return errors


def _paper_entry(db, uid, event_id, event):
    price = event["price"]
    quantity = event["quantity"]
    leverage = event["leverage"]
    position_value = price * quantity
    trade = {
        "id": event_id,
        "eventId": event_id,
        "externalPositionId": event.get("targetTradeId"),
        "symbol": event["symbol"],
        "side": "buy" if event["direction"] == "long" else "sell",
        "direction": event["direction"],
        "strategy": event["strategy"],
        "entryPrice": price,
        "quantity": quantity,
        "leverage": leverage,
        "margin": round(position_value / leverage, 8),
        "fee": 0,
        "positionValue": round(position_value, 8),
        "stopLoss": event.get("stopLoss"),
        "takeProfit": event.get("takeProfit"),
        "status": "open",
        "mode": "paper",
        "source": "tradingview_webhook_v1",
        "pnl": 0,
        "roi": 0,
        "openedAt": _iso(),
        "closedAt": None,
        "exitPrice": None,
    }
    saved = _safe_set(db, uid, "webhook_trades", event_id, trade)
    if db is not None and not saved:
        return {"status": "failed", "reason": "trade_persistence_failed"}
    return {"status": "filled", "tradeId": event_id, "trade": trade}


def _paper_exit(db, uid, event_id, event):
    candidates = _fetch_user_docs(db, uid, "webhook_trades", 500)
    target_trade_id = str(event.get("targetTradeId") or "").strip()
    matches = []
    for trade in candidates:
        if trade.get("status") != "open" or _normalize_symbol(trade.get("symbol")) != event["symbol"]:
            continue
        if target_trade_id and str(trade.get("id")) != target_trade_id and str(trade.get("externalPositionId") or "") != target_trade_id:
            continue
        if event.get("direction") and trade.get("direction") != event["direction"]:
            continue
        if event.get("strategy") and trade.get("strategy") != event["strategy"]:
            continue
        matches.append(trade)
    if not matches:
        return {"status": "ignored", "reason": "no_matching_open_trade"}
    if len(matches) > 1 and not target_trade_id:
        return {"status": "ignored", "reason": "ambiguous_open_trades_require_trade_id"}
    selected = matches[0] if target_trade_id else max(matches, key=lambda item: str(item.get("openedAt") or ""))
    exit_price = event["exitPrice"]
    closed_at = _now()

    def close_values(current):
        entry = _number(current.get("entryPrice"), 0)
        quantity = _number(current.get("quantity"), 0)
        leverage = _number(current.get("leverage"), 1)
        multiplier = 1 if current.get("direction") == "long" else -1
        fees = _number(current.get("fee"), 0)
        # Quantity is the actual instrument size; leverage affects margin and ROI,
        # not the absolute price-movement P&L.
        pnl = (exit_price - entry) * quantity * multiplier - fees
        margin = _number(current.get("margin"), 0)
        roi = (pnl / margin * 100) if margin else 0
        updates = {
            "status": "closed", "exitPrice": exit_price, "pnl": round(pnl, 2),
            "roi": round(roi, 2), "closedAt": _iso(closed_at), "closeEventId": event_id,
        }
        return updates, entry, quantity, leverage, fees, pnl, roi

    def journal_record(trade, entry, quantity, leverage, fees, pnl, roi):
        return {
            "tradeId": selected["id"],
            "eventId": event_id,
            "userId": uid,
            "pair": trade["symbol"],
            "type": trade.get("direction", "long"),
            "entryPrice": entry,
            "exitPrice": exit_price,
            "quantity": quantity,
            "leverage": leverage,
            "fees": fees,
            "date": closed_at.date().isoformat(),
            "time": closed_at.strftime("%H:%M"),
            "strategy": trade.get("strategy") or event.get("strategy"),
            "timeframe": event.get("timeframe"),
            "notes": event.get("message") or "Closed by TradingView webhook",
            "tags": ["webhook", "paper"],
            "status": "closed",
            "stopLoss": trade.get("stopLoss"),
            "takeProfit": trade.get("takeProfit"),
            "pnl": round(pnl, 2),
            "pnlPercent": round(roi, 2),
            "source": "tradingview_webhook_v1",
            "createdAt": _iso(closed_at),
            "updatedAt": _iso(closed_at),
            "openedAt": trade.get("openedAt"),
            "closedAt": _iso(closed_at),
            "holdingTimeSeconds": max(0, int((closed_at - (_parse_time(trade.get("openedAt")) or closed_at)).total_seconds())),
        }

    if db is not None:
        trade_ref = _user_collection(db, uid, "webhook_trades").document(selected["id"])
        journal_ref = _user_collection(db, uid, "trades").document(selected["id"])
        transaction = db.transaction()
        try:
            snapshot = trade_ref.get(transaction=transaction)
            if not snapshot.exists:
                return {"status": "ignored", "reason": "position_not_found"}
            trade = _json_safe(snapshot.to_dict() or {})
            if trade.get("status") != "open":
                return {"status": "ignored", "reason": "position_already_closed"}
            closed_updates, entry, quantity, leverage, fees, pnl, roi = close_values(trade)
            journal = journal_record(trade, entry, quantity, leverage, fees, pnl, roi)
            transaction.update(trade_ref, closed_updates)
            transaction.set(journal_ref, _json_safe(journal))
            transaction.commit()
        except Exception:
            return {"status": "failed", "reason": "position_close_transaction_failed"}
        with _MEMORY_LOCK:
            memory_trade = _MEMORY["webhook_trades"][uid].setdefault(selected["id"], dict(trade))
            memory_trade.update(closed_updates)
            _MEMORY["trades"][uid][selected["id"]] = _json_safe(journal)
    else:
        with _MEMORY_LOCK:
            current = _MEMORY["webhook_trades"][uid].get(selected["id"])
            if not current or current.get("status") != "open":
                return {"status": "ignored", "reason": "position_already_closed"}
            trade = dict(current)
            closed_updates, entry, quantity, leverage, fees, pnl, roi = close_values(trade)
            journal = journal_record(trade, entry, quantity, leverage, fees, pnl, roi)
            current.update(closed_updates)
            _MEMORY["trades"][uid][selected["id"]] = _json_safe(journal)

    return {"status": "filled", "tradeId": selected["id"], "pnl": round(pnl, 2), "journalId": selected["id"]}


def _sort_time(item):
    return str(item.get("receivedTimestamp") or item.get("createdAt") or item.get("updatedAt") or "")


def _filter_events(events, args):
    status = (args.get("status") or "").lower()
    action = (args.get("action") or "").lower()
    symbol = _normalize_symbol(args.get("symbol"))
    strategy = (args.get("strategy") or "").lower()
    search = (args.get("search") or "").lower()[:128]
    start = _parse_time(args.get("start"))
    end = _parse_time(args.get("end"))
    filtered = []
    for event in events:
        when = _parse_time(event.get("receivedTimestamp") or event.get("createdAt"))
        if status and str(event.get("status", "")).lower() != status:
            continue
        if action and str(event.get("action", "")).lower() != action:
            continue
        if symbol and _normalize_symbol(event.get("symbol")) != symbol:
            continue
        if strategy and strategy not in str(event.get("strategy", "")).lower():
            continue
        if start and (not when or when < start):
            continue
        if end and (not when or when > end):
            continue
        if search:
            haystack = " ".join(str(event.get(key, "")) for key in (
                "id", "alertId", "uuid", "symbol", "strategy", "message", "triggerName", "status"
            )).lower()
            if search not in haystack:
                continue
        filtered.append(event)
    return sorted(filtered, key=_sort_time, reverse=True)


def _trade_metrics(trades):
    closed = [trade for trade in trades if trade.get("status") == "closed" or trade.get("closedAt")]
    closed.sort(key=lambda item: str(item.get("closedAt") or item.get("date") or item.get("createdAt") or ""))
    pnls = [_number(item.get("pnl"), 0) for item in closed]
    profits = sum(value for value in pnls if value > 0)
    losses = abs(sum(value for value in pnls if value < 0))
    equity = peak = max_drawdown = 0
    longest_wins = longest_losses = current_wins = current_losses = 0
    holding = []
    for trade, pnl in zip(closed, pnls):
        equity += pnl
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
        if pnl > 0:
            current_wins += 1
            current_losses = 0
            longest_wins = max(longest_wins, current_wins)
        elif pnl < 0:
            current_losses += 1
            current_wins = 0
            longest_losses = max(longest_losses, current_losses)
        seconds = _number(trade.get("holdingTimeSeconds"))
        if seconds is None:
            opened = _parse_time(trade.get("openedAt"))
            closed_at = _parse_time(trade.get("closedAt"))
            if opened and closed_at:
                seconds = max(0, (closed_at - opened).total_seconds())
        if seconds is not None:
            holding.append(seconds)
    current_streak = 0
    for pnl in reversed(pnls):
        sign = 1 if pnl > 0 else -1 if pnl < 0 else 0
        if not sign:
            break
        if not current_streak or (current_streak > 0) == (sign > 0):
            current_streak += sign
        else:
            break
    wins = len([value for value in pnls if value > 0])
    losses_count = len([value for value in pnls if value < 0])
    return {
        "closedTrades": len(closed),
        "wins": wins,
        "losses": losses_count,
        "winRate": round(wins / len(closed) * 100, 2) if closed else 0,
        "lossRate": round(losses_count / len(closed) * 100, 2) if closed else 0,
        "grossProfit": round(profits, 2),
        "grossLoss": round(losses, 2),
        "netProfit": round(sum(pnls), 2),
        "profitFactor": round(profits / losses, 4) if losses else (None if not profits else "infinity"),
        "averageHoldingSeconds": round(sum(holding) / len(holding), 2) if holding else 0,
        "maxDrawdown": round(max_drawdown, 2),
        "currentStreak": current_streak,
        "longestWinStreak": longest_wins,
        "longestLossStreak": longest_losses,
    }


def create_webhook_blueprint(db, base_url=None, firebase_app=None):
    """Create the webhook intelligence Blueprint for an existing Firestore client."""
    bp = Blueprint("webhook_intelligence", __name__)
    configured_base_url = (base_url or os.environ.get("WEBHOOK_BASE_URL") or "").rstrip("/")

    def public_endpoint(endpoint):
        """Return a client-safe endpoint with the configured callback origin."""
        result = _public_endpoint(endpoint)
        if result and configured_base_url and result.get("id"):
            result["webhookUrl"] = "%s/webhook/v1/%s" % (
                configured_base_url,
                result["id"],
            )
        return result

    @bp.before_request
    def assign_request_id():
        g.request_id = uuid.uuid4().hex

    @bp.errorhandler(413)
    def payload_too_large(_error_value):
        return _error("payload_too_large", "JSON payload exceeds 256 KB", 413)

    def require_firebase_auth(handler):
        @wraps(handler)
        def wrapped(*args, **kwargs):
            parts = request.headers.get("Authorization", "").split()
            if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
                return _error(
                    "authentication_required",
                    "A valid Firebase bearer token is required",
                    401,
                )

            if firebase_app is None:
                return _error(
                    "auth_service_unavailable",
                    "Authentication service is temporarily unavailable",
                    503,
                )

            token = parts[1]
            try:
                decoded = auth.verify_id_token(
                    token,
                    app=firebase_app,
                    check_revoked=True,
                )
                uid = decoded.get("uid") or decoded.get("sub")
                if not uid:
                    return _error(
                        "invalid_token",
                        "The Firebase bearer token is invalid",
                        401,
                    )
                if not has_current_otp_proof(decoded):
                    return _error(
                        "otp_required",
                        "Complete OTP verification for this sign-in session",
                        403,
                    )
                g.auth_uid = str(uid)
            except auth.ExpiredIdTokenError:
                return _error(
                    "token_expired",
                    "Your session token expired",
                    401,
                )
            except (auth.RevokedIdTokenError, auth.UserNotFoundError):
                return _error(
                    "token_revoked",
                    "Your session is no longer valid; sign in again",
                    401,
                )
            except auth.UserDisabledError:
                return _error(
                    "user_disabled",
                    "This user account is disabled",
                    401,
                )
            except (auth.InvalidIdTokenError, ValueError):
                return _error(
                    "invalid_token",
                    "The Firebase bearer token is invalid",
                    401,
                )
            except auth.CertificateFetchError:
                return _error(
                    "auth_service_unavailable",
                    "Authentication service is temporarily unavailable",
                    503,
                )
            except Exception:
                # Unknown verification failures are infrastructure failures, not
                # proof that a user's credential is invalid. Fail closed without
                # returning exception text or token material.
                return _error(
                    "auth_service_unavailable",
                    "Authentication service is temporarily unavailable",
                    503,
                )
            return handler(*args, **kwargs)
        return wrapped

    def owned_endpoint(uid, endpoint_id, include_deleted=False):
        endpoint = _get_user_doc(db, uid, "endpoints", endpoint_id)
        if endpoint is None:
            endpoint = _get_user_doc(db, uid, "webhook_endpoints", endpoint_id)
        if endpoint and (include_deleted or not endpoint.get("deleted")):
            return endpoint
        registry = _get_endpoint(db, endpoint_id)
        if registry and registry.get("userId") == uid and (include_deleted or not registry.get("deleted")):
            return registry
        return None

    @bp.post("/webhook/v1/<endpoint_id>")
    def ingest(endpoint_id):
        received_at = _now()
        if request.content_length is not None and request.content_length > MAX_PAYLOAD_BYTES:
            return _error("payload_too_large", "JSON payload exceeds 256 KB", 413)
        if not request.is_json:
            return _error("json_required", "Content-Type must be application/json", 415)
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return _error("invalid_json", "Request body must be a JSON object", 400)
        endpoint = _get_endpoint(db, endpoint_id)
        if not endpoint or endpoint.get("deleted"):
            return _error("endpoint_not_found", "Webhook endpoint was not found", 404)
        uid = endpoint.get("userId")
        if not endpoint.get("enabled", False):
            _log_error(db, uid, "endpoint_disabled", "Webhook endpoint is disabled", endpoint_id, status=403)
            _increment_endpoint(db, uid, endpoint_id, "failedCount")
            return _error("endpoint_disabled", "Webhook endpoint is disabled", 403)
        source_ip = request.remote_addr or ""
        if not _ip_allowed(source_ip, endpoint.get("ipWhitelist") or []):
            _log_error(db, uid, "ip_not_allowed", "Source IP is not allowed", endpoint_id, status=403)
            _increment_endpoint(db, uid, endpoint_id, "failedCount")
            return _error("ip_not_allowed", "Source IP is not allowed", 403)
        provided_secret = data.get("secret")
        if not provided_secret or not _secret_matches(provided_secret, endpoint.get("secretHash")):
            _log_error(db, uid, "invalid_secret", "Webhook secret did not match", endpoint_id, status=401)
            _increment_endpoint(db, uid, endpoint_id, "failedCount")
            return _error("invalid_secret", "Webhook authentication failed", 401)

        # Local burst protection. Production deployments should additionally
        # enforce distributed quotas at the load balancer/API gateway.
        rate_limit = max(1, min(_int(os.environ.get("WEBHOOK_RATE_LIMIT_PER_MINUTE"), 120) or 120, 10000))
        rate_key = "%s:%s" % (endpoint_id, source_ip)
        now_epoch = received_at.timestamp()
        with _MEMORY_LOCK:
            rate_buckets = _MEMORY.setdefault("rate_buckets", {})
            recent = [stamp for stamp in rate_buckets.get(rate_key, []) if now_epoch - stamp < 60]
            if len(recent) >= rate_limit:
                rate_buckets[rate_key] = recent
                rate_limited = True
            else:
                recent.append(now_epoch)
                rate_buckets[rate_key] = recent
                rate_limited = False
        if rate_limited:
            _log_error(db, uid, "rate_limit", "Webhook rate limit exceeded", endpoint_id, status=429)
            _increment_endpoint(db, uid, endpoint_id, "failedCount")
            return _error("rate_limit", "Webhook rate limit exceeded; retry later", 429)

        if not _pick(data, "symbol", "ticker", "pair"):
            _log_error(db, uid, "missing_symbol", "symbol is required", endpoint_id, status=400)
            _increment_endpoint(db, uid, endpoint_id, "failedCount")
            return _error("missing_symbol", "symbol is required", 400)
        action_raw = _pick(data, "action", "side", "signal")
        action_info = _normalize_action(action_raw)
        if not action_info:
            _log_error(db, uid, "invalid_action", "A supported action is required", endpoint_id, status=400)
            _increment_endpoint(db, uid, endpoint_id, "failedCount")
            return _error("invalid_action", "action must be buy/long, sell/short, exit_long, exit_short, or close", 400)
        supplied_timestamp = _pick(data, "timestamp", "triggerTimestamp", "trigger_time", "alertTimestamp", "triggeredAt")
        if supplied_timestamp is not None:
            parsed_timestamp = _parse_time(supplied_timestamp)
            if parsed_timestamp is None:
                return _error("invalid_timestamp", "timestamp must be an epoch or ISO-8601 value", 400)
            default_window = _int(os.environ.get("WEBHOOK_REPLAY_WINDOW_SECONDS"), 300) or 300
            replay_window = _int(endpoint.get("replayWindowSeconds"), default_window) or default_window
            replay_window = max(1, min(replay_window, 3600))
            if abs((received_at - parsed_timestamp).total_seconds()) > replay_window:
                _log_error(db, uid, "stale_webhook", "Webhook timestamp is outside the replay window", endpoint_id, status=408)
                _increment_endpoint(db, uid, endpoint_id, "failedCount")
                return _error("stale_webhook", "Webhook timestamp is outside the allowed replay window", 408)

        canonical = _canonical_event(data, endpoint, endpoint_id, action_info, received_at, source_ip)
        event_id = _idempotency_id(endpoint_id, data, canonical)
        canonical["id"] = event_id
        stages = []
        _stage(stages, "received")
        _stage(stages, "validated")
        canonical["timeline"] = list(stages)
        claim_result = _claim_event(db, uid, event_id, canonical)
        if claim_result is None:
            _log_error(db, uid, "persistence_unavailable", "Unable to durably store webhook event", endpoint_id, event_id, 503)
            _increment_endpoint(db, uid, endpoint_id, "failedCount")
            return _error("persistence_unavailable", "Webhook storage is temporarily unavailable; retry this alert", 503)
        if claim_result is False:
            _stage(stages, "duplicate_checked", "duplicate")
            _complete_skipped_stages(stages, "completed", "duplicate")
            _save_execution(db, uid, event_id, endpoint_id, stages, "duplicate", {"duplicate": True}, uuid.uuid4().hex[:10])
            _mark_duplicate(db, uid, event_id)
            _increment_endpoint(db, uid, endpoint_id, "duplicateCount")
            return jsonify({"status": "duplicate", "eventId": event_id, "requestId": _request_id()}), 200

        _stage(stages, "duplicate_checked")
        risk_errors = _risk_errors(canonical, endpoint)
        if risk_errors:
            _stage(stages, "risk_checked", "rejected", "; ".join(risk_errors))
            _stage(stages, "order_created", "skipped")
            _stage(stages, "execution_blocked", "skipped")
            _stage(stages, "rejected", "completed", "risk_validation_failed")
            _stage(stages, "completed", "completed", "rejected")
            updates = {"status": "failed", "tradeStatus": "rejected", "timeline": stages, "validationErrors": risk_errors, "completedAt": _iso()}
            _update_event(db, uid, event_id, updates)
            _save_execution(db, uid, event_id, endpoint_id, stages, "rejected", {"validationErrors": risk_errors})
            _log_error(db, uid, "risk_validation_failed", "Webhook failed risk validation", endpoint_id, event_id, 422)
            _increment_endpoint(db, uid, endpoint_id, "failedCount")
            return _error("risk_validation_failed", "Webhook failed risk validation", 422, risk_errors)

        _stage(stages, "risk_checked")
        mode = endpoint.get("mode", "paper")
        execution_started = _now()
        if mode == "live":
            _stage(stages, "order_created", "skipped", "tenant-safe adapter not configured")
            _stage(stages, "execution_blocked", "completed", "tenant-safe adapter not configured")
            _stage(stages, "completed", "completed", "execution_blocked")
            enabled = os.environ.get("WEBHOOK_LIVE_EXECUTION_ENABLED", "false").lower() == "true"
            reason = "adapter_not_configured" if enabled else "live_execution_disabled"
            result = {"status": "execution_blocked", "reason": reason}
            status = "execution_blocked"
        else:
            _stage(stages, "order_created")
            _stage(stages, "order_sent", "completed", "paper")
            result = _paper_entry(db, uid, event_id, canonical) if canonical["actionType"] == "entry" else _paper_exit(db, uid, event_id, canonical)
            if result["status"] == "filled":
                _stage(stages, "filled")
                status = "executed"
            elif result["status"] == "failed":
                _stage(stages, "rejected", "completed", result.get("reason", "persistence_failed"))
                status = "failed"
                _log_error(db, uid, result.get("reason", "execution_failed"), "Paper execution could not be persisted", endpoint_id, event_id, 503)
            else:
                _stage(stages, "completed", "completed", result.get("reason", "ignored"))
                status = "ignored"
            if result["status"] == "filled":
                _stage(stages, "completed")
        execution_finished = _now()
        latency_ms = max(0, int((execution_finished - execution_started).total_seconds() * 1000))
        updates = {
            "status": status,
            "tradeStatus": result["status"],
            "executionTimestamp": _iso(execution_finished),
            "executionLatencyMs": latency_ms,
            "timeline": stages,
            "executionResult": _bounded_json(result),
            "completedAt": _iso(execution_finished),
        }
        _update_event(db, uid, event_id, updates)
        _save_execution(db, uid, event_id, endpoint_id, stages, status, result)
        if status == "executed":
            _increment_endpoint(db, uid, endpoint_id, "acceptedCount")
        elif status == "failed":
            _increment_endpoint(db, uid, endpoint_id, "failedCount")
        elif status in ("execution_blocked", "ignored"):
            _increment_endpoint(db, uid, endpoint_id, status + "Count")
        response_body = {
            "status": status,
            "eventId": event_id,
            "execution": result,
            "requestId": _request_id(),
        }
        if status == "failed":
            _release_event_claim(db, uid, event_id)
            return jsonify(response_body), 503
        return jsonify(response_body), 202

    @bp.get("/api/v1/webhooks/endpoints")
    @require_firebase_auth
    def list_endpoints():
        uid = g.auth_uid
        records = _fetch_user_docs(db, uid, "webhook_endpoints", 200)
        if not records:
            records = _fetch_user_docs(db, uid, "endpoints", 200)
        records = [public_endpoint(item) for item in records if not item.get("deleted")]
        records.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
        return jsonify({"endpoints": records, "total": len(records), "requestId": _request_id()})

    @bp.post("/api/v1/webhooks/endpoints")
    @require_firebase_auth
    def create_endpoint():
        uid = g.auth_uid
        data = request.get_json(silent=True) if request.is_json else None
        if not isinstance(data, dict):
            return _error("invalid_json", "Request body must be a JSON object", 400)
        name = str(data.get("name") or "").strip()[:128]
        strategy = str(data.get("strategy") or "").strip()[:128]
        mode = str(data.get("mode") or "paper").lower()
        if not name or not strategy:
            return _error("missing_fields", "name and strategy are required", 400)
        if mode not in ("paper", "live"):
            return _error("invalid_mode", "mode must be paper or live", 400)
        ip_whitelist = data.get("ipWhitelist") or []
        if not isinstance(ip_whitelist, list) or len(ip_whitelist) > 50:
            return _error("invalid_ip_whitelist", "ipWhitelist must be a list of at most 50 addresses or CIDRs", 400)
        for item in ip_whitelist:
            try:
                ipaddress.ip_network(str(item), strict=False)
            except ValueError:
                return _error("invalid_ip_whitelist", "ipWhitelist contains an invalid address or CIDR", 400)
        max_risk = _number(data.get("maxRiskPercent"))
        max_leverage = _number(data.get("maxLeverage"))
        if max_risk is not None and not 0 <= max_risk <= 100:
            return _error("invalid_max_risk", "maxRiskPercent must be between 0 and 100", 400)
        if max_leverage is not None and not 1 <= max_leverage <= 125:
            return _error("invalid_max_leverage", "maxLeverage must be between 1 and 125", 400)
        endpoint_id = secrets.token_urlsafe(18).replace("-", "").replace("_", "")
        secret = secrets.token_urlsafe(32)
        now = _iso()
        root = configured_base_url or request.url_root.rstrip("/")
        webhook_url = "%s/webhook/v1/%s" % (root, endpoint_id)
        endpoint = {
            "id": endpoint_id,
            "name": name,
            "strategy": strategy,
            "webhookUrl": webhook_url,
            "mode": mode,
            "enabled": bool(data.get("enabled", True)),
            "deleted": False,
            "secretHash": _hash_secret(secret),
            "ipWhitelist": [str(item) for item in ip_whitelist],
            "replayWindowSeconds": max(1, min(_int(data.get("replayWindowSeconds"), 300) or 300, 3600)),
            "maxRiskPercent": max_risk,
            "maxLeverage": max_leverage,
            "createdAt": now,
            "updatedAt": now,
            "acceptedCount": 0,
            "failedCount": 0,
            "duplicateCount": 0,
        }
        saved = _save_endpoint(db, uid, endpoint_id, endpoint)
        if db is not None and not saved:
            return _error("persistence_unavailable", "Unable to durably create the endpoint; retry later", 503)
        _audit(db, uid, "endpoint_created", endpoint_id, {"name": name, "mode": mode})
        return jsonify({
            "endpoint": public_endpoint(endpoint),
            "secret": secret,
            "webhookUrl": webhook_url,
            "warning": "Store this secret now; it will not be shown again.",
            "requestId": _request_id(),
        }), 201

    @bp.patch("/api/v1/webhooks/endpoints/<endpoint_id>")
    @require_firebase_auth
    def update_endpoint(endpoint_id):
        uid = g.auth_uid
        endpoint = owned_endpoint(uid, endpoint_id)
        if not endpoint:
            return _error("endpoint_not_found", "Webhook endpoint was not found", 404)
        data = request.get_json(silent=True) if request.is_json else None
        if not isinstance(data, dict):
            return _error("invalid_json", "Request body must be a JSON object", 400)
        updates = {}
        for key in ("name", "strategy"):
            if key in data:
                value = str(data[key] or "").strip()[:128]
                if not value:
                    return _error("invalid_%s" % key, "%s cannot be empty" % key, 400)
                updates[key] = value
        if "mode" in data:
            mode = str(data["mode"]).lower()
            if mode not in ("paper", "live"):
                return _error("invalid_mode", "mode must be paper or live", 400)
            updates["mode"] = mode
        if "enabled" in data:
            updates["enabled"] = bool(data["enabled"])
        if "ipWhitelist" in data:
            values = data["ipWhitelist"]
            if not isinstance(values, list) or len(values) > 50:
                return _error("invalid_ip_whitelist", "ipWhitelist must be a list of at most 50 addresses or CIDRs", 400)
            try:
                for item in values:
                    ipaddress.ip_network(str(item), strict=False)
            except ValueError:
                return _error("invalid_ip_whitelist", "ipWhitelist contains an invalid address or CIDR", 400)
            updates["ipWhitelist"] = [str(item) for item in values]
        if "maxRiskPercent" in data:
            value = _number(data["maxRiskPercent"])
            if value is None or not 0 <= value <= 100:
                return _error("invalid_max_risk", "maxRiskPercent must be between 0 and 100", 400)
            updates["maxRiskPercent"] = value
        if "maxLeverage" in data:
            value = _number(data["maxLeverage"])
            if value is None or not 1 <= value <= 125:
                return _error("invalid_max_leverage", "maxLeverage must be between 1 and 125", 400)
            updates["maxLeverage"] = value
        if "replayWindowSeconds" in data:
            value = _int(data["replayWindowSeconds"])
            if value is None or not 1 <= value <= 3600:
                return _error("invalid_replay_window", "replayWindowSeconds must be between 1 and 3600", 400)
            updates["replayWindowSeconds"] = value
        updates["updatedAt"] = _iso()
        saved = _save_endpoint(db, uid, endpoint_id, updates, merge=True)
        if db is not None and not saved:
            return _error("persistence_unavailable", "Unable to update the endpoint; retry later", 503)
        _audit(db, uid, "endpoint_updated", endpoint_id, {"fields": sorted(updates.keys())})
        updated = {**endpoint, **updates}
        return jsonify({"endpoint": public_endpoint(updated), "requestId": _request_id()})

    @bp.post("/api/v1/webhooks/endpoints/<endpoint_id>/rotate-secret")
    @require_firebase_auth
    def rotate_secret(endpoint_id):
        uid = g.auth_uid
        endpoint = owned_endpoint(uid, endpoint_id)
        if not endpoint:
            return _error("endpoint_not_found", "Webhook endpoint was not found", 404)
        secret = secrets.token_urlsafe(32)
        saved = _save_endpoint(db, uid, endpoint_id, {"secretHash": _hash_secret(secret), "updatedAt": _iso(), "secretRotatedAt": _iso()}, merge=True)
        if db is not None and not saved:
            return _error("persistence_unavailable", "Unable to rotate the endpoint secret; the previous secret remains authoritative", 503)
        _audit(db, uid, "endpoint_secret_rotated", endpoint_id)
        webhook_url = "%s/webhook/v1/%s" % (
            configured_base_url or request.url_root.rstrip("/"),
            endpoint_id,
        )
        return jsonify({
            "endpointId": endpoint_id,
            "secret": secret,
            "webhookUrl": webhook_url,
            "warning": "Store this secret now; it will not be shown again.",
            "requestId": _request_id(),
        })

    @bp.post("/api/v1/webhooks/endpoints/<endpoint_id>/<state>")
    @require_firebase_auth
    def set_endpoint_state(endpoint_id, state):
        if state not in ("enable", "disable"):
            return _error("not_found", "Resource was not found", 404)
        uid = g.auth_uid
        endpoint = owned_endpoint(uid, endpoint_id)
        if not endpoint:
            return _error("endpoint_not_found", "Webhook endpoint was not found", 404)
        enabled = state == "enable"
        saved = _save_endpoint(db, uid, endpoint_id, {"enabled": enabled, "updatedAt": _iso()}, merge=True)
        if db is not None and not saved:
            return _error("persistence_unavailable", "Unable to change endpoint state; retry later", 503)
        _audit(db, uid, "endpoint_%sd" % state, endpoint_id)
        return jsonify({"endpointId": endpoint_id, "enabled": enabled, "requestId": _request_id()})

    @bp.delete("/api/v1/webhooks/endpoints/<endpoint_id>")
    @require_firebase_auth
    def delete_endpoint(endpoint_id):
        uid = g.auth_uid
        endpoint = owned_endpoint(uid, endpoint_id)
        if not endpoint:
            return _error("endpoint_not_found", "Webhook endpoint was not found", 404)
        now = _iso()
        saved = _save_endpoint(db, uid, endpoint_id, {"enabled": False, "deleted": True, "deletedAt": now, "updatedAt": now}, merge=True)
        if db is not None and not saved:
            return _error("persistence_unavailable", "Unable to delete the endpoint; retry later", 503)
        _audit(db, uid, "endpoint_deleted", endpoint_id)
        return jsonify({"status": "deleted", "endpointId": endpoint_id, "requestId": _request_id()})

    @bp.get("/api/v1/webhooks/events")
    @require_firebase_auth
    def list_events():
        uid = g.auth_uid
        page = max(1, request.args.get("page", 1, type=int))
        limit = max(1, min(request.args.get("limit", 50, type=int), 100))
        records = _fetch_user_docs(db, uid, "webhook_events", MAX_FETCH)
        if not records:
            records = _fetch_user_docs(db, uid, "events", MAX_FETCH)
        records = _filter_events(records, request.args)
        start = (page - 1) * limit
        return jsonify({
            "events": records[start:start + limit], "total": len(records), "page": page,
            "limit": limit, "hasMore": start + limit < len(records), "requestId": _request_id(),
        })

    @bp.get("/api/v1/webhooks/events/<event_id>")
    @require_firebase_auth
    def event_detail(event_id):
        uid = g.auth_uid
        event = _get_user_doc(db, uid, "webhook_events", event_id) or _get_user_doc(db, uid, "events", event_id)
        if not event:
            return _error("event_not_found", "Webhook event was not found", 404)
        executions = [item for item in _fetch_user_docs(db, uid, "webhook_executions", MAX_FETCH) if item.get("eventId") == event_id]
        if not executions:
            executions = [item for item in _fetch_user_docs(db, uid, "executions", MAX_FETCH) if item.get("eventId") == event_id]
        errors = [item for item in _fetch_user_docs(db, uid, "webhook_errors", MAX_FETCH) if item.get("eventId") == event_id]
        if not errors:
            errors = [item for item in _fetch_user_docs(db, uid, "errors", MAX_FETCH) if item.get("eventId") == event_id]
        return jsonify({"event": event, "executions": executions, "errors": errors, "requestId": _request_id()})

    def collection_response(primary, fallback, key):
        uid = g.auth_uid
        limit = max(1, min(request.args.get("limit", 100, type=int), 200))
        records = _fetch_user_docs(db, uid, primary, MAX_FETCH)
        if not records:
            records = _fetch_user_docs(db, uid, fallback, MAX_FETCH)
        endpoint_id = request.args.get("endpointId")
        event_id = request.args.get("eventId")
        status = request.args.get("status")
        if endpoint_id:
            records = [item for item in records if item.get("endpointId") == endpoint_id]
        if event_id:
            records = [item for item in records if item.get("eventId") == event_id]
        if status:
            records = [item for item in records if str(item.get("status", "")).lower() == status.lower()]
        records.sort(key=_sort_time, reverse=True)
        return jsonify({key: records[:limit], "total": len(records), "requestId": _request_id()})

    @bp.get("/api/v1/webhooks/errors")
    @require_firebase_auth
    def list_errors():
        return collection_response("webhook_errors", "errors", "errors")

    @bp.get("/api/v1/webhooks/trades")
    @require_firebase_auth
    def list_webhook_trades():
        return collection_response("webhook_trades", "webhook_trades", "trades")

    @bp.get("/api/v1/webhooks/executions")
    @require_firebase_auth
    def list_executions():
        return collection_response("webhook_executions", "executions", "executions")

    @bp.get("/api/v1/webhooks/overview")
    @require_firebase_auth
    def overview():
        uid = g.auth_uid
        events = _fetch_user_docs(db, uid, "webhook_events", MAX_FETCH)
        if not events:
            events = _fetch_user_docs(db, uid, "events", MAX_FETCH)
        endpoints = _fetch_user_docs(db, uid, "webhook_endpoints", 200)
        trades = _fetch_user_docs(db, uid, "webhook_trades", MAX_FETCH)
        journal = _fetch_user_docs(db, uid, "trades", MAX_FETCH)
        metrics = {
            "total": len(events), "buy": 0, "sell": 0, "executed": 0,
            "failed": 0, "duplicate": 0, "ignored": 0,
        }
        receive_latencies = []
        execution_latencies = []
        per_hour = defaultdict(int)
        per_day = defaultdict(int)
        per_strategy = defaultdict(int)
        per_symbol = defaultdict(int)
        for event in events:
            action = event.get("action")
            if action == "buy":
                metrics["buy"] += 1
            elif action == "sell":
                metrics["sell"] += 1
            status = str(event.get("status") or "")
            if status in metrics:
                metrics[status] += 1
            metrics["duplicate"] += int(event.get("duplicateCount", 0) or 0)
            for field, target in (("receiveLatencyMs", receive_latencies), ("executionLatencyMs", execution_latencies)):
                value = _number(event.get(field))
                if value is not None:
                    target.append(value)
            moment = _parse_time(event.get("receivedTimestamp"))
            if moment:
                per_hour[moment.strftime("%Y-%m-%dT%H:00Z")] += 1
                per_day[moment.strftime("%Y-%m-%d")] += 1
            per_strategy[str(event.get("strategy") or "Unspecified")] += 1
            per_symbol[str(event.get("symbol") or "Unknown")] += 1
        webhook_journal = [
            trade for trade in journal
            if trade.get("source") == "tradingview_webhook_v1" or "webhook" in (trade.get("tags") or [])
        ]
        closed_for_metrics = webhook_journal or trades
        trade_metrics = _trade_metrics(closed_for_metrics)
        metrics.update({
            "averageLatencyMs": round(sum(receive_latencies) / len(receive_latencies), 2) if receive_latencies else 0,
            "averageExecutionMs": round(sum(execution_latencies) / len(execution_latencies), 2) if execution_latencies else 0,
            "winRate": trade_metrics["winRate"],
            "lossRate": trade_metrics["lossRate"],
            "connectedEndpoints": len([item for item in endpoints if item.get("enabled") and not item.get("deleted")]),
        })
        live_flag = os.environ.get("WEBHOOK_LIVE_EXECUTION_ENABLED", "false").lower() == "true"
        return jsonify({
            "metrics": metrics,
            "statuses": {
                "server": "healthy",
                "database": "connected" if db is not None else "memory_fallback",
                "exchange": "not_configured",
                "liveSafety": "adapter_not_configured" if live_flag else "disabled",
            },
            "aggregates": {"perHour": dict(per_hour), "perDay": dict(per_day), "perStrategy": dict(per_strategy), "perSymbol": dict(per_symbol)},
            "tradeMetrics": trade_metrics,
            "boundedSampleSize": MAX_FETCH,
            "requestId": _request_id(),
        })

    @bp.get("/api/v1/webhooks/health")
    @require_firebase_auth
    def webhook_health():
        live_flag = os.environ.get("WEBHOOK_LIVE_EXECUTION_ENABLED", "false").lower() == "true"
        return jsonify({
            "server": {"status": "healthy", "timestamp": _iso()},
            "database": {"status": "connected" if db is not None else "memory_fallback"},
            "exchange": {"status": "not_configured"},
            "liveSafety": {
                "status": "adapter_not_configured" if live_flag else "disabled",
                "executionEnabledFlag": live_flag,
                "tenantSafeAdapterConfigured": False,
            },
            "requestId": _request_id(),
        })

    return bp
