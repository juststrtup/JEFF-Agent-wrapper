import os
import sys
import time

import jwt


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
    print(f"Bearer {jwt.encode(payload, secret, algorithm=header['alg'], headers=header)}")


if __name__ == "__main__":
    main()
