"""
Lead Import Service for CSV and Excel files.
Supports automatic column detection, user-defined column mappings,
strict phone E.164 normalization, and deduplicated database ingestion.
"""
import io
import re
import csv
import logging
import hashlib
from typing import List, Dict, Any, Optional, Tuple
import pandas as pd
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.phone_service import PhoneService
from backend.app.services.lead_ingest_service import LeadIngestService

logger = logging.getLogger(__name__)

# Heuristic alias maps for auto-detecting columns (case-insensitive, trimmed)
COLUMN_ALIASES: Dict[str, List[str]] = {
    "name": [
        "name", "işletme adı", "isletme adi", "firma adı", "firma adi",
        "işletme", "isletme", "firma", "şirket", "sirket", "business_name",
        "business", "company", "unvan", "ünvan", "müşteri", "musteri", "ad", "title"
    ],
    "phone": [
        "phone", "telefon", "telefon numarası", "telefon no", "tel", "tel no",
        "gsm", "cep", "mobile", "whatsapp", "iletişim", "iletisim", "numara",
        "phone_number", "contact_number"
    ],
    "city": [
        "city", "şehir", "sehir", "il", "province", "vilayet"
    ],
    "district": [
        "district", "ilçe", "ilce", "bölge", "bolge", "semt", "town", "county"
    ],
    "category": [
        "category", "kategori", "sektör", "sektor", "alan", "faaliyet", "faaliyet alanı",
        "industry", "business_type", "type"
    ],
    "website": [
        "website", "web", "web sitesi", "web adresi", "site", "url", "link", "homepage"
    ],
    "address": [
        "address", "adres", "açık adres", "acik adres", "tam adres", "location", "konum"
    ],
    "notes": [
        "notes", "not", "notlar", "açıklama", "aciklama", "description", "yorum", "detay"
    ],
}


def _normalize_header_str(val: str) -> str:
    s = str(val).replace("İ", "i").replace("I", "ı").lower().replace("\u0307", "")
    return re.sub(r"\s+", " ", s).strip()


def _strip_accents(val: str) -> str:
    tr_map = str.maketrans("ığüşöç", "igusoc")
    return _normalize_header_str(val).translate(tr_map)


