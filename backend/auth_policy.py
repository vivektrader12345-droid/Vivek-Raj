"""Shared authorization policy for Firebase-authenticated backend APIs."""


def firebase_sign_in_provider(decoded_token):
    firebase_claims = decoded_token.get("firebase") or {}
    return firebase_claims.get("sign_in_provider")


def has_current_otp_proof(decoded_token):
    """Allow Google sessions or password sessions verified for exact auth_time."""
    provider = firebase_sign_in_provider(decoded_token)
    if provider == "google.com":
        return True
    if provider != "password":
        return False
    try:
        auth_time = int(decoded_token.get("auth_time"))
        otp_auth_time = int(decoded_token.get("otp_auth_time"))
    except (TypeError, ValueError):
        return False
    return auth_time > 0 and otp_auth_time == auth_time
