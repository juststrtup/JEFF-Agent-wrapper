import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from typing import Any

from fastapi import Header, HTTPException


@dataclass(frozen=True)
class CurrentUser:
    user_id: str
    claims: dict[str, Any] | None = None


def require_auth() -> bool:
    return os.getenv("REQUIRE_AUTH", "false").lower() == "true"


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail="Invalid or missing authentication token.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _extract_user_id(claims: dict[str, Any]) -> str | None:
    data_user_id = claims.get("data", {}).get("user", {}).get("id") if isinstance(claims.get("data"), dict) else None
    user_id = data_user_id or claims.get("user_id") or claims.get("sub") or claims.get("id")
    return str(user_id) if user_id is not None and str(user_id) else None


def verify_jwt(token: str) -> CurrentUser:
    secret = os.getenv("WP_JWT_SECRET")
    if not secret:
        raise _unauthorized()

    parts = token.split(".")
    if len(parts) != 3:
        raise _unauthorized()

    try:
        header = json.loads(_b64decode(parts[0]))
        claims = json.loads(_b64decode(parts[1]))
    except Exception:
        raise _unauthorized()
    if not isinstance(header, dict) or not isinstance(claims, dict):
        raise _unauthorized()

    if header.get("alg") != "HS256":
        raise _unauthorized()

    signed = f"{parts[0]}.{parts[1]}".encode()
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).digest()
    try:
        signature = _b64decode(parts[2])
    except Exception:
        raise _unauthorized()
    if not hmac.compare_digest(signature, expected):
        raise _unauthorized()

    exp = claims.get("exp")
    try:
        expired = exp is None or int(exp) <= int(time.time())
    except (TypeError, ValueError):
        raise _unauthorized()
    if expired:
        raise _unauthorized()

    user_id = _extract_user_id(claims)
    if not user_id:
        raise _unauthorized()

    return CurrentUser(user_id=user_id, claims=claims)


async def get_current_user(authorization: str | None = Header(default=None)) -> CurrentUser:
    if not require_auth():
        return CurrentUser(user_id="")

    if not isinstance(authorization, str) or not authorization:
        raise _unauthorized()

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise _unauthorized()

    return verify_jwt(token)
