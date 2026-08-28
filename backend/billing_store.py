"""Durable server-only Firestore storage for billing state."""

from __future__ import annotations

import hashlib
from copy import deepcopy
from datetime import timedelta

from firebase_admin import firestore

from billing_core import (
    BillingError,
    MAX_CLIENT_FAILURE_ATTEMPTS,
    evaluate_coupon,
    public_coupon,
    utc_now,
)


COLLECTIONS = {
    "coupons": "billing_coupons",
    "coupon_users": "billing_coupon_user_usage",
    "orders": "billing_orders",
    "provider_orders": "billing_provider_orders",
    "payments": "billing_payments",
    "payment_attempts": "billing_payment_attempts",
    "subscriptions": "billing_subscriptions",
    "redemptions": "billing_coupon_redemptions",
    "events": "billing_webhook_events",
}


def _data(snapshot):
    return ({"id": snapshot.id, **(snapshot.to_dict() or {})} if snapshot.exists else None)


def _safe_doc_id(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


class FirestoreBillingStore:
    """Billing persistence whose state transitions are Firestore transactions."""

    def __init__(self, db):
        if db is None:
            raise ValueError("A Firestore client is required")
        self.db = db

    def _ref(self, key, document_id):
        return self.db.collection(COLLECTIONS[key]).document(str(document_id))

    def put_coupon(self, coupon, create_only=False):
        ref = self._ref("coupons", coupon["code"])
        transaction = self.db.transaction()

        @firestore.transactional
        def update(transaction):
            prior = _data(ref.get(transaction=transaction)) or {}
            if create_only and prior:
                raise BillingError("coupon_exists", "A coupon with this code already exists", 409)
            record = deepcopy(coupon)
            record["usedCount"] = int(prior.get("usedCount", coupon.get("usedCount", 0)))
            record["reservedCount"] = int(prior.get("reservedCount", coupon.get("reservedCount", 0)))
            record["updatedAt"] = utc_now()
            if not prior:
                record["createdAt"] = record["updatedAt"]
            else:
                record["createdAt"] = prior.get("createdAt", record["updatedAt"])
            transaction.set(ref, record)
            return record

        return update(transaction)

    def get_coupon(self, code):
        return _data(self._ref("coupons", code).get())

    def list_coupons(self):
        values = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["coupons"]).stream()]
        return sorted((value for value in values if value), key=lambda value: value["code"])

    def _coupon_user_ref(self, uid, code):
        return self._ref("coupon_users", _safe_doc_id(uid + "\0" + code))

    def coupon_user_counts(self, uid, code):
        value = _data(self._coupon_user_ref(uid, code).get())
        return value or {"userId": uid, "couponCode": code, "usedCount": 0, "reservedCount": 0}

    def has_prior_payment(self, uid):
        query = self.db.collection(COLLECTIONS["payments"]).where("userId", "==", uid)
        return any(
            (snapshot.to_dict() or {}).get("status") == "captured"
            for snapshot in query.stream()
        )

    def cleanup_expired(self, now):
        # Coupon-backed provider orders keep their capacity reservation because
        # Razorpay Orders cannot be cancelled locally and may still capture.
        # Releasing those slots would allow late captures to exceed hard limits.
        # Other expired reservations are released transactionally.
        snapshots = []
        for snapshot in self.db.collection(COLLECTIONS["orders"]).stream():
            value = snapshot.to_dict() or {}
            if (
                value.get("status") == "reserved"
                and value.get("reservationExpiresAt")
                and value["reservationExpiresAt"] <= now
                and not (value.get("couponCode") and value.get("providerOrderId"))
            ):
                snapshots.append(snapshot)
        for snapshot in snapshots:
            try:
                self.release_internal_order(None, snapshot.id, now, "expired")
            except BillingError:
                continue

    def reserve_order(
        self, uid, idempotency_key, plan, coupon_code, now, expires_at,
        allow_zero=False, user_email=None,
    ):
        order_id = _safe_doc_id(uid + "\0" + idempotency_key)
        order_ref = self._ref("orders", order_id)
        coupon_ref = self._ref("coupons", coupon_code) if coupon_code else None
        usage_ref = self._coupon_user_ref(uid, coupon_code) if coupon_code else None
        subscription_ref = self._ref("subscriptions", uid)
        transaction = self.db.transaction()

        @firestore.transactional
        def reserve(transaction):
            existing = _data(order_ref.get(transaction=transaction))
            if existing:
                if existing.get("planId") != plan.id or existing.get("couponCode") != coupon_code:
                    raise BillingError("idempotency_conflict", "Idempotency key was already used for different checkout details", 409)
                return existing, False

            subscription = _data(subscription_ref.get(transaction=transaction))
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

            discount = 0
            coupon_snapshot = None
            if coupon_code:
                coupon = _data(coupon_ref.get(transaction=transaction))
                usage = _data(usage_ref.get(transaction=transaction)) or {
                    "userId": uid, "couponCode": coupon_code, "usedCount": 0, "reservedCount": 0,
                }
                active_reservation = usage.get("activeReservationOrderId")
                active_until = usage.get("activeReservationExpiresAt")
                if active_reservation and active_reservation != order_id and active_until and active_until > now:
                    raise BillingError(
                        "coupon_reservation_exists",
                        "You already have an active checkout using this coupon",
                        409,
                    )
                has_prior = bool(subscription and int(subscription.get("paymentCount", 0)) > 0)
                discount = evaluate_coupon(
                    coupon, plan, now, int(usage.get("usedCount", 0)),
                    int(usage.get("reservedCount", 0)), has_prior,
                )
                coupon_snapshot = public_coupon(coupon)
                coupon_update = deepcopy(coupon)
                coupon_update.pop("id", None)
                coupon_update["reservedCount"] = int(coupon.get("reservedCount", 0)) + 1
                coupon_update["updatedAt"] = now
                usage["reservedCount"] = int(usage.get("reservedCount", 0)) + 1
                usage["activeReservationOrderId"] = order_id
                usage["activeReservationExpiresAt"] = expires_at
                usage["updatedAt"] = now
                usage.pop("id", None)
                transaction.set(coupon_ref, coupon_update)
                transaction.set(usage_ref, usage)

            final_amount = plan.amount_paise - discount
            if final_amount == 0 and not allow_zero:
                raise BillingError("zero_amount_not_allowed", "Coupons cannot reduce a Razorpay order to zero", 409)
            order = {
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
            transaction.set(order_ref, order)
            return {"id": order_id, **order}, True

        return reserve(transaction)

    def attach_provider_order(self, order_id, provider_order_id, now):
        order_ref = self._ref("orders", order_id)
        mapping_ref = self._ref("provider_orders", provider_order_id)
        transaction = self.db.transaction()

        @firestore.transactional
        def attach(transaction):
            order = _data(order_ref.get(transaction=transaction))
            if not order:
                raise BillingError("order_not_found", "Billing order was not found", 404)
            mapping = _data(mapping_ref.get(transaction=transaction))
            if mapping and mapping.get("billingOrderId") != order_id:
                raise BillingError("order_state_conflict", "Provider order is already linked", 409)
            if order.get("providerOrderId") and order["providerOrderId"] != provider_order_id:
                raise BillingError("order_state_conflict", "Checkout order is already linked", 409)
            transaction.set(order_ref, {"providerOrderId": provider_order_id, "updatedAt": now}, merge=True)
            transaction.set(mapping_ref, {
                "billingOrderId": order_id, "userId": order["userId"], "createdAt": now,
            })
            order["providerOrderId"] = provider_order_id
            order["updatedAt"] = now
            return order

        return attach(transaction)

    def _mapped_order_ref(self, provider_order_id):
        mapping = _data(self._ref("provider_orders", provider_order_id).get())
        return self._ref("orders", mapping["billingOrderId"]) if mapping else None

    def get_order_for_user(self, uid, provider_order_id):
        ref = self._mapped_order_ref(provider_order_id)
        order = _data(ref.get()) if ref else None
        return order if order and order.get("userId") == uid else None

    def get_order_by_provider(self, provider_order_id):
        ref = self._mapped_order_ref(provider_order_id)
        return _data(ref.get()) if ref else None

    def release_internal_order(self, uid, order_id, now, reason="failed"):
        order_ref = self._ref("orders", order_id)
        transaction = self.db.transaction()

        @firestore.transactional
        def release(transaction):
            order = _data(order_ref.get(transaction=transaction))
            if not order or (uid is not None and order.get("userId") != uid):
                raise BillingError("order_not_found", "Billing order was not found", 404)
            if order.get("status") != "reserved":
                return order
            code = order.get("couponCode")
            if code:
                coupon_ref = self._ref("coupons", code)
                usage_ref = self._coupon_user_ref(order["userId"], code)
                coupon = _data(coupon_ref.get(transaction=transaction))
                usage = _data(usage_ref.get(transaction=transaction))
                if coupon:
                    transaction.set(coupon_ref, {
                        "reservedCount": max(0, int(coupon.get("reservedCount", 0)) - 1), "updatedAt": now,
                    }, merge=True)
                if usage:
                    usage_update = {
                        "reservedCount": max(0, int(usage.get("reservedCount", 0)) - 1),
                        "updatedAt": now,
                    }
                    if usage.get("activeReservationOrderId") == order_id:
                        usage_update.update({
                            "activeReservationOrderId": None,
                            "activeReservationExpiresAt": None,
                        })
                    transaction.set(usage_ref, usage_update, merge=True)
            transaction.set(order_ref, {"status": reason, "updatedAt": now}, merge=True)
            order["status"] = reason
            order["updatedAt"] = now
            return order

        return release(transaction)

    def record_failed_attempt(self, uid, provider_order_id, now, payment_id=None):
        mapping = _data(self._ref("provider_orders", provider_order_id).get())
        if not mapping:
            raise BillingError("order_not_found", "Billing order was not found", 404)
        order_ref = self._ref("orders", mapping["billingOrderId"])
        current = _data(order_ref.get())
        if not current or (uid is not None and current.get("userId") != uid):
            raise BillingError("order_not_found", "Billing order was not found", 404)
        if (
            current.get("status") == "reserved"
            and current.get("reservationExpiresAt") <= now
            and not (current.get("couponCode") and current.get("providerOrderId"))
        ):
            return self.release_internal_order(uid, mapping["billingOrderId"], now, "expired")

        discriminator = payment_id or "client-reported-failure"
        attempt_id = _safe_doc_id(provider_order_id + "\0" + discriminator)
        attempt_ref = self._ref("payment_attempts", attempt_id)
        transaction = self.db.transaction()

        @firestore.transactional
        def record(transaction):
            order = _data(order_ref.get(transaction=transaction))
            existing_attempt = _data(attempt_ref.get(transaction=transaction))
            if not order or (uid is not None and order.get("userId") != uid):
                raise BillingError("order_not_found", "Billing order was not found", 404)
            if existing_attempt or order.get("status") != "reserved":
                return order
            if int(order.get("failureAttempts", 0)) >= MAX_CLIENT_FAILURE_ATTEMPTS:
                return order
            update = {
                "failureAttempts": int(order.get("failureAttempts", 0)) + 1,
                "lastFailedPaymentId": payment_id,
                "lastFailureAt": now,
                "updatedAt": now,
            }
            transaction.set(order_ref, update, merge=True)
            transaction.set(attempt_ref, {
                "userId": order["userId"], "userEmail": order.get("userEmail"),
                "provider": "razorpay", "providerOrderId": provider_order_id,
                "providerPaymentId": payment_id, "status": "failed",
                "planId": order["planId"], "planSnapshot": order["planSnapshot"],
                "couponCode": order.get("couponCode"),
                "couponSnapshot": order.get("couponSnapshot"),
                "originalAmountPaise": order["originalAmountPaise"],
                "discountPaise": order["discountPaise"],
                "amountPaise": order["amountPaise"], "currency": "INR",
                "createdAt": now, "verifiedAt": None,
            })
            order.update(update)
            return order

        return record(transaction)

    def release_order(self, uid, provider_order_id, now, reason="failed"):
        mapping = _data(self._ref("provider_orders", provider_order_id).get())
        if not mapping:
            raise BillingError("order_not_found", "Billing order was not found", 404)
        return self.release_internal_order(uid, mapping["billingOrderId"], now, reason)

    def activate_payment(self, order, provider_payment, now):
        order_ref = self._ref("orders", order["id"])
        payment_ref = self._ref("payments", provider_payment["id"])
        subscription_ref = self._ref("subscriptions", order["userId"])
        transaction = self.db.transaction()

        @firestore.transactional
        def activate(transaction):
            existing = _data(payment_ref.get(transaction=transaction))
            if existing:
                if existing.get("providerOrderId") != order.get("providerOrderId"):
                    raise BillingError("payment_already_claimed", "This provider payment belongs to another order", 409)
                subscription = _data(subscription_ref.get(transaction=transaction))
                return existing, subscription, False

            current = _data(order_ref.get(transaction=transaction))
            if not current or current.get("userId") != order.get("userId"):
                raise BillingError("order_not_found", "Billing order was not found", 404)
            if current.get("status") == "paid":
                raise BillingError("payment_state_conflict", "Paid order has no matching payment claim", 409)
            if current.get("status") not in ("reserved", "expired", "failed"):
                raise BillingError("payment_state_conflict", "Billing order cannot accept a captured payment", 409)
            late_capture = current.get("status") != "reserved" or current.get("reservationExpiresAt") <= now

            code = current.get("couponCode")
            if code:
                coupon_ref = self._ref("coupons", code)
                usage_ref = self._coupon_user_ref(current["userId"], code)
                coupon = _data(coupon_ref.get(transaction=transaction))
                usage = _data(usage_ref.get(transaction=transaction)) or {"usedCount": 0, "reservedCount": 0}
                if not coupon:
                    raise BillingError("billing_data_inconsistent", "Coupon snapshot is unavailable", 503)
                prior_subscription = _data(subscription_ref.get(transaction=transaction))
                coupon_update = {
                    "usedCount": int(coupon.get("usedCount", 0)) + 1,
                    "updatedAt": now,
                }
                usage_update = {
                    "userId": current["userId"], "couponCode": code,
                    "usedCount": int(usage.get("usedCount", 0)) + 1,
                    "updatedAt": now,
                }
                if current.get("status") == "reserved":
                    coupon_update["reservedCount"] = max(0, int(coupon.get("reservedCount", 0)) - 1)
                    usage_update["reservedCount"] = max(0, int(usage.get("reservedCount", 0)) - 1)
                if usage.get("activeReservationOrderId") == current["id"]:
                    usage_update.update({
                        "activeReservationOrderId": None,
                        "activeReservationExpiresAt": None,
                    })
                transaction.set(coupon_ref, coupon_update, merge=True)
                transaction.set(usage_ref, usage_update, merge=True)
                redemption_ref = self._ref("redemptions", current["id"])
                transaction.set(redemption_ref, {
                    "userId": current["userId"], "couponCode": code,
                    "providerPaymentId": provider_payment["id"],
                    "providerOrderId": current["providerOrderId"],
                    "discountPaise": current["discountPaise"],
                    "lateCapture": late_capture, "createdAt": now,
                })
            else:
                prior_subscription = _data(subscription_ref.get(transaction=transaction))

            changing_plan = bool(
                prior_subscription
                and prior_subscription.get("expiresAt")
                and prior_subscription["expiresAt"] > now
                and prior_subscription.get("planId") != current["planId"]
            )
            starts = now
            if (
                prior_subscription
                and prior_subscription.get("expiresAt")
                and prior_subscription["expiresAt"] > now
                and not changing_plan
            ):
                starts = prior_subscription["expiresAt"]
            expires = starts + timedelta(days=int(current["planSnapshot"]["durationDays"]))
            payment = {
                "userId": current["userId"], "userEmail": current.get("userEmail"),
                "provider": "razorpay",
                "providerPaymentId": provider_payment["id"], "providerOrderId": current["providerOrderId"],
                "status": "captured", "amountPaise": current["amountPaise"],
                "originalAmountPaise": current["originalAmountPaise"], "discountPaise": current["discountPaise"],
                "currency": "INR", "method": provider_payment.get("method"),
                "bank": provider_payment.get("bank"), "wallet": provider_payment.get("wallet"),
                "vpa": provider_payment.get("vpa"), "feePaise": provider_payment.get("fee"),
                "taxPaise": provider_payment.get("tax"), "providerCreatedAt": provider_payment.get("created_at"),
                "planId": current["planId"], "planSnapshot": current["planSnapshot"],
                "couponCode": code, "couponSnapshot": current.get("couponSnapshot"),
                "lateCapture": late_capture,
                "planChangeImmediate": changing_plan,
                "createdAt": now, "verifiedAt": now,
                "subscriptionStartsAt": starts, "subscriptionExpiresAt": expires,
            }
            subscription = {
                "userId": current["userId"], "status": "active", "planId": current["planId"],
                "startsAt": starts, "expiresAt": expires, "updatedAt": now,
                "lastPaymentId": provider_payment["id"],
                "paymentCount": int((prior_subscription or {}).get("paymentCount", 0)) + 1,
            }
            transaction.set(payment_ref, payment)
            transaction.set(subscription_ref, subscription)
            transaction.set(order_ref, {
                "status": "paid", "providerPaymentId": provider_payment["id"], "updatedAt": now,
            }, merge=True)
            return {"id": provider_payment["id"], **payment}, subscription, True

        return activate(transaction)

    def list_payments(self, uid, limit=100):
        maximum = max(1, min(int(limit), 200))
        values = [
            _data(snapshot)
            for snapshot in self.db.collection(COLLECTIONS["payments"]).stream()
            if (snapshot.to_dict() or {}).get("userId") == uid
        ]
        values.extend(
            _data(snapshot)
            for snapshot in self.db.collection(COLLECTIONS["payment_attempts"]).stream()
            if (snapshot.to_dict() or {}).get("userId") == uid
        )
        return sorted(values, key=lambda value: value.get("createdAt"), reverse=True)[:maximum]

    def get_payment_by_order(self, uid, provider_order_id):
        for snapshot in self.db.collection(COLLECTIONS["payments"]).stream():
            value = _data(snapshot)
            if value.get("userId") == uid and value.get("providerOrderId") == provider_order_id:
                return value
        return None

    def get_subscription(self, uid):
        return _data(self._ref("subscriptions", uid).get())

    def claim_event(self, event_id, payload_hash, now):
        ref = self._ref("events", event_id)
        transaction = self.db.transaction()

        @firestore.transactional
        def claim(transaction):
            existing = _data(ref.get(transaction=transaction))
            if existing and existing.get("payloadHash") != payload_hash:
                raise BillingError("webhook_event_conflict", "Webhook event ID was reused with different content", 409)
            if existing and existing.get("status") == "completed":
                return False
            if (
                existing and existing.get("status") == "processing"
                and existing.get("leaseExpiresAt") and existing["leaseExpiresAt"] > now
            ):
                raise BillingError("webhook_event_processing", "Webhook event is already being processed", 503)
            transaction.set(ref, {
                "payloadHash": payload_hash, "status": "processing",
                "attempts": int((existing or {}).get("attempts", 0)) + 1,
                "leaseExpiresAt": now + timedelta(minutes=5),
                "createdAt": (existing or {}).get("createdAt", now), "updatedAt": now,
            })
            return True

        return claim(transaction)

    def finish_event(self, event_id, status, now, outcome=None):
        self._ref("events", event_id).set({"status": status, "outcome": outcome, "updatedAt": now}, merge=True)

    def list_redemptions(self, limit=200):
        query = self.db.collection(COLLECTIONS["redemptions"]).order_by("createdAt", direction=firestore.Query.DESCENDING).limit(max(1, min(int(limit), 500)))
        return [_data(snapshot) for snapshot in query.stream()]

    def analytics(self):
        payments = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["payments"]).stream()]
        subscriptions = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["subscriptions"]).stream()]
        redemptions = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["redemptions"]).stream()]
        coupons = [_data(snapshot) for snapshot in self.db.collection(COLLECTIONS["coupons"]).stream()]
        now = utc_now()
        discounts = sum(int(value.get("discountPaise", 0)) for value in payments)
        return {
            "totalCoupons": len(coupons),
            "activeCoupons": sum(
                1 for value in coupons
                if value.get("active")
                and (not value.get("startsAt") or value["startsAt"] <= now)
                and (not value.get("expiresAt") or value["expiresAt"] > now)
            ),
            "expiredCoupons": sum(
                1 for value in coupons
                if value.get("expiresAt") and value["expiresAt"] <= now
            ),
            "totalCouponUses": sum(int(value.get("usedCount", 0)) for value in coupons),
            "totalDiscountGivenPaise": discounts,
            "capturedPayments": len(payments),
            "grossRevenuePaise": sum(int(value.get("amountPaise", 0)) for value in payments),
            "discountsPaise": discounts,
            "activeSubscriptions": sum(1 for value in subscriptions if value.get("expiresAt") and value["expiresAt"] > now),
            "couponRedemptions": len(redemptions),
        }
