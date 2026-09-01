"""Server-side email OTP challenge issuance and verification."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

import requests
from firebase_admin import auth as firebase_auth, firestore
from firebase_admin_setup import classify_firestore_error
from flask import Blueprint, jsonify, request

OTP_EXPIRY_SECONDS = 5 * 60
OTP_RESEND_SECONDS = 60
OTP_MAX_ATTEMPTS = 5
EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send"
EMAILJS_TIMEOUT = (5, 10)
MAX_SAFE_RETRY_AFTER = 60 * 60
_EMAILJS_VALUE = re.compile(r"^[A-Za-z0-9_-]{3,128}$")
_EMAILJS_TEMPLATE_SIGNALS = frozenset({
    "service not found",
    "template not found",
    "service is not active",
    "template is not active",
})
_EMAILJS_RECIPIENT_SIGNALS = frozenset({
    "recipient is required",
    "recipient address is invalid",
    "recipient rejected",
})


@dataclass(frozen=True)
class EmailDeliveryFailure(Exception):
    """Secret-free description of an EmailJS delivery failure."""

    category: str
    diagnostic_code: str
    retryable: bool
    retry_after: Optional[int]
    exception_class: str


def _error(message: str, status: int, diagnostic_code: Optional[str] = None):
    payload = {"success": False, "message": message}
    if diagnostic_code:
        payload["diagnosticCode"] = diagnostic_code
    return jsonify(payload), status


def _log_safe_failure(event: str, error: Exception) -> None:
    """Log an allowlisted event and exception class, never exception text."""
    print(f"[WARN] {event} ({type(error).__name__})", flush=True)


def _log_email_failure(failure: EmailDeliveryFailure) -> None:
    print(
        "[WARN] %s category=%s exception=%s retryable=%s"
        % (
            failure.diagnostic_code,
            failure.category,
            failure.exception_class,
            str(failure.retryable).lower(),
        ),
        flush=True,
    )


def _safe_int(value: Any, default: int = 0) -> int:
    """Coerce legacy numeric or timestamp values without blocking OTP renewal."""
    try:
        if hasattr(value, "timestamp"):
            value = value.timestamp()
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _storage_error(error: Exception):
    category = classify_firestore_error(error)
    return _error(
        "OTP service unavailable", 503, f"otp_storage_{category}"
    )


def _authenticate(firebase_app) -> Tuple[Optional[Dict[str, Any]], Optional[Tuple[Any, int]]]:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer ") or not header[7:].strip():
        return None, _error("Authentication required", 401)
    if firebase_app is None:
        return None, _error("Authentication service unavailable", 503)
    try:
        decoded = firebase_auth.verify_id_token(
            header[7:].strip(), app=firebase_app, check_revoked=True
        )
    except Exception:
        return None, _error("Invalid or expired token", 401)
    if not (decoded.get("uid") or decoded.get("sub")) or not decoded.get("email"):
        return None, _error("Invalid token", 401)
    return decoded, None


def _otp_digest(secret: str, uid: str, nonce: str, code: str) -> str:
    message = f"{uid}:{nonce}:{code}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def _safe_exception_class(error: Optional[Exception]) -> str:
    if error is None:
        return "HttpResponse"
    allowed = {
        "Timeout",
        "ConnectTimeout",
        "ReadTimeout",
        "ConnectionError",
        "RequestException",
    }
    name = type(error).__name__
    return name if name in allowed else "Exception"


def _delivery_failure(
    category: str,
    *,
    retryable: bool = False,
    retry_after: Optional[int] = None,
    error: Optional[Exception] = None,
) -> EmailDeliveryFailure:
    return EmailDeliveryFailure(
        category=category,
        diagnostic_code=f"otp_email_{category}",
        retryable=retryable,
        retry_after=retry_after,
        exception_class=_safe_exception_class(error),
    )


def _emailjs_configuration() -> Tuple[str, str, str, Optional[str]]:
    required = tuple(
        os.environ.get(key, "").strip()
        for key in ("EMAILJS_SERVICE_ID", "EMAILJS_TEMPLATE_ID", "EMAILJS_PUBLIC_KEY")
    )
    private_key = os.environ.get("EMAILJS_PRIVATE_KEY", "").strip() or None
    if (
        not all(_EMAILJS_VALUE.fullmatch(value) for value in required)
        or (private_key is not None and not _EMAILJS_VALUE.fullmatch(private_key))
    ):
        raise _delivery_failure("configuration")
    return (*required, private_key)


def emailjs_configuration_ready() -> bool:
    """Report only whether local EmailJS configuration has a plausible shape."""
    try:
        _emailjs_configuration()
        return True
    except EmailDeliveryFailure:
        return False


def _bounded_retry_after(value: Any) -> Optional[int]:
    text = str(value).strip() if value is not None else ""
    if not text.isdecimal():
        return None
    retry_after = int(text)
    if 0 < retry_after <= MAX_SAFE_RETRY_AFTER:
        return retry_after
    return None


def _allowlisted_provider_category(response: Any) -> Optional[str]:
    """Compare a short provider signal in memory, then discard it."""
    try:
        signal = response.text
    except Exception:
        return None
    if not isinstance(signal, str) or len(signal) > 128:
        return None
    normalized = " ".join(signal.strip().lower().split())
    if normalized in _EMAILJS_TEMPLATE_SIGNALS:
        return "template"
    if normalized in _EMAILJS_RECIPIENT_SIGNALS:
        return "recipient"
    return None


def _classify_emailjs_response(response: Any) -> EmailDeliveryFailure:
    status = _safe_int(getattr(response, "status_code", 0))
    headers = getattr(response, "headers", {}) or {}
    retry_after = _bounded_retry_after(headers.get("Retry-After"))
    if status in (401, 403):
        return _delivery_failure("authentication")
    if status == 404:
        return _delivery_failure("template")
    if status == 429:
        return _delivery_failure(
            "rate_limit", retryable=True, retry_after=retry_after
        )
    if status >= 500:
        return _delivery_failure("provider_unavailable", retryable=True)
    allowlisted = _allowlisted_provider_category(response)
    if allowlisted:
        return _delivery_failure(allowlisted)
    if status == 400:
        return _delivery_failure("request_contract")
    if status == 422:
        return _delivery_failure("recipient")
    return _delivery_failure("operation_failed")


def _send_emailjs_otp(email: str, code: str) -> None:
    service_id, template_id, public_key, private_key = _emailjs_configuration()
    payload = {
        "service_id": service_id,
        "template_id": template_id,
        "user_id": public_key,
        "template_params": {
            "email": email,
            "to_email": email,
            "otp_code": code,
            "otp": code,
            "app_name": "Vivek Marco Trader",
            "expiry_minutes": str(OTP_EXPIRY_SECONDS // 60),
        },
    }
    if private_key is not None:
        payload["accessToken"] = private_key
    try:
        response = requests.post(
            EMAILJS_ENDPOINT,
            json=payload,
            timeout=EMAILJS_TIMEOUT,
        )
    except (requests.Timeout, requests.ConnectionError) as error:
        raise _delivery_failure("network", retryable=True, error=error) from None
    except requests.RequestException as error:
        raise _delivery_failure("network", retryable=True, error=error) from None
    except Exception as error:
        raise _delivery_failure("operation_failed", error=error) from None

    status = _safe_int(getattr(response, "status_code", 0))
    if 200 <= status < 300:
        return
    raise _classify_emailjs_response(response)


def _activate_pending_challenge(db, challenge_ref, challenge_id: str) -> bool:
    transaction = db.transaction()

    @firestore.transactional
    def activate(active_transaction):
        snapshot = challenge_ref.get(transaction=active_transaction)
        if not snapshot.exists:
            return False
        challenge = snapshot.to_dict() or {}
        if (
            challenge.get("challengeId") != challenge_id
            or challenge.get("deliveryState") != "pending"
        ):
            return False
        active_transaction.update(challenge_ref, {"deliveryState": "active"})
        return True

    return bool(activate(transaction))


def _cleanup_pending_challenge(db, challenge_ref, challenge_id: str) -> None:
    transaction = db.transaction()

    @firestore.transactional
    def cleanup(active_transaction):
        snapshot = challenge_ref.get(transaction=active_transaction)
        if not snapshot.exists:
            return
        challenge = snapshot.to_dict() or {}
        if (
            challenge.get("challengeId") == challenge_id
            and challenge.get("deliveryState") == "pending"
        ):
            active_transaction.delete(challenge_ref)

    cleanup(transaction)


def _legacy_challenge_is_structurally_valid(challenge: Dict[str, Any], uid: str) -> bool:
    digest = challenge.get("codeHash")
    nonce = challenge.get("nonce")
    email = challenge.get("email")
    return (
        challenge.get("uid") == uid
        and isinstance(email, str)
        and bool(email)
        and isinstance(nonce, str)
        and bool(nonce)
        and isinstance(digest, str)
        and len(digest) == 64
        and all(character in "0123456789abcdef" for character in digest.lower())
        and _safe_int(challenge.get("authTime", 0)) > 0
        and _safe_int(challenge.get("expiresAt", 0)) > 0
        and _safe_int(challenge.get("attempts", -1), -1) >= 0
    )


def _delivery_error(failure: EmailDeliveryFailure):
    payload = {
        "success": False,
        "message": "Unable to send OTP. Please try again later.",
        "diagnosticCode": failure.diagnostic_code,
    }
    status = 429 if failure.category == "rate_limit" else 503
    if failure.retry_after is not None:
        payload["retryAfter"] = failure.retry_after
    response = jsonify(payload)
    response.status_code = status
    if failure.retry_after is not None:
        response.headers["Retry-After"] = str(failure.retry_after)
    return response


def create_otp_blueprint(db, firebase_app=None) -> Blueprint:
    blueprint = Blueprint("otp_auth", __name__)

    @blueprint.post("/api/auth/otp/send")
    def send_otp():
        decoded, auth_error = _authenticate(firebase_app)
        if auth_error:
            return auth_error
        if db is None:
            return _error(
                "OTP service unavailable", 503, "otp_storage_client_unavailable"
            )

        secret = os.environ.get("OTP_HMAC_SECRET", "").strip()
        if len(secret) < 32:
            return _error("OTP service unavailable", 503, "otp_hmac_unavailable")

        uid = str(decoded.get("uid") or decoded.get("sub"))
        email = str(decoded["email"]).strip().lower()
        auth_time = int(decoded.get("auth_time") or 0)
        if auth_time <= 0:
            return _error("Invalid token", 401)
        body = request.get_json(silent=True) or {}
        requested_email = str(body.get("email", email)).strip().lower()
        if requested_email != email:
            return _error("Email does not match authenticated user", 403)

        challenge_ref = db.collection("otp_challenges").document(uid)
        now = int(time.time())
        code = f"{secrets.randbelow(900000) + 100000:06d}"
        nonce = secrets.token_urlsafe(16)
        challenge_id = secrets.token_hex(16)
        transaction = db.transaction()

        @firestore.transactional
        def store_challenge(active_transaction):
            existing = challenge_ref.get(transaction=active_transaction)
            if existing.exists:
                last_sent_at = _safe_int(
                    (existing.to_dict() or {}).get("lastSentAt", 0)
                )
                retry_after = OTP_RESEND_SECONDS - (now - last_sent_at)
                if retry_after > 0:
                    response = jsonify({
                        "success": False,
                        "message": "Please wait before requesting another OTP",
                        "retryAfter": retry_after,
                    })
                    response.status_code = 429
                    response.headers["Retry-After"] = str(retry_after)
                    return response
            active_transaction.set(challenge_ref, {
                "uid": uid,
                "email": email,
                "authTime": auth_time,
                "codeHash": _otp_digest(secret, uid, nonce, code),
                "nonce": nonce,
                "expiresAt": now + OTP_EXPIRY_SECONDS,
                "attempts": 0,
                "lastSentAt": now,
                "verificationPending": False,
                "challengeId": challenge_id,
                "deliveryState": "pending",
            })
            return None

        try:
            transaction_result = store_challenge(transaction)
        except Exception as error:
            _log_safe_failure("otp_challenge_store_failed", error)
            return _storage_error(error)
        if transaction_result is not None:
            return transaction_result

        def cleanup_failed_attempt() -> None:
            try:
                _cleanup_pending_challenge(db, challenge_ref, challenge_id)
            except Exception as cleanup_error:
                category = classify_firestore_error(cleanup_error)
                _log_safe_failure(
                    f"otp_challenge_cleanup_{category}", cleanup_error
                )

        try:
            _send_emailjs_otp(email, code)
        except EmailDeliveryFailure as failure:
            _log_email_failure(failure)
            cleanup_failed_attempt()
            return _delivery_error(failure)
        except Exception as error:
            failure = _delivery_failure("operation_failed", error=error)
            _log_email_failure(failure)
            cleanup_failed_attempt()
            return _delivery_error(failure)

        try:
            activated = _activate_pending_challenge(
                db, challenge_ref, challenge_id
            )
        except Exception as error:
            _log_safe_failure("otp_challenge_activate_failed", error)
            cleanup_failed_attempt()
            return _storage_error(error)
        if not activated:
            cleanup_failed_attempt()
            return _error(
                "OTP service unavailable", 503, "otp_storage_operation_failed"
            )

        return jsonify({"success": True, "message": "OTP sent successfully"})

    @blueprint.post("/api/auth/otp/verify")
    def verify_otp():
        decoded, auth_error = _authenticate(firebase_app)
        if auth_error:
            return auth_error
        if db is None:
            return _error(
                "OTP service unavailable", 503, "otp_storage_client_unavailable"
            )

        secret = os.environ.get("OTP_HMAC_SECRET", "").strip()
        if len(secret) < 32:
            return _error("OTP service unavailable", 503, "otp_hmac_unavailable")

        body = request.get_json(silent=True) or {}
        code = str(body.get("code", "")).strip()
        if len(code) != 6 or not code.isdigit():
            return _error("Enter a valid 6-digit OTP", 400)

        uid = str(decoded.get("uid") or decoded.get("sub"))
        auth_time = int(decoded.get("auth_time") or 0)
        challenge_ref = db.collection("otp_challenges").document(uid)
        transaction = db.transaction()
        now = int(time.time())

        @firestore.transactional
        def check_challenge(active_transaction):
            snapshot = challenge_ref.get(transaction=active_transaction)
            if not snapshot.exists:
                return _error("No OTP found. Please request a new one.", 404)

            challenge = snapshot.to_dict() or {}
            if "deliveryState" in challenge:
                if challenge.get("deliveryState") != "active":
                    active_transaction.delete(challenge_ref)
                    return _error(
                        "No active OTP found. Please request a new one.", 409
                    )
            elif not _legacy_challenge_is_structurally_valid(challenge, uid):
                active_transaction.delete(challenge_ref)
                return _error(
                    "No active OTP found. Please request a new one.", 409
                )

            if auth_time <= 0 or _safe_int(challenge.get("authTime", 0)) != auth_time:
                active_transaction.delete(challenge_ref)
                return _error("OTP belongs to another sign-in session. Request a new one.", 409)
            if now > _safe_int(challenge.get("expiresAt", 0)):
                active_transaction.delete(challenge_ref)
                return _error("OTP expired. Please request a new one.", 410)

            attempts = _safe_int(challenge.get("attempts", 0))
            if attempts >= OTP_MAX_ATTEMPTS:
                active_transaction.delete(challenge_ref)
                return _error("Too many attempts. Please request a new OTP.", 429)

            expected = str(challenge.get("codeHash", ""))
            actual = _otp_digest(secret, uid, str(challenge.get("nonce", "")), code)
            if not hmac.compare_digest(expected, actual):
                attempts += 1
                if attempts >= OTP_MAX_ATTEMPTS:
                    active_transaction.delete(challenge_ref)
                else:
                    active_transaction.update(challenge_ref, {"attempts": attempts})
                if attempts >= OTP_MAX_ATTEMPTS:
                    return _error("Too many attempts. Please request a new OTP.", 429)
                return _error("Invalid OTP. Please try again.", 401)

            active_transaction.update(challenge_ref, {"verificationPending": True})
            return None

        try:
            transaction_result = check_challenge(transaction)
        except Exception as error:
            _log_safe_failure("otp_challenge_verify_failed", error)
            return _storage_error(error)
        if transaction_result is not None:
            return transaction_result

        try:
            user_record = firebase_auth.get_user(uid, app=firebase_app)
            claims = dict(user_record.custom_claims or {})
            firebase_auth.update_user(uid, email_verified=True, app=firebase_app)
            claims["otp_auth_time"] = auth_time
            firebase_auth.set_custom_user_claims(uid, claims, app=firebase_app)
        except Exception:
            return _error("Unable to complete verification. Please try again.", 503)

        challenge_ref.delete()
        return jsonify({
            "success": True,
            "message": "Email verified successfully",
            "refreshToken": True,
        })

    return blueprint
