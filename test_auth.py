import asyncio
import base64
import hashlib
import hmac
import json
import os
import time

from fastapi import HTTPException

from auth import get_current_user, verify_jwt


def b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token(user_id: str = "123", exp: int | None = None, secret: str = "test-secret") -> str:
    header = {"typ": "JWT", "alg": "HS256"}
    payload = {"data": {"user": {"id": user_id}}, "exp": exp or int(time.time()) + 60}
    signing_input = ".".join(
        [
            b64encode(json.dumps(header, separators=(",", ":")).encode()),
            b64encode(json.dumps(payload, separators=(",", ":")).encode()),
        ]
    )
    signature = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return f"{signing_input}.{b64encode(signature)}"


async def main() -> None:
    os.environ["WP_JWT_SECRET"] = "test-secret"
    os.environ["REQUIRE_AUTH"] = "true"

    assert verify_jwt(token("42")).user_id == "42"

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
