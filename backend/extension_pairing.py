"""One-time pairing flow for a refreshable Chrome extension Firebase session."""

from functools import wraps
import hashlib
import secrets
import time

from firebase_admin import auth as firebase_auth
from flask import Blueprint, g, jsonify, request

from auth_policy import has_current_otp_proof


PAIRING_TTL_SECONDS = 300
PAIRING_COLLECTION = "extension_pairings"


class PairingCodeError(Exception):
    """A pairing code is invalid, expired, or already consumed."""


class FirestorePairingStore:
    def __init__(self, database, now=time.time):
        self.database = database
        self.now = now

    @staticmethod
    def _document_id(code):
        return hashlib.sha256(code.encode("utf-8")).hexdigest()

    def create(self, uid):
        code = secrets.token_urlsafe(24)
        self.database.collection(PAIRING_COLLECTION).document(
            self._document_id(code)
        ).set({
            "uid": uid,
            "expiresAt": int(self.now()) + PAIRING_TTL_SECONDS,
        })
        return code

    def consume(self, code):
        reference = self.database.collection(PAIRING_COLLECTION).document(
            self._document_id(code)
        )
        transaction = self.database.transaction()
        snapshot = reference.get(transaction=transaction)
        data = snapshot.to_dict() if snapshot.exists else None
        if not data or int(data.get("expiresAt", 0)) < int(self.now()):
            raise PairingCodeError()
        uid = str(data.get("uid") or "")
        if not uid:
            raise PairingCodeError()
        transaction.delete(reference)
        transaction.commit()
        return uid


def create_extension_pairing_blueprint(database, firebase_app=None, pairing_store=None):
    blueprint = Blueprint("extension_pairing", __name__)
    store = pairing_store or (FirestorePairingStore(database) if database is not None else None)

    def require_current_user(handler):
        @wraps(handler)
        def wrapped(*args, **kwargs):
            header = request.headers.get("Authorization", "")
            if not header.startswith("Bearer ") or not header[7:].strip():
                return jsonify({"success": False, "message": "Authentication required"}), 401
            if firebase_app is None:
                return jsonify({"success": False, "message": "Authentication service unavailable"}), 503
            try:
                decoded = firebase_auth.verify_id_token(
                    header[7:].strip(), app=firebase_app, check_revoked=True
                )
            except Exception:
                return jsonify({"success": False, "message": "Invalid or expired token"}), 401
            uid = decoded.get("uid") or decoded.get("sub")
            if not uid:
                return jsonify({"success": False, "message": "Invalid token"}), 401
            if not has_current_otp_proof(decoded):
                return jsonify({"success": False, "message": "Current OTP verification required"}), 403
            g.auth_uid = str(uid)
            return handler(*args, **kwargs)

        return wrapped

    @blueprint.post("/api/auth/extension/pair")
    @require_current_user
    def create_pairing_code():
        if store is None:
            return jsonify({"success": False, "message": "Pairing service unavailable"}), 503
        try:
            code = store.create(g.auth_uid)
        except Exception:
            return jsonify({"success": False, "message": "Unable to create pairing code"}), 503
        return jsonify({
            "success": True,
            "pairingCode": code,
            "expiresIn": PAIRING_TTL_SECONDS,
        })

    @blueprint.post("/api/auth/extension/redeem")
    def redeem_pairing_code():
        if store is None or firebase_app is None:
            return jsonify({"success": False, "message": "Pairing service unavailable"}), 503
        body = request.get_json(silent=True)
        code = str(body.get("pairingCode") or "").strip() if isinstance(body, dict) else ""
        if not code or len(code) > 128:
            return jsonify({"success": False, "message": "Invalid or expired pairing code"}), 400
        try:
            uid = store.consume(code)
            custom_token = firebase_auth.create_custom_token(
                uid,
                developer_claims={"extension_session": True},
                app=firebase_app,
            )
        except PairingCodeError:
            return jsonify({"success": False, "message": "Invalid or expired pairing code"}), 400
        except Exception:
            return jsonify({"success": False, "message": "Unable to redeem pairing code"}), 503
        if isinstance(custom_token, bytes):
            custom_token = custom_token.decode("utf-8")
        return jsonify({"success": True, "customToken": custom_token})

    return blueprint
