import asyncio
import json
import urllib.request
from uuid import UUID
from backend.app.core.database import AsyncSessionLocal
from backend.app.auth.application.session_service import SessionService

async def main():
    async with AsyncSessionLocal() as db:
        svc = SessionService()
        sess, raw_token = await svc.create_session(db, UUID("f65642ab-4ae5-4d69-945c-8f30c8454bac"), ttl_days=1)
        await db.commit()

    headers = {"Authorization": "Bearer " + raw_token}
    req = urllib.request.Request("http://127.0.0.1:8000/api/v1/whatsapp/conversations?limit=300", headers=headers)
    with urllib.request.urlopen(req) as resp:
        content = resp.read().decode("utf-8")
        data = json.loads(content)

    items = data.get("items", [])
    total_val = data.get("total", 0)
    print("REAL_API_TOTAL:", total_val)
    print("REAL_API_ITEMS_LEN:", len(items))

    with open("/tmp/real_conversations_api.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print("WROTE_TO_TMP_JSON")

    async with AsyncSessionLocal() as db:
        await svc.revoke_session(db, raw_token)
        await db.commit()
    print("REVOKED_AUTH_TOKEN")

if __name__ == "__main__":
    asyncio.run(main())
