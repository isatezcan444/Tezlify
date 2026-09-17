"""Phase 13.1 Production Avatar Diagnostic & Verification Script.

Audit real production avatars for Session 50 (115+ conversations):
1. Measures:
   - total conversations
   - conversations with avatar URL
   - successful HTTP image loads (200 OK)
   - failed image loads (404/403/expired)
   - group conversations
   - no-avatar contacts
2. Verifies at least 20 avatars with URL -> HTTP response -> content-length evidence.
3. For any failed/stale URLs, triggers POST /api/v1/whatsapp/contacts/{phone}/avatar/refresh to verify the refresh mechanism.
"""
import asyncio
import httpx
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.auth_helper import get_ephemeral_auth_token

BASE_URL = os.environ.get("TARGET_URL", "https://130.162.247.20.sslip.io")
TOKEN = get_ephemeral_auth_token()


async def main():
    headers = {"Authorization": f"Bearer {TOKEN}"}
    async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
        # 1. Fetch all conversations
        res = await client.get(f"{BASE_URL}/api/v1/whatsapp/conversations?limit=200", headers=headers)
        if res.status_code != 200:
            print(f"Error fetching conversations: {res.status_code} {res.text}")
            sys.exit(1)

        data = res.json()
        items = data.get("items", [])
        total = data.get("total", len(items))
        print(f"Total conversations reported: {total} (fetched: {len(items)})")

        total_conversations = len(items)
        has_avatar = []
        no_avatar = []
        groups = []

        for c in items:
            is_group = bool(c.get("is_group")) or str(c.get("phone", "")).endswith("@g.us")
            if is_group:
                groups.append(c)
            avatar_url = c.get("avatar_url")
            if avatar_url:
                has_avatar.append(c)
            else:
                no_avatar.append(c)

        print(f"\nBreakdown:")
        print(f"  - Total conversations analyzed: {total_conversations}")
        print(f"  - Group conversations: {len(groups)}")
        print(f"  - Conversations with avatar URL: {len(has_avatar)}")
        print(f"  - Conversations without avatar (initials fallback): {len(no_avatar)}")

        # 2. Test HTTP image loading on avatars
        print(f"\nTesting HTTP loading on {len(has_avatar)} avatar URLs...")
        success_loads = []
        failed_loads = []

        for idx, c in enumerate(has_avatar, 1):
            url = c["avatar_url"]
            phone = c.get("phone", "unknown")
            name = c.get("name") or phone
            try:
                img_res = await client.get(url, timeout=10.0)
                if img_res.status_code == 200:
                    content_type = img_res.headers.get("content-type", "")
                    content_len = len(img_res.content)
                    success_loads.append({
                        "idx": idx,
                        "name": name,
                        "phone": phone,
                        "url": url,
                        "status": img_res.status_code,
                        "content_type": content_type,
                        "bytes": content_len,
                    })
                else:
                    failed_loads.append({
                        "idx": idx,
                        "name": name,
                        "phone": phone,
                        "url": url,
                        "status": img_res.status_code,
                        "reason": img_res.reason_phrase,
                    })
            except Exception as e:
                failed_loads.append({
                    "idx": idx,
                    "name": name,
                    "phone": phone,
                    "url": url,
                    "status": "EXCEPTION",
                    "reason": str(e),
                })

        print(f"\nHTTP Load Results:")
        print(f"  - Successful image loads (200 OK): {len(success_loads)}")
        print(f"  - Failed image loads (stale/expired/error): {len(failed_loads)}")

        print("\n--- Evidence of at least 20 Successfully Rendered Avatars ---")
        for item in success_loads[:25]:
            print(f"[{item['idx']:02d}] {item['name'][:22]:<22} | Phone: {item['phone']} | Status: {item['status']} | Size: {item['bytes']} B | URL: {item['url'][:65]}...")

        if failed_loads:
            print("\n--- Failed / Stale Avatar URLs Detected ---")
            for item in failed_loads:
                print(f"  [FAILED] {item['name']} ({item['phone']}): HTTP {item['status']} - {item['url']}")

            print("\nTesting Refresh Mechanism on Stale Avatars...")
            for item in failed_loads:
                phone = item["phone"]
                print(f"Triggering refresh for phone: {phone}...")
                ref_res = await client.post(f"{BASE_URL}/api/v1/whatsapp/contacts/{phone}/avatar/refresh", headers=headers)
                print(f"Refresh response ({ref_res.status_code}): {ref_res.text}")

        print("\n==========================================")
        print(f"Avatar Verification Metric: {len(success_loads)}/{len(has_avatar)} successful ({len(success_loads)/max(1, len(has_avatar))*100:.1f}%)")
        print("==========================================")


if __name__ == "__main__":
    asyncio.run(main())
