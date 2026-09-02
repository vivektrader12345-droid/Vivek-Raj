"""Core billing rules and an injectable in-memory persistence implementation."""

from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from billing_observability import log_event


UTC = timezone.utc
CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{1,31}$")
IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
MAX_CLIENT_FAILURE_ATTEMPTS = 10


class BillingError(Exception):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details


def utc_now():
    return datetime.now(UTC)


def aware_datetime(value, field="date"):
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise BillingError("invalid_%s" % field, "%s must be an ISO-8601 datetime" % field) from error
    else:
        raise BillingError("invalid_%s" % field, "%s must be an ISO-8601 datetime" % field)
    if parsed.tzinfo is None:
        raise BillingError("invalid_%s" % field, "%s must include a timezone" % field)
    return parsed.astimezone(UTC)


def iso(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def paise_from_inr(value, field):
    if isinstance(value, bool):
        raise BillingError("invalid_%s" % field, "%s must be a non-negative INR amount" % field)
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise BillingError("invalid_%s" % field, "%s must be a non-negative INR amount" % field) from error
    if not decimal.is_finite() or decimal < 0:
        raise BillingError("invalid_%s" % field, "%s must be a non-negative INR amount" % field)
    quantized = decimal.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if quantized != decimal:
        raise BillingError("invalid_%s" % field, "%s supports at most two decimal places" % field)
    return int(quantized * 100)


def inr_from_paise(value):
    return float((Decimal(int(value or 0)) / 100).quantize(Decimal("0.01")))


PLAN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")
ENTITLEMENT_TIERS = ("basic", "pro", "elite")


@dataclass(frozen=True)
class Plan:
    id: str
    name: str
    amount_paise: int
    duration_days: int
    features: tuple
    active: bool = True
    sort_order: int = 0
    entitlement_tier: str = "basic"
    revision: int = 0

    def record(self):
        return {
            "id": self.id,
            "name": self.name,
            "amountPaise": self.amount_paise,
            "durationDays": self.duration_days,
            "features": list(self.features),
            "active": self.active,
            "sortOrder": self.sort_order,
            "entitlementTier": self.entitlement_tier,
            "revision": self.revision,
        }

    def public(self):
        return {
            **self.record(),
            "amountInr": inr_from_paise(self.amount_paise),
            "currency": "INR",
        }

    def snapshot(self):
        return self.public()


DEFAULT_PLANS = (
    Plan("basic", "Basic", 49900, 30, ("Trading dashboard", "Trade journal", "Email support"), True, 0, "basic"),
    Plan("pro", "Pro", 99900, 90, ("Everything in Basic", "Advanced analytics", "Algo and webhook tools", "Priority support"), True, 1, "pro"),
    Plan("elite", "Elite", 249900, 365, ("Everything in Pro", "Pro trading terminal", "Full-year access", "Premium support"), True, 2, "elite"),
)


def normalize_plan_input(data, existing=None):
    if not isinstance(data, dict):
        raise BillingError("invalid_request", "Plan must be a JSON object")
    source = dict(existing or {})
    source.update(data)
    raw_id = source.get("id")
    if not isinstance(raw_id, str):
        raise BillingError("invalid_plan_id", "Plan ID must be a string")
    plan_id = raw_id.strip()
    if not PLAN_ID_RE.fullmatch(plan_id):
        raise BillingError("invalid_plan_id", "Plan ID must be 2-32 lowercase letters, numbers, underscores, or hyphens")
    raw_name = source.get("name")
    if not isinstance(raw_name, str):
        raise BillingError("invalid_plan_name", "Plan name must be a string")
    name = raw_name.strip()
    if not name or len(name) > 80:
        raise BillingError("invalid_plan_name", "Plan name must be between 1 and 80 characters")
    amount = source.get("amountPaise")
    duration = source.get("durationDays")
    sort_order = source.get("sortOrder", 0)
    revision = source.get("revision", 0)
    if type(amount) is not int or amount <= 0:
        raise BillingError("invalid_plan_amount", "Plan amountPaise must be a positive integer")
    if type(duration) is not int or duration <= 0 or duration > 3650:
        raise BillingError("invalid_plan_duration", "Plan durationDays must be an integer from 1 to 3650")
    if type(sort_order) is not int or sort_order < 0 or sort_order > 10000:
        raise BillingError("invalid_plan_sort_order", "Plan sortOrder must be an integer from 0 to 10000")
    if type(revision) is not int or revision < 0:
        raise BillingError("invalid_plan_revision", "Plan revision must be a non-negative integer")
    features = source.get("features")
    if not isinstance(features, list) or not features or len(features) > 20:
        raise BillingError("invalid_plan_features", "Plan features must contain between 1 and 20 items")
    normalized_features = []
    for value in features:
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 160:
            raise BillingError("invalid_plan_features", "Each plan feature must be a string between 1 and 160 characters")
        normalized_features.append(value.strip())
    active = source.get("active", True)
    if type(active) is not bool:
        raise BillingError("invalid_plan_status", "Plan active must be a boolean")
    raw_tier = source.get("entitlementTier", plan_id if plan_id in ENTITLEMENT_TIERS else "basic")
    if not isinstance(raw_tier, str):
        raise BillingError("invalid_entitlement_tier", "Plan entitlementTier must be a string")
    entitlement_tier = raw_tier.strip().lower()
    if entitlement_tier not in ENTITLEMENT_TIERS:
        raise BillingError("invalid_entitlement_tier", "Plan entitlementTier must be basic, pro, or elite")
    return {
        "id": plan_id,
        "name": name,
        "amountPaise": amount,
        "durationDays": duration,
        "features": normalized_features,
        "active": active,
        "sortOrder": sort_order,
        "entitlementTier": entitlement_tier,
        "revision": revision,
    }


def plan_from_record(value):
    record = normalize_plan_input(value)
    return Plan(
        record["id"], record["name"], record["amountPaise"], record["durationDays"],
        tuple(record["features"]), record["active"], record["sortOrder"], record["entitlementTier"],
        record["revision"],
    )


class PlanCatalog:
    def __init__(self, plans=None):
        values = tuple(DEFAULT_PLANS if plans is None else plans)
        self._plans = {plan.id: plan for plan in values}
        if len(self._plans) != len(values):
            raise ValueError("Plan IDs must be unique")

    @classmethod
    def from_json(cls, raw):
        if not (raw or "").strip():
            return cls()
        try:
            data = json.loads(raw)
        except Exception as error:
            raise ValueError("BILLING_PLANS_JSON must be valid JSON") from error
        if isinstance(data, dict):
            if any(not isinstance(value, dict) for value in data.values()):
                raise ValueError("Each billing plan must be an object")
            items = [{"id": key, **value} for key, value in data.items()]
        elif isinstance(data, list):
            items = data
        else:
            raise ValueError("BILLING_PLANS_JSON must be an array or object")
        plans = []
        try:
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    raise BillingError("invalid_plan", "Each billing plan must be an object")
                raw_id = item.get("id")
                if not isinstance(raw_id, str):
                    raise BillingError("invalid_plan_id", "Plan ID must be a string")
                plan_id = raw_id.strip()
                record = normalize_plan_input({
                    **item,
                    "active": item.get("active", True),
                    "sortOrder": item.get("sortOrder", index),
                    "entitlementTier": item.get("entitlementTier", plan_id if plan_id in ENTITLEMENT_TIERS else "basic"),
                })
                plans.append(plan_from_record(record))
        except BillingError as error:
            raise ValueError(error.message) from error
        if not plans:
            raise ValueError("At least one billing plan is required")
        return cls(plans)

    def all(self, include_inactive=False):
        return [
            plan.public() for plan in sorted(self._plans.values(), key=lambda value: (value.sort_order, value.id))
            if include_inactive or plan.active
        ]

    def get(self, plan_id, include_inactive=False):
        plan = self._plans.get(str(plan_id or "").strip().lower())
        if not plan or (not include_inactive and not plan.active):
            raise BillingError("plan_not_found", "The selected billing plan was not found", 404)
        return plan


class StoredPlanCatalog:
    """Request-time plan catalog backed by the billing store."""

    def __init__(self, store):
        self.store = store

    def all(self, include_inactive=False):
        return [plan_from_record(value).public() for value in self.store.list_plans(include_inactive)]

    def get(self, plan_id, include_inactive=False):
        value = self.store.get_plan(str(plan_id or "").strip().lower(), include_inactive)
        if not value:
            raise BillingError("plan_not_found", "The selected billing plan was not found", 404)
        return plan_from_record(value)


def normalize_code(value):
    code = str(value or "").strip().upper()
    if not CODE_RE.fullmatch(code):
        raise BillingError("invalid_coupon_code", "Coupon code must be 2-32 letters, numbers, underscores, or hyphens")
    return code


def _positive_optional_int(value, field):
    if value in (None, ""):
        return None
    if type(value) is not int:
        raise BillingError("invalid_%s" % field, "%s must be a positive integer" % field)
    parsed = value
    if parsed <= 0:
        raise BillingError("invalid_%s" % field, "%s must be a positive integer" % field)
    return parsed


def normalize_coupon_input(data, existing=None):
    if not isinstance(data, dict):
        raise BillingError("invalid_request", "Request body must be a JSON object")
    source = dict(existing or {})
    source.update(data)
    code = normalize_code(source.get("code"))
    discount_type = str(source.get("type") or source.get("discountType") or "").strip().lower()
    if discount_type not in ("percentage", "fixed"):
        raise BillingError("invalid_coupon_type", "Coupon type must be percentage or fixed")
    raw_value = source.get("value")
    if raw_value is None and existing:
        raw_value = (Decimal(existing.get("valueBasisPoints", 0)) / 100 if discount_type == "percentage" else inr_from_paise(existing.get("valuePaise", 0)))
    if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float, Decimal)):
        raise BillingError("invalid_coupon_value", "Coupon value must be a JSON number")
    if discount_type == "percentage":
        try:
            percent = Decimal(str(raw_value))
        except (InvalidOperation, ValueError) as error:
            raise BillingError("invalid_coupon_value", "Percentage value must be greater than 0 and at most 100") from error
        basis_points = int((percent * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        if percent <= 0 or percent > 100 or Decimal(basis_points) / 100 != percent:
            raise BillingError("invalid_coupon_value", "Percentage value must be 0.01-100 with at most two decimals")
        value_paise = None
    else:
        value_paise = paise_from_inr(raw_value, "coupon_value")
        if value_paise <= 0:
            raise BillingError("invalid_coupon_value", "Fixed coupon value must be greater than zero")
        basis_points = None
    minimum_source = source.get("minimumAmountInr", source.get("minimumAmount", None))
    if minimum_source is None and existing:
        minimum_paise = int(existing.get("minimumAmountPaise", 0))
    else:
        if isinstance(minimum_source, bool) or (minimum_source is not None and not isinstance(minimum_source, (int, float, Decimal))):
            raise BillingError("invalid_minimum_amount", "minimum amount must be a JSON number")
        minimum_paise = paise_from_inr(minimum_source or 0, "minimum_amount")
    max_provided = "maxDiscountInr" in data or "maximumDiscountInr" in data
    max_source = data.get("maxDiscountInr", data.get("maximumDiscountInr")) if max_provided else None
    if not max_provided and existing:
        max_paise = existing.get("maxDiscountPaise")
    else:
        if isinstance(max_source, bool) or (max_source is not None and not isinstance(max_source, (int, float, Decimal))):
            raise BillingError("invalid_max_discount", "maximum discount must be a JSON number")
        max_paise = paise_from_inr(max_source, "max_discount") if max_source is not None else None
    if discount_type == "fixed" and max_paise is not None:
        raise BillingError("invalid_max_discount", "Maximum discount applies only to percentage coupons")
    plan_ids = source.get("planIds", [])
    if plan_ids is None:
        plan_ids = []
    if not isinstance(plan_ids, list) or any(not isinstance(value, str) or not value.strip() for value in plan_ids):
        raise BillingError("invalid_plan_ids", "planIds must be an array of plan IDs")
    active = source.get("active", True)
    first_time_only = source.get("firstTimeOnly", False)
    if type(active) is not bool:
        raise BillingError("invalid_active", "active must be a JSON boolean")
    if type(first_time_only) is not bool:
        raise BillingError("invalid_first_time_only", "firstTimeOnly must be a JSON boolean")
    starts_at = aware_datetime(source.get("startsAt"), "starts_at")
    expires_at = aware_datetime(source.get("expiresAt"), "expires_at")
    if starts_at and expires_at and starts_at >= expires_at:
        raise BillingError("invalid_coupon_window", "Coupon start date must be before its expiry date")
    return {
        "code": code,
        "discountType": discount_type,
        "valueBasisPoints": basis_points,
        "valuePaise": value_paise,
        "minimumAmountPaise": minimum_paise,
        "maxDiscountPaise": max_paise,
        "startsAt": starts_at,
        "expiresAt": expires_at,
        "globalUsageLimit": _positive_optional_int(source.get("globalUsageLimit"), "global_usage_limit"),
        "perUserUsageLimit": _positive_optional_int(source.get("perUserUsageLimit"), "per_user_usage_limit"),
        "active": active,
        "planIds": sorted({str(value).strip().lower() for value in plan_ids}),
        "firstTimeOnly": first_time_only,
        "usedCount": int((existing or {}).get("usedCount", 0)),
        "reservedCount": int((existing or {}).get("reservedCount", 0)),
    }


def public_coupon(coupon):
    if not coupon:
        return None
    result = {
        "code": coupon["code"],
        "type": coupon["discountType"],
        "value": (float(Decimal(coupon["valueBasisPoints"]) / 100) if coupon["discountType"] == "percentage" else inr_from_paise(coupon["valuePaise"])),
        "minimumAmountInr": inr_from_paise(coupon.get("minimumAmountPaise", 0)),
        "maxDiscountInr": inr_from_paise(coupon["maxDiscountPaise"]) if coupon.get("maxDiscountPaise") is not None else None,
        "startsAt": iso(coupon.get("startsAt")),
        "expiresAt": iso(coupon.get("expiresAt")),
        "globalUsageLimit": coupon.get("globalUsageLimit"),
        "perUserUsageLimit": coupon.get("perUserUsageLimit"),
        "active": bool(coupon.get("active")),
        "planIds": list(coupon.get("planIds") or []),
        "firstTimeOnly": bool(coupon.get("firstTimeOnly")),
        "usedCount": int(coupon.get("usedCount", 0)),
        "reservedCount": int(coupon.get("reservedCount", 0)),
    }
    return result


def evaluate_coupon(coupon, plan, now, user_used=0, user_reserved=0, has_prior_payment=False, require_capacity=True):
    if not coupon:
        raise BillingError("coupon_not_found", "Coupon code was not found", 404)
    if not coupon.get("active"):
        raise BillingError("coupon_inactive", "This coupon is inactive", 409)
    starts = coupon.get("startsAt")
    expires = coupon.get("expiresAt")
    if starts and now < starts:
        raise BillingError("coupon_not_started", "This coupon is not active yet", 409)
    if expires and now >= expires:
        raise BillingError("coupon_expired", "This coupon has expired", 409)
    if coupon.get("planIds") and plan.id not in coupon["planIds"]:
        raise BillingError("coupon_plan_mismatch", "This coupon does not apply to the selected plan", 409)
    if plan.amount_paise < int(coupon.get("minimumAmountPaise", 0)):
        raise BillingError("coupon_minimum_not_met", "The plan amount does not meet this coupon's minimum", 409)
    if coupon.get("firstTimeOnly") and has_prior_payment:
        raise BillingError("coupon_first_time_only", "This coupon is only for first-time customers", 409)
    if require_capacity:
        global_limit = coupon.get("globalUsageLimit")
        if global_limit is not None and int(coupon.get("usedCount", 0)) + int(coupon.get("reservedCount", 0)) >= global_limit:
            raise BillingError("coupon_global_limit_reached", "This coupon has reached its usage limit", 409)
        user_limit = coupon.get("perUserUsageLimit")
        if user_limit is not None and int(user_used) + int(user_reserved) >= user_limit:
            raise BillingError("coupon_per_user_limit_reached", "You have reached this coupon's usage limit", 409)
    if coupon["discountType"] == "percentage":
        discount = (plan.amount_paise * int(coupon["valueBasisPoints"])) // 10000
        if coupon.get("maxDiscountPaise") is not None:
            discount = min(discount, int(coupon["maxDiscountPaise"]))
    else:
        discount = min(plan.amount_paise, int(coupon["valuePaise"]))
    return max(0, int(discount))


def payment_public(payment):
    if not payment:
        return None
    result = deepcopy(payment)
    for key in ("createdAt", "verifiedAt", "subscriptionStartsAt", "subscriptionExpiresAt"):
        if key in result:
            result[key] = iso(result[key])
    result["amountInr"] = inr_from_paise(result.get("amountPaise", 0))
    result["originalAmountInr"] = inr_from_paise(result.get("originalAmountPaise", 0))
    result["discountInr"] = inr_from_paise(result.get("discountPaise", 0))
    return result


# Shared by billing and backend premium authorization.  Unknown tiers deliberately
# rank below every paid tier so authorization remains fail closed.
ENTITLEMENT_TIER_RANK = {"basic": 1, "pro": 2, "elite": 3}
TIER_RANK = ENTITLEMENT_TIER_RANK

GRANT_STATUSES = frozenset(("active", "expired", "revoked", "superseded"))
PRESET_VALIDITY_DAYS = frozenset((7, 30, 90, 365))
GRANT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$")
COMPLIMENTARY_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$")
RFC3339_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
EMAIL_RE = re.compile(r"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$")

_GRANT_FIELDS = frozenset((
    "id", "targetUid", "targetEmail", "targetEmailNormalized", "targetDisplayName",
    "planId", "planSnapshot", "validityType", "presetDays", "activationAt",
    "expiresAt", "lifetime", "storedStatus", "createdAt", "updatedAt", "createdBy",
    "reason", "endedAt", "endReason", "revokedBy", "supersededByGrantId",
    "supersededBy", "creationOperationId", "schemaVersion",
))
_PLAN_SNAPSHOT_FIELDS = frozenset(("id", "name", "entitlementTier", "features", "revision"))
_POINTER_FIELDS = frozenset(("targetUid", "activeGrantId", "revision", "updatedAt", "schemaVersion"))


def entitlement_tier_rank(tier):
    """Return the canonical authorization rank for a server-owned entitlement tier."""
    return ENTITLEMENT_TIER_RANK.get(tier, 0) if isinstance(tier, str) else 0


def tier_rank(tier):
    """Backward-friendly callable alias for the centralized tier ordering."""
    return entitlement_tier_rank(tier)


class EffectiveEntitlementService:
    """Shared store-backed entitlement reads and premium authorization decisions."""

    def __init__(self, store, clock=utc_now):
        if store is None or not hasattr(store, "get_effective_entitlement"):
            raise ValueError("An effective-entitlement store is required")
        if not callable(clock):
            raise ValueError("An entitlement clock is required")
        self.store = store
        self.clock = clock

    def resolve(self, uid, now=None):
        evaluation_time = self.clock() if now is None else now
        try:
            resolved = self.store.get_effective_entitlement(
                uid,
                evaluation_time,
                require_valid_paid=True,
            )
        except Exception:
            log_event(
                operation="resolver",
                result_code="failure",
                duplicate=False,
                target_uid=uid,
                transition_type="failed",
            )
            raise
        effective = resolved.get("effectiveEntitlement") or {}
        source = effective.get("source") or "inactive"
        log_event(
            operation="resolver",
            result_code="resolved_%s" % source,
            duplicate=False,
            target_uid=uid,
            plan_id=effective.get("planId"),
            validity_type=effective.get("validityType"),
            transition_type="resolved",
        )
        return resolved

    def subscription(self, uid, now=None):
        return deepcopy(self.resolve(uid, now)["effectiveEntitlement"])

    def require_entitlement(self, uid, minimum_tier, now=None):
        if minimum_tier not in ENTITLEMENT_TIER_RANK:
            raise ValueError("minimum_tier must be basic, pro, or elite")
        subscription = self.subscription(uid, now)
        return (
            subscription.get("status") == "active"
            and entitlement_tier_rank(subscription.get("entitlementTier"))
            >= entitlement_tier_rank(minimum_tier)
        )


def _domain_error(message="Stored billing data is inconsistent"):
    return BillingError("billing_data_inconsistent", message, 503)


def _unexpected_fields(data, allowed):
    if not isinstance(data, dict):
        raise BillingError("unexpected_fields", "Input must be a JSON object")
    unexpected = sorted(set(data) - set(allowed))
    if unexpected:
        raise BillingError(
            "unexpected_fields",
            "Input contains unsupported fields",
            details={"fields": unexpected},
        )


def normalize_email(value):
    if not isinstance(value, str):
        raise BillingError("invalid_email", "email must be a string", details={"field": "email"})
    normalized = value.strip().casefold()
    if (
        not normalized
        or len(normalized) > 254
        or not EMAIL_RE.fullmatch(normalized)
        or any(ord(character) < 32 or ord(character) == 127 for character in normalized)
    ):
        raise BillingError("invalid_email", "email must be a valid address", details={"field": "email"})
    return normalized


def normalize_plan_selector(value):
    if not isinstance(value, str):
        raise BillingError("invalid_plan_id", "planId must be a string", details={"field": "planId"})
    normalized = value.strip()
    if not PLAN_ID_RE.fullmatch(normalized):
        raise BillingError(
            "invalid_plan_id",
            "planId must be 2-32 lowercase letters, numbers, underscores, or hyphens",
            details={"field": "planId"},
        )
    return normalized


def normalize_grant_id(value):
    if not isinstance(value, str):
        raise BillingError("invalid_grant_id", "grantId must be a string", details={"field": "grantId"})
    normalized = value.strip()
    if not GRANT_ID_RE.fullmatch(normalized):
        raise BillingError("invalid_grant_id", "grantId is invalid", details={"field": "grantId"})
    return normalized


def normalize_reason(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise BillingError("invalid_reason", "reason must be a string", details={"field": "reason"})
    normalized = value.strip()
    if not normalized:
        return None
    if (
        len(normalized) > 500
        or "<" in normalized
        or ">" in normalized
        or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in normalized)
    ):
        raise BillingError(
            "invalid_reason",
            "reason must be at most 500 plain-text characters",
            details={"field": "reason"},
        )
    return normalized


def normalize_idempotency_key(value):
    if not isinstance(value, str):
        raise BillingError(
            "invalid_idempotency_key",
            "idempotencyKey must be a string",
            details={"field": "idempotencyKey"},
        )
    normalized = value.strip()
    if not COMPLIMENTARY_IDEMPOTENCY_RE.fullmatch(normalized):
        raise BillingError(
            "invalid_idempotency_key",
            "idempotencyKey must contain 8-200 safe characters",
            details={"field": "idempotencyKey"},
        )
    return normalized


def normalize_grant_list_query(query):
    if not isinstance(query, dict):
        raise BillingError("invalid_filter", "Grant list query must be an object")
    _unexpected_fields(query, ("limit", "email", "planId", "status", "cursor"))

    raw_limit = query.get("limit", 25)
    if isinstance(raw_limit, str) and raw_limit.isascii() and raw_limit.isdigit():
        limit = int(raw_limit)
    elif type(raw_limit) is int:
        limit = raw_limit
    else:
        raise BillingError("invalid_limit", "limit must be an integer from 1 to 100", details={"field": "limit"})
    if not 1 <= limit <= 100:
        raise BillingError("invalid_limit", "limit must be an integer from 1 to 100", details={"field": "limit"})

    raw_email = query.get("email")
    email = normalize_email(raw_email) if raw_email not in (None, "") else None
    raw_plan_id = query.get("planId")
    plan_id = normalize_plan_selector(raw_plan_id) if raw_plan_id not in (None, "") else None
    raw_status = query.get("status")
    if raw_status in (None, ""):
        status = None
    elif isinstance(raw_status, str) and raw_status in GRANT_STATUSES:
        status = raw_status
    else:
        raise BillingError("invalid_filter", "status filter is invalid", details={"field": "status"})

    raw_cursor = query.get("cursor")
    if raw_cursor in (None, ""):
        cursor = None
    elif (
        isinstance(raw_cursor, str)
        and len(raw_cursor) <= 4096
        and not any(ord(character) < 33 or ord(character) == 127 for character in raw_cursor)
    ):
        cursor = raw_cursor
    else:
        raise BillingError("invalid_cursor", "cursor is invalid", details={"field": "cursor"})
    return {"limit": limit, "email": email, "planId": plan_id, "status": status, "cursor": cursor}


def _required_utc_datetime(value, field, *, consistency=False):
    try:
        parsed = aware_datetime(value, field.replace(".", "_"))
    except (BillingError, OverflowError, TypeError, ValueError) as error:
        if consistency:
            raise _domain_error() from error
        raise
    if parsed is None:
        if consistency:
            raise _domain_error()
        raise BillingError("invalid_expiration", "%s is required" % field, details={"field": field})
    return parsed


def normalize_validity(value, activation_at):
    activation = _required_utc_datetime(activation_at, "activationAt")
    if not isinstance(value, dict):
        raise BillingError("invalid_validity", "validity must be an object", details={"field": "validity"})
    validity_type = value.get("type")
    if validity_type == "preset":
        if set(value) != {"type", "days"} or type(value.get("days")) is not int or value["days"] not in PRESET_VALIDITY_DAYS:
            raise BillingError("invalid_validity", "preset validity is invalid", details={"field": "validity"})
        days = value["days"]
        try:
            expiration = activation + timedelta(days=days)
        except OverflowError as error:
            raise BillingError("invalid_expiration", "validity expiration is invalid", details={"field": "validity.expiresAt"}) from error
        return {
            "validityType": "preset", "presetDays": days, "activationAt": activation,
            "expiresAt": expiration, "lifetime": False,
        }
    if validity_type == "custom":
        if set(value) != {"type", "expiresAt"} or not isinstance(value.get("expiresAt"), str):
            raise BillingError("invalid_validity", "custom validity is invalid", details={"field": "validity"})
        raw_expiration = value["expiresAt"]
        if not RFC3339_RE.fullmatch(raw_expiration):
            raise BillingError(
                "invalid_expiration", "validity.expiresAt must be an offset-aware RFC 3339 date-time",
                details={"field": "validity.expiresAt"},
            )
        try:
            expiration = datetime.fromisoformat(raw_expiration.replace("Z", "+00:00")).astimezone(UTC)
        except (OverflowError, ValueError) as error:
            raise BillingError(
                "invalid_expiration", "validity.expiresAt must be an offset-aware RFC 3339 date-time",
                details={"field": "validity.expiresAt"},
            ) from error
        if expiration <= activation:
            raise BillingError(
                "invalid_expiration", "validity.expiresAt must be later than activation time",
                details={"field": "validity.expiresAt"},
            )
        return {
            "validityType": "custom", "presetDays": None, "activationAt": activation,
            "expiresAt": expiration, "lifetime": False,
        }
    if validity_type == "lifetime" and set(value) == {"type"}:
        return {
            "validityType": "lifetime", "presetDays": None, "activationAt": activation,
            "expiresAt": None, "lifetime": True,
        }
    raise BillingError("invalid_validity", "validity is invalid", details={"field": "validity"})


def _validate_plan_snapshot(snapshot):
    if not isinstance(snapshot, dict) or set(snapshot) != _PLAN_SNAPSHOT_FIELDS:
        raise _domain_error()
    try:
        plan_id = normalize_plan_selector(snapshot.get("id"))
    except BillingError as error:
        raise _domain_error() from error
    name = snapshot.get("name")
    tier = snapshot.get("entitlementTier")
    features = snapshot.get("features")
    revision = snapshot.get("revision")
    if (
        not isinstance(name, str) or not name.strip() or len(name.strip()) > 80
        or tier not in ENTITLEMENT_TIER_RANK
        or not isinstance(features, (list, tuple)) or not features or len(features) > 20
        or type(revision) is not int or revision < 0
    ):
        raise _domain_error()
    normalized_features = []
    for feature in features:
        if not isinstance(feature, str) or not feature.strip() or len(feature.strip()) > 160:
            raise _domain_error()
        normalized_features.append(feature.strip())
    return {
        "id": plan_id,
        "name": name.strip(),
        "entitlementTier": tier,
        "features": normalized_features,
        "revision": revision,
    }


def canonical_plan_snapshot(plan):
    source = plan.record() if isinstance(plan, Plan) else plan
    if not isinstance(source, dict) or source.get("active") is not True:
        raise _domain_error("The selected canonical plan is unavailable or inactive")
    snapshot = {
        "id": source.get("id"),
        "name": source.get("name"),
        "entitlementTier": source.get("entitlementTier"),
        "features": deepcopy(source.get("features")),
        "revision": source.get("revision"),
    }
    return _validate_plan_snapshot(snapshot)


def _validate_uid(value):
    if (
        not isinstance(value, str) or not value or len(value) > 128
        or any(ord(character) < 33 or ord(character) == 127 for character in value)
    ):
        raise _domain_error()
    return value


def _validate_actor(value):
    if not isinstance(value, dict) or set(value) != {"uid", "email"}:
        raise _domain_error()
    uid = _validate_uid(value.get("uid"))
    email = value.get("email")
    try:
        normalized_email = normalize_email(email)
    except BillingError as error:
        raise _domain_error() from error
    return {"uid": uid, "email": email.strip() if normalized_email else email}


def validate_complimentary_grant(grant):
    if not isinstance(grant, dict) or set(grant) != _GRANT_FIELDS:
        raise _domain_error()
    try:
        grant_id = normalize_grant_id(grant.get("id"))
        plan_id = normalize_plan_selector(grant.get("planId"))
        target_email_normalized = normalize_email(grant.get("targetEmailNormalized"))
        target_email = grant.get("targetEmail")
        if normalize_email(target_email) != target_email_normalized:
            raise _domain_error()
    except BillingError as error:
        if error.code == "billing_data_inconsistent":
            raise
        raise _domain_error() from error

    target_uid = _validate_uid(grant.get("targetUid"))
    display_name = grant.get("targetDisplayName")
    if display_name is not None and (
        not isinstance(display_name, str) or len(display_name.strip()) > 256
        or any(ord(character) < 32 or ord(character) == 127 for character in display_name)
    ):
        raise _domain_error()
    snapshot = _validate_plan_snapshot(grant.get("planSnapshot"))
    if snapshot["id"] != plan_id:
        raise _domain_error()

    validity_type = grant.get("validityType")
    preset_days = grant.get("presetDays")
    lifetime = grant.get("lifetime")
    activation = _required_utc_datetime(grant.get("activationAt"), "activationAt", consistency=True)
    expiration = None
    if validity_type == "preset":
        if type(preset_days) is not int or preset_days not in PRESET_VALIDITY_DAYS or lifetime is not False:
            raise _domain_error()
        expiration = _required_utc_datetime(grant.get("expiresAt"), "expiresAt", consistency=True)
        if expiration <= activation:
            raise _domain_error()
    elif validity_type == "custom":
        if preset_days is not None or lifetime is not False:
            raise _domain_error()
        expiration = _required_utc_datetime(grant.get("expiresAt"), "expiresAt", consistency=True)
        if expiration <= activation:
            raise _domain_error()
    elif validity_type == "lifetime":
        if preset_days is not None or grant.get("expiresAt") is not None or lifetime is not True:
            raise _domain_error()
    else:
        raise _domain_error()

    created_at = _required_utc_datetime(grant.get("createdAt"), "createdAt", consistency=True)
    updated_at = _required_utc_datetime(grant.get("updatedAt"), "updatedAt", consistency=True)
    if updated_at < created_at:
        raise _domain_error()
    actor = _validate_actor(grant.get("createdBy"))
    try:
        reason = normalize_reason(grant.get("reason"))
    except BillingError as error:
        raise _domain_error() from error

    stored_status = grant.get("storedStatus")
    ended_at = grant.get("endedAt")
    end_reason = grant.get("endReason")
    revoked_by = grant.get("revokedBy")
    superseded_by_id = grant.get("supersededByGrantId")
    superseded_by = grant.get("supersededBy")
    if stored_status == "active":
        if any(value is not None for value in (ended_at, end_reason, revoked_by, superseded_by_id, superseded_by)):
            raise _domain_error()
    elif stored_status == "revoked":
        ended_at = _required_utc_datetime(ended_at, "endedAt", consistency=True)
        if ended_at < activation or revoked_by is None or superseded_by_id is not None or superseded_by is not None:
            raise _domain_error()
        revoked_by = _validate_actor(revoked_by)
    elif stored_status == "superseded":
        ended_at = _required_utc_datetime(ended_at, "endedAt", consistency=True)
        if ended_at < activation or revoked_by is not None or superseded_by_id is None or superseded_by is None:
            raise _domain_error()
        try:
            superseded_by_id = normalize_grant_id(superseded_by_id)
        except BillingError as error:
            raise _domain_error() from error
        superseded_by = _validate_actor(superseded_by)
    else:
        raise _domain_error()
    if end_reason is not None:
        try:
            end_reason = normalize_reason(end_reason)
        except BillingError as error:
            raise _domain_error() from error

    operation_id = grant.get("creationOperationId")
    schema_version = grant.get("schemaVersion")
    if (
        not isinstance(operation_id, str) or not GRANT_ID_RE.fullmatch(operation_id)
        or type(schema_version) is not int or schema_version < 1
    ):
        raise _domain_error()

    result = deepcopy(grant)
    result.update({
        "id": grant_id,
        "targetUid": target_uid,
        "targetEmail": target_email.strip(),
        "targetEmailNormalized": target_email_normalized,
        "targetDisplayName": display_name.strip() if isinstance(display_name, str) else None,
        "planId": plan_id,
        "planSnapshot": snapshot,
        "validityType": validity_type,
        "presetDays": preset_days,
        "activationAt": activation,
        "expiresAt": expiration,
        "lifetime": lifetime,
        "storedStatus": stored_status,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "createdBy": actor,
        "reason": reason,
        "endedAt": ended_at,
        "endReason": end_reason,
        "revokedBy": revoked_by,
        "supersededByGrantId": superseded_by_id,
        "supersededBy": superseded_by,
    })
    return result


def complimentary_grant_status(grant, evaluation_time):
    validated = validate_complimentary_grant(grant)
    now = _required_utc_datetime(evaluation_time, "evaluationTime", consistency=True)
    if validated["storedStatus"] == "revoked":
        return "revoked"
    if validated["storedStatus"] == "superseded":
        return "superseded"
    if not validated["lifetime"] and validated["expiresAt"] <= now:
        return "expired"
    return "active"


def validate_complimentary_pointer(pointer, expected_uid=None):
    if not isinstance(pointer, dict) or set(pointer) != _POINTER_FIELDS:
        raise _domain_error()
    target_uid = _validate_uid(pointer.get("targetUid"))
    if expected_uid is not None and target_uid != expected_uid:
        raise _domain_error()
    active_grant_id = pointer.get("activeGrantId")
    if active_grant_id is not None:
        try:
            active_grant_id = normalize_grant_id(active_grant_id)
        except BillingError as error:
            raise _domain_error() from error
    revision = pointer.get("revision")
    schema_version = pointer.get("schemaVersion")
    if type(revision) is not int or revision < 0 or type(schema_version) is not int or schema_version < 1:
        raise _domain_error()
    updated_at = _required_utc_datetime(pointer.get("updatedAt"), "updatedAt", consistency=True)
    return {
        "targetUid": target_uid, "activeGrantId": active_grant_id, "revision": revision,
        "updatedAt": updated_at, "schemaVersion": schema_version,
    }


def complimentary_grant_public(grant, evaluation_time, admin=False):
    validated = validate_complimentary_grant(grant)
    status = complimentary_grant_status(validated, evaluation_time)
    snapshot = validated["planSnapshot"]
    common = {
        "status": status,
        "planId": validated["planId"],
        "entitlementTier": snapshot["entitlementTier"],
        "activationAt": iso(validated["activationAt"]),
        "expiresAt": iso(validated["expiresAt"]),
        "updatedAt": iso(validated["updatedAt"]),
        "source": "complimentary",
        "validityType": validated["validityType"],
        "lifetime": validated["lifetime"],
        "grantId": validated["id"],
        "planName": snapshot["name"],
        "features": deepcopy(snapshot["features"]),
        "complimentary": True,
    }
    if not admin:
        return {**common, "startsAt": common["activationAt"]}
    return {
        "id": validated["id"],
        "targetUid": validated["targetUid"],
        "targetEmail": validated["targetEmail"],
        "targetDisplayName": validated["targetDisplayName"],
        "planId": validated["planId"],
        "planName": snapshot["name"],
        "entitlementTier": snapshot["entitlementTier"],
        "features": deepcopy(snapshot["features"]),
        "validityType": validated["validityType"],
        "presetDays": validated["presetDays"],
        "activationAt": iso(validated["activationAt"]),
        "expiresAt": iso(validated["expiresAt"]),
        "lifetime": validated["lifetime"],
        "status": status,
        "createdAt": iso(validated["createdAt"]),
        "updatedAt": iso(validated["updatedAt"]),
        "createdBy": deepcopy(validated["createdBy"]),
        "reason": validated["reason"],
        "endedAt": iso(validated["endedAt"]),
        "endReason": validated["endReason"],
        "revokedBy": deepcopy(validated["revokedBy"]),
        "supersededByGrantId": validated["supersededByGrantId"],
        "supersededBy": deepcopy(validated["supersededBy"]),
        "source": "complimentary",
        "complimentary": True,
    }


def _inactive_subscription():
    return {
        "status": "inactive", "planId": None, "entitlementTier": None,
        "startsAt": None, "activationAt": None, "expiresAt": None, "updatedAt": None,
        "source": None, "validityType": None, "lifetime": False, "grantId": None,
        "complimentary": False,
    }


def _validate_paid_subscription(subscription):
    if not isinstance(subscription, dict):
        raise _domain_error()
    source = subscription.get("source")
    if source not in (None, "paid"):
        raise _domain_error()
    try:
        plan_id = normalize_plan_selector(subscription.get("planId"))
    except BillingError as error:
        raise _domain_error() from error
    tier = subscription.get("entitlementTier", plan_id)
    if tier not in ENTITLEMENT_TIER_RANK:
        raise _domain_error()
    expiration = _required_utc_datetime(subscription.get("expiresAt"), "expiresAt", consistency=True)
    result = deepcopy(subscription)
    result["planId"] = plan_id
    result["entitlementTier"] = tier
    result["expiresAt"] = expiration
    for key in ("startsAt", "updatedAt"):
        if result.get(key) is not None:
            result[key] = _required_utc_datetime(result[key], key, consistency=True)
    return result


def subscription_public(subscription, now=None):
    if not subscription:
        return _inactive_subscription()
    evaluation_time = _required_utc_datetime(now or utc_now(), "evaluationTime", consistency=True)
    paid = _validate_paid_subscription(subscription)
    result = deepcopy(paid)
    expires = paid["expiresAt"]
    result["status"] = "active" if expires > evaluation_time else "expired"
    result["startsAt"] = iso(paid.get("startsAt"))
    result["expiresAt"] = iso(expires)
    result["updatedAt"] = iso(paid.get("updatedAt"))
    result["source"] = "paid"
    result["validityType"] = "finite"
    result["lifetime"] = False
    result["grantId"] = None
    result["complimentary"] = False
    return result


def resolve_effective_entitlement(paid_subscription, complimentary_grant, now):
    evaluation_time = _required_utc_datetime(now, "evaluationTime", consistency=True)
    validated_grant = None
    grant_status = None
    if complimentary_grant is not None:
        validated_grant = validate_complimentary_grant(complimentary_grant)
        grant_status = complimentary_grant_status(validated_grant, evaluation_time)

    if grant_status == "active":
        effective = complimentary_grant_public(validated_grant, evaluation_time, admin=False)
        try:
            paid_fallback = subscription_public(paid_subscription, evaluation_time) if paid_subscription else None
        except BillingError:
            paid_fallback = None
        return {"effectiveEntitlement": effective, "paidFallback": paid_fallback}

    paid_fallback = subscription_public(paid_subscription, evaluation_time) if paid_subscription else None
    if paid_fallback and paid_fallback["status"] == "active":
        effective = deepcopy(paid_fallback)
    else:
        effective = _inactive_subscription()
    return {"effectiveEntitlement": effective, "paidFallback": paid_fallback}


def _cursor_filters(filters):
    if not isinstance(filters, dict):
        raise BillingError("invalid_cursor", "cursor filters are invalid", details={"field": "cursor"})
    allowed = {"email", "planId", "status", "limit", "cursor"}
    if set(filters) - allowed:
        raise BillingError("invalid_cursor", "cursor filters are invalid", details={"field": "cursor"})
    try:
        email = normalize_email(filters["email"]) if filters.get("email") not in (None, "") else None
        plan_id = normalize_plan_selector(filters["planId"]) if filters.get("planId") not in (None, "") else None
    except BillingError as error:
        raise BillingError("invalid_cursor", "cursor filters are invalid", details={"field": "cursor"}) from error
    status = filters.get("status")
    if status in (None, ""):
        status = None
    elif status not in GRANT_STATUSES:
        raise BillingError("invalid_cursor", "cursor filters are invalid", details={"field": "cursor"})
    return {"email": email, "planId": plan_id, "status": status}


def _cursor_key(value):
    if isinstance(value, bytes) and value:
        return value
    if isinstance(value, str) and value:
        return value.encode("utf-8")
    raise BillingError("invalid_cursor", "cursor signing key is unavailable", details={"field": "cursor"})


def _b64url_encode(value):
    import base64
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value):
    import base64
    if not isinstance(value, str) or not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("invalid base64url")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    # Reject alternate textual encodings whose unused trailing bits decode to
    # the same bytes. Signed cursors are opaque and must have one canonical
    # representation so every textual bit change is treated as tampering.
    if _b64url_encode(decoded) != value:
        raise ValueError("non-canonical base64url")
    return decoded


def encode_grant_list_cursor(
    filters, as_of, last_created_at, last_grant_id, signing_key, key_id="v1", version=1,
):
    if version != 1 or not isinstance(key_id, str) or not key_id or len(key_id) > 64:
        raise BillingError("invalid_cursor", "cursor version is unsupported", details={"field": "cursor"})
    normalized_filters = _cursor_filters(filters)
    as_of_value = _required_utc_datetime(as_of, "asOf", consistency=False)
    scanned_at = _required_utc_datetime(last_created_at, "lastScanned.createdAt", consistency=False)
    try:
        grant_id = normalize_grant_id(last_grant_id)
    except BillingError as error:
        raise BillingError("invalid_cursor", "cursor scan position is invalid", details={"field": "cursor"}) from error
    payload = {
        "v": 1,
        "kid": key_id,
        "filters": normalized_filters,
        "asOf": iso(as_of_value),
        "lastScanned": {"createdAt": iso(scanned_at), "grantId": grant_id},
    }
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    import hmac
    signature = hmac.new(_cursor_key(signing_key), body, hashlib.sha256).digest()
    return "%s.%s" % (_b64url_encode(body), _b64url_encode(signature))


def decode_grant_list_cursor(cursor, signing_keys, expected_filters):
    try:
        body_part, signature_part = cursor.split(".")
        body = _b64url_decode(body_part)
        signature = _b64url_decode(signature_part)
        payload = json.loads(body.decode("utf-8"))
        if not isinstance(payload, dict) or set(payload) != {"v", "kid", "filters", "asOf", "lastScanned"}:
            raise ValueError("invalid payload")
        if payload["v"] != 1 or not isinstance(payload["kid"], str):
            raise ValueError("unsupported cursor")
        if isinstance(signing_keys, dict):
            key_value = signing_keys.get(payload["kid"])
        else:
            key_value = signing_keys
        import hmac
        expected_signature = hmac.new(_cursor_key(key_value), body, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected_signature):
            raise ValueError("invalid signature")
        normalized_filters = _cursor_filters(payload["filters"])
        if normalized_filters != payload["filters"] or normalized_filters != _cursor_filters(expected_filters):
            raise ValueError("filter mismatch")
        last_scanned = payload["lastScanned"]
        if not isinstance(last_scanned, dict) or set(last_scanned) != {"createdAt", "grantId"}:
            raise ValueError("invalid position")
        as_of = _required_utc_datetime(payload["asOf"], "asOf")
        created_at = _required_utc_datetime(last_scanned["createdAt"], "lastScanned.createdAt")
        grant_id = normalize_grant_id(last_scanned["grantId"])
    except Exception as error:
        if isinstance(error, BillingError) and error.code == "invalid_cursor":
            raise
        raise BillingError("invalid_cursor", "cursor is invalid", details={"field": "cursor"}) from error
    return {
        "version": 1,
        "keyId": payload["kid"],
        "filters": normalized_filters,
        "asOf": as_of,
        "lastScanned": {"createdAt": created_at, "grantId": grant_id},
    }


def encode_signed_cursor(state, signing_key, key_id="v1", version=1):
    if not isinstance(state, dict):
        raise BillingError("invalid_cursor", "cursor state is invalid", details={"field": "cursor"})
    last = state.get("lastScanned")
    if not isinstance(last, dict):
        raise BillingError("invalid_cursor", "cursor state is invalid", details={"field": "cursor"})
    return encode_grant_list_cursor(
        state.get("filters", {}), state.get("asOf"), last.get("createdAt"), last.get("grantId"),
        signing_key, key_id=key_id, version=version,
    )


def decode_signed_cursor(cursor, signing_keys, expected_filters):
    return decode_grant_list_cursor(cursor, signing_keys, expected_filters)


# Explicit aliases keep the primitive discoverable to store/API layers without
# introducing a second cursor implementation.
encode_complimentary_cursor = encode_grant_list_cursor
decode_complimentary_cursor = decode_grant_list_cursor


def _complimentary_sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _complimentary_payload_hash(payload):
    encoded = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )
    return _complimentary_sha256(encoded)


