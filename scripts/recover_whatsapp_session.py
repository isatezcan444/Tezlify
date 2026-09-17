#!/usr/bin/env python3
"""WhatsApp Logical Session Recovery Runner (Phase 15.4+).

Executes application-level recovery of an orphaned WhatsApp gateway session:
- Detects orphaned gateway evidence in database.
- Verifies user ownership and phone lineage.
- Idempotently creates or reuses the permanent logical session row in public.whatsapp_sessions.
- Preserves all history sync states and provider evidence untouched.
- Outputs structured JSON results.
"""
import argparse
import asyncio
import json
import logging
import sys

from backend.app.core.database import AsyncSessionLocal
from backend.app.services.whatsapp.orchestration.recovery import (
    OrphanRecoveryError,
    detect_orphaned_gateway_lineages,
    recover_orphan_logical_session,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("whatsapp_recovery_runner")


async def main() -> int:
    parser = argparse.ArgumentParser(description="WhatsApp Logical Session Recovery Runner")
    parser.add_argument(
        "--user-id",
        type=str,
        default="f65642ab-4ae5-4d69-945c-8f30c8454bac",
        help="Target user ID for recovery",
    )
    parser.add_argument(
        "--phone",
        type=str,
        default="+905413749073",
        help="Target phone number (E.164)",
    )
    parser.add_argument(
        "--gateway-id",
        type=str,
        default="7ca58b14-a53e-47bd-b879-b77519f119bc",
        help="Orphan gateway session UUID to recover",
    )
    parser.add_argument(
        "--session-name",
        type=str,
        default="Hat 1",
        help="Logical session name",
    )
    parser.add_argument(
        "--inspect-only",
        action="store_true",
        help="Only inspect and list orphaned gateway sessions without creating rows",
    )
    args = parser.parse_args()

    async with AsyncSessionLocal() as db:
        if args.inspect_only:
            orphans = await detect_orphaned_gateway_lineages(db)
            print(
                json.dumps(
                    {
                        "action": "inspect_orphans",
                        "orphan_count": len(orphans),
                        "orphans": [
                            {
                                "old_gateway_id": o.old_gateway_id,
                                "session_name": o.session_name,
                                "history_state_count": o.history_state_count,
                                "checked_state_count": o.checked_state_count,
                            }
                            for o in orphans
                        ],
                    },
                    indent=2,
                )
            )
            return 0

        try:
            result = await recover_orphan_logical_session(
                db,
                user_id=args.user_id,
                phone=args.phone,
                old_gateway_id=args.gateway_id,
                session_name=args.session_name,
            )
            print(
                json.dumps(
                    {
                        "status": "SUCCESS",
                        "session_id": result.session_id,
                        "user_id": result.user_id,
                        "phone_number": result.phone_number,
                        "session_name": result.session_name,
                        "old_gateway_id": result.old_gateway_id,
                        "history_state_count": result.history_state_count,
                        "session_status": result.status,
                        "was_already_recovered": result.was_already_recovered,
                        "lineage_source": result.lineage_source,
                    },
                    indent=2,
                )
            )
            return 0
        except OrphanRecoveryError as exc:
            logger.error("Recovery failed: %s", exc)
            print(
                json.dumps(
                    {
                        "status": "ERROR",
                        "error_type": exc.__class__.__name__,
                        "error_message": str(exc),
                    },
                    indent=2,
                ),
                file=sys.stderr,
            )
            return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
