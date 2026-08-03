"""Secret-safe Firebase Admin initialization.

Credentials are supplied by Application Default Credentials. In hosted runtimes,
GOOGLE_APPLICATION_CREDENTIALS may point to a securely mounted secret file; this
module never opens, copies, logs, or serializes that credential material.
"""

from dataclasses import dataclass

import firebase_admin
from firebase_admin import firestore


@dataclass(frozen=True)
class FirebaseServices:
    """Firebase service handles and a sanitized readiness classification."""

    app: object | None
    db: object | None
    error_code: str | None = None

    @property
    def auth_ready(self):
        return self.app is not None


def _log_safe_failure(event, error):
    """Log an allowlisted event and exception class, never exception text."""
    print("[WARN] %s (%s)" % (event, type(error).__name__))


def initialize_firebase_services(project_id=None):
    """Initialize or reuse the default Firebase app through ADC.

    Authentication readiness is independent from Firestore readiness: a storage
    client failure preserves the initialized app so protected requests can still
    be verified and then fail according to their route's storage behavior.
    """
    try:
        try:
            app = firebase_admin.get_app()
        except ValueError:
            options = {"projectId": project_id} if project_id else None
            app = firebase_admin.initialize_app(options=options)
    except Exception as error:
        _log_safe_failure("firebase_admin_initialization_failed", error)
        return FirebaseServices(
            app=None,
            db=None,
            error_code="firebase_admin_initialization_failed",
        )

    try:
        db = firestore.client(app=app)
    except Exception as error:
        if type(error).__name__ == "DefaultCredentialsError":
            _log_safe_failure("firebase_admin_credentials_unavailable", error)
            return FirebaseServices(
                app=None,
                db=None,
                error_code="firebase_admin_credentials_unavailable",
            )
        _log_safe_failure("firestore_initialization_failed", error)
        db = None

    return FirebaseServices(app=app, db=db)
