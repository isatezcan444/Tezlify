"""
Lead Ingestion and Deduplication Service.
Extracted from God Router endpoints to ensure Single Responsibility Principle.
"""
import logging
from typing import List, Dict, Any, Tuple, Optional, Callable, Awaitable, Set
from datetime import datetime
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, and_, insert

from backend.app.models.lead import Lead, LeadStatus, EntityType, VerificationStatus, ConfidenceLevel
from backend.app.models.blacklist import Blacklist
from backend.app.services.phone_service import PhoneService
from backend.app.services.lead_match_policy import LeadMatchPolicy, MatchBasis
from backend.app.scrapers.google_maps_playwright_scraper import strip_leading_business_name

logger = logging.getLogger(__name__)


class LeadIngestService:
    """
    Handles robust lead ingestion, normalization, blacklist verification,
    deduplication, and database persistence.

    Concurrency invariant: unique constraints (place_id / phone_e164) are enforced
    per-lead inside a SAVEPOINT. A concurrent job winning the insert race can no
    longer fail the whole batch — the conflicting lead is merged instead.

    Identity invariant: whether an incoming candidate IS an existing lead is
    delegated to LeadMatchPolicy; this service never merges two distinct
    businesses sharing merely a phone line.
    """

    # DI seam: tests / alternative deployments can swap matching semantics.
    match_policy = LeadMatchPolicy()

    @classmethod
    async def ingest_leads(
        cls,
        db: AsyncSession,
        raw_leads: List[Dict[str, Any]],
        source: str = "GOOGLE_MAPS",
        search_keyword: Optional[str] = None,
        search_location: Optional[str] = None,
        progress_callback: Optional[Callable[[int, int], Awaitable[None]]] = None,
        user_id: Optional[str] = None,
    ) -> Tuple[List[Lead], int, int]:
        """
        Processes and saves raw leads into the database.
        Returns:
            (created_leads, total_new_count, total_updated_count)

        progress_callback (optional) receives (processed_count, total) roughly
        every 10 leads so long Supabase round-trips never look like a hang.
        """
        if not raw_leads:
            return [], 0, 0

        total = len(raw_leads)
        if progress_callback:
            await progress_callback(0, total)

        # Pre-pass 1: normalize phones once (sync, cheap) so blacklist lookup
        # collapses from N round-trips into ONE batched query.
        prepared: List[Tuple[Dict[str, Any], str, Optional[str]]] = []
        wanted_e164s: Set[str] = set()
        for raw in raw_leads:
            name = (raw.get("name") or "").strip()
            raw_phone = raw.get("phone")
            phone_data = PhoneService.normalize_to_e164(raw_phone) if raw_phone else None
            e164 = phone_data["e164"] if (phone_data and phone_data["is_valid"]) else raw.get("phone_e164")
            prepared.append((raw, name, e164))
            if e164:
                wanted_e164s.add(e164)

        blacklisted: Set[str] = set()
        if wanted_e164s:
            bl_rows = (
                await db.execute(
                    select(Blacklist.phone_e164).where(Blacklist.phone_e164.in_(wanted_e164s))
                )
            ).scalars().all()
            blacklisted = set(bl_rows)

        # Pre-pass 2: batched identity prefetch — 3 round-trips total instead of
        # ~4 per lead. NULL keys are excluded (NULL never matches in SQL, and
        # the matcher guards falsy keys identically to resolve()).
        wanted_pids = {r.get("place_id") for r, _, _ in prepared if r.get("place_id")}
        place_map: Dict[str, Lead] = {}
        if wanted_pids:
            for row in (
                await db.execute(
                    select(Lead).where(Lead.place_id.in_(wanted_pids)).order_by(Lead.id)
                )
            ).scalars().all():
                place_map.setdefault(row.place_id, row)

        phone_map: Dict[str, Lead] = {}
        if wanted_e164s:
            for row in (
                await db.execute(
                    select(Lead).where(Lead.phone_e164.in_(wanted_e164s)).order_by(Lead.id)
                )
            ).scalars().all():
                phone_map.setdefault(row.phone_e164, row)

        # (name, city, district) triples, deduped. `== None` renders IS NULL —
        # byte-identical semantics to the former per-row fallback query.
        wanted_triples = {
            (name, raw.get("city"), raw.get("district"))
            for raw, name, _ in prepared if name
        }
        nameloc_map: Dict[Tuple[str, Any, Any], Lead] = {}
        if wanted_triples:
            conds = [
                and_(Lead.name == n, Lead.city == c, Lead.district == d)
                for n, c, d in wanted_triples
            ]
            for row in (
                await db.execute(select(Lead).where(or_(*conds)).order_by(Lead.id))
            ).scalars().all():
                nameloc_map.setdefault((row.name, row.city, row.district), row)

        # In-batch created rows: read-your-writes for same-batch duplicates
        # (mirrors the flush visibility the per-row queries used to have).
        created_by_place: Dict[str, Lead] = {}
        created_by_phone: Dict[str, Lead] = {}
        created_by_nameloc: Dict[Tuple[str, Any, Any], Lead] = {}

        def find_cached(kind: str, key: object) -> Optional[Lead]:
            if kind == "place":
                hit = created_by_place.get(key)  # type: ignore[arg-type]
                return hit if hit is not None else place_map.get(key)  # type: ignore[arg-type]
            if kind == "phone":
                hit = created_by_phone.get(key)  # type: ignore[arg-type]
                return hit if hit is not None else phone_map.get(key)  # type: ignore[arg-type]
            hit = created_by_nameloc.get(key)  # type: ignore[arg-type]
            return hit if hit is not None else nameloc_map.get(key)  # type: ignore[arg-type]

        def register_created(lead: Lead, raw_ref: Dict[str, Any], final_e164: Optional[str]) -> None:
            pid = raw_ref.get("place_id")
            if pid:
                created_by_place.setdefault(pid, lead)
            if final_e164:
                created_by_phone.setdefault(final_e164, lead)
            nm_key = (
                (lead.name or "").strip(),
                raw_ref.get("city"),
                raw_ref.get("district"),
            )
            if nm_key[0]:
                created_by_nameloc.setdefault(nm_key, lead)

        all_processed_leads: List[Lead] = []
        created_leads: List[Lead] = []
        new_count = 0
        updated_count = 0
        skipped_no_name = 0
        shared_line_saved = 0
        matched_by: Dict[str, int] = {basis.value: 0 for basis in MatchBasis}
        race_merged = 0
        assigned_batch_e164s: Set[str] = set()
        # (transient, raw, name, e164, phone_data, is_wa, is_verified,
        #  is_blacklisted, all_processed_index) for the bulk phase.
        planned_inserts: list = []

        for idx, (raw, name, e164) in enumerate(prepared):
            if not name:
                skipped_no_name += 1
                continue

            raw_phone = raw.get("phone")
            phone_data = PhoneService.normalize_to_e164(raw_phone) if raw_phone else None

            # Check blacklist (prefetched set — zero extra round-trips)
            is_blacklisted = bool(e164 and e164 in blacklisted)

            # Identity resolution (policy-owned, cache-backed: zero round-trips).
            # A distinct business that merely shares a line with an existing
            # row keeps its own row; its targeting number is withheld exactly
            # like discovery-side SHARED_PHONE leads.
            verdict = cls.match_policy.resolve_from_caches(raw, name, e164, find_cached)
            if verdict.shares_phone_line:
                e164 = None
                raw = {**raw, "phone_e164": None}
                shared_line_saved += 1

            # Strict phone unique index guard (cache-backed):
            # If e164 is already allocated to another lead in this batch, or already exists on a
            # DIFFERENT row in the database, withhold phone_e164 (None) to satisfy the ix_leads_phone_e164
            # unique constraint while preserving the display phone and creating/updating the lead row.
            if e164:
                target_lead_id = verdict.existing.id if verdict.existing else None
                conflict = False
                if e164 in assigned_batch_e164s:
                    conflict = True
                else:
                    # Fail-safe: legacy prod rows may hold duplicates; any
                    # holder on a different row means conflict — never raise.
                    holder = find_cached("phone", e164)
                    if holder is not None and holder.id != target_lead_id:
                        conflict = True

                if conflict:
                    e164 = None
                    raw = {**raw, "phone_e164": None}
                    shared_line_saved += 1
                else:
                    assigned_batch_e164s.add(e164)

            is_wa_eligible = bool(phone_data and phone_data.get("is_whatsapp_eligible")) if (phone_data and e164) else False
            is_verified = raw.get("is_verified", bool(phone_data and phone_data.get("is_valid")))

            if verdict.existing:
                cls._merge_into_existing(verdict.existing, raw, e164, is_wa_eligible, is_blacklisted)
                if verdict.existing.phone_e164:
                    assigned_batch_e164s.add(verdict.existing.phone_e164)
                updated_count += 1
                matched_by[verdict.basis.value] += 1
                all_processed_leads.append(verdict.existing)
            else:
                # Row-mode flush is deferred: collect a transient carrying the
                # final (post same-batch-merge) values for the bulk statement.
                values = cls._build_lead_values(
                    raw, name, e164, phone_data, is_wa_eligible,
                    is_verified, is_blacklisted, source,
                    search_keyword, search_location,
                    user_id=user_id,
                )
                transient = Lead(**values)
                register_created(transient, raw, transient.phone_e164)
                if transient.phone_e164:
                    assigned_batch_e164s.add(transient.phone_e164)
                planned_inserts.append(
                    (transient, raw, name, e164, phone_data,
                     is_wa_eligible, is_verified, is_blacklisted,
                     len(all_processed_leads))
                )
                created_leads.append(transient)
                new_count += 1
                all_processed_leads.append(transient)

            if progress_callback and (idx + 1 == total or (idx + 1) % 10 == 0):
                await progress_callback(idx + 1, total)

        # ---- Persistence phase: ONE multi-VALUES statement for all new rows
        # (~1 round-trip regardless of N) instead of N savepoint flushes. ----
        if planned_inserts:
            try:
                async with db.begin_nested():
                    id_by_key = await cls._bulk_insert_transients(
                        db, [t for t, *_ in planned_inserts]
                    )
            except IntegrityError:
                # A concurrent job slipped a conflicting row between prefetch
                # and bulk: the savepoint contains the failure, so retry rows
                # individually (each with its own race-merge).
                logger.warning(
                    "[LeadIngestService] Bulk insert hit a concurrent race; "
                    "retrying rows individually."
                )
                trans_to_real_fb: Dict[int, Lead] = {}
                for (transient, fraw, fname, fe164, fpdata, fwa, fver, fbl, _apos) in planned_inserts:
                    fvals = {c: getattr(transient, c) for c in cls._LEAD_VALUE_COLS}
                    lead, merged_flag = await cls._persist_new_lead(
                        db, fraw, fname, fe164, fpdata, fwa, fver, fbl,
                        source, search_keyword, search_location, values=fvals,
                    )
                    trans_to_real_fb.setdefault(id(transient), lead)
                    new_count -= 1
                    if merged_flag:
                        updated_count += 1
                        race_merged += 1
                    else:
                        new_count += 1
                # Identity substitution: one transient may occupy several
                # positions when same-batch raws merged into it.
                all_processed_leads = [
                    trans_to_real_fb.get(id(l), l) for l in all_processed_leads
                ]
            else:
                # Substitute real rows for transients (single batched fetch).
                new_ids = list(id_by_key.values())
                fresh = (
                    await db.execute(select(Lead).where(Lead.id.in_(new_ids)))
                ).scalars().all()
                fresh_by_id = {r.id: r for r in fresh}
                trans_to_real: Dict[int, Lead] = {}
                for (transient, *_rest) in planned_inserts:
                    real = fresh_by_id.get(id_by_key.get(cls._bulk_key(transient)))  # type: ignore[arg-type]
                    if real is not None:
                        trans_to_real.setdefault(id(transient), real)
                if trans_to_real:
                    all_processed_leads = [
                        trans_to_real.get(id(l), l) for l in all_processed_leads
                    ]

        await db.commit()
        # Single batched re-read instead of N per-row refresh round-trips
        # (matters on remote Postgres: N RTTs looked like a post-scan hang).
        if all_processed_leads:
            ids_in_order = [l.id for l in all_processed_leads]
            rows = (
                await db.execute(select(Lead).where(Lead.id.in_(ids_in_order)))
            ).scalars().all()
            by_id = {r.id: r for r in rows}
            all_processed_leads = [by_id.get(l.id, l) for l in all_processed_leads]

        logger.info(
            f"[LeadIngestService] Ingest complete: total_raw={len(raw_leads)}, "
            f"new={new_count}, updated={updated_count} "
            f"(by_place={matched_by[MatchBasis.PLACE_ID.value]}, "
            f"by_phone={matched_by[MatchBasis.PHONE.value]}, "
            f"by_identity={matched_by[MatchBasis.NAME_LOCATION.value]}, "
            f"race_merged={race_merged}) "
            f"shared_line_new_rows={shared_line_saved}, skipped_no_name={skipped_no_name}"
        )
        return all_processed_leads, new_count, updated_count



    @staticmethod
    def _merge_into_existing(
        existing_lead: Lead,
        raw: Dict[str, Any],
        e164: Optional[str],
        is_wa_eligible: bool,
        is_blacklisted: bool,
    ) -> bool:
        """Backfills richer details discovered on a subsequent scan of the same business.

        Returns True when any attribute actually changed. Untouched rows stay
        clean so commit emits no UPDATE for them (identical re-saves cost zero
        write round-trips on remote Postgres).
        """
        changed = False

        def _set(attr: str, value: Any) -> None:
            nonlocal changed
            if getattr(existing_lead, attr) != value:
                setattr(existing_lead, attr, value)
                changed = True

        maps_url = raw.get("maps_url") or raw.get("google_maps_url")
        if not existing_lead.phone_e164 and e164:
            _set("phone_e164", e164)
            _set("phone", e164)
            _set("is_whatsapp_eligible", is_wa_eligible)
        if not existing_lead.website and raw.get("website"):
            _set("website", raw.get("website"))
        if not existing_lead.address and raw.get("address"):
            _set("address", raw.get("address"))
        # Self-healing: rows stored before the name-prefix strip carry
        # "Business Name, street...". Normalize them on contact — pure removal
        # of a proven prefix, never injecting new content.
        if existing_lead.address:
            healed = strip_leading_business_name(existing_lead.name, existing_lead.address)
            if healed and healed != existing_lead.address:
                _set("address", healed)
        if raw.get("rating") and not existing_lead.rating:
            _set("rating", raw.get("rating"))
        if is_blacklisted:
            _set("status", LeadStatus.UNSUBSCRIBED)
        if maps_url and not (existing_lead.custom_data or {}).get("maps_url"):
            _set("custom_data", {**(existing_lead.custom_data or {}), "maps_url": maps_url})
        if changed:
            _set("updated_at", datetime.utcnow())
        return changed

    @staticmethod
    def _initial_custom_data(raw: Dict[str, Any]) -> Dict[str, Any]:
        """Builds the initial custom_data payload preserving the canonical Maps URL."""
        maps_url = raw.get("maps_url") or raw.get("google_maps_url")
        return {"maps_url": maps_url} if maps_url else {}

    # Column set materialized from transient Lead objects into Core bulk rows.
    # Must stay in sync with _build_lead_values().
    _LEAD_VALUE_COLS = (
        "name", "category", "canonical_category", "category_score",
        "category_classification", "entity_type", "verification_status",
        "confidence_level", "confidence_score", "is_verified", "discovered_from",
        "verified_by", "phone", "phone_e164", "is_mobile", "is_whatsapp_eligible",
        "address", "city", "district", "latitude", "longitude", "website",
        "rating", "reviews_count", "place_id", "search_keyword", "search_location",
        "source", "status", "custom_data", "user_id",
    )

    @classmethod
    def _build_lead_values(
        cls,
        raw: Dict[str, Any],
        name: str,
        e164: Optional[str],
        phone_data: Optional[Dict[str, Any]],
        is_wa_eligible: bool,
        is_verified: bool,
        is_blacklisted: bool,
        source: str,
        search_keyword: Optional[str],
        search_location: Optional[str],
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Builds the column-value dict for a brand-new lead row.

        Single construction site shared by the ORM row-mode path and the Core
        bulk path — both persist byte-identical rows.
        """
        initial_status = LeadStatus.UNSUBSCRIBED if is_blacklisted else LeadStatus.NEW

        # Defensive truncation: protect all VARCHAR-bounded columns from overflow
        def _trunc(val: Optional[str], limit: int) -> Optional[str]:
            if val is None:
                return None
            # Also strip embedded newlines that can corrupt single-line fields
            val = val.split("\n")[0].strip()
            return val[:limit]

        return {
            "name": name,  # text (unlimited)
            "category": raw.get("category"),  # text (unlimited)
            "canonical_category": raw.get("canonical_category"),  # text
            "category_score": raw.get("category_score", 1.0),
            "category_classification": _trunc(raw.get("category_classification", "MATCH"), 50),
            "entity_type": _trunc(raw.get("entity_type", EntityType.BUSINESS.value), 50),
            "verification_status": _trunc(raw.get("verification_status", VerificationStatus.VERIFIED.value if is_verified else VerificationStatus.UNVERIFIED.value), 50),
            "confidence_level": _trunc(raw.get("confidence_level", ConfidenceLevel.HIGH.value if (is_verified and is_wa_eligible) else ConfidenceLevel.MEDIUM.value), 20),
            "confidence_score": raw.get("confidence_score", 90 if (is_verified and is_wa_eligible) else 60),
            "is_verified": is_verified,
            "discovered_from": _trunc(raw.get("discovered_from", source), 100),
            "verified_by": raw.get("verified_by"),
            "phone": _trunc(raw.get("phone") or (e164 or "Belirtilmemiş"), 50),
            "phone_e164": _trunc(e164, 30),  # None if phone is not present — never fabricate numbers
            "is_mobile": phone_data.get("is_mobile", False) if phone_data else False,
            "is_whatsapp_eligible": is_wa_eligible,
            "address": raw.get("address"),  # text
            "city": _trunc(raw.get("city"), 100),
            "district": _trunc(raw.get("district"), 100),
            "latitude": raw.get("latitude"),
            "longitude": raw.get("longitude"),
            "website": raw.get("website"),  # text
            "rating": raw.get("rating"),
            "reviews_count": raw.get("reviews_count", 0),
            "place_id": _trunc(raw.get("place_id"), 255),
            "search_keyword": _trunc(search_keyword or raw.get("search_keyword"), 200),
            "search_location": _trunc(search_location or raw.get("search_location"), 200),
            "source": _trunc(source, 50),
            "status": initial_status,
            "custom_data": cls._initial_custom_data(raw),
            "user_id": user_id,
        }

    @staticmethod
    def _bulk_key(transient: Lead) -> Tuple[str, Any, Any, Optional[str], Optional[str]]:
        """Correlation key mapping a planned transient to its bulk-inserted row.

        Full (name, city, district, phone_e164, place_id): any strict subset
        can repeat across two inserts (shared phone line on one triple; see
        SHARED_PHONE), but the full key is distinct — an exact repeat would
        have merged during planning instead of inserting.
        """
        return (
            transient.name, transient.city, transient.district,
            transient.phone_e164, transient.place_id,
        )

    @classmethod
    async def _bulk_insert_transients(
        cls, db: AsyncSession, transients: List[Lead]
    ) -> Dict[Tuple[str, Any, Any, Optional[str], Optional[str]], int]:
        """Persists planned new rows with ONE multi-VALUES statement.

        Values are materialized from the transient objects (which already carry
        any same-batch merges), so the bulk row equals what row-mode would
        have flushed. Returns {_bulk_key: id} for exact response mapping
        without relying on RETURNING order.
        """
        rows = [{c: getattr(t, c) for c in cls._LEAD_VALUE_COLS} for t in transients]
        prev_autoflush = db.autoflush
        db.autoflush = False
        try:
            res = await db.execute(
                insert(Lead)
                .values(rows)
                .returning(
                    Lead.id, Lead.name, Lead.city, Lead.district,
                    Lead.phone_e164, Lead.place_id,
                )
            )
        finally:
            db.autoflush = prev_autoflush
        return {(r[1], r[2], r[3], r[4], r[5]): r[0] for r in res.all()}

    @classmethod
    async def _persist_new_lead(
        cls,
        db: AsyncSession,
        raw: Dict[str, Any],
        name: str,
        e164: Optional[str],
        phone_data: Optional[Dict[str, Any]],
        is_wa_eligible: bool,
        is_verified: bool,
        is_blacklisted: bool,
        source: str,
        search_keyword: Optional[str],
        search_location: Optional[str],
        values: Optional[Dict[str, Any]] = None,
    ) -> Tuple[Lead, bool]:
        """
        Inserts a new lead inside a SAVEPOINT so a concurrent-job IntegrityError
        rolls back only this insert; the winner's row is then merged instead.
        Returns (lead, merged_into_existing). Row-mode path: used as the
        fallback when the bulk statement hits a concurrent race (pass the
        transient's current values so same-batch folds are preserved).
        """
        if values is None:
            values = cls._build_lead_values(
                raw, name, e164, phone_data, is_wa_eligible,
                is_verified, is_blacklisted, source,
                search_keyword, search_location,
            )
        lead = Lead(**values)

        try:
            async with db.begin_nested():
                db.add(lead)
                await db.flush()
        except IntegrityError:
            logger.warning(
                f"[LeadIngestService] Concurrent insert race detected for '{name}' "
                f"(place_id={raw.get('place_id')}, e164={e164}). Merging into winner."
            )
            verdict = await cls.match_policy.resolve(db, raw, name, e164)
            winner = verdict.existing
            if winner:
                cls._merge_into_existing(winner, raw, e164, is_wa_eligible, is_blacklisted)
                return winner, True
            raise
        return lead, False