class LeadImportService:
    """
    Parses, validates, maps, and ingests leads from Excel (.xlsx, .xls) and CSV (.csv, .tsv) files.
    """

    @classmethod
    def _read_dataframe(cls, file_bytes: bytes, filename: str) -> pd.DataFrame:
        """
        Reads CSV or Excel bytes into a Pandas DataFrame with encoding and delimiter fallbacks.
        """
        filename_lower = filename.lower()
        if filename_lower.endswith((".xlsx", ".xls")):
            try:
                return pd.read_excel(io.BytesIO(file_bytes), engine="openpyxl")
            except Exception as e:
                logger.warning(f"Failed to read Excel with openpyxl: {e}. Trying default engine...")
                return pd.read_excel(io.BytesIO(file_bytes))

        # Handle CSV / TSV with encoding & delimiter auto-detection
        encodings = ["utf-8-sig", "utf-8", "windows-1254", "iso-8859-9", "cp1252", "latin-1"]

        # Sniff delimiter from first 4096 bytes
        sample = file_bytes[:4096]
        detected_sep = ","
        for enc in encodings:
            try:
                sample_str = sample.decode(enc)
                sniffer = csv.Sniffer()
                dialect = sniffer.sniff(sample_str, delimiters=[",", ";", "\t", "|"])
                detected_sep = dialect.delimiter
                break
            except Exception:
                continue

        # Try reading with candidate encodings
        for enc in encodings:
            try:
                df = pd.read_csv(
                    io.BytesIO(file_bytes),
                    sep=detected_sep,
                    encoding=enc,
                    dtype=str,
                    skipinitialspace=True,
                    on_bad_lines="skip",
                )
                if not df.empty or len(df.columns) > 1:
                    return df
            except Exception:
                continue

        # Final fallback
        return pd.read_csv(
            io.BytesIO(file_bytes),
            sep=None,
            engine="python",
            dtype=str,
            on_bad_lines="skip",
        )

    @classmethod
    def _detect_mapping(cls, columns: List[str]) -> Dict[str, Optional[str]]:
        """
        Heuristically maps standard lead fields to the best matching dataframe column name.
        """
        mapping: Dict[str, Optional[str]] = {
            "name": None,
            "phone": None,
            "city": None,
            "district": None,
            "category": None,
            "website": None,
            "address": None,
            "notes": None,
        }

        col_cleaned = {col: _normalize_header_str(col) for col in columns}
        col_accentless = {col: _strip_accents(col) for col in columns}

        for field, raw_aliases in COLUMN_ALIASES.items():
            norm_aliases = [_normalize_header_str(a) for a in raw_aliases]
            accentless_aliases = [_strip_accents(a) for a in raw_aliases]

            # 1. Exact match (with or without accents)
            for orig_col, cleaned in col_cleaned.items():
                if cleaned in norm_aliases:
                    mapping[field] = orig_col
                    break
            if not mapping[field]:
                for orig_col, a_cleaned in col_accentless.items():
                    if a_cleaned in accentless_aliases:
                        mapping[field] = orig_col
                        break
            if mapping[field]:
                continue

            # 2. Substring match
            for orig_col, cleaned in col_cleaned.items():
                for alias in norm_aliases:
                    if len(alias) >= 3 and (alias in cleaned or cleaned in alias):
                        mapping[field] = orig_col
                        break
                if mapping[field]:
                    break

            if not mapping[field]:
                for orig_col, a_cleaned in col_accentless.items():
                    for a_alias in accentless_aliases:
                        if len(a_alias) >= 3 and (a_alias in a_cleaned or a_cleaned in a_alias):
                            mapping[field] = orig_col
                            break
                    if mapping[field]:
                        break

        return mapping

    @classmethod
    def preview(cls, file_bytes: bytes, filename: str) -> Dict[str, Any]:
        """
        Generates a preview containing column headers, detected mappings,
        total row count, and the first 5 sample rows.
        """
        df = cls._read_dataframe(file_bytes, filename)
        # Strip string values and fill NAs
        df = df.fillna("")
        columns = [str(c).strip() for c in df.columns]
        detected_mapping = cls._detect_mapping(columns)

        preview_rows = []
        for _, row in df.head(5).iterrows():
            row_dict = {col: str(row.get(col, "")).strip() for col in columns}
            preview_rows.append(row_dict)

        return {
            "filename": filename,
            "total_rows": int(len(df)),
            "headers": columns,
            "detected_mapping": detected_mapping,
            "preview_rows": preview_rows,
        }

    @classmethod
    async def parse_and_import(
        cls,
        db: AsyncSession,
        file_bytes: bytes,
        filename: str,
        column_mapping: Optional[Dict[str, str]] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Parses the uploaded file according to column_mapping, normalizes phone numbers,
        and saves leads via LeadIngestService with deduplication and blacklist filtering.
        """
        df = cls._read_dataframe(file_bytes, filename)
        df = df.fillna("")
        columns = [str(c).strip() for c in df.columns]

        # Use auto-detected mapping if not provided or to fill missing fields
        detected = cls._detect_mapping(columns)
        mapping = {**detected, **(column_mapping or {})}

        name_col = mapping.get("name")
        phone_col = mapping.get("phone")
        city_col = mapping.get("city")
        district_col = mapping.get("district")
        category_col = mapping.get("category")
        website_col = mapping.get("website")
        address_col = mapping.get("address")
        notes_col = mapping.get("notes")

        raw_leads: List[Dict[str, Any]] = []
        invalid_phone_count = 0
        skipped_no_name = 0

        for _, row in df.iterrows():
            name_val = str(row.get(name_col, "")).strip() if name_col else ""
            if not name_val or name_val.lower() == "nan":
                skipped_no_name += 1
                continue

            raw_phone = str(row.get(phone_col, "")).strip() if phone_col else None
            if raw_phone and raw_phone.lower() in ("nan", "none", "-", ""):
                raw_phone = None

            phone_e164 = None
            is_valid_phone = False
            if raw_phone:
                phone_data = PhoneService.normalize_to_e164(raw_phone)
                if phone_data and phone_data.get("is_valid"):
                    phone_e164 = phone_data["e164"]
                    is_valid_phone = True
                else:
                    invalid_phone_count += 1

            city_val = str(row.get(city_col, "")).strip() if city_col else None
            district_val = str(row.get(district_col, "")).strip() if district_col else None
            category_val = str(row.get(category_col, "")).strip() if category_col else None
            website_val = str(row.get(website_col, "")).strip() if website_col else None
            address_val = str(row.get(address_col, "")).strip() if address_col else None
            notes_val = str(row.get(notes_col, "")).strip() if notes_col else None

            # Generate deterministic place_id for imported leads
            if phone_e164:
                seed = f"imp_{phone_e164}"
            else:
                seed = f"imp_{name_val}_{city_val or ''}_{district_val or ''}"
            place_id = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]

            raw_lead: Dict[str, Any] = {
                "name": name_val,
                "phone": raw_phone or (phone_e164 or ""),
                "phone_e164": phone_e164,
                "city": city_val if city_val and city_val.lower() != "nan" else None,
                "district": district_val if district_val and district_val.lower() != "nan" else None,
                "category": category_val if category_val and category_val.lower() != "nan" else None,
                "website": website_val if website_val and website_val.lower() != "nan" else None,
                "address": address_val if address_val and address_val.lower() != "nan" else None,
                "notes": notes_val if notes_val and notes_val.lower() != "nan" else None,
                "place_id": place_id,
            }
            raw_leads.append(raw_lead)

        source = "IMPORT_EXCEL" if filename.lower().endswith((".xlsx", ".xls")) else "IMPORT_CSV"

        # Ingest leads with deduplication and blacklist validation
        _, new_count, updated_count = await LeadIngestService.ingest_leads(
            db=db,
            raw_leads=raw_leads,
            source=source,
            user_id=user_id,
        )

        return {
            "total_rows": int(len(df)),
            "imported_count": len(raw_leads),
            "created_count": new_count,
            "updated_count": updated_count,
            "skipped_count": skipped_no_name,
            "invalid_phone_count": invalid_phone_count,
        }