def _complimentary_operation_id(actor_uid, operation_type, idempotency_key):
    return _complimentary_sha256(
        actor_uid + "\0" + operation_type + "\0" + idempotency_key
    )


def _complimentary_audit_id(operation_id, event_type, grant_id):
    return _complimentary_sha256(
        operation_id + "\0" + event_type + "\0" + grant_id
    )


def _canonical_complimentary_validity(value):
    """Normalize a validity request without binding it to a transaction time."""
    if not isinstance(value, dict):
        raise BillingError(
            "invalid_validity", "validity must be an object", details={"field": "validity"},
        )
    validity_type = value.get("type")
    if validity_type == "preset":
        if (
            set(value) != {"type", "days"}
            or type(value.get("days")) is not int
            or value["days"] not in PRESET_VALIDITY_DAYS
        ):
            raise BillingError(
                "invalid_validity", "preset validity is invalid", details={"field": "validity"},
            )
        return {"type": "preset", "days": value["days"]}
    if validity_type == "lifetime" and set(value) == {"type"}:
        return {"type": "lifetime"}
    if validity_type == "custom":
        if set(value) != {"type", "expiresAt"} or not isinstance(value.get("expiresAt"), str):
            raise BillingError(
                "invalid_validity", "custom validity is invalid", details={"field": "validity"},
            )
        raw_expiration = value["expiresAt"]
        if not RFC3339_RE.fullmatch(raw_expiration):
            raise BillingError(
                "invalid_expiration",
                "validity.expiresAt must be an offset-aware RFC 3339 date-time",
                details={"field": "validity.expiresAt"},
            )
        try:
            expiration = datetime.fromisoformat(
                raw_expiration.replace("Z", "+00:00")
            ).astimezone(UTC)
        except (OverflowError, ValueError) as error:
            raise BillingError(
                "invalid_expiration",
                "validity.expiresAt must be an offset-aware RFC 3339 date-time",
                details={"field": "validity.expiresAt"},
            ) from error
        return {"type": "custom", "expiresAt": iso(expiration)}
    raise BillingError(
        "invalid_validity", "validity is invalid", details={"field": "validity"},
    )


