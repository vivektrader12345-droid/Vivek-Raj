"""Flask API surface for server-owned Razorpay billing."""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from functools import wraps

from firebase_admin import auth as firebase_auth
from flask import Blueprint, Response, g, jsonify, request, render_template_string

from auth_policy import has_current_otp_proof
from billing_core import (
    BillingError,
    BillingService,
    PlanCatalog,
    StoredPlanCatalog,
    inr_from_paise,
    iso,
    normalize_code,
    normalize_coupon_input,
    normalize_plan_input,
    payment_public,
    plan_from_record,
    public_coupon,
    subscription_public,
    utc_now,
)
from billing_store import FirestoreBillingStore
from razorpay_adapter import RazorpayAdapter, RazorpayAdapterError


USER_ORDER_FIELDS = {"planId", "couponCode", "idempotencyKey"}
VERIFY_FIELDS = {"razorpay_order_id", "razorpay_payment_id", "razorpay_signature"}
FAILURE_FIELDS = {"razorpay_order_id", "razorpay_payment_id"}
COUPON_VALIDATE_FIELDS = {"planId", "couponCode"}
PLAN_CREATE_FIELDS = {"id", "name", "amountPaise", "durationDays", "features", "active", "sortOrder", "entitlementTier"}
PLAN_UPDATE_FIELDS = (PLAN_CREATE_FIELDS - {"id"}) | {"revision"}
PLAN_ORDER_FIELDS = {"planIds"}


def _request_id():
    return getattr(g, "request_id", uuid.uuid4().hex)


def _error(code, message, status, details=None):
    body = {"error": {"code": code, "message": message}, "requestId": _request_id()}
    if details:
        body["error"]["details"] = details
    return jsonify(body), status


def _body():
    if not request.is_json:
        raise BillingError("json_required", "Content-Type must be application/json", 415)
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        raise BillingError("invalid_json", "Request body must be a JSON object")
    return value


def _allow_fields(data, allowed):
    unexpected = sorted(set(data) - set(allowed))
    if unexpected:
        raise BillingError(
            "unexpected_fields",
            "Request contains fields that are not accepted",
            400,
            {"fields": unexpected},
        )


def _limit_arg(default=100, maximum=200):
    try:
        return max(1, min(int(request.args.get("limit", default)), maximum))
    except (TypeError, ValueError) as error:
        raise BillingError("invalid_limit", "limit must be a positive integer") from error


