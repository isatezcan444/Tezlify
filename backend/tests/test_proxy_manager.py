import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

from backend.app.core.database import Base
from backend.app.schemas.proxy import ProxyConfigSchema
from backend.app.services.proxy_manager import ProxyManager


@pytest.mark.asyncio
async def test_proxy_normalization():
    """Verify raw proxy strings are formatted to proper URLs."""
    assert ProxyManager.normalize_proxy_url("127.0.0.1:8080") == "http://127.0.0.1:8080"
    assert ProxyManager.normalize_proxy_url("user:pass@1.2.3.4:3128") == "http://user:pass@1.2.3.4:3128"
    assert ProxyManager.normalize_proxy_url("http://custom:8000") == "http://custom:8000"
    assert ProxyManager.normalize_proxy_url("https://secure:8443") == "https://secure:8443"
    assert ProxyManager.normalize_proxy_url("socks5://user:pass@host:1080") == "socks5://user:pass@host:1080"
    assert ProxyManager.normalize_proxy_url("   ") == ""


@pytest.mark.asyncio
async def test_proxy_config_persistence_and_rotation():
    """Verify saving proxy configuration and round-robin rotation."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with async_session() as db:
        # Initial empty config
        cfg = await ProxyManager.get_config(db)
        assert cfg.enabled is False
        assert len(cfg.proxies) == 0

        # Save new proxy pool
        new_cfg = ProxyConfigSchema(
            enabled=True,
            proxies=[
                "1.1.1.1:8080",
                "2.2.2.2:8080",
                "3.3.3.3:8080",
            ],
            rotation_strategy="ROUND_ROBIN",
            timeout_seconds=5.0,
        )
        saved = await ProxyManager.save_config(db, new_cfg)
        assert saved.enabled is True
        assert len(saved.proxies) == 3
        assert saved.proxies[0] == "http://1.1.1.1:8080"

        # Test rotation: should yield 1 -> 2 -> 3 -> 1
        p1 = await ProxyManager.get_next_proxy(db)
        p2 = await ProxyManager.get_next_proxy(db)
        p3 = await ProxyManager.get_next_proxy(db)
        p4 = await ProxyManager.get_next_proxy(db)

        assert p1 == "http://1.1.1.1:8080"
        assert p2 == "http://2.2.2.2:8080"
        assert p3 == "http://3.3.3.3:8080"
        assert p4 == "http://1.1.1.1:8080"

        # Status response
        status = await ProxyManager.get_status(db)
        assert status.enabled is True
        assert status.total_proxies == 3
        assert status.active_proxies == 3

    await engine.dispose()


@pytest.mark.asyncio
async def test_proxy_test_connection_mock():
    """Verify proxy connection test helper returns formatted latency and exit IP."""
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"ip": "198.51.100.42"}

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        res = await ProxyManager.test_proxy("http://198.51.100.42:8080", timeout_seconds=2.0)
        assert res.success is True
        assert res.exit_ip == "198.51.100.42"
        assert res.latency_ms is not None
        assert res.error is None