def _firebase_user_field(user, attribute, mapping_key=None):
    if isinstance(user, dict):
        return user.get(mapping_key or attribute)
    return getattr(user, attribute, None)


class ComplimentaryBillingService:
    """Server-owned coordination boundary for complimentary billing operations."""

    def __init__(
        self,
        store,
        catalog,
        firebase_user_lookup,
        clock=utc_now,
        cursor_signing_key=None,
        cursor_key_id="v1",
    ):
        self.store = store
        self.catalog = catalog
        self.firebase_user_lookup = firebase_user_lookup
        self.clock = clock
        self.cursor_signing_key = _cursor_key(cursor_signing_key)
        if not isinstance(cursor_key_id, str) or not cursor_key_id or len(cursor_key_id) > 64:
            raise ValueError("cursor_key_id must be a non-empty string of at most 64 characters")
        self.cursor_key_id = cursor_key_id

    @staticmethod
    def _persistence_error(error):
        if isinstance(error, BillingError):
            raise error
        raise BillingError(
            "persistence_unavailable",
            "Complimentary billing persistence is temporarily unavailable",
            503,
        ) from error

    def _lookup_target(self, email):
        normalized_email = normalize_email(email)
        try:
            user = self.firebase_user_lookup(normalized_email)
        except BillingError:
            raise
        except Exception as error:
            raise BillingError(
                "auth_service_unavailable",
                "Firebase Authentication is temporarily unavailable",
                503,
            ) from error
        if user is None:
            raise BillingError("user_not_found", "No user has that exact email", 404)

        canonical_email = _firebase_user_field(user, "email")
        if not isinstance(canonical_email, str) or not canonical_email.strip():
            raise BillingError(
                "target_email_missing",
                "The Firebase Authentication user has no canonical email",
                409,
            )
        try:
            canonical_normalized = normalize_email(canonical_email)
        except BillingError as error:
            raise BillingError(
                "target_email_missing",
                "The Firebase Authentication user has no canonical email",
                409,
            ) from error
        if canonical_normalized != normalized_email:
            raise BillingError(
                "target_state_conflict",
                "The target account changed; look it up again",
                409,
            )

        try:
            uid = _validate_uid(_firebase_user_field(user, "uid"))
        except BillingError as error:
            raise BillingError(
                "target_state_conflict",
                "The target account cannot be used for a grant",
                409,
            ) from error
        display_name = _firebase_user_field(user, "display_name", "displayName")
        if display_name is not None:
            if (
                not isinstance(display_name, str)
                or len(display_name.strip()) > 256
                or any(ord(character) < 32 or ord(character) == 127 for character in display_name)
            ):
                raise BillingError(
                    "target_state_conflict",
                    "The target account cannot be used for a grant",
                    409,
                )
            display_name = display_name.strip() or None
        email_verified = _firebase_user_field(user, "email_verified", "emailVerified") is True
        disabled = _firebase_user_field(user, "disabled") is True
        return {
            "uid": uid,
            "email": canonical_email.strip(),
            "emailNormalized": canonical_normalized,
            "emailVerified": email_verified,
            "displayName": display_name,
            "disabled": disabled,
            "grantEligible": email_verified and not disabled,
        }

    @staticmethod
    def _target_public(target):
        return {
            "uid": target["uid"],
            "email": target["email"],
            "emailVerified": target["emailVerified"],
            "displayName": target["displayName"],
            "disabled": target["disabled"],
            "grantEligible": target["grantEligible"],
        }

    def lookup_user(self, email):
        target = self._lookup_target(email)
        try:
            entitlement = self.store.get_effective_entitlement(
                target["uid"], self.clock(), require_valid_paid=True,
            )
        except Exception as error:
            self._persistence_error(error)
        return {"user": self._target_public(target), **entitlement}

    def create_grant(
        self,
        *,
        actor,
        target_email,
        plan_id,
        validity,
        reason=None,
        idempotency_key,
    ):
        normalized_actor = _validate_actor(actor)
        normalized_plan_id = normalize_plan_selector(plan_id)
        normalized_validity = _canonical_complimentary_validity(validity)
        normalized_reason = normalize_reason(reason)
        normalized_key = normalize_idempotency_key(idempotency_key)
        target = self._lookup_target(target_email)
        if target["disabled"]:
            raise BillingError("target_disabled", "The target account is disabled", 409)
        if not target["emailVerified"]:
            raise BillingError(
                "target_email_unverified", "The target email is not verified", 409,
            )

        def load_current_plan(selected_plan_id):
            return self.catalog.get(selected_plan_id, include_inactive=True)

        try:
            return self.store.create_complimentary_grant(
                actor=normalized_actor,
                target=target,
                plan_id=normalized_plan_id,
                validity=normalized_validity,
                reason=normalized_reason,
                idempotency_key=normalized_key,
                plan_loader=load_current_plan,
                clock=self.clock,
            )
        except Exception as error:
            self._persistence_error(error)

    def revoke_grant(self, *, actor, grant_id, reason=None, idempotency_key):
        normalized_actor = _validate_actor(actor)
        normalized_grant_id = normalize_grant_id(grant_id)
        normalized_reason = normalize_reason(reason)
        normalized_key = normalize_idempotency_key(idempotency_key)
        try:
            return self.store.revoke_complimentary_grant(
                actor=normalized_actor,
                grant_id=normalized_grant_id,
                reason=normalized_reason,
                idempotency_key=normalized_key,
                clock=self.clock,
            )
        except Exception as error:
            self._persistence_error(error)

    def list_grants(self, query=None):
        normalized = normalize_grant_list_query(query or {})
        filters = {
            "email": normalized["email"],
            "planId": normalized["planId"],
            "status": normalized["status"],
        }
        if normalized["cursor"]:
            cursor = decode_grant_list_cursor(
                normalized["cursor"],
                {self.cursor_key_id: self.cursor_signing_key},
                filters,
            )
            as_of = cursor["asOf"]
            last_scanned = cursor["lastScanned"]
        else:
            as_of = _required_utc_datetime(self.clock(), "asOf")
            last_scanned = None
        try:
            page = self.store.list_complimentary_grants(
                filters=filters,
                limit=normalized["limit"],
                as_of=as_of,
                last_scanned=last_scanned,
            )
        except Exception as error:
            self._persistence_error(error)
        next_cursor = None
        if page["hasMore"]:
            position = page["lastScanned"]
            next_cursor = encode_grant_list_cursor(
                filters,
                as_of,
                position["createdAt"],
                position["grantId"],
                self.cursor_signing_key,
                key_id=self.cursor_key_id,
            )
        return {
            "grants": [
                complimentary_grant_public(grant, as_of, admin=True)
                for grant in page["grants"]
            ],
            "page": {
                "limit": normalized["limit"],
                "nextCursor": next_cursor,
                "asOf": iso(as_of),
            },
        }


