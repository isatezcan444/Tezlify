import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import delete, or_

from backend.app.main import app
from backend.app.core.auth import AuthUser, get_current_user
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.quick_reply import QuickReply

USER_A = "aaaaaaa1-1111-1111-1111-111111111111"
USER_B = "bbbbbbb2-2222-2222-2222-222222222222"
USER_A_HEX = USER_A.replace("-", "")
USER_B_HEX = USER_B.replace("-", "")

user_a_auth = AuthUser(
    id=USER_A,
    email="user_a@tezlify.com",
    full_name="User A",
)

user_b_auth = AuthUser(
    id=USER_B,
    email="user_b@tezlify.com",
    full_name="User B",
)


@pytest_asyncio.fixture(autouse=True)
async def cleanup_quick_replies():
    async with AsyncSessionLocal() as db:
        await db.execute(
            delete(QuickReply).where(
                or_(
                    QuickReply.user_id.in_([USER_A, USER_B]),
                    QuickReply.user_id.in_([USER_A_HEX, USER_B_HEX]),
                )
            )
        )
        await db.commit()
    yield
    app.dependency_overrides.clear()
    async with AsyncSessionLocal() as db:
        await db.execute(
            delete(QuickReply).where(
                or_(
                    QuickReply.user_id.in_([USER_A, USER_B]),
                    QuickReply.user_id.in_([USER_A_HEX, USER_B_HEX]),
                )
            )
        )
        await db.commit()


@pytest.mark.asyncio
async def test_list_quick_replies_seeds_defaults_on_empty():
    app.dependency_overrides[get_current_user] = lambda: user_a_auth
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.get("/api/v1/whatsapp/quick-replies")

    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 5
    shortcuts = [item["shortcut"] for item in data["items"]]
    assert "/merhaba" in shortcuts
    assert "/fiyat" in shortcuts
    assert "/katalog" in shortcuts
    assert "/iban" in shortcuts
    assert "/konum" in shortcuts


@pytest.mark.asyncio
async def test_create_quick_reply_success():
    app.dependency_overrides[get_current_user] = lambda: user_a_auth
    transport = ASGITransport(app=app)

    payload = {
        "shortcut": "randevu",  # test auto-prefix with '/'
        "title": "Randevu Talebi",
        "content": "Merhaba {isim}, müsait olduğunuz bir randevu saatini belirtebilir misiniz?",
        "category": "Satış",
        "variables": [{"key": "isim", "label": "Müşteri Adı"}],
    }

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post("/api/v1/whatsapp/quick-replies", json=payload)

    assert res.status_code == 201
    created = res.json()
    assert created["shortcut"] == "/randevu"
    assert created["title"] == "Randevu Talebi"
    assert created["category"] == "Satış"
    assert len(created["variables"]) == 1


@pytest.mark.asyncio
async def test_create_quick_reply_duplicate_shortcut():
    app.dependency_overrides[get_current_user] = lambda: user_a_auth
    transport = ASGITransport(app=app)

    payload = {
        "shortcut": "/indirim",
        "title": "İndirim Kodu",
        "content": "Özel %10 indiriminiz tanımlandı.",
    }

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res1 = await ac.post("/api/v1/whatsapp/quick-replies", json=payload)
        assert res1.status_code == 201

        # Duplicate shortcut attempt
        res2 = await ac.post("/api/v1/whatsapp/quick-replies", json=payload)
        assert res2.status_code == 409
        assert "zaten kullanımda" in res2.json()["detail"]


@pytest.mark.asyncio
async def test_create_quick_reply_validation_errors():
    app.dependency_overrides[get_current_user] = lambda: user_a_auth
    transport = ASGITransport(app=app)

    # Empty content
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(
            "/api/v1/whatsapp/quick-replies",
            json={"shortcut": "/test", "title": "Başlık", "content": "  "},
        )
        assert res.status_code == 422

    # Empty title
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res = await ac.post(
            "/api/v1/whatsapp/quick-replies",
            json={"shortcut": "/test", "title": "", "content": "İçerik"},
        )
        assert res.status_code == 422


@pytest.mark.asyncio
async def test_update_and_delete_quick_reply():
    app.dependency_overrides[get_current_user] = lambda: user_a_auth
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Create
        c_res = await ac.post(
            "/api/v1/whatsapp/quick-replies",
            json={"shortcut": "/eski", "title": "Eski Başlık", "content": "Eski içerik"},
        )
        qr_id = c_res.json()["id"]

        # Update
        u_res = await ac.patch(
            f"/api/v1/whatsapp/quick-replies/{qr_id}",
            json={"title": "Yeni Başlık", "shortcut": "/yeni"},
        )
        assert u_res.status_code == 200
        assert u_res.json()["title"] == "Yeni Başlık"
        assert u_res.json()["shortcut"] == "/yeni"

        # Delete
        d_res = await ac.delete(f"/api/v1/whatsapp/quick-replies/{qr_id}")
        assert d_res.status_code == 200
        assert d_res.json()["success"] is True

        # Second delete -> 404
        d2_res = await ac.delete(f"/api/v1/whatsapp/quick-replies/{qr_id}")
        assert d2_res.status_code == 404


@pytest.mark.asyncio
async def test_multi_tenant_authorization_isolation():
    transport = ASGITransport(app=app)

    # 1. User A creates a quick reply
    app.dependency_overrides[get_current_user] = lambda: user_a_auth
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res_a = await ac.post(
            "/api/v1/whatsapp/quick-replies",
            json={"shortcut": "/ozel", "title": "A'nın Özel Şablonu", "content": "Gizli Bilgi A"},
        )
        assert res_a.status_code == 201
        qr_a_id = res_a.json()["id"]

    # 2. User B tries to update User A's quick reply -> 404 Not Found
    app.dependency_overrides[get_current_user] = lambda: user_b_auth
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        res_b_update = await ac.patch(
            f"/api/v1/whatsapp/quick-replies/{qr_a_id}",
            json={"title": "Hacked Title"},
        )
        assert res_b_update.status_code == 404

        # User B tries to delete User A's quick reply -> 404 Not Found
        res_b_delete = await ac.delete(f"/api/v1/whatsapp/quick-replies/{qr_a_id}")
        assert res_b_delete.status_code == 404

        # User B CAN create the SAME shortcut `/ozel` without conflict!
        res_b_create = await ac.post(
            "/api/v1/whatsapp/quick-replies",
            json={"shortcut": "/ozel", "title": "B'nin Özel Şablonu", "content": "B'nin İçeriği"},
        )
        assert res_b_create.status_code == 201
        assert res_b_create.json()["title"] == "B'nin Özel Şablonu"
