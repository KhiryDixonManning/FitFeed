# auth.py
"""Firebase authentication for the FitFeed API.

Every protected endpoint derives the caller's uid from a verified Firebase ID
token. A uid supplied in a request body is never trusted, because a browser
can put anything there.

The Admin SDK is initialised lazily and never at import time, so the module
can be imported (and unit-tested) on a machine with no credentials.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
from functools import wraps
from typing import Any, Callable, Optional

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import credentials, firestore as fb_firestore
from flask import g, jsonify, request

log = logging.getLogger(__name__)

_init_attempted = False
_init_ok = False


class AuthError(Exception):
    """Raised internally when a request cannot be authenticated."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def init_firebase_admin() -> bool:
    """Initialise the Admin SDK once. Returns True when usable.

    Credentials come from GOOGLE_CREDENTIALS_JSON (the variable this service
    already uses on Railway) or a local serviceAccountKey.json for development.
    Failure is logged and reported, never raised at import time.
    """
    global _init_attempted, _init_ok

    if firebase_admin._apps:
        _init_ok = True
        return True
    if _init_attempted:
        return _init_ok

    _init_attempted = True

    try:
        creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
        if creds_json:
            cred = credentials.Certificate(json.loads(creds_json))
            firebase_admin.initialize_app(cred)
            log.info("firebase-admin initialised from environment credentials")
            _init_ok = True
            return True

        cred_path = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")
        if os.path.exists(cred_path):
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred)
            log.info("firebase-admin initialised from local service account file")
            _init_ok = True
            return True

        log.error(
            "firebase-admin has no credentials: set GOOGLE_CREDENTIALS_JSON "
            "or provide serviceAccountKey.json. Authenticated endpoints will "
            "return 503."
        )
    except Exception:
        # Never log the credential payload itself.
        log.exception("firebase-admin initialisation failed")

    _init_ok = False
    return False


def get_db():
    """Firestore client, or None when credentials are unavailable."""
    if not init_firebase_admin():
        return None
    return fb_firestore.client()


def _bearer_token() -> str:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise AuthError(401, "missing_token", "Authentication required.")
    token = header[len("Bearer ") :].strip()
    if not token:
        raise AuthError(401, "missing_token", "Authentication required.")
    return token


def verify_request_token() -> dict[str, Any]:
    """Verify the caller's Firebase ID token and return its claims.

    The header is checked before the Admin SDK is touched, so a missing token
    is a clean 401 even in an environment with no credentials configured.
    """
    token = _bearer_token()

    if not init_firebase_admin():
        raise AuthError(503, "auth_unavailable", "Authentication is temporarily unavailable.")

    try:
        return fb_auth.verify_id_token(token)
    except Exception as exc:
        # Log the class only; the token itself is a credential.
        log.warning("ID token rejected: %s", type(exc).__name__)
        raise AuthError(401, "invalid_token", "Invalid or expired credentials.") from exc


def require_auth(fn: Callable) -> Callable:
    """Populate g.uid / g.email from a verified ID token, or reject."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            claims = verify_request_token()
        except AuthError as err:
            return jsonify({"error": err.code, "message": err.message}), err.status

        g.uid = claims.get("uid") or claims.get("sub")
        g.email = claims.get("email")
        g.claims = claims
        if not g.uid:
            return jsonify({"error": "invalid_token", "message": "Invalid credentials."}), 401
        return fn(*args, **kwargs)

    return wrapper


def require_admin(fn: Callable) -> Callable:
    """Gate maintenance endpoints behind a shared secret.

    ADMIN_API_KEY is compared in constant time. When it is unset the endpoint
    reports 404, so an unconfigured deployment does not advertise that a
    maintenance route exists at all.
    """

    @wraps(fn)
    def wrapper(*args, **kwargs):
        expected: Optional[str] = os.environ.get("ADMIN_API_KEY")
        if not expected:
            log.warning("Admin endpoint called but ADMIN_API_KEY is not configured")
            return jsonify({"error": "not_found", "message": "Not found."}), 404

        provided = request.headers.get("X-Admin-Key", "")
        if not provided or not hmac.compare_digest(provided, expected):
            log.warning("Admin endpoint rejected a request with a bad key")
            return jsonify({"error": "forbidden", "message": "Not authorised."}), 403

        return fn(*args, **kwargs)

    return wrapper
