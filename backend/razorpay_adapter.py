"""Secret-safe adapter around the official Razorpay Python SDK."""

from __future__ import annotations

import hmac
from dataclasses import dataclass


class RazorpayAdapterError(Exception):
    """A sanitized provider failure safe to return through the API layer."""

    def __init__(self, code="provider_unavailable", message="Payment provider is temporarily unavailable"):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class RazorpayReadiness:
    configured: bool
    webhook_configured: bool


class RazorpayAdapter:
    """Narrow SDK wrapper; credentials and raw provider errors never leave it."""

    def __init__(self, key_id, key_secret, webhook_secret, client=None):
        self._key_id = (key_id or "").strip()
        self._key_secret = key_secret or ""
        self._webhook_secret = webhook_secret or ""
        self.readiness = RazorpayReadiness(
            configured=bool(self._key_id and self._key_secret),
            webhook_configured=bool(self._webhook_secret),
        )
        self._client = client
        if self._client is None and self.readiness.configured:
            try:
                import razorpay

                self._client = razorpay.Client(auth=(self._key_id, self._key_secret))
            except Exception as error:
                raise RazorpayAdapterError() from error

    @property
    def public_key_id(self):
        return self._key_id if self.readiness.configured else None

    def _require_client(self):
        if not self.readiness.configured or self._client is None:
            raise RazorpayAdapterError("billing_not_configured", "Billing is not configured")

    def create_order(self, amount_paise, receipt, notes=None):
        self._require_client()
        if isinstance(amount_paise, bool) or int(amount_paise) <= 0:
            raise RazorpayAdapterError("zero_amount_not_allowed", "A zero-value Razorpay order cannot be created")
        payload = {
            "amount": int(amount_paise),
            "currency": "INR",
            "receipt": str(receipt)[:40],
            "notes": {str(key)[:32]: str(value)[:256] for key, value in (notes or {}).items()},
        }
        try:
            result = self._client.order.create(data=payload)
        except Exception as error:
            raise RazorpayAdapterError() from error
        if not isinstance(result, dict) or not result.get("id"):
            raise RazorpayAdapterError()
        return {
            "id": str(result["id"]),
            "amount": int(result.get("amount", amount_paise)),
            "currency": str(result.get("currency", "INR")),
            "status": str(result.get("status", "created")),
        }

    def find_order_by_receipt(self, receipt):
        """Recover an accepted provider order after a worker interruption."""
        self._require_client()
        try:
            result = self._client.order.all({"count": 100})
        except Exception as error:
            raise RazorpayAdapterError() from error
        items = result.get("items", []) if isinstance(result, dict) else []
        for item in items:
            if isinstance(item, dict) and item.get("receipt") == str(receipt)[:40] and item.get("id"):
                return {
                    "id": str(item["id"]), "amount": int(item.get("amount") or 0),
                    "currency": str(item.get("currency") or ""), "status": str(item.get("status") or ""),
                }
        return None

    def verify_checkout_signature(self, order_id, payment_id, signature):
        self._require_client()
        try:
            self._client.utility.verify_payment_signature({
                "razorpay_order_id": str(order_id),
                "razorpay_payment_id": str(payment_id),
                "razorpay_signature": str(signature),
            })
            return True
        except Exception as error:
            raise RazorpayAdapterError("invalid_payment_signature", "Payment signature verification failed") from error

    def verify_webhook_signature(self, raw_body, signature):
        self._require_client()
        if not self.readiness.webhook_configured:
            raise RazorpayAdapterError("billing_not_configured", "Razorpay webhook verification is not configured")
        if not isinstance(raw_body, (bytes, bytearray)):
            raise RazorpayAdapterError("invalid_webhook_signature", "Webhook signature verification failed")
        try:
            body = bytes(raw_body).decode("utf-8")
            self._client.utility.verify_webhook_signature(body, str(signature or ""), self._webhook_secret)
            return True
        except Exception as error:
            raise RazorpayAdapterError("invalid_webhook_signature", "Webhook signature verification failed") from error

    def fetch_payment(self, payment_id):
        self._require_client()
        try:
            result = self._client.payment.fetch(str(payment_id))
        except Exception as error:
            raise RazorpayAdapterError() from error
        if not isinstance(result, dict) or not result.get("id"):
            raise RazorpayAdapterError()
        # Only fields needed for reconciliation are retained. Card, contact,
        # email, token, and provider error descriptions are deliberately omitted.
        return {
            "id": str(result["id"]),
            "order_id": str(result.get("order_id") or ""),
            "amount": int(result.get("amount") or 0),
            "currency": str(result.get("currency") or ""),
            "status": str(result.get("status") or ""),
            "captured": bool(result.get("captured")),
            "method": str(result.get("method") or "")[:32] or None,
            "bank": str(result.get("bank") or "")[:64] or None,
            "wallet": str(result.get("wallet") or "")[:64] or None,
            "vpa": str(result.get("vpa") or "")[:128] or None,
            "created_at": result.get("created_at"),
            "fee": int(result["fee"]) if result.get("fee") is not None else None,
            "tax": int(result["tax"]) if result.get("tax") is not None else None,
        }


class HmacTestRazorpayAdapter:
    """Small deterministic adapter useful for local/unit tests without the SDK."""

    def __init__(self, secret="test-secret", webhook_secret="webhook-secret"):
        self.secret = secret.encode("utf-8")
        self.webhook_secret = webhook_secret.encode("utf-8")
        self.public_key_id = "rzp_test_public"
        self.readiness = RazorpayReadiness(True, True)
        self.orders = {}
        self.payments = {}
        self.create_calls = 0

    def create_order(self, amount_paise, receipt, notes=None):
        self.create_calls += 1
        order_id = "order_%s" % self.create_calls
        value = {"id": order_id, "amount": int(amount_paise), "currency": "INR", "status": "created", "receipt": str(receipt)[:40]}
        self.orders[order_id] = value
        return dict(value)

    def find_order_by_receipt(self, receipt):
        for order in self.orders.values():
            if order.get("receipt") == str(receipt)[:40]:
                return dict(order)
        return None

    def checkout_signature(self, order_id, payment_id):
        return hmac.new(self.secret, (order_id + "|" + payment_id).encode("utf-8"), "sha256").hexdigest()

    def webhook_signature(self, raw_body):
        return hmac.new(self.webhook_secret, raw_body, "sha256").hexdigest()

    def verify_checkout_signature(self, order_id, payment_id, signature):
        if not hmac.compare_digest(self.checkout_signature(order_id, payment_id), str(signature)):
            raise RazorpayAdapterError("invalid_payment_signature", "Payment signature verification failed")
        return True

    def verify_webhook_signature(self, raw_body, signature):
        if not hmac.compare_digest(self.webhook_signature(raw_body), str(signature or "")):
            raise RazorpayAdapterError("invalid_webhook_signature", "Webhook signature verification failed")
        return True

    def fetch_payment(self, payment_id):
        if payment_id not in self.payments:
            raise RazorpayAdapterError()
        return dict(self.payments[payment_id])
