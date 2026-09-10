import re
from typing import Optional, Dict, Any
import phonenumbers
from phonenumbers import NumberParseException, PhoneNumberType

class PhoneService:
    """
    Phone number normalization and validation.
    Defaults to Turkey (TR) region if no international country code is specified.
    """

    DEFAULT_REGION = "TR"

    # Turkish geographic area codes (BTK numbering plan: 81 provinces, with
    # 212/216 both in İstanbul) plus TRNC 392. Used ONLY for plausibility of
    # the display number — validity/eligibility still requires libphonenumber.
    TR_AREA_CODES = frozenset({
        "212", "216", "222", "224", "226", "228", "232", "236", "242", "246",
        "248", "252", "256", "258", "262", "264", "266", "272", "274", "276",
        "282", "284", "286", "288", "312", "318", "322", "324", "326", "328",
        "332", "338", "342", "344", "346", "348", "352", "354", "356", "358",
        "362", "364", "366", "368", "372", "374", "376", "378", "382", "384",
        "386", "388", "392", "412", "414", "416", "422", "424", "426", "428",
        "432", "434", "436", "438", "442", "446", "452", "454", "456", "458",
        "462", "464", "466", "468", "472", "474", "476", "478", "482", "484",
        "486", "488",
    })

    @classmethod
    def canonical_display(cls, raw_phone: Optional[str]) -> Optional[str]:
        """Best-effort +90 display form for a TR-plausible number.

        Returns the canonical +90… form when the digits fit the Turkish
        numbering plan (mobile 05xx, geographic area code, 850/800/900,
        444 short), else None. Display is NOT validity: callers must still
        gate targeting/eligibility on normalize_to_e164().
        """
        if not raw_phone or not isinstance(raw_phone, str):
            return None
        digits = re.sub(r"\D", "", raw_phone)
        if digits.startswith("00"):
            digits = digits[2:]
        if digits.startswith("90") and len(digits) > 10:
            digits = digits[2:]
        if digits.startswith("0"):
            digits = digits[1:]

        national: Optional[str] = None
        if re.fullmatch(r"5\d{9}", digits):
            national = digits
        elif re.fullmatch(r"444\d{4}", digits):
            national = digits
        elif re.fullmatch(r"(850|800|900)\d{7}", digits):
            national = digits
        elif re.fullmatch(r"[2-4]\d{2}\d{7}", digits) and digits[:3] in cls.TR_AREA_CODES:
            national = digits

        if national is None:
            return None
        return f"+90{national}"

    @staticmethod
    def mask_for_log(phone_e164: Optional[str]) -> str:
        """PII-safe phone rendering for logs: keeps routing prefix + last 2 digits."""
        if not phone_e164:
            return "—"
        visible = str(phone_e164)
        if len(visible) <= 6:
            return "****"
        return f"{visible[:4]}****{visible[-2:]}"

    @classmethod
    def clean_raw_number(cls, raw: str) -> str:
        """Removes all non-digit characters except leading plus."""
        if not raw:
            return ""
        raw = raw.strip()
        # Keep leading + if present
        has_plus = raw.startswith("+")
        digits = re.sub(r'\D', '', raw)
        return f"+{digits}" if has_plus else digits

    @classmethod
    def normalize_to_e164(cls, raw_phone: str, default_region: str = DEFAULT_REGION) -> Optional[Dict[str, Any]]:
        """
        Parses raw phone string and converts to E.164 (+905321234567).
        Returns a dict with metadata:
        {
            "e164": "+905321234567",
            "national_number": "5321234567",
            "country_code": 90,
            "is_valid": True,
            "is_mobile": True,
            "is_whatsapp_eligible": True
        }
        """
        if not raw_phone:
            return None

        cleaned = cls.clean_raw_number(raw_phone)
        if not cleaned:
            return None

        try:
            # If Turkish number starting with 05xx, 5xx, or 905xx
            if not cleaned.startswith("+"):
                if cleaned.startswith("00"):
                    cleaned = f"+{cleaned[2:]}"
                elif cleaned.startswith("0"):
                    cleaned = f"+90{cleaned[1:]}"
                elif cleaned.startswith("90") and len(cleaned) >= 12:
                    cleaned = f"+{cleaned}"
                elif len(cleaned) == 10 and cleaned.startswith("5"):
                    cleaned = f"+90{cleaned}"

            parsed = phonenumbers.parse(cleaned, default_region)
            is_valid = phonenumbers.is_valid_number(parsed)

            if not is_valid:
                # Fail-closed (No False Positives invariant): a digit string
                # that libphonenumber rejects is NOT a targeting number.
                # Callers keep the raw display text; phone_e164 stays None.
                return None

            e164 = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
            num_type = phonenumbers.number_type(parsed)
            
            # Mobile or Fixed Line / Mobile combo
            is_mobile = num_type in (
                PhoneNumberType.MOBILE,
                PhoneNumberType.FIXED_LINE_OR_MOBILE,
                PhoneNumberType.PERSONAL_NUMBER
            )
            
            # Additional TR specific check (5xx is always mobile in Turkey)
            national_str = str(parsed.national_number)
            if parsed.country_code == 90 and national_str.startswith("5"):
                is_mobile = True

            return {
                "e164": e164,
                "national_number": national_str,
                "country_code": parsed.country_code,
                "is_valid": True,
                "is_mobile": is_mobile,
                "is_whatsapp_eligible": is_mobile
            }

        except NumberParseException:
            # Fail-closed: unparseable input is not a targeting number.
            return None
