"""Server-side email OTP challenge issuance and verification."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from typing import Any, Dict, Optional, Tuple

import requests
from firebase_admin import auth as firebase_auth, firestore
from flask import Blueprint, jsonify, request

OTP_EXPIRY_SECONDS = 5 * 60
OTP_RESEND_SECONDS = 60
OTP_MAX_ATTEMPTS = 5
EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send"


def _error(message: str, status: int):
    return jsonify({"success": False, "message": message}), status


def _log_safe_failure(event: str, error: Exception) -> None:
    """Log failure type without leaking credentials, OTPs, or provider responses."""
    print(f"[WARN] {event} ({type(error).__name__})", flush=True)


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


def _send_emailjs_otp(email: str, code: str) -> None:
    service_id = os.environ.get("EMAILJS_SERVICE_ID", "").strip()
    template_id = os.environ.get("EMAILJS_TEMPLATE_ID", "").strip()
    public_key = os.environ.get("EMAILJS_PUBLIC_KEY", "").strip()
    if not service_id or not template_id or not public_key:
        raise RuntimeError("OTP email service is not configured")

    response = requests.post(
        EMAILJS_ENDPOINT,
        json={
            "service_id": service_id,
            "template_id": template_id,
            "user_id": public_key,
            "template_params": {
                "email": email,
                "otp_code": code,
                "app_name": "Vivek Marco Trader",
                "expiry_minutes": str(OTP_EXPIRY_SECONDS // 60),
            },
        },
        timeout=10,
    )
    response.raise_for_status()


def create_otp_blueprint(db, firebase_app=None) -> Blueprint:
    blueprint = Blueprint("otp_auth", __name__)

    @blueprint.post("/api/auth/otp/send")
    def send_otp():
        decoded, auth_error = _authenticate(firebase_app)
        if auth_error:
            return auth_error
        if db is None:
            return _error("OTP service unavailable", 503)

        secret = os.environ.get("OTP_HMAC_SECRET", "").strip()
        if len(secret) < 32:
            return _error("OTP service unavailable", 503)

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
        transaction = db.transaction()

        @firestore.transactional
        def store_challenge(active_transaction):
            existing = challenge_ref.get(transaction=active_transaction)
            if existing.exists:
                last_sent_at = int((existing.to_dict() or {}).get("lastSentAt", 0))
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
            })
            return None

        try:
            transaction_result = store_challenge(transaction)
        except Exception as error:
            _log_safe_failure("otp_challenge_store_failed", error)
            return _error("OTP service unavailable", 503)
        if transaction_result is not None:
            return transaction_result

        try:
            _send_emailjs_otp(email, code)
        except Exception as error:
            _log_safe_failure("otp_email_send_failed", error)
            challenge_ref.delete()
            return _error("Unable to send OTP. Please try again later.", 503)

        return jsonify({"success": True, "message": "OTP sent successfully"})

    @blueprint.post("/api/auth/otp/verify")
    def verify_otp():
        decoded, auth_error = _authenticate(firebase_app)
        if auth_error:
            return auth_error
        if db is None:
            return _error("OTP service unavailable", 503)

        secret = os.environ.get("OTP_HMAC_SECRET", "").strip()
        if len(secret) < 32:
            return _error("OTP service unavailable", 503)

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
            if auth_time <= 0 or int(challenge.get("authTime", 0)) != auth_time:
                active_transaction.delete(challenge_ref)
                return _error("OTP belongs to another sign-in session. Request a new one.", 409)
            if now > int(challenge.get("expiresAt", 0)):
                active_transaction.delete(challenge_ref)
                return _error("OTP expired. Please request a new one.", 410)

            attempts = int(challenge.get("attempts", 0))
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
            return _error("OTP service unavailable", 503)
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