class MemoryBillingStore:
    """Thread-safe semantic store used by tests; mirrors production transactions."""

    def __init__(self):
        self.lock = threading.RLock()
        self.coupons = {}
        self.user_coupon = {}
        self.orders = {}
        self.order_by_provider = {}
        self.payments = {}
        self.failed_payments = {}
        self.subscriptions = {}
        self.redemptions = {}
        self.events = {}
        self.plans = {}
        self.complimentary_grants = {}
        self.complimentary_users = {}
        self.complimentary_operations = {}
        self.complimentary_audit = {}
        self.persisted_plans_required = False

    @staticmethod
    def _replay_complimentary_operation(
        operation, actor_uid, operation_type, key_hash, payload_hash,
    ):
        expected_fields = {
            "actorUid", "operationType", "idempotencyKeyHash", "payloadHash", "status",
            "targetUid", "grantId", "responseSnapshot", "createdAt", "schemaVersion",
        }
        if (
            not isinstance(operation, dict)
            or set(operation) != expected_fields
            or operation.get("actorUid") != actor_uid
            or operation.get("operationType") != operation_type
            or operation.get("idempotencyKeyHash") != key_hash
            or operation.get("status") != "committed"
            or type(operation.get("schemaVersion")) is not int
            or operation.get("schemaVersion") < 1
            or not isinstance(operation.get("responseSnapshot"), dict)
        ):
            raise _domain_error()
        if operation.get("payloadHash") != payload_hash:
            raise BillingError(
                "idempotency_conflict",
                "Idempotency key was already used with different operation details",
                409,
            )
        response = deepcopy(operation["responseSnapshot"])
        response["duplicate"] = True
        return response

    def get_effective_entitlement(self, uid, now, require_valid_paid=True):
        evaluation_time = _required_utc_datetime(now, "evaluationTime", consistency=True)
        with self.lock:
            target_uid = _validate_uid(uid)
            paid = deepcopy(self.subscriptions.get(target_uid))
            if require_valid_paid and paid is not None:
                subscription_public(paid, evaluation_time)
            pointer_value = self.complimentary_users.get(target_uid)
            grant = None
            if pointer_value is not None:
                pointer = validate_complimentary_pointer(pointer_value, target_uid)
                if pointer["activeGrantId"] is not None:
                    grant_value = self.complimentary_grants.get(pointer["activeGrantId"])
                    if grant_value is None:
                        raise _domain_error()
                    grant = validate_complimentary_grant(grant_value)
                    if grant["targetUid"] != target_uid:
                        raise _domain_error()
                    if grant["storedStatus"] != "active":
                        raise _domain_error()
            return resolve_effective_entitlement(paid, grant, evaluation_time)

    def create_complimentary_grant(
        self,
        *,
        actor,
        target,
        plan_id,
        validity,
        reason,
        idempotency_key,
        plan_loader,
        clock,
    ):
        operation_id = _complimentary_operation_id(
            actor["uid"], "grant", idempotency_key,
        )
        key_hash = _complimentary_sha256(idempotency_key)
        payload = {
            "targetUid": target["uid"],
            "targetEmail": target["emailNormalized"],
            "planId": plan_id,
            "validity": deepcopy(validity),
            "reason": reason,
        }
        payload_hash = _complimentary_payload_hash(payload)

        with self.lock:
            existing_operation = self.complimentary_operations.get(operation_id)
            if existing_operation is not None:
                return self._replay_complimentary_operation(
                    existing_operation,
                    actor["uid"],
                    "grant",
                    key_hash,
                    payload_hash,
                )

            now = _required_utc_datetime(clock(), "activationAt")
            plan = plan_loader(plan_id)
            plan_record = plan.record() if isinstance(plan, Plan) else deepcopy(plan)
            if not isinstance(plan_record, dict):
                raise _domain_error("The selected canonical plan is unavailable")
            if plan_record.get("active") is not True:
                raise BillingError(
                    "plan_inactive", "The selected billing plan is inactive", 409,
                )
            plan_snapshot = canonical_plan_snapshot(plan_record)
            normalized_validity = normalize_validity(validity, now)

            paid = deepcopy(self.subscriptions.get(target["uid"]))
            if paid is not None:
                subscription_public(paid, now)

            pointer_value = self.complimentary_users.get(target["uid"])
            if pointer_value is None:
                pointer_revision = 0
                prior_grant = None
            else:
                pointer = validate_complimentary_pointer(pointer_value, target["uid"])
                pointer_revision = pointer["revision"]
                prior_grant = None
                if pointer["activeGrantId"] is not None:
                    prior_value = self.complimentary_grants.get(pointer["activeGrantId"])
                    if prior_value is None:
                        raise _domain_error()
                    prior_grant = validate_complimentary_grant(prior_value)
                    if (
                        prior_grant["targetUid"] != target["uid"]
                        or prior_grant["storedStatus"] != "active"
                    ):
                        raise _domain_error()

            grant_id = uuid.uuid4().hex
            while grant_id in self.complimentary_grants:
                grant_id = uuid.uuid4().hex
            grant = {
                "id": grant_id,
                "targetUid": target["uid"],
                "targetEmail": target["email"],
                "targetEmailNormalized": target["emailNormalized"],
                "targetDisplayName": target["displayName"],
                "planId": plan_id,
                "planSnapshot": plan_snapshot,
                "validityType": normalized_validity["validityType"],
                "presetDays": normalized_validity["presetDays"],
                "activationAt": now,
                "expiresAt": normalized_validity["expiresAt"],
                "lifetime": normalized_validity["lifetime"],
                "storedStatus": "active",
                "createdAt": now,
                "updatedAt": now,
                "createdBy": deepcopy(actor),
                "reason": reason,
                "endedAt": None,
                "endReason": None,
                "revokedBy": None,
                "supersededByGrantId": None,
                "supersededBy": None,
                "creationOperationId": operation_id,
                "schemaVersion": 1,
            }
            grant = validate_complimentary_grant(grant)

            events = []
            prior_update = None
            if prior_grant is not None and complimentary_grant_status(prior_grant, now) == "active":
                prior_update = deepcopy(prior_grant)
                prior_update.update({
                    "storedStatus": "superseded",
                    "updatedAt": now,
                    "endedAt": now,
                    "endReason": "Superseded by a newer complimentary grant",
                    "supersededByGrantId": grant_id,
                    "supersededBy": deepcopy(actor),
                })
                prior_update = validate_complimentary_grant(prior_update)
                event_id = _complimentary_audit_id(
                    operation_id, "superseded", prior_update["id"],
                )
                events.append({
                    "eventId": event_id,
                    "eventType": "superseded",
                    "grantId": prior_update["id"],
                    "targetUid": target["uid"],
                    "actor": deepcopy(actor),
                    "replacementGrantId": grant_id,
                    "reason": "Superseded by a newer complimentary grant",
                    "occurredAt": now,
                    "operationId": operation_id,
                    "schemaVersion": 1,
                })

            granted_event_id = _complimentary_audit_id(
                operation_id, "granted", grant_id,
            )
            events.append({
                "eventId": granted_event_id,
                "eventType": "granted",
                "grantId": grant_id,
                "targetUid": target["uid"],
                "actor": deepcopy(actor),
                "replacementGrantId": None,
                "reason": reason,
                "occurredAt": now,
                "operationId": operation_id,
                "schemaVersion": 1,
            })
            pointer = {
                "targetUid": target["uid"],
                "activeGrantId": grant_id,
                "revision": pointer_revision + 1,
                "updatedAt": now,
                "schemaVersion": 1,
            }
            pointer = validate_complimentary_pointer(pointer, target["uid"])
            entitlement = resolve_effective_entitlement(paid, grant, now)
            response = {
                "grant": complimentary_grant_public(grant, now, admin=True),
                **entitlement,
                "duplicate": False,
            }
            operation = {
                "actorUid": actor["uid"],
                "operationType": "grant",
                "idempotencyKeyHash": key_hash,
                "payloadHash": payload_hash,
                "status": "committed",
                "targetUid": target["uid"],
                "grantId": grant_id,
                "responseSnapshot": deepcopy(response),
                "createdAt": now,
                "schemaVersion": 1,
            }

            if prior_update is not None:
                self.complimentary_grants[prior_update["id"]] = deepcopy(prior_update)
            self.complimentary_grants[grant_id] = deepcopy(grant)
            self.complimentary_users[target["uid"]] = deepcopy(pointer)
            for event in events:
                self.complimentary_audit[event["eventId"]] = deepcopy(event)
            self.complimentary_operations[operation_id] = deepcopy(operation)
            return deepcopy(response)

    def revoke_complimentary_grant(
        self, *, actor, grant_id, reason, idempotency_key, clock,
    ):
        operation_id = _complimentary_operation_id(
            actor["uid"], "revoke", idempotency_key,
        )
        key_hash = _complimentary_sha256(idempotency_key)
        payload_hash = _complimentary_payload_hash({
            "grantId": grant_id, "reason": reason,
        })

        with self.lock:
            existing_operation = self.complimentary_operations.get(operation_id)
            if existing_operation is not None:
                return self._replay_complimentary_operation(
                    existing_operation,
                    actor["uid"],
                    "revoke",
                    key_hash,
                    payload_hash,
                )

            now = _required_utc_datetime(clock(), "revokedAt")
            grant_value = self.complimentary_grants.get(grant_id)
            if grant_value is None:
                raise BillingError("grant_not_found", "Complimentary grant was not found", 404)
            grant = validate_complimentary_grant(grant_value)
            pointer_value = self.complimentary_users.get(grant["targetUid"])
            if pointer_value is None:
                raise BillingError(
                    "grant_state_conflict", "The grant is no longer active", 409,
                )
            pointer = validate_complimentary_pointer(pointer_value, grant["targetUid"])
            if (
                pointer["activeGrantId"] != grant_id
                or complimentary_grant_status(grant, now) != "active"
            ):
                raise BillingError(
                    "grant_state_conflict", "The grant is no longer active", 409,
                )

            paid = deepcopy(self.subscriptions.get(grant["targetUid"]))
            if paid is not None:
                subscription_public(paid, now)
            revoked = deepcopy(grant)
            revoked.update({
                "storedStatus": "revoked",
                "updatedAt": now,
                "endedAt": now,
                "endReason": reason,
                "revokedBy": deepcopy(actor),
            })
            revoked = validate_complimentary_grant(revoked)
            updated_pointer = {
                "targetUid": grant["targetUid"],
                "activeGrantId": None,
                "revision": pointer["revision"] + 1,
                "updatedAt": now,
                "schemaVersion": 1,
            }
            updated_pointer = validate_complimentary_pointer(
                updated_pointer, grant["targetUid"],
            )
            entitlement = resolve_effective_entitlement(paid, revoked, now)
            response = {
                "grant": complimentary_grant_public(revoked, now, admin=True),
                **entitlement,
                "duplicate": False,
            }
            event_id = _complimentary_audit_id(
                operation_id, "revoked", grant_id,
            )
            event = {
                "eventId": event_id,
                "eventType": "revoked",
                "grantId": grant_id,
                "targetUid": grant["targetUid"],
                "actor": deepcopy(actor),
                "replacementGrantId": None,
                "reason": reason,
                "occurredAt": now,
                "operationId": operation_id,
                "schemaVersion": 1,
            }
            operation = {
                "actorUid": actor["uid"],
                "operationType": "revoke",
                "idempotencyKeyHash": key_hash,
                "payloadHash": payload_hash,
                "status": "committed",
                "targetUid": grant["targetUid"],
                "grantId": grant_id,
                "responseSnapshot": deepcopy(response),
                "createdAt": now,
                "schemaVersion": 1,
            }

            self.complimentary_grants[grant_id] = deepcopy(revoked)
            self.complimentary_users[grant["targetUid"]] = deepcopy(updated_pointer)
            self.complimentary_audit[event_id] = deepcopy(event)
            self.complimentary_operations[operation_id] = deepcopy(operation)
            return deepcopy(response)

    def list_complimentary_grants(
        self, *, filters, limit, as_of, last_scanned=None,
    ):
        evaluation_time = _required_utc_datetime(as_of, "asOf", consistency=True)
        with self.lock:
            values = []
            for value in self.complimentary_grants.values():
                grant = validate_complimentary_grant(value)
                if filters.get("email") and grant["targetEmailNormalized"] != filters["email"]:
                    continue
                if filters.get("planId") and grant["planId"] != filters["planId"]:
                    continue
                values.append(grant)
            values.sort(
                key=lambda grant: (grant["createdAt"], grant["id"]), reverse=True,
            )
            if last_scanned is not None:
                scanned_time = _required_utc_datetime(
                    last_scanned.get("createdAt"),
                    "lastScanned.createdAt",
                    consistency=True,
                )
                scanned_id = normalize_grant_id(last_scanned.get("grantId"))
                values = [
                    grant for grant in values
                    if (grant["createdAt"], grant["id"]) < (scanned_time, scanned_id)
                ]

            returned = []
            final_scanned = None
            has_more = False
            for index, grant in enumerate(values):
                final_scanned = {
                    "createdAt": grant["createdAt"], "grantId": grant["id"],
                }
                if (
                    filters.get("status") is None
                    or complimentary_grant_status(grant, evaluation_time) == filters["status"]
                ):
                    returned.append(grant)
                if len(returned) == limit:
                    has_more = index + 1 < len(values)
                    break
            return {
                "grants": deepcopy(returned),
                "hasMore": has_more,
                "lastScanned": deepcopy(final_scanned) if has_more else None,
            }

    def require_persisted_plans(self):
        self.persisted_plans_required = True

    def seed_plans_if_empty(self, plans):
        with self.lock:
            if self.plans:
                return False
            now = utc_now()
            for value in plans:
                record = normalize_plan_input(value)
                record.update({"revision": max(1, record.get("revision", 0)), "createdAt": now, "updatedAt": now})
                self.plans[record["id"]] = record
            return True

    def list_plans(self, include_inactive=False):
        with self.lock:
            values = (
                value for value in self.plans.values()
                if include_inactive or value.get("active") is True
            )
            return [deepcopy(value) for value in sorted(values, key=lambda item: (item.get("sortOrder", 0), item["id"]))]

    def get_plan(self, plan_id, include_inactive=False):
        with self.lock:
            value = self.plans.get(str(plan_id or "").strip().lower())
            if not value or (not include_inactive and value.get("active") is not True):
                return None
            return deepcopy(value)

    def put_plan(self, plan, create_only=False, expected_revision=None):
        with self.lock:
            record = normalize_plan_input(plan)
            prior = self.plans.get(record["id"])
            if create_only and prior:
                raise BillingError("plan_exists", "A plan with this ID already exists", 409)
            if expected_revision is not None and (not prior or int(prior.get("revision", 0)) != expected_revision):
                raise BillingError("plan_conflict", "This plan changed while you were editing it. Reload and try again", 409)
            now = utc_now()
            record["revision"] = int((prior or {}).get("revision", 0)) + 1
            record["createdAt"] = (prior or {}).get("createdAt", now)
            record["updatedAt"] = now
            self.plans[record["id"]] = record
            return deepcopy(record)

    def deactivate_plan(self, plan_id):
        with self.lock:
            normalized = str(plan_id or "").strip().lower()
            prior = self.plans.get(normalized)
            if not prior:
                raise BillingError("plan_not_found", "The selected billing plan was not found", 404)
            record = deepcopy(prior)
            record["active"] = False
            record["revision"] = int(prior.get("revision", 0)) + 1
            record["updatedAt"] = utc_now()
            self.plans[normalized] = record
            return deepcopy(record)

    def reorder_plans(self, plan_ids):
        with self.lock:
            if len(plan_ids) != len(set(plan_ids)) or set(plan_ids) != set(self.plans):
                raise BillingError("invalid_plan_order", "planIds must contain every plan exactly once")
            now = utc_now()
            for index, plan_id in enumerate(plan_ids):
                self.plans[plan_id]["sortOrder"] = index
                self.plans[plan_id]["revision"] = int(self.plans[plan_id].get("revision", 0)) + 1
                self.plans[plan_id]["updatedAt"] = now
            return self.list_plans(include_inactive=True)

    def put_coupon(self, coupon, create_only=False):
        with self.lock:
            if create_only and coupon["code"] in self.coupons:
                raise BillingError("coupon_exists", "A coupon with this code already exists", 409)
            self.coupons[coupon["code"]] = deepcopy(coupon)
            return deepcopy(coupon)

    def get_coupon(self, code):
        with self.lock:
            return deepcopy(self.coupons.get(code))

    def list_coupons(self):
        with self.lock:
            return [deepcopy(value) for value in sorted(self.coupons.values(), key=lambda item: item["code"])]

    def coupon_user_counts(self, uid, code):
        return deepcopy(self.user_coupon.get((uid, code), {"usedCount": 0, "reservedCount": 0}))

    def has_prior_payment(self, uid):
        return any(value["userId"] == uid and value.get("status") == "captured" for value in self.payments.values())

    def cleanup_expired(self, now):
        with self.lock:
            for order in list(self.orders.values()):
                if (
                    order.get("status") == "reserved"
                    and order.get("reservationExpiresAt") <= now
                    and not (order.get("couponCode") and order.get("providerOrderId"))
                ):
                    self._release_locked(order, now, "expired")

    def reserve_order(
        self, uid, idempotency_key, plan, coupon_code, now, expires_at,
        allow_zero=False, user_email=None,
    ):
        order_key = hashlib.sha256((uid + "\0" + idempotency_key).encode("utf-8")).hexdigest()
        with self.lock:
            existing = self.orders.get(order_key)
            if existing:
                if existing["planId"] != plan.id or existing.get("couponCode") != coupon_code:
                    raise BillingError("idempotency_conflict", "Idempotency key was already used for different checkout details", 409)
                return deepcopy(existing), False
            if self.persisted_plans_required:
                stored_plan = self.plans.get(plan.id)
                if not stored_plan or stored_plan.get("active") is not True:
                    raise BillingError("plan_not_found", "The selected billing plan is no longer available", 404)
                plan = plan_from_record(stored_plan)
            subscription = self.subscriptions.get(uid)
            if (
                subscription
                and subscription.get("expiresAt")
                and subscription["expiresAt"] > now
                and subscription.get("planId") != plan.id
            ):
                raise BillingError(
                    "active_subscription_plan_conflict",
                    "An active subscription can only be extended with the same plan",
                    409,
                )
            coupon = self.coupons.get(coupon_code) if coupon_code else None
            discount = 0
            coupon_snapshot = None
            if coupon_code:
                live_reservation = next((
                    value for value in self.orders.values()
                    if value.get("userId") == uid
                    and value.get("couponCode") == coupon_code
                    and value.get("status") == "reserved"
                    and value.get("reservationExpiresAt") > now
                ), None)
                if live_reservation:
                    raise BillingError(
                        "coupon_reservation_exists",
                        "You already have an active checkout using this coupon",
                        409,
                    )
                counts = self.user_coupon.get((uid, coupon_code), {"usedCount": 0, "reservedCount": 0})
                discount = evaluate_coupon(coupon, plan, now, counts["usedCount"], counts["reservedCount"], self.has_prior_payment(uid))
                coupon["reservedCount"] += 1
                counts = deepcopy(counts)
                counts["reservedCount"] += 1
                self.user_coupon[(uid, coupon_code)] = counts
                coupon_snapshot = public_coupon(coupon)
            final_amount = plan.amount_paise - discount
            if final_amount == 0 and not allow_zero:
                if coupon_code:
                    coupon["reservedCount"] -= 1
                    self.user_coupon[(uid, coupon_code)]["reservedCount"] -= 1
                raise BillingError("zero_amount_not_allowed", "Coupons cannot reduce a Razorpay order to zero", 409)
            order = {
                "id": order_key,
                "userId": uid,
                "userEmail": user_email,
                "idempotencyKeyHash": hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest(),
                "planId": plan.id,
                "planSnapshot": plan.snapshot(),
                "couponCode": coupon_code,
                "couponSnapshot": coupon_snapshot,
                "amountPaise": final_amount,
                "originalAmountPaise": plan.amount_paise,
                "discountPaise": discount,
                "currency": "INR",
                "status": "reserved" if final_amount > 0 else "zero_amount",
                "reservationExpiresAt": expires_at,
                "createdAt": now,
                "updatedAt": now,
                "providerOrderId": None,
            }
            self.orders[order_key] = order
            return deepcopy(order), True

    def attach_provider_order(self, order_id, provider_order_id, now):
        with self.lock:
            order = self.orders[order_id]
            if order.get("providerOrderId") and order["providerOrderId"] != provider_order_id:
                raise BillingError("order_state_conflict", "Checkout order is already linked", 409)
            order["providerOrderId"] = provider_order_id
            order["updatedAt"] = now
            self.order_by_provider[provider_order_id] = order_id
            return deepcopy(order)

    def get_order_for_user(self, uid, provider_order_id):
        with self.lock:
            internal = self.order_by_provider.get(provider_order_id)
            order = self.orders.get(internal)
            return deepcopy(order) if order and order["userId"] == uid else None

    def get_order_by_provider(self, provider_order_id):
        with self.lock:
            order = self.orders.get(self.order_by_provider.get(provider_order_id))
            return deepcopy(order) if order else None

    def release_order(self, uid, provider_order_id, now, reason="failed"):
        with self.lock:
            internal = self.order_by_provider.get(provider_order_id)
            order = self.orders.get(internal)
            if not order or (uid is not None and order["userId"] != uid):
                raise BillingError("order_not_found", "Billing order was not found", 404)
            self._release_locked(order, now, reason)
            return deepcopy(order)

    def record_failed_attempt(self, uid, provider_order_id, now, payment_id=None):
        with self.lock:
            internal = self.order_by_provider.get(provider_order_id)
            order = self.orders.get(internal)
            if not order or (uid is not None and order["userId"] != uid):
                raise BillingError("order_not_found", "Billing order was not found", 404)
            if (
                order.get("status") == "reserved"
                and order.get("reservationExpiresAt") <= now
                and not (order.get("couponCode") and order.get("providerOrderId"))
            ):
                self._release_locked(order, now, "expired")
                return deepcopy(order)
            if order.get("status") != "reserved":
                return deepcopy(order)

            discriminator = payment_id or "client-reported-failure"
            attempt_id = provider_order_id + "\0" + discriminator
            if attempt_id in self.failed_payments:
                return deepcopy(order)
            if int(order.get("failureAttempts", 0)) >= MAX_CLIENT_FAILURE_ATTEMPTS:
                return deepcopy(order)

            order["failureAttempts"] = int(order.get("failureAttempts", 0)) + 1
            order["lastFailedPaymentId"] = payment_id
            order["lastFailureAt"] = now
            order["updatedAt"] = now
            self.failed_payments[attempt_id] = {
                "id": attempt_id,
                "userId": order["userId"],
                "userEmail": order.get("userEmail"),
                "provider": "razorpay",
                "providerOrderId": provider_order_id,
                "providerPaymentId": payment_id,
                "status": "failed",
                "planId": order["planId"],
                "planSnapshot": deepcopy(order["planSnapshot"]),
                "couponCode": order.get("couponCode"),
                "couponSnapshot": deepcopy(order.get("couponSnapshot")),
                "originalAmountPaise": order["originalAmountPaise"],
                "discountPaise": order["discountPaise"],
                "amountPaise": order["amountPaise"],
                "currency": "INR",
                "createdAt": now,
                "verifiedAt": None,
            }
            return deepcopy(order)

    def _release_locked(self, order, now, reason):
        if order.get("status") != "reserved":
            return
        code = order.get("couponCode")
        if code:
            coupon = self.coupons.get(code)
            counts = self.user_coupon.get((order["userId"], code))
            if coupon:
                coupon["reservedCount"] = max(0, coupon.get("reservedCount", 0) - 1)
            if counts:
                counts["reservedCount"] = max(0, counts.get("reservedCount", 0) - 1)
        order["status"] = reason
        order["updatedAt"] = now

    def activate_payment(self, order, provider_payment, now):
        evaluation_time = _required_utc_datetime(
            now, "evaluationTime", consistency=True,
        )
        with self.lock:
            target_uid = _validate_uid(order.get("userId"))
            pointer_value = self.complimentary_users.get(target_uid)
            grant = None
            if pointer_value is not None:
                pointer = validate_complimentary_pointer(pointer_value, target_uid)
                if pointer["activeGrantId"] is not None:
                    grant_value = self.complimentary_grants.get(pointer["activeGrantId"])
                    if grant_value is None:
                        raise _domain_error()
                    grant = validate_complimentary_grant(grant_value)
                    if grant["targetUid"] != target_uid or grant["storedStatus"] != "active":
                        raise _domain_error()

            existing = self.payments.get(provider_payment["id"])
            if existing:
                if existing["providerOrderId"] != order["providerOrderId"]:
                    raise BillingError("payment_already_claimed", "This provider payment belongs to another order", 409)
                paid = deepcopy(self.subscriptions.get(target_uid))
                entitlement = resolve_effective_entitlement(
                    paid, grant, evaluation_time,
                )
                return deepcopy(existing), entitlement, False

            current = self.orders.get(order["id"])
            if not current or current["userId"] != target_uid:
                raise BillingError("order_not_found", "Billing order was not found", 404)
            if current["status"] == "paid":
                raise BillingError("payment_state_conflict", "Paid order has no matching payment claim", 409)
            if current["status"] not in ("reserved", "expired", "failed"):
                raise BillingError("payment_state_conflict", "Billing order cannot accept a captured payment", 409)

            prior = deepcopy(self.subscriptions.get(target_uid))
            if prior is not None:
                subscription_public(prior, evaluation_time)
            late_capture = current["status"] != "reserved" or current["reservationExpiresAt"] <= evaluation_time
            code = current.get("couponCode")
            if code:
                coupon = self.coupons.get(code)
                if not coupon:
                    raise BillingError("billing_data_inconsistent", "Coupon snapshot is unavailable", 503)
                counts = self.user_coupon.get((target_uid, code), {"usedCount": 0, "reservedCount": 0})
                if current["status"] == "reserved":
                    coupon["reservedCount"] = max(0, int(coupon.get("reservedCount", 0)) - 1)
                    counts["reservedCount"] = max(0, int(counts.get("reservedCount", 0)) - 1)
                coupon["usedCount"] = int(coupon.get("usedCount", 0)) + 1
                counts["usedCount"] = int(counts.get("usedCount", 0)) + 1
                self.user_coupon[(target_uid, code)] = counts
                redemption_id = current["id"]
                self.redemptions[redemption_id] = {
                    "id": redemption_id, "userId": target_uid, "couponCode": code,
                    "providerPaymentId": provider_payment["id"], "discountPaise": current["discountPaise"],
                    "lateCapture": late_capture, "createdAt": evaluation_time,
                }
            changing_plan = bool(
                prior
                and prior.get("expiresAt")
                and prior["expiresAt"] > evaluation_time
                and prior.get("planId") != current["planId"]
            )
            starts = (
                prior["expiresAt"]
                if prior and prior.get("expiresAt") and prior["expiresAt"] > evaluation_time and not changing_plan
                else evaluation_time
            )
            expires = starts + timedelta(days=int(current["planSnapshot"]["durationDays"]))
            payment = {
                "id": provider_payment["id"],
                "userId": target_uid,
                "userEmail": current.get("userEmail"),
                "provider": "razorpay",
                "providerPaymentId": provider_payment["id"],
                "providerOrderId": current["providerOrderId"],
                "status": "captured",
                "amountPaise": current["amountPaise"],
                "originalAmountPaise": current["originalAmountPaise"],
                "discountPaise": current["discountPaise"],
                "currency": "INR",
                "method": provider_payment.get("method"),
                "bank": provider_payment.get("bank"),
                "wallet": provider_payment.get("wallet"),
                "vpa": provider_payment.get("vpa"),
                "feePaise": provider_payment.get("fee"),
                "taxPaise": provider_payment.get("tax"),
                "providerCreatedAt": provider_payment.get("created_at"),
                "planId": current["planId"],
                "planSnapshot": deepcopy(current["planSnapshot"]),
                "couponCode": code,
                "couponSnapshot": deepcopy(current.get("couponSnapshot")),
                "lateCapture": late_capture,
                "planChangeImmediate": changing_plan,
                "createdAt": evaluation_time,
                "verifiedAt": evaluation_time,
                "subscriptionStartsAt": starts,
                "subscriptionExpiresAt": expires,
            }
            subscription = {
                "userId": target_uid, "status": "active", "planId": current["planId"],
                "entitlementTier": current["planSnapshot"].get("entitlementTier", current["planId"]),
                "startsAt": starts, "expiresAt": expires, "updatedAt": evaluation_time,
                "lastPaymentId": provider_payment["id"], "paymentCount": int((prior or {}).get("paymentCount", 0)) + 1,
            }
            current["status"] = "paid"
            current["providerPaymentId"] = provider_payment["id"]
            current["updatedAt"] = evaluation_time
            self.payments[provider_payment["id"]] = payment
            self.subscriptions[target_uid] = subscription
            entitlement = resolve_effective_entitlement(
                subscription, grant, evaluation_time,
            )
            return deepcopy(payment), entitlement, True

    def list_payments(self, uid, limit=100):
        values = [deepcopy(value) for value in self.payments.values() if value["userId"] == uid]
        values.extend(
            deepcopy(value) for value in self.failed_payments.values()
            if value["userId"] == uid
        )
        return sorted(values, key=lambda value: value["createdAt"], reverse=True)[:limit]

    def get_payment_by_order(self, uid, provider_order_id):
        for value in self.payments.values():
            if value["userId"] == uid and value["providerOrderId"] == provider_order_id:
                return deepcopy(value)
        return None

    def get_subscription(self, uid):
        return deepcopy(self.subscriptions.get(uid))

    def claim_event(self, event_id, payload_hash, now):
        with self.lock:
            event = self.events.get(event_id)
            if event and event["payloadHash"] != payload_hash:
                raise BillingError("webhook_event_conflict", "Webhook event ID was reused with different content", 409)
            if event and event.get("status") == "completed":
                return False
            if event and event.get("status") == "processing" and event.get("leaseExpiresAt") and event["leaseExpiresAt"] > now:
                raise BillingError("webhook_event_processing", "Webhook event is already being processed", 503)
            self.events[event_id] = {
                "id": event_id, "payloadHash": payload_hash, "status": "processing",
                "attempts": int((event or {}).get("attempts", 0)) + 1,
                "leaseExpiresAt": now + timedelta(minutes=5), "updatedAt": now,
            }
            return True

    def finish_event(self, event_id, status, now, outcome=None):
        with self.lock:
            self.events[event_id].update({"status": status, "outcome": outcome, "updatedAt": now})

    def list_redemptions(self, limit=200):
        return sorted((deepcopy(value) for value in self.redemptions.values()), key=lambda value: value["createdAt"], reverse=True)[:limit]

    def analytics(self):
        captured = list(self.payments.values())
        now = utc_now()
        coupons = list(self.coupons.values())
        expired = sum(
            1 for coupon in coupons
            if coupon.get("expiresAt") and coupon["expiresAt"] <= now
        )
        active = sum(
            1 for coupon in coupons
            if coupon.get("active")
            and (not coupon.get("startsAt") or coupon["startsAt"] <= now)
            and (not coupon.get("expiresAt") or coupon["expiresAt"] > now)
        )
        discounts = sum(value["discountPaise"] for value in captured)
        return {
            "totalCoupons": len(coupons),
            "activeCoupons": active,
            "expiredCoupons": expired,
            "totalCouponUses": sum(int(coupon.get("usedCount", 0)) for coupon in coupons),
            "totalDiscountGivenPaise": discounts,
            "capturedPayments": len(captured),
            "grossRevenuePaise": sum(value["amountPaise"] for value in captured),
            "discountsPaise": discounts,
            "activeSubscriptions": sum(1 for value in self.subscriptions.values() if value.get("expiresAt") and value["expiresAt"] > now),
            "couponRedemptions": len(self.redemptions),
        }


