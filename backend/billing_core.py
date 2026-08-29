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


def subscription_public(subscription, now=None):
    if not subscription:
        return {"status": "inactive", "expiresAt": None, "planId": None}
    now = now or utc_now()
    result = deepcopy(subscription)
    expires = result.get("expiresAt")
    result["status"] = "active" if expires and expires > now else "expired"
    result["startsAt"] = iso(result.get("startsAt"))
    result["expiresAt"] = iso(expires)
    result["updatedAt"] = iso(result.get("updatedAt"))
    return result


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
        self.persisted_plans_required = False

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
        with self.lock:
            existing = self.payments.get(provider_payment["id"])
            if existing:
                if existing["providerOrderId"] != order["providerOrderId"]:
                    raise BillingError("payment_already_claimed", "This provider payment belongs to another order", 409)
                return deepcopy(existing), deepcopy(self.subscriptions[order["userId"]]), False
            current = self.orders.get(order["id"])
            if not current or current["userId"] != order["userId"]:
                raise BillingError("order_not_found", "Billing order was not found", 404)
            if current["status"] == "paid":
                raise BillingError("payment_state_conflict", "Paid order has no matching payment claim", 409)
            if current["status"] not in ("reserved", "expired", "failed"):
                raise BillingError("payment_state_conflict", "Billing order cannot accept a captured payment", 409)
            late_capture = current["status"] != "reserved" or current["reservationExpiresAt"] <= now
            code = current.get("couponCode")
            if code:
                coupon = self.coupons.get(code)
                if not coupon:
                    raise BillingError("billing_data_inconsistent", "Coupon snapshot is unavailable", 503)
                counts = self.user_coupon.get((current["userId"], code), {"usedCount": 0, "reservedCount": 0})
                if current["status"] == "reserved":
                    coupon["reservedCount"] = max(0, int(coupon.get("reservedCount", 0)) - 1)
                    counts["reservedCount"] = max(0, int(counts.get("reservedCount", 0)) - 1)
                coupon["usedCount"] = int(coupon.get("usedCount", 0)) + 1
                counts["usedCount"] = int(counts.get("usedCount", 0)) + 1
                self.user_coupon[(current["userId"], code)] = counts
                redemption_id = current["id"]
                self.redemptions[redemption_id] = {
                    "id": redemption_id, "userId": current["userId"], "couponCode": code,
                    "providerPaymentId": provider_payment["id"], "discountPaise": current["discountPaise"],
                    "lateCapture": late_capture, "createdAt": now,
                }
            prior = self.subscriptions.get(current["userId"])
            changing_plan = bool(
                prior
                and prior.get("expiresAt")
                and prior["expiresAt"] > now
                and prior.get("planId") != current["planId"]
            )
            starts = (
                prior["expiresAt"]
                if prior and prior.get("expiresAt") and prior["expiresAt"] > now and not changing_plan
                else now
            )
            expires = starts + timedelta(days=int(current["planSnapshot"]["durationDays"]))
            payment = {
                "id": provider_payment["id"],
                "userId": current["userId"],
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
                "createdAt": now,
                "verifiedAt": now,
                "subscriptionStartsAt": starts,
                "subscriptionExpiresAt": expires,
            }
            subscription = {
                "userId": current["userId"], "status": "active", "planId": current["planId"],
                "entitlementTier": current["planSnapshot"].get("entitlementTier", current["planId"]),
                "startsAt": starts, "expiresAt": expires, "updatedAt": now,
                "lastPaymentId": provider_payment["id"], "paymentCount": int((prior or {}).get("paymentCount", 0)) + 1,
            }
            current["status"] = "paid"
            current["providerPaymentId"] = provider_payment["id"]
            current["updatedAt"] = now
            self.payments[provider_payment["id"]] = payment
            self.subscriptions[current["userId"]] = subscription
            return deepcopy(payment), deepcopy(subscription), True

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
        result, subscription, created = self.store.activate_payment(order, payment, self.clock())
        return {"payment": payment_public(result), "subscription": subscription_public(subscription, self.clock()), "duplicate": not created}

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
