"""Tenant-scoped LID -> phone mapping repository (Phase 4 / G-3).

`whatsapp_private.lid_mappings` is keyed by `(session_id, lid_jid)` where
`session_id` is the *gateway* session UUID (TEXT) -- not the integer
`public.whatsapp_sessions.id` primary key. The table carries **no** `user_id`
column, so the only route from a mapping row to a tenant is:

    whatsapp_private.lid_mappings.session_id
      -> whatsapp_private.gateway_sessions.session_id   (FK, 1:1)
      -> public.whatsapp_sessions.gateway_id            (UNIQUE)
      -> public.whatsapp_sessions.user_id               (tenant)

A LID -> phone pair is a *global WhatsApp protocol fact*: a LID denotes one
account for every tenant. The 2026-09-18 production read-only audit confirmed
it -- 27 `lid_jid` values appear under more than one tenant's gateway session
and `COUNT(DISTINCT phone_jid) = 1` for every one of them.

**A global protocol fact is not the same thing as a globally readable row.**
The row still belongs to exactly one tenant, and a lookup performed on behalf of
tenant A must never read tenant B's row. Resolution order (G-3 protective
model):

  1. the caller's own gateway session             (``gateway_session_id``)
  2. another session belonging to the SAME user   (``user_id``)
  3. NEVER another user -- and never an unowned (orphan) session

Fail-closed: with no ``user_id`` the resolver returns nothing rather than
falling back to a global scan. ``get_user_filter`` is deliberately NOT used for
the tenant predicate: under pytest it additionally accepts ``column IS NULL``,
which would make every orphan row readable by every tenant -- precisely the hole
G-3 closes.
"""

import logging
from typing import Any, Dict, Optional, Sequence

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

_PG_LID_TABLE = "whatsapp_private.lid_mappings"
_PG_SESSION_TABLE = "public.whatsapp_sessions"
_SQLITE_LID_TABLE = "lid_mappings"
_SQLITE_SESSION_TABLE = "whatsapp_sessions"


def _tables(db: AsyncSession) -> "tuple[str, str]":
    """Dialect-aware table references.

    PostgreSQL keeps the gateway tables in the private schema. SQLite (dev and
    test) has no schema support, so the same logical tables are unqualified.
    The previously hardcoded ``whatsapp_private.lid_mappings`` reference raised
    on SQLite and every LID lookup was silently swallowed by a broad
    ``except`` -- i.e. the whole LID branch was dead outside PostgreSQL.
    """
    name = ""
    try:
        bind = db.get_bind()
        name = str(getattr(getattr(bind, "dialect", None), "name", "") or "")
    except Exception:  # pragma: no cover - defensive only
        name = ""
    if name == "postgresql":
        return _PG_LID_TABLE, _PG_SESSION_TABLE
    return _SQLITE_LID_TABLE, _SQLITE_SESSION_TABLE


def _user_predicate(alias: str = "ws") -> str:
    """Tenant predicate binding a session row to exactly one owner.

    Both the canonical hyphenated UUID and its raw hex form are accepted, to
    match how the rest of the codebase compares UUID columns across dialects.
    ``IS NOT NULL`` keeps unowned (orphan) sessions out of every result set.
    """
    col = f"CAST({alias}.user_id AS TEXT)"
    return f"({alias}.user_id IS NOT NULL AND ({col} = :uid OR {col} = :uid_hex))"


def _uid_params(user_id: Any) -> Dict[str, str]:
    raw = str(user_id).strip()
    return {"uid": raw, "uid_hex": raw.replace("-", "")}


async def resolve_lid_phone(
    db: AsyncSession,
    lid_jid: str,
    *,
    user_id: Optional[str],
    gateway_session_id: Optional[str] = None,
) -> Optional[str]:
    """Tenant-scoped single LID -> ``phone_jid`` resolution.

    Returns the mapped ``phone_jid`` (e.g. ``905321110077@s.whatsapp.net``) or
    ``None``. Never raises: an unresolvable LID must degrade to "unresolved",
    not to a 500 and never to a cross-tenant guess.
    """
    if not lid_jid or not user_id:
        return None
    lid = str(lid_jid).strip()
    if not lid:
        return None

    lid_tbl, sess_tbl = _tables(db)
    sql = (
        f"SELECT lm.phone_jid FROM {lid_tbl} lm "
        f"JOIN {sess_tbl} ws ON ws.gateway_id = lm.session_id "
        f"WHERE lm.lid_jid = :lid AND {_user_predicate('ws')} "
        "ORDER BY (lm.session_id = :gw) DESC, lm.created_at DESC "
        "LIMIT 1"
    )
    params: Dict[str, Any] = {"lid": lid, "gw": str(gateway_session_id or "")}
    params.update(_uid_params(user_id))
    try:
        row = (await db.execute(text(sql), params)).first()
    except Exception as exc:
        logger.warning("LID cozumlemesi basarisiz (tenant=%s, lid=%s): %s", user_id, lid, exc)
        return None
    if row and row[0]:
        return str(row[0])
    return None


async def resolve_lid_phones(
    db: AsyncSession,
    lid_jids: Sequence[str],
    *,
    user_id: Optional[str],
    gateway_session_id: Optional[str] = None,
) -> Dict[str, str]:
    """Tenant-scoped batch LID -> ``phone_jid`` resolution.

    Returns ``{lid_jid: phone_jid}``. The caller's own session wins when the
    same LID is present in more than one of the user's sessions.
    """
    if not lid_jids or not user_id:
        return {}
    lids = [str(l).strip() for l in lid_jids if l and str(l).strip()]
    if not lids:
        return {}

    lid_tbl, sess_tbl = _tables(db)
    sql = (
        f"SELECT lm.lid_jid, lm.phone_jid FROM {lid_tbl} lm "
        f"JOIN {sess_tbl} ws ON ws.gateway_id = lm.session_id "
        f"WHERE lm.lid_jid IN :lids AND {_user_predicate('ws')} "
        "ORDER BY lm.lid_jid, (lm.session_id = :gw) DESC, lm.created_at DESC"
    )
    stmt = text(sql).bindparams(bindparam("lids", expanding=True))
    params: Dict[str, Any] = {"lids": lids, "gw": str(gateway_session_id or "")}
    params.update(_uid_params(user_id))
    try:
        rows = (await db.execute(stmt, params)).fetchall()
    except Exception as exc:
        logger.warning("LID toplu cozumlemesi basarisiz (tenant=%s): %s", user_id, exc)
        return {}

    out: Dict[str, str] = {}
    for r in rows:
        if not r[0] or not r[1]:
            continue
        key = str(r[0])
        if key in out:
            continue  # already ordered own-session-first
        out[key] = str(r[1])
    return out