class BillingService:
    def __init__(self, store, provider, catalog=None, checkout_ttl_minutes=20, allow_zero=False, clock=utc_now):
        self.store = store
        self.provider = provider
        self.catalog = catalog if catalog is not None else PlanCatalog()
        self.ttl = max(1, int(checkout_ttl_minutes))
        self.allow_zero = bool(allow_zero)
        self.clock = clock

    def validate_coupon(self, uid, plan_id, coupon_code):
        now = self.clock()
        plan = self.catalog.get(plan_id)
        code = normalize_code(coupon_code)
        self.store.cleanup_expired(now)
        coupon = self.store.get_coupon(code)
        counts = self.store.coupon_user_counts(uid, code)
        discount = evaluate_coupon(coupon, plan, now, counts["usedCount"], counts["reservedCount"], self.store.has_prior_payment(uid))
        final_amount = plan.amount_paise - discount
        if final_amount == 0 and not self.allow_zero:
            raise BillingError("zero_amount_not_allowed", "Coupons cannot reduce a Razorpay order to zero", 409)
        return {"valid": True, "coupon": public_coupon(coupon), "planId": plan.id, "originalAmountPaise": plan.amount_paise, "discountPaise": discount, "amountPaise": final_amount, "amountInr": inr_from_paise(final_amount)}

    def create_order(self, uid, plan_id, coupon_code, idempotency_key, user_email=None):
        if not IDEMPOTENCY_RE.fullmatch(str(idempotency_key or "")):
            raise BillingError("invalid_idempotency_key", "idempotencyKey must be 8-128 safe characters")
        now = self.clock()
        self.store.cleanup_expired(now)
        plan = self.catalog.get(plan_id)
        code = normalize_code(coupon_code) if coupon_code else None
        order, created = self.store.reserve_order(
            uid,
            idempotency_key,
            plan,
            code,
            now,
            now + timedelta(minutes=self.ttl),
            self.allow_zero,
            user_email,
        )
        if order.get("providerOrderId"):
            return self._order_public(order), True
        receipt = order["id"][:40]
        if not created:
            try:
                recovered = self.provider.find_order_by_receipt(receipt)
            except Exception as error:
                raise BillingError("provider_unavailable", "Payment provider is temporarily unavailable", 503) from error
            if recovered:
                self._validate_provider_order(recovered, order)
                order = self.store.attach_provider_order(order["id"], recovered["id"], self.clock())
                return self._order_public(order), True
            raise BillingError("order_creation_in_progress", "An order is already being created for this idempotency key", 409)
        if order["amountPaise"] == 0:
            return self._order_public(order), False
        try:
            provider_order = self.provider.create_order(order["amountPaise"], receipt, {"planId": plan.id, "billingOrderId": order["id"]})
            self._validate_provider_order(provider_order, order)
            order = self.store.attach_provider_order(order["id"], provider_order["id"], self.clock())
            return self._order_public(order), False
        except BillingError:
            self._release_internal(order, uid)
            raise
        except Exception as error:
            # The provider may have accepted the order even if the response was
            # interrupted. Recover by the stable receipt before releasing.
            try:
                recovered = self.provider.find_order_by_receipt(receipt)
            except Exception:
                recovered = None
            if recovered:
                self._validate_provider_order(recovered, order)
                order = self.store.attach_provider_order(order["id"], recovered["id"], self.clock())
                return self._order_public(order), False
            self._release_internal(order, uid)
            if hasattr(error, "code"):
                raise BillingError(error.code, error.message, 503) from error
            raise BillingError("provider_unavailable", "Payment provider is temporarily unavailable", 503) from error

    @staticmethod
    def _validate_provider_order(provider_order, order):
        if int(provider_order.get("amount", -1)) != order["amountPaise"] or provider_order.get("currency") != "INR":
            raise BillingError("provider_order_mismatch", "Payment provider returned an inconsistent order", 502)

    def _release_internal(self, order, uid):
        # Store implementations can release by internal ID before provider attach.
        if hasattr(self.store, "release_internal_order"):
            self.store.release_internal_order(uid, order["id"], self.clock(), "provider_failed")
        elif isinstance(self.store, MemoryBillingStore):
            with self.store.lock:
                current = self.store.orders.get(order["id"])
                if current:
                    self.store._release_locked(current, self.clock(), "provider_failed")

    def _order_public(self, order):
        return {
            "orderId": order.get("providerOrderId"), "billingOrderId": order["id"],
            "keyId": self.provider.public_key_id, "amountPaise": order["amountPaise"],
            "amountInr": inr_from_paise(order["amountPaise"]), "currency": "INR",
            "plan": deepcopy(order["planSnapshot"]), "coupon": deepcopy(order.get("couponSnapshot")),
            "discountPaise": order["discountPaise"], "reservationExpiresAt": iso(order["reservationExpiresAt"]),
            "status": order["status"],
        }

    def verify_payment(self, uid, provider_order_id, provider_payment_id, signature):
        self.provider.verify_checkout_signature(provider_order_id, provider_payment_id, signature)
        payment = self.provider.fetch_payment(provider_payment_id)
        if payment.get("id") != provider_payment_id:
            raise BillingError("payment_id_mismatch", "Provider returned a different payment", 409)
        return self._reconcile(uid, provider_order_id, payment)

    def reconcile_webhook_payment(self, provider_order_id, provider_payment_id):
        payment = self.provider.fetch_payment(provider_payment_id)
        if payment.get("id") != provider_payment_id:
            raise BillingError("payment_id_mismatch", "Provider returned a different payment", 409)
        order = self.store.get_order_by_provider(provider_order_id)
        if not order:
            raise BillingError("order_not_found", "Billing order was not found", 404)
        return self._reconcile(order["userId"], provider_order_id, payment)

    def _reconcile(self, uid, provider_order_id, payment):
        order = self.store.get_order_for_user(uid, provider_order_id)
        if not order:
            raise BillingError("order_not_found", "Billing order was not found", 404)
        if payment.get("order_id") != provider_order_id:
            raise BillingError("payment_order_mismatch", "Provider payment does not belong to this order", 409)
        if int(payment.get("amount", -1)) != order["amountPaise"]:
            raise BillingError("payment_amount_mismatch", "Provider payment amount does not match this order", 409)
        if payment.get("currency") != "INR":
            raise BillingError("payment_currency_mismatch", "Provider payment currency must be INR", 409)
        if payment.get("status") != "captured" or not payment.get("captured"):
            raise BillingError("payment_not_captured", "Provider payment is not captured", 409)
        evaluation_time = _required_utc_datetime(
            self.clock(), "evaluationTime", consistency=True,
        )
        result, entitlement, created = self.store.activate_payment(
            order, payment, evaluation_time,
        )
        return {
            "payment": payment_public(result),
            "subscription": deepcopy(entitlement["effectiveEntitlement"]),
            "paidFallback": deepcopy(entitlement["paidFallback"]),
            "duplicate": not created,
        }

    def record_failed_attempt(self, uid, provider_order_id, provider_payment_id=None):
        return self.store.record_failed_attempt(
            uid, provider_order_id, self.clock(), provider_payment_id
        )

    def order_status(self, uid, provider_order_id):
        now = self.clock()
        self.store.cleanup_expired(now)
        order = self.store.get_order_for_user(uid, provider_order_id)
        if not order:
            raise BillingError("order_not_found", "Billing order was not found", 404)
        payment = self.store.get_payment_by_order(uid, provider_order_id)
        return {
            "orderId": provider_order_id,
            "status": "paid" if payment else order.get("status", "pending"),
            "payment": payment_public(payment),
            "subscription": subscription_public(self.store.get_subscription(uid), now),
        }

    def subscription(self, uid):
        return subscription_public(self.store.get_subscription(uid), self.clock())

    def payments(self, uid, limit=100):
        return [payment_public(value) for value in self.store.list_payments(uid, limit)]
