import asyncio
import os
import sys
import time
from pathlib import Path

import jwt
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from auth import get_current_user, verify_jwt


def token(user_id: str = "123", exp: int | None = None, secret: str = "test-secret", **claims) -> str:
    payload = {"data": {"user": {"id": user_id}}, "exp": exp or int(time.time()) + 60, **claims}
    return jwt.encode(payload, secret, algorithm="HS256")


async def main() -> None:
    os.environ["WP_JWT_SECRET"] = "test-secret"
    os.environ["REQUIRE_AUTH"] = "true"

    assert verify_jwt(token("42")).user_id == "42"
    assert verify_jwt(token("43", aud="ignored", nbf=int(time.time()) + 60)).user_id == "43"

    try:
        verify_jwt(token("42", secret="wrong-secret"))
        raise AssertionError("invalid signature accepted")
    except HTTPException as exc:
        assert exc.status_code == 401

    try:
        verify_jwt(token("42", exp=int(time.time()) - 1))
        raise AssertionError("expired token accepted")
    except HTTPException as exc:
        assert exc.status_code == 401

    try:
        await get_current_user()
        raise AssertionError("missing auth accepted")
    except HTTPException as exc:
        assert exc.status_code == 401

    assert (await get_current_user(f"Bearer {token('99')}")).user_id == "99"

    os.environ["REQUIRE_AUTH"] = "false"
    assert (await get_current_user()).user_id == ""


if __name__ == "__main__":
    asyncio.run(main())
