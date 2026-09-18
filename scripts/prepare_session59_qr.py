#!/usr/bin/env python3
"""Session 59 QR Generation & Pairing Helper.

Calls get_session_qr for Session 59 (status: RELINK_REQUIRED).
Triggers the ephemeral pairing fallback and saves the resulting QR PNG.
"""
import asyncio
import base64
import json
import os
import sys
from uuid import UUID

from backend.app.core.database import AsyncSessionLocal
from backend.app.services import whatsapp_service

USER_ID = "f65642ab-4ae5-4d69-945c-8f30c8454bac"
SESSION_ID = 59
QR_OUTPUT_PATH = "/tmp/session59_qr.png"


async def main():
    async with AsyncSessionLocal() as db:
        print(f"[FETCH_QR] Requesting QR for Session {SESSION_ID} (User {USER_ID})...")
        qr_res = await whatsapp_service.get_session_qr(db, user_id=USER_ID, session_id=SESSION_ID)
        
        status = qr_res.get("status")
        qr_code = qr_res.get("qr_code")
        phone = qr_res.get("phone")
        print(f"[RESPONSE] status={status}, phone={phone}, has_qr={bool(qr_code)}")
        
        # If QR not returned immediately, poll up to 10s or refresh
        if not qr_code and status != "CONNECTED":
            print("[POLL] Waiting for QR code generation from gateway...")
            for attempt in range(1, 11):
                await asyncio.sleep(1)
                qr_res = await whatsapp_service.get_session_qr(db, user_id=USER_ID, session_id=SESSION_ID)
                status = qr_res.get("status")
                qr_code = qr_res.get("qr_code")
                if qr_code:
                    print(f"[POLL #{attempt}] QR code received!")
                    break
        
        if qr_code and qr_code.startswith("data:image/png;base64,"):
            b64_data = qr_code.split(",", 1)[1]
            with open(QR_OUTPUT_PATH, "wb") as f:
                f.write(base64.b64decode(b64_data))
            print(f"[SAVED] QR PNG saved to {QR_OUTPUT_PATH} ({os.path.getsize(QR_OUTPUT_PATH)} bytes)")
        
        output = {
            "session_id": SESSION_ID,
            "status": status,
            "phone": phone,
            "has_qr": bool(qr_code),
            "qr_output_path": QR_OUTPUT_PATH if (qr_code and os.path.exists(QR_OUTPUT_PATH)) else None,
        }
        print(json.dumps(output, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
