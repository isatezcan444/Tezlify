"""Session persistence repository.

Read-only and persistence queries for WhatsApp sessions.
DOES NOT own transaction lifecycle (no commit/rollback).
"""

from typing import List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import get_user_filter
from backend.app.models.conversation import Conversation
from backend.app.models.whatsapp_session import SessionStatus, WhatsAppSession
from backend.app.services.whatsapp.exceptions import EventOwnerUnresolved, NoWhatsAppSession


async def get_user_sessions(
    db: AsyncSession, user_id: str, connected_only: bool = True
) -> List[WhatsAppSession]:
    """Kullanicinin WhatsApp hatlari (varsayilan: yalnizca BAGLI olanlar)."""
    stmt = select(WhatsAppSession).where(get_user_filter(WhatsAppSession.user_id, user_id))
    if connected_only:
        stmt = stmt.where(WhatsAppSession.status == SessionStatus.CONNECTED)
    res = await db.execute(stmt.order_by(WhatsAppSession.updated_at.desc()))
    return list(res.scalars().all())


async def get_session_by_id(
    db: AsyncSession, user_id: str, session_id: int
) -> WhatsAppSession:
    """Tek bir oturumu ID ile getirir; yoksa LookupError."""
    stmt = select(WhatsAppSession).where(
        WhatsAppSession.id == session_id,
        get_user_filter(WhatsAppSession.user_id, user_id),
    )
    res = await db.execute(stmt)
    row = res.scalar_one_or_none()
    if not row:
        raise LookupError("WhatsApp oturumu bulunamadi.")
    return row


async def require_user_session(
    db: AsyncSession, user_id: str, session_id: Optional[int] = None
) -> WhatsAppSession:
    """Tek bir hat cozer: verilen `session_id` (sahiplik dogrulanarak) ya da
    kullanicinin bagli hatti. Hic yoksa `NoWhatsAppSession` (sahte basari yok).
    """
    if session_id is not None:
        row = await db.scalar(
            select(WhatsAppSession).where(
                WhatsAppSession.id == session_id,
                get_user_filter(WhatsAppSession.user_id, user_id),
            )
        )
        if row is not None:
            return row
    sessions = await get_user_sessions(db, user_id, connected_only=True)
    if sessions:
        return sessions[0]
    raise NoWhatsAppSession(
        "Bagli bir WhatsApp hatti yok. Lutfen once QR ile eslestirin."
    )


async def conversation_gateway_id(
    db: AsyncSession, user_id: str, conv: Conversation
) -> str:
    """Sohbetin ait oldugu hattin gateway kimligi."""
    row = await require_user_session(db, user_id, conv.session_id)
    return str(row.gateway_id)


async def conversation_session(
    db: AsyncSession, user_id: str, conv: Conversation
) -> WhatsAppSession:
    """Sohbetin ait oldugu kullanici oturum kaydi."""
    return await require_user_session(db, user_id, conv.session_id)


async def resolve_event_owner_and_session(
    db: AsyncSession, jid: str, gw_session_id: Optional[str] = None
) -> Tuple[str, Optional[int]]:
    """Olayin sahibi (user_id) ve backend oturum id'sini (WhatsAppSession.id)
    tek bir SQL sorgusuyla cozer. 2 ayri SELECT tur-donusunu ortadan kaldirir.
    """
    if gw_session_id:
        res = await db.execute(
            select(WhatsAppSession.user_id, WhatsAppSession.id).where(
                WhatsAppSession.gateway_id == str(gw_session_id)
            )
        )
        row = res.first()
        if row and row[0]:
            return str(row[0]), int(row[1]) if row[1] is not None else None
        raise EventOwnerUnresolved(
            f"Bilinmeyen gateway oturumu (session_id={gw_session_id}, jid={jid})"
        )
    owner = await resolve_event_owner(db, jid, None)
    return owner, None


async def resolve_event_session_id(
    db: AsyncSession, gw_session_id: Optional[str]
) -> Optional[int]:
    """Olayin geldigi gateway oturumunun BACKEND satir id'si."""
    if not gw_session_id:
        return None
    row_id = await db.scalar(
        select(WhatsAppSession.id).where(WhatsAppSession.gateway_id == str(gw_session_id))
    )
    return int(row_id) if row_id is not None else None


async def resolve_event_owner(
    db: AsyncSession, jid: str, gw_session_id: Optional[str] = None
) -> str:
    """Gateway olayinin sahibi (tenant user_id) — KESIN cozum, tahmin yok."""
    if gw_session_id:
        owner = await db.scalar(
            select(WhatsAppSession.user_id).where(
                WhatsAppSession.gateway_id == str(gw_session_id)
            )
        )
        if owner:
            return str(owner)
        raise EventOwnerUnresolved(
            f"Bilinmeyen gateway oturumu (session_id={gw_session_id}, jid={jid})"
        )

    rows = (
        await db.execute(
            select(WhatsAppSession.user_id).where(
                WhatsAppSession.status == SessionStatus.CONNECTED
            )
        )
    ).all()
    owners = {str(r[0]) for r in rows if r[0]}
    if len(owners) == 1:
        return next(iter(owners))
    raise EventOwnerUnresolved(
        "Olay session_id tasimiyor ve sahibi tek anlamli degil "
        f"(bagli tenant sayisi={len(owners)}, jid={jid})"
    )
