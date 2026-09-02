"""Privacy-safe structured observability for complimentary billing.

Only the allowlisted fields below may be emitted. Callers pass raw UIDs solely to
``log_event``; they are one-way hashed before serialization and are never placed
in a log record directly.
"""

from __future__ import annotations

import hashlib
import json
import logging
from contextvars import ContextVar


LOGGER_NAME = "billing.complimentary"
_LOGGER = logging.getLogger(LOGGER_NAME)
_REQUEST_ID = ContextVar("billing_complimentary_request_id", default=None)

_ALLOWED_FIELDS = frozenset({
    "requestId",
    "operation",
    "resultCode",
    "duplicate",
    "latencyMs",
    "actorUidHash",
    "targetUidHash",
    "grantId",
    "planId",
    "validityType",
    "transitionType",
})


def set_request_id(request_id):
    """Bind a request correlation ID for logs emitted during this execution."""
    normalized = str(request_id or "").strip()
    _REQUEST_ID.set(normalized[:128] or None)


def hash_uid(uid):
    """Return a stable one-way identifier suitable for operational correlation."""
    if not isinstance(uid, str) or not uid:
        return None
    return hashlib.sha256(uid.encode("utf-8")).hexdigest()


def log_event(
    *,
    operation,
    result_code,
    duplicate=None,
    latency_ms=None,
    actor_uid=None,
    target_uid=None,
    grant_id=None,
    plan_id=None,
    validity_type=None,
    transition_type=None,
):
    """Emit one JSON event containing only the approved Task 20 fields."""
    event = {
        "requestId": _REQUEST_ID.get(),
        "operation": operation,
        "resultCode": result_code,
        "duplicate": duplicate if type(duplicate) is bool else None,
        "latencyMs": max(0, int(latency_ms)) if isinstance(latency_ms, (int, float)) else None,
        "actorUidHash": hash_uid(actor_uid),
        "targetUidHash": hash_uid(target_uid),
        "grantId": grant_id if isinstance(grant_id, str) and grant_id else None,
        "planId": plan_id if isinstance(plan_id, str) and plan_id else None,
        "validityType": validity_type if isinstance(validity_type, str) and validity_type else None,
        "transitionType": transition_type if isinstance(transition_type, str) and transition_type else None,
    }
    event = {key: value for key, value in event.items() if value is not None}
    if not event or set(event) - _ALLOWED_FIELDS:
        raise ValueError("Complimentary billing log fields are not allowlisted")
    _LOGGER.info(json.dumps(event, sort_keys=True, separators=(",", ":")))
