import json
import random
import time
import asyncio
import logging
from typing import Optional, List, Dict, Any
import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.app.models.system_settings import SystemSetting
from backend.app.schemas.proxy import (
    ProxyConfigSchema,
    ProxyTestResponse,
    ProxyPoolStatusResponse,
)

logger = logging.getLogger(__name__)

PROXY_CONFIG_KEY = "proxy_config"


class ProxyManager:
    """Scraper Motoru için Proxy Havuzu, Rotasyon ve Sağlık Kontrolü Yöneticisi."""

    _cached_config: Optional[ProxyConfigSchema] = None
    _round_robin_index: int = 0
    _lock = asyncio.Lock()

    @classmethod
    def normalize_proxy_url(cls, raw: str) -> str:
        """Kullanıcının girdiği 'ip:port' veya 'user:pass@ip:port' girdisini geçerli URL'ye çevirir."""
        clean = raw.strip()
        if not clean:
            return ""
        if not (clean.startswith("http://") or clean.startswith("https://") or clean.startswith("socks5://")):
            clean = f"http://{clean}"
        return clean

    @classmethod
    async def get_config(cls, db: AsyncSession) -> ProxyConfigSchema:
        """Veritabanından proxy havuzu yapılandırmasını okur."""
        stmt = select(SystemSetting).where(SystemSetting.key == PROXY_CONFIG_KEY)
        res = await db.execute(stmt)
        setting = res.scalar_one_or_none()

        if not setting or not setting.value_json:
            config = ProxyConfigSchema()
            cls._cached_config = config
            return config

        try:
            data = json.loads(setting.value_json)
            config = ProxyConfigSchema(**data)
        except Exception as exc:
            logger.warning("[ProxyManager] Proxy config parse error: %s, falling back to default", exc)
            config = ProxyConfigSchema()

        cls._cached_config = config
        return config

    @classmethod
    async def save_config(cls, db: AsyncSession, config: ProxyConfigSchema) -> ProxyConfigSchema:
        """Proxy yapılandırmasını veritabanında kalıcı kılar."""
        # Normalize proxy URLs
        cleaned_proxies = [
            cls.normalize_proxy_url(p) for p in config.proxies if cls.normalize_proxy_url(p)
        ]
        config.proxies = cleaned_proxies

        stmt = select(SystemSetting).where(SystemSetting.key == PROXY_CONFIG_KEY)
        res = await db.execute(stmt)
        setting = res.scalar_one_or_none()

        data_json = config.model_dump_json()

        if not setting:
            setting = SystemSetting(
                key=PROXY_CONFIG_KEY,
                value_json=data_json,
            )
            db.add(setting)
        else:
            setting.value_json = data_json

        await db.commit()
        await db.refresh(setting)
        cls._cached_config = config
        logger.info(
            f"[ProxyManager] Proxy havuzu güncellendi: enabled={config.enabled}, "
            f"count={len(config.proxies)}, strategy={config.rotation_strategy}"
        )
        return config

    @classmethod
    async def get_next_proxy(cls, db: Optional[AsyncSession] = None) -> Optional[str]:
        """Sıradaki proxy'yi seçer (ROUND_ROBIN veya RANDOM).
        
        Proxy havuzu kapalı veya liste boşsa None döndürür.
        """
        config = cls._cached_config
        if config is None and db is not None:
            config = await cls.get_config(db)

        if not config or not config.enabled or not config.proxies:
            return None

        proxies = config.proxies
        if not proxies:
            return None

        async with cls._lock:
            if config.rotation_strategy == "RANDOM":
                return random.choice(proxies)
            else:
                cls._round_robin_index = cls._round_robin_index % len(proxies)
                chosen = proxies[cls._round_robin_index]
                cls._round_robin_index = (cls._round_robin_index + 1) % len(proxies)
                return chosen

    @classmethod
    async def test_proxy(cls, proxy_url: str, timeout_seconds: float = 8.0) -> ProxyTestResponse:
        """Belirtilen proxy üzerinden dış IP sorgulayarak bağlantıyı ve gecikmeyi ölçer."""
        clean_url = cls.normalize_proxy_url(proxy_url)
        if not clean_url:
            return ProxyTestResponse(
                success=False,
                proxy_url=proxy_url,
                error="Geçersiz proxy URL formatı",
            )

        start_time = time.perf_counter()
        try:
            # httpbin or ipify check
            async with httpx.AsyncClient(proxy=clean_url, timeout=timeout_seconds, verify=False) as client:
                res = await client.get("https://api.ipify.org?format=json")
                latency_ms = round((time.perf_counter() - start_time) * 1000, 1)
                if res.status_code == 200:
                    data = res.json()
                    return ProxyTestResponse(
                        success=True,
                        proxy_url=clean_url,
                        latency_ms=latency_ms,
                        exit_ip=data.get("ip"),
                    )
                else:
                    return ProxyTestResponse(
                        success=False,
                        proxy_url=clean_url,
                        latency_ms=latency_ms,
                        error=f"HTTP {res.status_code}",
                    )
        except Exception as exc:
            latency_ms = round((time.perf_counter() - start_time) * 1000, 1)
            err_msg = str(exc)
            if "ConnectTimeout" in err_msg or "Timeout" in err_msg:
                err_msg = "Zaman Aşımı (Timeout)"
            elif "ProxyError" in err_msg:
                err_msg = "Proxy Bağlantı Hatası"
            return ProxyTestResponse(
                success=False,
                proxy_url=clean_url,
                latency_ms=latency_ms,
                error=err_msg[:120],
            )

    @classmethod
    async def test_all_proxies(cls, db: AsyncSession) -> List[ProxyTestResponse]:
        """Havuzdaki tüm proxy'leri eşzamanlı test eder."""
        config = await cls.get_config(db)
        if not config.proxies:
            return []

        tasks = [cls.test_proxy(p, timeout_seconds=config.timeout_seconds) for p in config.proxies]
        results = await asyncio.gather(*tasks, return_exceptions=False)
        return results

    @classmethod
    async def get_status(cls, db: AsyncSession) -> ProxyPoolStatusResponse:
        """Mevcut havuz durumu ve aktif proxy sayısı."""
        config = await cls.get_config(db)
        return ProxyPoolStatusResponse(
            enabled=config.enabled,
            total_proxies=len(config.proxies),
            active_proxies=len(config.proxies) if config.enabled else 0,
            rotation_strategy=config.rotation_strategy,
            proxies=config.proxies,
            timeout_seconds=config.timeout_seconds,
        )
