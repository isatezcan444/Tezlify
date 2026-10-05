"""
Anti-Ban politikası — gecikme/mesai kararlarının TEK kaynağı.

Kurallar:
- Jitter, kampanya (veya varsayılan) min/max aralığında Gaussian dağılımla hesaplanır.
- Mesai saati kontrolü FAIL-CLOSED'dur: parse hatası durumunda gönderim YASAKLANIR.
"""
import random
from dataclasses import dataclass
from datetime import datetime, time
from typing import Optional

from backend.app.core.config import settings


def parse_hhmm(value: str) -> time:
    """'HH:MM' değerini time'a çevirir; geçersiz formatta ValueError fırlatır."""
    hour_str, minute_str = value.strip().split(":")
    hour, minute = int(hour_str), int(minute_str)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"Geçersiz saat değeri: {value!r}")
    return time(hour, minute)


def gaussian_jitter_seconds(min_delay: int, max_delay: int) -> int:
    """min/max aralığında Gaussian dağılımlı, sıkı şekilde sınırlandırılmış gecikme."""
    if min_delay >= max_delay:
        return min_delay
    mean = (min_delay + max_delay) / 2.0
    std_dev = (max_delay - min_delay) / 4.0
    delay = random.gauss(mean, std_dev)
    return max(min_delay, min(max_delay, int(delay)))


@dataclass(frozen=True)
class AntibanPolicy:
    min_delay_seconds: int
    max_delay_seconds: int
    typing_delay_seconds: int
    working_hours_enabled: bool
    working_hours_start: str
    working_hours_end: str
    daily_message_limit: int = 50

    @classmethod
    def from_campaign(cls, campaign, default_daily_limit: int = 50) -> "AntibanPolicy":
        min_del = getattr(campaign, "min_delay_seconds", None)
        max_del = getattr(campaign, "max_delay_seconds", None)
        typing_del = getattr(campaign, "typing_delay_seconds", None)
        wh_enabled = getattr(campaign, "working_hours_enabled", None)
        wh_start = getattr(campaign, "working_hours_start", None)
        wh_end = getattr(campaign, "working_hours_end", None)
        daily_lim = getattr(campaign, "daily_message_limit", None)

        return cls(
            min_delay_seconds=min_del if min_del is not None else settings.DEFAULT_MIN_DELAY_SECONDS,
            max_delay_seconds=max_del if max_del is not None else settings.DEFAULT_MAX_DELAY_SECONDS,
            typing_delay_seconds=typing_del if typing_del is not None else settings.DEFAULT_TYPING_DELAY_SECONDS,
            working_hours_enabled=bool(wh_enabled) if wh_enabled is not None else True,
            working_hours_start=wh_start if wh_start is not None else settings.DEFAULT_WORKING_HOURS_START,
            working_hours_end=wh_end if wh_end is not None else settings.DEFAULT_WORKING_HOURS_END,
            daily_message_limit=daily_lim if daily_lim is not None else default_daily_limit,
        )

    def is_daily_limit_reached(self, sent_today: int) -> bool:
        """Belirtilen gün içindeki gönderim sayısı limiti aştı mı?"""
        return sent_today >= self.daily_message_limit

    def jitter_seconds(self) -> int:
        return gaussian_jitter_seconds(self.min_delay_seconds, self.max_delay_seconds)

    def worker_sleep_seconds(self) -> int:
        """Arka plan worker'ının iki mesaj arasında bekleyeceği gerçek süre."""
        return self.jitter_seconds()

    def is_within_working_hours(self, now: Optional[time] = None) -> bool:
        """Şu an izinli gönderim penceresinde miyiz? Hata halinde False (fail-closed)."""
        if not self.working_hours_enabled:
            return True
        try:
            current = now if now is not None else datetime.now().time()
            return parse_hhmm(self.working_hours_start) <= current <= parse_hhmm(self.working_hours_end)
        except (ValueError, AttributeError, TypeError):
            # Geçersiz saat formatı -> gönderime izin verme.
            return False
