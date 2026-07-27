import os
from dataclasses import dataclass
from typing import Any

import jwt
from fastapi import Header, HTTPException
from jwt import InvalidTokenError


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


def _extract_user_id(claims: dict[str, Any]) -> str | None:
    data_user_id = claims.get("data", {}).get("user", {}).get("id") if isinstance(claims.get("data"), dict) else None
    user_id = data_user_id or claims.get("user_id") or claims.get("sub") or claims.get("id")
    return str(user_id) if user_id is not None and str(user_id) else None


def verify_jwt(token: str) -> CurrentUser:
    secret = os.getenv("WP_JWT_SECRET")
    if not secret:
        raise _unauthorized()

    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            options={
                "require": ["exp"],
                "verify_aud": False,
                "verify_iat": False,
                "verify_iss": False,
                "verify_nbf": False,
            },
        )
    except InvalidTokenError:
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