def create_billing_blueprint(db, firebase_app=None, store=None, provider=None, catalog=None):
    """Create an isolated billing blueprint with injectable persistence/provider."""
    bp = Blueprint("razorpay_billing", __name__)
    explicit_catalog = catalog is not None
    try:
        fallback_catalog = catalog if explicit_catalog else PlanCatalog.from_json(os.environ.get("BILLING_PLANS_JSON", ""))
        catalog_config_valid = True
    except ValueError:
        fallback_catalog = PlanCatalog()
        catalog_config_valid = False

    if provider is None:
        try:
            provider = RazorpayAdapter(
                os.environ.get("RAZORPAY_KEY_ID"),
                os.environ.get("RAZORPAY_KEY_SECRET"),
                os.environ.get("RAZORPAY_WEBHOOK_SECRET"),
            )
        except RazorpayAdapterError:
            provider = RazorpayAdapter(None, None, None)
    if store is None and db is not None:
        store = FirestoreBillingStore(db)

    catalog_ready = catalog_config_valid
    dynamic_catalog = bool(
        store is not None
        and not explicit_catalog
        and hasattr(store, "seed_plans_if_empty")
        and hasattr(store, "list_plans")
    )
    if dynamic_catalog:
        catalog_ready = False
    catalog = StoredPlanCatalog(store) if dynamic_catalog else fallback_catalog

    def ensure_catalog_ready():
        nonlocal catalog_ready
        if not dynamic_catalog:
            catalog_ready = catalog_config_valid
            return catalog_ready
        try:
            if not catalog_ready:
                if catalog_config_valid:
                    store.seed_plans_if_empty(fallback_catalog.all(include_inactive=True))
                elif not store.list_plans(include_inactive=True):
                    raise ValueError("A valid initial plan catalog is required")
                if hasattr(store, "require_persisted_plans"):
                    store.require_persisted_plans()
            catalog.all(include_inactive=True)
            catalog_ready = True
        except Exception:
            catalog_ready = False
        if hasattr(bp, "billing_readiness"):
            bp.billing_readiness["catalog"] = catalog_ready
        return catalog_ready

    ensure_catalog_ready()
    ttl = os.environ.get("BILLING_CHECKOUT_TTL_MINUTES", "20")
    try:
        ttl = max(1, min(int(ttl), 1440))
    except ValueError:
        ttl = 20
    allow_zero = os.environ.get("BILLING_ALLOW_ZERO_AMOUNT", "false").strip().lower() == "true"
    service = BillingService(store, provider, catalog, ttl, allow_zero) if store is not None else None
    admin_emails = {
        value.strip().lower()
        for value in os.environ.get("BILLING_ADMIN_EMAILS", "").split(",")
        if value.strip()
    }
    bp.billing_readiness = {
        "catalog": catalog_ready,
        "storage": store is not None,
        "provider": bool(provider.readiness.configured),
        "webhook": bool(provider.readiness.webhook_configured),
    }

    def billing_probe():
        components = {
            "catalog": ensure_catalog_ready(),
            "storage": store is not None,
            "provider": bool(provider.readiness.configured),
            "webhook": bool(provider.readiness.webhook_configured),
        }
        bp.billing_readiness = components
        return dict(components)

    bp.billing_probe = billing_probe

    @bp.before_request
    def assign_request_id():
        g.request_id = uuid.uuid4().hex

    @bp.errorhandler(413)
    def payload_too_large(_error_value):
        return _error("payload_too_large", "JSON payload exceeds 256 KB", 413)

    @bp.errorhandler(BillingError)
    def billing_error(error):
        return _error(error.code, error.message, error.status, error.details)

    @bp.errorhandler(RazorpayAdapterError)
    def provider_error(error):
        status = 401 if error.code in ("invalid_payment_signature", "invalid_webhook_signature") else 503
        return _error(error.code, error.message, status)

    @bp.errorhandler(Exception)
    def unexpected_billing_error(_error_value):
        # Keep v1 responses structured and sanitized. In particular, webhook
        # processing failures must remain non-2xx so Razorpay retries delivery.
        return _error("billing_unavailable", "Billing is temporarily unavailable", 503)

    def require_auth(admin=False):
        def decorator(handler):
            @wraps(handler)
            def wrapped(*args, **kwargs):
                parts = request.headers.get("Authorization", "").split()
                if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1]:
                    return _error("authentication_required", "A valid Firebase bearer token is required", 401)
                if firebase_app is None:
                    return _error("auth_service_unavailable", "Authentication service is temporarily unavailable", 503)
                try:
                    decoded = firebase_auth.verify_id_token(parts[1], app=firebase_app, check_revoked=True)
                    uid = decoded.get("uid") or decoded.get("sub")
                    if not uid:
                        return _error("invalid_token", "The Firebase bearer token is invalid", 401)
                    if not has_current_otp_proof(decoded):
                        return _error("otp_required", "Complete OTP verification for this sign-in session", 403)
                    email = str(decoded.get("email") or "").strip().lower()
                    allowlisted = bool(
                        email and decoded.get("email_verified") is True and email in admin_emails
                    )
                    is_admin = decoded.get("admin") is True or allowlisted
                    if admin and not is_admin:
                        return _error("admin_required", "Billing administrator access is required", 403)
                    g.auth_uid = str(uid)
                    g.auth_token = decoded
                    g.billing_is_admin = is_admin
                except firebase_auth.ExpiredIdTokenError:
                    return _error("token_expired", "Your session token expired", 401)
                except (firebase_auth.RevokedIdTokenError, firebase_auth.UserNotFoundError):
                    return _error("token_revoked", "Your session is no longer valid; sign in again", 401)
                except firebase_auth.UserDisabledError:
                    return _error("user_disabled", "This user account is disabled", 401)
                except (firebase_auth.InvalidIdTokenError, ValueError):
                    return _error("invalid_token", "The Firebase bearer token is invalid", 401)
                except firebase_auth.CertificateFetchError:
                    return _error("auth_service_unavailable", "Authentication service is temporarily unavailable", 503)
                except Exception:
                    return _error("auth_service_unavailable", "Authentication service is temporarily unavailable", 503)
                return handler(*args, **kwargs)
            return wrapped
        return decorator

    def require_storage():
        if service is None:
            raise BillingError("persistence_unavailable", "Billing storage is temporarily unavailable", 503)
        return service

    @bp.get("/api/v1/billing/plans")
    @require_auth()
    def plans():
        if not ensure_catalog_ready():
            raise BillingError("billing_catalog_invalid", "Billing plan configuration is invalid", 503)
        return jsonify({"plans": catalog.all(), "currency": "INR", "requestId": _request_id()})

    @bp.get("/api/v1/billing/me")
    @require_auth()
    def me():
        billing = require_storage()
        return jsonify({
            "subscription": billing.subscription(g.auth_uid),
            "isAdmin": bool(g.billing_is_admin),
            "requestId": _request_id(),
        })

    @bp.post("/api/v1/billing/coupons/validate")
    @require_auth()
    def validate_coupon_route():
        data = _body()
        _allow_fields(data, COUPON_VALIDATE_FIELDS)
        result = require_storage().validate_coupon(g.auth_uid, data.get("planId"), data.get("couponCode"))
        return jsonify({**result, "requestId": _request_id()})

    @bp.post("/api/v1/billing/orders")
    @require_auth()
    def orders():
        data = _body()
        _allow_fields(data, USER_ORDER_FIELDS)
        result, duplicate = require_storage().create_order(
            g.auth_uid,
            data.get("planId"),
            data.get("couponCode"),
            data.get("idempotencyKey"),
            user_email=str(g.auth_token.get("email") or "").strip().lower() or None,
        )
        return jsonify({**result, "duplicate": duplicate, "requestId": _request_id()}), 200 if duplicate else 201

    @bp.post("/api/v1/billing/payments/verify")
    @require_auth()
    def verify_payment():
        data = _body()
        _allow_fields(data, VERIFY_FIELDS)
        for field in VERIFY_FIELDS:
            if not isinstance(data.get(field), str) or not data[field].strip():
                raise BillingError("invalid_payment_response", "All Razorpay response identifiers are required")
        result = require_storage().verify_payment(
            g.auth_uid,
            data["razorpay_order_id"].strip(),
            data["razorpay_payment_id"].strip(),
            data["razorpay_signature"].strip(),
        )
        return jsonify({**result, "requestId": _request_id()})

    @bp.post("/api/v1/billing/payments/failure")
    @require_auth()
    def payment_failure():
        data = _body()
        _allow_fields(data, FAILURE_FIELDS)
        order_id = str(data.get("razorpay_order_id") or "").strip()
        if not order_id:
            raise BillingError("invalid_payment_response", "razorpay_order_id is required")
        order = require_storage().record_failed_attempt(
            g.auth_uid,
            order_id,
            str(data.get("razorpay_payment_id") or "").strip() or None,
        )
        return jsonify({
            "recorded": True,
            "reservationExpiresAt": iso(order.get("reservationExpiresAt")),
            "orderId": order_id,
            "requestId": _request_id(),
        })

    @bp.get("/api/v1/billing/orders/<order_id>")
    @require_auth()
    def order_status(order_id):
        result = require_storage().order_status(g.auth_uid, order_id)
        return jsonify({**result, "requestId": _request_id()})

    @bp.get("/api/v1/billing/payments")
    @require_auth()
    def payments():
        values = require_storage().payments(g.auth_uid, _limit_arg())
        return jsonify({"payments": values, "requestId": _request_id()})

    @bp.get("/api/v1/billing/payments/<order_id>/invoice")
    @require_auth()
    def invoice(order_id):
        payment = require_storage().store.get_payment_by_order(g.auth_uid, order_id)
        if not payment:
            raise BillingError("invoice_not_found", "Invoice was not found", 404)
        public = payment_public(payment)
        template = """<!doctype html><html><head><meta charset=\"utf-8\"><title>Invoice {{ p.providerOrderId }}</title>
        <style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;color:#111}table{width:100%;border-collapse:collapse}td{padding:8px;border-bottom:1px solid #ddd}.amount{text-align:right}@media print{button{display:none}}</style></head>
        <body><button onclick=\"window.print()\">Print</button><h1>Payment invoice</h1><p>Order: {{ p.providerOrderId }}</p><p>Payment: {{ p.providerPaymentId }}</p>
        <table><tr><td>Plan</td><td class=\"amount\">{{ p.planSnapshot.name }}</td></tr><tr><td>Original amount</td><td class=\"amount\">₹{{ '%.2f'|format(p.originalAmountPaise / 100) }}</td></tr>
        <tr><td>Discount</td><td class=\"amount\">-₹{{ '%.2f'|format(p.discountPaise / 100) }}</td></tr><tr><td><strong>Paid</strong></td><td class=\"amount\"><strong>₹{{ '%.2f'|format(p.amountPaise / 100) }}</strong></td></tr></table>
        <p>Status: {{ p.status }} · Verified: {{ p.verifiedAt }}</p></body></html>"""
        return Response(render_template_string(template, p=public), mimetype="text/html")

    @bp.post("/api/v1/billing/webhooks/razorpay")
    def razorpay_webhook():
        billing = require_storage()
        raw_body = request.get_data(cache=True)
        signature = request.headers.get("X-Razorpay-Signature", "")
        # Verification intentionally precedes JSON parsing or any durable write.
        provider.verify_webhook_signature(raw_body, signature)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BillingError("invalid_json", "Webhook body must be valid JSON") from error
        if not isinstance(payload, dict):
            raise BillingError("invalid_json", "Webhook body must be a JSON object")
        payload_hash = hashlib.sha256(raw_body).hexdigest()
        event_id = str(request.headers.get("X-Razorpay-Event-Id") or payload_hash).strip()[:200]
        now = utc_now()
        if not billing.store.claim_event(event_id, payload_hash, now):
            return jsonify({"received": True, "duplicate": True, "requestId": _request_id()})
        event_type = str(payload.get("event") or "")
        try:
            entity = (((payload.get("payload") or {}).get("payment") or {}).get("entity") or {})
            payment_id = str(entity.get("id") or "")
            order_id = str(entity.get("order_id") or "")
            if event_type == "payment.captured":
                if not payment_id or not order_id:
                    raise BillingError("invalid_webhook_payload", "Captured payment webhook is missing identifiers")
                billing.reconcile_webhook_payment(order_id, payment_id)
                outcome = "payment_activated"
            elif event_type == "payment.failed":
                if not order_id:
                    raise BillingError("invalid_webhook_payload", "Failed payment webhook is missing order ID")
                billing.record_failed_attempt(None, order_id, payment_id or None)
                outcome = "failed_attempt_recorded"
            else:
                outcome = "ignored_event"
            billing.store.finish_event(event_id, "completed", utc_now(), outcome)
            return jsonify({"received": True, "duplicate": False, "outcome": outcome, "requestId": _request_id()})
        except Exception:
            billing.store.finish_event(event_id, "failed", utc_now(), "processing_failed")
            raise

    @bp.get("/api/v1/admin/billing/plans")
    @require_auth(admin=True)
    def admin_list_plans():
        billing = require_storage()
        if not hasattr(billing.store, "list_plans"):
            raise BillingError("plan_management_unavailable", "Plan management is unavailable", 503)
        values = [plan_from_record(value).public() for value in billing.store.list_plans(include_inactive=True)]
        return jsonify({"plans": values, "requestId": _request_id()})

    @bp.post("/api/v1/admin/billing/plans")
    @require_auth(admin=True)
    def admin_create_plan():
        billing = require_storage()
        if not hasattr(billing.store, "put_plan"):
            raise BillingError("plan_management_unavailable", "Plan management is unavailable", 503)
        data = _body()
        _allow_fields(data, PLAN_CREATE_FIELDS)
        default_order = len(billing.store.list_plans(include_inactive=True))
        plan = normalize_plan_input({**data, "sortOrder": data.get("sortOrder", default_order)})
        value = billing.store.put_plan(plan, create_only=True)
        return jsonify({"plan": plan_from_record(value).public(), "requestId": _request_id()}), 201

    @bp.patch("/api/v1/admin/billing/plans/<plan_id>")
    @require_auth(admin=True)
    def admin_update_plan(plan_id):
        billing = require_storage()
        if not hasattr(billing.store, "get_plan") or not hasattr(billing.store, "put_plan"):
            raise BillingError("plan_management_unavailable", "Plan management is unavailable", 503)
        normalized_id = str(plan_id or "").strip().lower()
        existing = billing.store.get_plan(normalized_id, include_inactive=True)
        if not existing:
            raise BillingError("plan_not_found", "The selected billing plan was not found", 404)
        data = _body()
        _allow_fields(data, PLAN_UPDATE_FIELDS)
        expected_revision = data.get("revision")
        if type(expected_revision) is not int or expected_revision < 1:
            raise BillingError("invalid_plan_revision", "The current positive plan revision is required")
        changes = dict(data)
        changes.pop("revision", None)
        plan = normalize_plan_input({**changes, "id": normalized_id}, existing)
        value = billing.store.put_plan(plan, expected_revision=expected_revision)
        return jsonify({"plan": plan_from_record(value).public(), "requestId": _request_id()})

    @bp.delete("/api/v1/admin/billing/plans/<plan_id>")
    @require_auth(admin=True)
    def admin_deactivate_plan(plan_id):
        billing = require_storage()
        if not hasattr(billing.store, "deactivate_plan"):
            raise BillingError("plan_management_unavailable", "Plan management is unavailable", 503)
        value = billing.store.deactivate_plan(str(plan_id or "").strip().lower())
        return jsonify({"plan": plan_from_record(value).public(), "requestId": _request_id()})

    @bp.put("/api/v1/admin/billing/plans/order")
    @require_auth(admin=True)
    def admin_reorder_plans():
        billing = require_storage()
        if not hasattr(billing.store, "reorder_plans"):
            raise BillingError("plan_management_unavailable", "Plan management is unavailable", 503)
        data = _body()
        _allow_fields(data, PLAN_ORDER_FIELDS)
        raw_ids = data.get("planIds")
        if not isinstance(raw_ids, list) or not raw_ids or any(not isinstance(value, str) or not value.strip() for value in raw_ids):
            raise BillingError("invalid_plan_order", "planIds must be a non-empty string array")
        plan_ids = [value.strip().lower() for value in raw_ids]
        values = billing.store.reorder_plans(plan_ids)
        return jsonify({
            "plans": [plan_from_record(value).public() for value in values],
            "requestId": _request_id(),
        })

    @bp.get("/api/v1/admin/billing/coupons")
    @require_auth(admin=True)
    def admin_list_coupons():
        values = [public_coupon(value) for value in require_storage().store.list_coupons()]
        return jsonify({"coupons": values, "requestId": _request_id()})

    @bp.post("/api/v1/admin/billing/coupons")
    @require_auth(admin=True)
    def admin_create_coupon():
        billing = require_storage()
        data = _body()
        coupon = normalize_coupon_input(data)
        for plan_id in coupon["planIds"]:
            catalog.get(plan_id, include_inactive=True)
        value = billing.store.put_coupon(coupon, create_only=True)
        return jsonify({"coupon": public_coupon(value), "requestId": _request_id()}), 201

    @bp.patch("/api/v1/admin/billing/coupons/<code>")
    @require_auth(admin=True)
    def admin_update_coupon(code):
        billing = require_storage()
        normalized = normalize_code(code)
        existing = billing.store.get_coupon(normalized)
        if not existing:
            raise BillingError("coupon_not_found", "Coupon code was not found", 404)
        data = _body()
        if "code" in data and normalize_code(data["code"]) != normalized:
            raise BillingError("coupon_code_immutable", "Coupon code cannot be changed", 409)
        coupon = normalize_coupon_input({**data, "code": normalized}, existing)
        for plan_id in coupon["planIds"]:
            catalog.get(plan_id, include_inactive=True)
        value = billing.store.put_coupon(coupon)
        return jsonify({"coupon": public_coupon(value), "requestId": _request_id()})

    @bp.delete("/api/v1/admin/billing/coupons/<code>")
    @require_auth(admin=True)
    def admin_deactivate_coupon(code):
        billing = require_storage()
        normalized = normalize_code(code)
        existing = billing.store.get_coupon(normalized)
        if not existing:
            raise BillingError("coupon_not_found", "Coupon code was not found", 404)
        existing["active"] = False
        value = billing.store.put_coupon(existing)
        return jsonify({"coupon": public_coupon(value), "requestId": _request_id()})

    @bp.get("/api/v1/admin/billing/coupon-usages")
    @require_auth(admin=True)
    def admin_coupon_usages():
        values = require_storage().store.list_redemptions(_limit_arg(200, 500))
        for value in values:
            value["createdAt"] = iso(value.get("createdAt"))
            value["discountInr"] = inr_from_paise(value.get("discountPaise", 0))
        return jsonify({"usages": values, "requestId": _request_id()})

    @bp.get("/api/v1/admin/billing/analytics")
    @require_auth(admin=True)
    def admin_analytics():
        result = require_storage().store.analytics()
        result["grossRevenueInr"] = inr_from_paise(result.get("grossRevenuePaise", 0))
        result["discountsInr"] = inr_from_paise(result.get("discountsPaise", 0))
        result["totalDiscountGivenInr"] = inr_from_paise(
            result.get("totalDiscountGivenPaise", result.get("discountsPaise", 0))
        )
        return jsonify({"analytics": result, "requestId": _request_id()})

    return bp
