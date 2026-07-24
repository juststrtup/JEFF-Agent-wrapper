import httpx
import asyncio
import os
import sys

BASE_URL = os.getenv("BASE_URL", "http://127.0.0.1:8000")
AUTH_HEADER = os.getenv("AUTH_HEADER")


def headers():
    return {"Authorization": AUTH_HEADER} if AUTH_HEADER else None

async def test_health():
    print("Testing /health...")
    async with httpx.AsyncClient() as client:
        r = await client.get(f"{BASE_URL}/health")
        assert r.status_code == 200
        print("PASS /health")

async def test_invalid_mode():
    print("Testing /chat with invalid mode...")
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/chat", json={"message": "Hi", "mode": "invalid"}, headers=headers())
        assert r.status_code == 422
        assert "Invalid mode" in r.text
        print("PASS invalid mode 422")

async def test_campaign_builder():
    print("Testing /chat with campaign_builder mode, streaming, and headers...")
    async with httpx.AsyncClient(timeout=30.0) as client:
        async with client.stream("POST", f"{BASE_URL}/chat", json={"message": "Hi Jeff", "mode": "campaign_builder", "session_id": "test_sess_1"}, headers=headers()) as r:
            assert r.status_code == 200, f"Expected 200 OK, got {r.status_code}"
            assert "x-tokens-remaining" in r.headers, "Missing X-Tokens-Remaining header"
            assert "x-tokens-reset" in r.headers, "Missing X-Tokens-Reset header"
            assert "x-session-id" in r.headers, "Missing X-Session-Id header"
            print(f"   X-Tokens-Remaining: {r.headers['x-tokens-remaining']}")
            
            content = ""
            async for chunk in r.aiter_text():
                content += chunk
            print(f"   Stream output length: {len(content)}")
            print("PASS proxy, streaming, and token headers")

async def test_exports():
    print("Testing /export/xlsx...")
    structured_payload = {
        "payload": {
            "summary": "Demo export",
            "rows": [
                {"metric": "MRR", "value": 12000},
                {"metric": "Burn", "value": 5000},
            ],
        },
        "filename": "test",
        "title": "Test Export",
    }
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/export/xlsx", json=structured_payload, headers=headers())
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        assert len(r.content) > 0
        print("PASS /export/xlsx")

    print("Testing /export/pdf...")
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{BASE_URL}/export/pdf", json=structured_payload, headers=headers())
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/pdf")
        assert len(r.content) > 0
        print("PASS /export/pdf")

async def main():
    try:
        await test_health()
        await test_invalid_mode()
        await test_campaign_builder()
        await test_exports()
        print("\nALL TESTS PASSED")
    except Exception as e:
        print(f"\nTEST FAILED: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
