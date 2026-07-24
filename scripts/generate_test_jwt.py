import base64
import hashlib
import hmac
import json
import os
import sys
import time


def b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def main() -> None:
    secret = os.getenv("WP_JWT_SECRET")
    if not secret:
        raise SystemExit("WP_JWT_SECRET is required.")

    user_id = sys.argv[1] if len(sys.argv) > 1 else "123"
    header = {"typ": "JWT", "alg": "HS256"}
    payload = {
        "data": {"user": {"id": user_id}},
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
    }
    signing_input = ".".join(
        [
            b64encode(json.dumps(header, separators=(",", ":")).encode()),
            b64encode(json.dumps(payload, separators=(",", ":")).encode()),
        ]
    )
    signature = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    print(f"Bearer {signing_input}.{b64encode(signature)}")


if __name__ == "__main__":
    main()
