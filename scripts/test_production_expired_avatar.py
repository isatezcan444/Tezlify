"""Phase 13.2 Controlled Expired Avatar Refresh Test.

Tests the full stale avatar recovery pipeline on production:
1. Records existing avatar URL.
2. Injects a stale/expired avatar URL into contact's custom_attributes in DB.
3. Calls live POST /api/v1/whatsapp/contacts/{phone}/avatar/refresh.
4. Verifies:
   - res.status_code == 200 and data["success"] is True
   - OLD_STALE_URL != NEW_URL
   - NEW_URL returns HTTP 200 OK with valid image/jpeg
   - DB contact.custom_attributes["avatar_url"] is updated to NEW_URL
   - No permanent invalid avatar data is left behind.
"""
import asyncio
import httpx
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.auth_helper import get_ephemeral_auth_token

BASE_URL = os.environ.get("TARGET_URL", "https://130.162.247.20.sslip.io")
SSH_KEY = os.path.expanduser("~/.ssh/id_tezlify_oracle")
ORACLE_HOST = "ubuntu@130.162.247.20"
TEST_PHONE = "+905413749073"
USER_ID = "f65642ab-4ae5-4d69-945c-8f30c8454bac"


def run_psql(sql: str) -> str:
    cmd = [
        "ssh", "-i", SSH_KEY, "-o", "StrictHostKeyChecking=no", ORACLE_HOST,
        f"docker exec -i tezlify-db psql -U tezlify -d tezlify -t -c \"{sql}\""
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"PSQL execution error: {res.stderr}")
    return res.stdout.strip()


async def main():
    print("=================================================================")
    print("STARTING TEST-AVATAR-REFRESH-01: CONTROLLED EXPIRED AVATAR TEST")
    print("=================================================================\n")

    # 1. Get current avatar URL from DB
    raw_attrs = run_psql(f"SELECT custom_attributes FROM public.contacts WHERE phone_e164 = '{TEST_PHONE}' AND user_id = '{USER_ID}';")
    current_url = None
    if raw_attrs and raw_attrs != "":
        try:
            attrs = json.loads(raw_attrs)
            current_url = attrs.get("avatar_url")
        except Exception:
            pass

    print(f"[1] Initial avatar URL in DB: {current_url[:50] if current_url else 'None'}...")

    # 2. Inject stale/expired URL into DB
    stale_url = "https://pps.whatsapp.net/v/t61.24694-24/expired_token_mock_test_403.jpg"
    print(f"[2] Injecting controlled stale avatar URL: {stale_url}")
    run_psql(f"""
        UPDATE public.contacts
        SET custom_attributes = jsonb_set(COALESCE(custom_attributes::jsonb, '{{}}'::jsonb), '{{avatar_url}}', to_jsonb('{stale_url}'::text))::json
        WHERE phone_e164 = '{TEST_PHONE}' AND user_id = '{USER_ID}';
    """)

    # Verify DB has stale URL
    check_stale = run_psql(f"SELECT custom_attributes->>'avatar_url' FROM public.contacts WHERE phone_e164 = '{TEST_PHONE}' AND user_id = '{USER_ID}';")
    assert check_stale == stale_url, f"Expected {stale_url}, got {check_stale}"
    print(f"  - Confirmed DB contains stale URL: {check_stale}")

    # 3. Call live refresh endpoint
    token = get_ephemeral_auth_token(USER_ID)
    headers = {"Authorization": f"Bearer {token}"}
    print(f"\n[3] Calling POST /api/v1/whatsapp/contacts/{TEST_PHONE}/avatar/refresh...")

    async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
        res = await client.post(f"{BASE_URL}/api/v1/whatsapp/contacts/{TEST_PHONE}/avatar/refresh", headers=headers)
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        print(f"  - Refresh response: success={data.get('success')}, phone={data.get('phone')}")
        assert data.get("success") is True, f"Refresh failed: {data}"
        new_url = data.get("avatar_url")
        assert new_url is not None, "avatar_url must not be None"
        assert new_url != stale_url, f"NEW URL must not equal stale URL: {new_url}"
        print(f"  - Fresh Avatar URL returned: {new_url[:65]}...")

        # 4. Verify HTTP 200 on new image URL
        print("\n[4] Validating fresh image HTTP response...")
        img_res = await client.get(new_url)
        assert img_res.status_code == 200, f"Fresh avatar returned {img_res.status_code}"
        assert "image/" in img_res.headers.get("content-type", ""), f"Invalid content-type: {img_res.headers.get('content-type')}"
        content_len = len(img_res.content)
        assert content_len > 500, f"Image size too small: {content_len} bytes"
        print(f"  - Image load SUCCESS: HTTP 200 OK, Type={img_res.headers.get('content-type')}, Size={content_len} bytes")

    # 5. Verify DB was updated with fresh URL
    print("\n[5] Verifying DB contact.custom_attributes was persisted with fresh URL...")
    db_updated_url = run_psql(f"SELECT custom_attributes->>'avatar_url' FROM public.contacts WHERE phone_e164 = '{TEST_PHONE}' AND user_id = '{USER_ID}';")
    assert db_updated_url == new_url, f"DB url ({db_updated_url}) != new_url ({new_url})"
    print(f"  - Confirmed DB updated: {db_updated_url[:65]}...")

    print("\n=================================================================")
    print("TEST-AVATAR-REFRESH-01: 100% PASSED WITH LIVE EVIDENCE!")
    print("=================================================================")


if __name__ == "__main__":
    asyncio.run(main())
