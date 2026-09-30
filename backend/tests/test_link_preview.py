"""SSRF korumali link onizleme — guvenlik, ayristirma ve onbellek sozlesmeleri.

Sozlesmeler
-----------
1. **Ozel/ayrilmis adresler reddedilir.** Loopback, RFC1918, link-local
   (bulut metadata dahil), ULA, multicast, ayrilmis, belirtilmemis ve
   IPv4-esli IPv6 bicimleri. Kontrol ANA MAKINE ADI uzerinde degil, COZULEN
   IP uzerinde yapilir; `localhost`u engellemek `localtest.me`i engellemez.
2. **Kodlanmis sayisal ana makineler cozumlemeden ONCE reddedilir.** Canli
   olarak olculdu (2026-09-30): `http://0177.0.0.1/` korumadan GECIYORDU,
   cunku bazi isletim sistemleri bu bicimi IP saymaz ve DNS'e sorar; DNS genel
   bir adres dondurunce kontrol izin veriyordu.
3. **Yonlendirmeler elle takip edilir ve her adim yeniden dogrulanir.** Aksi
   halde ilk dogrulamadan sonra ozel bir adrese atlanabilir.
4. **YouTube sayfasi KAZINMAZ**: kimlik URL'den cikar, kapak ve gomme adresi
   deterministik uretilir (tek bir dis istek yok).
5. **Onizleme istek yolunda ASLA cekilmez.** `previews_by_message` yalnizca
   onbellekten okur ve eksikleri arka plana birakir — `chat_open` ucuna bir
   HTTP cagrisi koymak sohbet acilisini saniyelere cikarirdi.
6. **Istemciye uzak gorsel adresi verilmez**, hash tabanli proxy yolu verilir;
   boylece proxy acik bir aktarima donusmez.
7. **Basarisizlik da onbelleklenir** (kisa TTL), ama kart cizilmez.
8. **Yanit modeli serilestirilen anahtarlari DUSURMEZ.** `serialize_message`
   `link_preview` uretir; `WhatsAppMessageItem` bu alani bildirmezse Pydantic
   v2 (varsayilan `extra="ignore"`) degeri SESSIZCE atar ve onizleme uctan
   hic cikmaz. Bu tam olarak canli ortamda yasandi (2026-09-30): tabloda
   `status=OK` satirlar varken `GET /conversations/{id}/messages` yanitinda
   `link_preview` anahtari YOKTU. Ayni hata `WhatsAppSessionResponse.sync`
   icin de yasanmis ve orada yorumla isaretlenmisti (A8).

Bu dosyadaki ayristirma ve URL testleri AG GEREKTIRMEZ; DNS'e bagli olanlar
`socket.getaddrinfo` monkeypatch'i ile deterministik hale getirilir.
"""

import shutil
import socket
import tempfile
from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.core.database import Base
from backend.app.models.link_preview import LinkPreview
from backend.app.services.link_preview import service as preview_service
from backend.app.services.link_preview.ssrf import (
    UnsafeUrlError,
    is_public_ip,
    resolve_and_validate,
    validate_url,
)
from backend.app.services.link_preview.unfurl import UnfurlError, parse_html
from backend.app.services.link_preview.urls import (
    classify_url,
    extract_first_url,
    instagram_shortcode,
    normalize_url,
    url_hash,
    youtube_embed,
    youtube_thumbnail,
    youtube_video_id,
)

import ipaddress


# ---------------------------------------------------------------------------
# DNS: deterministik hale getirilmis cozumleme (ag YOK)
# ---------------------------------------------------------------------------


def _fake_getaddrinfo(mapping):
    """`socket.getaddrinfo` yerine gecen sahte cozumleyici."""

    def _inner(host, port, *args, **kwargs):
        key = str(host).lower()
        if key not in mapping:
            raise socket.gaierror(f"cozulemedi: {host}")
        answers = []
        for ip in mapping[key]:
            family = socket.AF_INET6 if ":" in ip else socket.AF_INET
            answers.append((family, socket.SOCK_STREAM, 6, "", (ip, port or 443)))
        return answers

    return _inner


# ---------------------------------------------------------------------------
# 1-3. SSRF korumasi
# ---------------------------------------------------------------------------

_INTERNAL_IPS = [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",  # bulut metadata
    "100.64.0.1",  # CGNAT
    "192.0.0.1",
    "198.18.0.1",  # benchmarking blogu
    "240.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",  # IPv4-esli IPv6 geri dongu
]


@pytest.mark.parametrize("raw", _INTERNAL_IPS)
def test_is_public_ip_rejects_internal_and_reserved(raw):
    assert is_public_ip(ipaddress.ip_address(raw)) is False


@pytest.mark.parametrize("raw", ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"])
def test_is_public_ip_accepts_globally_routable(raw):
    assert is_public_ip(ipaddress.ip_address(raw)) is True


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com/",
        "data:text/html,<h1>x</h1>",
        "javascript:alert(1)",
    ],
)
def test_validate_url_rejects_non_http_schemes(url):
    with pytest.raises(UnsafeUrlError):
        validate_url(url)


@pytest.mark.parametrize(
    "url",
    [
        # Her biri gercek bir saldiri bicimi. `2130706433` ve `0x7f000001`
        # sayisal/hex kodlanmis IPv4; `0177.0.0.1` sekizlik gorunumlu;
        # `127.1` inet_aton'un kisa bicimi.
        "http://127.0.0.1/",
        "http://2130706433/",
        "http://0x7f000001/",
        "http://0177.0.0.1/",
        "http://127.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://localhost/",
        "http://0.0.0.0/",
    ],
)
def test_validate_url_rejects_local_targets_without_dns(url):
    """Bu girdiler cozumleme GEREKTIRMEZ; koruma DNS'ten once devreye girer."""
    with pytest.raises(UnsafeUrlError):
        validate_url(url)


def test_resolve_rejects_hostname_that_resolves_to_private(monkeypatch):
    """`localhost`u engellemek yetmez: genel alan adlari da ic agi gosterebilir."""
    monkeypatch.setattr(
        socket, "getaddrinfo", _fake_getaddrinfo({"localtest.me": ["127.0.0.1"]})
    )
    with pytest.raises(UnsafeUrlError):
        validate_url("http://localtest.me/")


def test_resolve_rejects_when_any_answer_is_private(monkeypatch):
    """Karisik cevap (genel + ozel) REDDEDILIR.

    Bir alan adi hem genel hem ozel adrese cozulebiliyorsa, "hangisi once
    gelirse" ona gore davranmak korumayi sans isine cevirirdi.
    """
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        _fake_getaddrinfo({"evil.example": ["93.184.216.34", "10.0.0.7"]}),
    )
    with pytest.raises(UnsafeUrlError):
        resolve_and_validate("evil.example")


def test_resolve_accepts_public_host(monkeypatch):
    monkeypatch.setattr(
        socket, "getaddrinfo", _fake_getaddrinfo({"example.com": ["93.184.216.34"]})
    )
    assert resolve_and_validate("example.com") == ["93.184.216.34"]


def test_resolve_rejects_unresolvable_host(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo({}))
    with pytest.raises(UnsafeUrlError):
        resolve_and_validate("does-not-exist.example")


def test_resolve_rejects_single_label_hosts():
    """`localhost` ve ic servis adlari genel internette bulunmaz."""
    with pytest.raises(UnsafeUrlError):
        resolve_and_validate("intranet")


def test_ambiguous_numeric_host_is_rejected_before_dns(monkeypatch):
    """Belirsiz sayisal bicimler DNS'e SORULMADAN reddedilir.

    Bu testin varlik sebebi bir canli olcumdur: `http://0177.0.0.1/`
    korumadan geciyordu, cunku macOS bu bicimi IP saymayip DNS'e soruyor ve
    DNS genel bir adres dondurunce kontrol izin veriyordu. Cozumleme
    cagrilirsa test KIRILIR — yani koruma gercekten cozumlemeden once calisir.
    """
    called = {"count": 0}

    def _explode(*args, **kwargs):
        called["count"] += 1
        raise AssertionError("belirsiz sayisal ana makine icin DNS cagrilmamali")

    monkeypatch.setattr(socket, "getaddrinfo", _explode)
    for host in ("0177.0.0.1", "2130706433", "0x7f000001", "127.1"):
        with pytest.raises(UnsafeUrlError):
            validate_url(f"http://{host}/")
    assert called["count"] == 0


# ---------------------------------------------------------------------------
# URL cikarma / normalizasyon
# ---------------------------------------------------------------------------


def test_extract_first_url_returns_none_without_url():
    assert extract_first_url("merhaba, nasilsin?") is None
    assert extract_first_url(None) is None
    assert extract_first_url("") is None


def test_extract_first_url_strips_sentence_punctuation():
    assert extract_first_url("bak: https://example.com/x.") == "https://example.com/x"
    assert extract_first_url("(https://example.com/y)") == "https://example.com/y"


def test_extract_first_url_keeps_balanced_parentheses():
    """Wikipedia baglantilari mesru olarak `)` icerir."""
    url = "https://tr.wikipedia.org/wiki/Foo_(bar)"
    assert extract_first_url(f"bkz {url}") == url


def test_extract_first_url_adds_scheme_to_www():
    assert extract_first_url("www.example.com/x") == "https://www.example.com/x"


def test_extract_first_url_takes_only_the_first():
    assert extract_first_url("https://a.com/1 ve https://b.com/2") == "https://a.com/1"


def test_normalize_lowercases_host_and_drops_default_port():
    assert normalize_url("HTTPS://Example.COM:443/x") == "https://example.com/x"
    assert normalize_url("http://Example.COM:80/x") == "http://example.com/x"


def test_normalize_keeps_non_default_port():
    assert normalize_url("http://example.com:8080/x") == "http://example.com:8080/x"


def test_normalize_drops_fragment():
    assert normalize_url("https://example.com/x#bolum") == "https://example.com/x"


def test_normalize_preserves_query_verbatim():
    """Imzali URL'lerin sorgusu AYNEN korunur.

    `utm_*` temizligi yaygin bir "iyilestirme"dir ama imzali baglantilarda tek
    bir parametreyi silmek linki 404'e cevirir. Bu yuzden sorguya dokunulmaz.
    """
    url = "https://cdn.example.com/f.pdf?X-Amz-Signature=abc123&utm_source=x"
    assert normalize_url(url) == url


def test_normalize_collapses_root_slash_only():
    assert normalize_url("https://example.com/") == "https://example.com"
    assert normalize_url("https://example.com/a/") == "https://example.com/a/"


def test_normalize_rejects_unsupported_scheme():
    assert normalize_url("ftp://example.com/x") is None
    assert normalize_url("javascript:alert(1)") is None
    # Sema benzeri onek + PORT DEGIL: `mailto:x@y.com` naif bir `https://`
    # onekiyle gecerli URL gibi ayristirilirdi (ana makine `y.com`).
    assert normalize_url("mailto:someone@example.com") is None
    assert normalize_url("data:text/html,<h1>x</h1>") is None


def test_normalize_keeps_host_port_without_scheme():
    """`example.com:8080/x` bir SEMA degil, ana makine:port'tur."""
    assert normalize_url("example.com:8080/x") == "https://example.com:8080/x"


def test_same_url_normalizes_to_same_hash():
    assert url_hash(normalize_url("HTTPS://Example.com:443/a?b=1#c")) == url_hash(
        normalize_url("https://example.com/a?b=1")
    )


# ---------------------------------------------------------------------------
# 4. YouTube / Instagram — kazima YOK
# ---------------------------------------------------------------------------

_YT_ID = "dQw4w9WgXcQ"


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.youtube.com/watch?v={_YT_ID}",
        f"https://youtube.com/watch?v={_YT_ID}&t=42",
        f"https://youtu.be/{_YT_ID}",
        f"https://www.youtube.com/shorts/{_YT_ID}",
        f"https://www.youtube.com/embed/{_YT_ID}",
        f"https://m.youtube.com/watch?v={_YT_ID}",
    ],
)
def test_youtube_id_is_extracted_from_every_common_form(url):
    assert youtube_video_id(normalize_url(url)) == _YT_ID


def test_youtube_id_is_none_for_non_video_urls():
    assert youtube_video_id(normalize_url("https://www.youtube.com/channel/abc")) is None
    assert youtube_video_id(normalize_url("https://example.com/watch?v=short")) is None


def test_youtube_helpers_are_deterministic():
    assert youtube_thumbnail(_YT_ID) == f"https://i.ytimg.com/vi/{_YT_ID}/hqdefault.jpg"
    # `nocookie` secildi: gomme cerez yazmaz.
    assert youtube_embed(_YT_ID) == f"https://www.youtube-nocookie.com/embed/{_YT_ID}"


@pytest.mark.parametrize(
    "url",
    [
        "https://www.instagram.com/p/ABC123/",
        "https://instagram.com/reel/XYZ789/",
        "https://www.instagram.com/tv/QQQ111/",
    ],
)
def test_instagram_shortcode_is_extracted(url):
    assert instagram_shortcode(normalize_url(url)) is not None


def test_instagram_shortcode_is_none_for_profile_url():
    assert instagram_shortcode(normalize_url("https://www.instagram.com/someuser/")) is None


# ---------------------------------------------------------------------------
# Tur siniflandirmasi
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url,expected",
    [
        (f"https://youtu.be/{_YT_ID}", "VIDEO"),
        ("https://www.instagram.com/p/ABC123/", "VIDEO"),
        ("https://example.com/rapor.pdf", "DOCUMENT"),
        ("https://example.com/sozlesme.docx", "DOCUMENT"),
        ("https://example.com/foto.png", "IMAGE"),
        ("https://example.com/haber", "LINK"),
    ],
)
def test_classify_url(url, expected):
    assert classify_url(normalize_url(url)) == expected


# ---------------------------------------------------------------------------
# OpenGraph ayristirma (ag YOK — sabit HTML)
# ---------------------------------------------------------------------------

_OG_HTML = """
<!doctype html><html><head>
<meta property="og:title" content="Baslik" />
<meta property="og:description" content="Aciklama" />
<meta property="og:site_name" content="Ornek" />
<meta property="og:image" content="/kapak.png" />
<title>Yedek</title>
</head><body>x</body></html>
"""


def test_parse_html_reads_opengraph_and_absolutizes_relative_image():
    parsed = parse_html(_OG_HTML, "https://example.com/haber/1")
    assert parsed["title"] == "Baslik"
    assert parsed["description"] == "Aciklama"
    assert parsed["site_name"] == "Ornek"
    # Goreceli gorsel adresi MUTLAKLASTIRILIR; aksi halde proxy onu kendi
    # adresimiz sanip 404 uretirdi.
    assert parsed["image_url"] == "https://example.com/kapak.png"


def test_parse_html_falls_back_to_title_tag():
    parsed = parse_html(
        "<html><head><title>Yalnizca baslik</title></head></html>", "https://a.com/"
    )
    assert parsed["title"] == "Yalnizca baslik"
    # site_name yoksa ana makine adi kullanilir (bos kart cizilmesin).
    assert parsed["site_name"] == "a.com"


def test_parse_html_uses_twitter_card_when_opengraph_absent():
    parsed = parse_html(
        '<html><head><meta name="twitter:title" content="Tw" /></head></html>',
        "https://a.com/",
    )
    assert parsed["title"] == "Tw"


def test_parse_html_raises_when_nothing_to_preview():
    with pytest.raises(UnfurlError):
        parse_html("<html><head></head><body>bos</body></html>", "https://a.com/")


# ---------------------------------------------------------------------------
# 5-7. Onbellek ve serilestirme (izole SQLite, ag YOK)
# ---------------------------------------------------------------------------


class _Row:
    """`previews_by_message` yalnizca `id` ve `body` okur; tam ORM satiri
    kurmak testi gereksiz yere agirlastirirdi."""

    def __init__(self, id: int, body: str) -> None:
        self.id = id
        self.body = body


@pytest_asyncio.fixture
async def preview_db():
    """Izole SQLite (ag YOK).

    `tmp_path` yerine `tempfile.mkdtemp` kullanilir: bu ortamda pytest'in
    `tmp_path` fabrikasi ikinci kosumda EEXIST ile patliyor ve butun kosumu
    fixture kurulumunda dusuruyor.
    """
    directory = tempfile.mkdtemp(prefix="tezlify-preview-")
    engine = create_async_engine(f"sqlite+aiosqlite:///{directory}/preview.db")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield sessions
    finally:
        await engine.dispose()
        shutil.rmtree(directory, ignore_errors=True)


@pytest.mark.asyncio
async def test_cached_ok_preview_is_returned_without_any_fetch(preview_db, monkeypatch):
    """Isabet: TEK sorgu, hicbir dis istek, hicbir arka plan isi."""
    scheduled = []
    monkeypatch.setattr(
        preview_service, "schedule_unfurl", lambda d, u: scheduled.append(d)
    )

    url = normalize_url("https://example.com/haber")
    digest = url_hash(url)
    async with preview_db() as db:
        db.add(
            LinkPreview(
                url_hash=digest,
                url=url,
                status="OK",
                kind="LINK",
                title="Baslik",
                description="Aciklama",
                site_name="Ornek",
                image_url="https://example.com/kapak.png",
                fetched_at=datetime.utcnow(),
                expires_at=datetime.utcnow() + timedelta(days=1),
            )
        )
        await db.commit()

        result = await preview_service.previews_by_message(
            db, [_Row(1, "bak https://example.com/haber")]
        )

    assert 1 in result
    assert result[1]["title"] == "Baslik"
    assert result[1]["kind"] == "LINK"
    # Uzak gorsel adresi istemciye VERILMEZ; hash tabanli proxy yolu verilir.
    assert result[1]["image_url"] == f"/api/v1/whatsapp/link-preview/image?u={digest}"
    assert "example.com/kapak.png" not in result[1]["image_url"]
    assert scheduled == []


@pytest.mark.asyncio
async def test_failed_preview_is_cached_but_renders_no_card(preview_db, monkeypatch):
    """Basarisizlik onbelleklenir (yeniden denenmesin) ama kart cizilmez."""
    scheduled = []
    monkeypatch.setattr(
        preview_service, "schedule_unfurl", lambda d, u: scheduled.append(d)
    )

    url = normalize_url("https://example.com/olu")
    async with preview_db() as db:
        db.add(
            LinkPreview(
                url_hash=url_hash(url),
                url=url,
                status="FAILED",
                error="HTTP 404",
                fetched_at=datetime.utcnow(),
                expires_at=datetime.utcnow() + timedelta(hours=1),
            )
        )
        await db.commit()
        result = await preview_service.previews_by_message(
            db, [_Row(1, "https://example.com/olu")]
        )

    assert result == {}
    # Taze negatif kayit YENIDEN DENENMEZ.
    assert scheduled == []


@pytest.mark.asyncio
async def test_missing_url_schedules_background_work_and_returns_nothing(
    preview_db, monkeypatch
):
    """Isabetsizlik: bu turda onizleme YOK, is arka plana birakilir.

    Bu, "sohbet acilisinda dis istek yok" sozlesmesinin dogrudan testidir.
    """
    scheduled = []
    monkeypatch.setattr(
        preview_service, "schedule_unfurl", lambda d, u: scheduled.append(u)
    )

    async with preview_db() as db:
        result = await preview_service.previews_by_message(
            db, [_Row(7, "https://example.com/yeni")]
        )

    assert result == {}
    assert scheduled == ["https://example.com/yeni"]


@pytest.mark.asyncio
async def test_expired_ok_preview_is_not_served_and_is_rescheduled(
    preview_db, monkeypatch
):
    """TTL gecmisse bayat onizleme GOSTERILMEZ."""
    scheduled = []
    monkeypatch.setattr(
        preview_service, "schedule_unfurl", lambda d, u: scheduled.append(u)
    )

    url = normalize_url("https://example.com/bayat")
    async with preview_db() as db:
        db.add(
            LinkPreview(
                url_hash=url_hash(url),
                url=url,
                status="OK",
                title="Bayat",
                fetched_at=datetime.utcnow() - timedelta(days=30),
                expires_at=datetime.utcnow() - timedelta(days=1),
            )
        )
        await db.commit()
        result = await preview_service.previews_by_message(
            db, [_Row(1, "https://example.com/bayat")]
        )

    assert result == {}
    assert scheduled == ["https://example.com/bayat"]


@pytest.mark.asyncio
async def test_same_url_twice_on_one_page_schedules_once(preview_db, monkeypatch):
    """Ayni URL sayfada iki kez gecerse TEK arka plan isi baslatilir."""
    scheduled = []
    monkeypatch.setattr(
        preview_service, "schedule_unfurl", lambda d, u: scheduled.append(u)
    )

    async with preview_db() as db:
        await preview_service.previews_by_message(
            db,
            [
                _Row(1, "https://example.com/ayni"),
                _Row(2, "tekrar https://example.com/ayni"),
            ],
        )

    assert scheduled == ["https://example.com/ayni"]


@pytest.mark.asyncio
async def test_messages_without_urls_are_ignored(preview_db, monkeypatch):
    scheduled = []
    monkeypatch.setattr(
        preview_service, "schedule_unfurl", lambda d, u: scheduled.append(u)
    )
    async with preview_db() as db:
        result = await preview_service.previews_by_message(
            db, [_Row(1, "selam"), _Row(2, None)]
        )
    assert result == {}
    assert scheduled == []


@pytest.mark.asyncio
async def test_ensure_preview_stores_ssrf_rejection_as_negative_cache(
    preview_db, monkeypatch
):
    """Guvenlik reddi bir SONUCTUR: kaydedilir, boylece ayni saldiri tekrar
    tekrar denenip her seferinde cozumleme yapmaz."""
    async def _refuse(url):
        raise UnsafeUrlError("Ozel adres reddedildi")

    monkeypatch.setattr(preview_service, "unfurl", _refuse)

    url = normalize_url("http://169.254.169.254/latest/meta-data/")
    async with preview_db() as db:
        row = await preview_service.ensure_preview(db, url)

    assert row is not None
    assert row.status == "FAILED"
    assert row.image_url is None
    assert row.expires_at is not None


# ---------------------------------------------------------------------------
# 8. KONTRAKT: yanit modeli serilestirilen anahtarlari DUSURMEMELI
# ---------------------------------------------------------------------------


def _serialized_message(preview=None):
    from backend.app.models.message import Message
    from backend.app.services.whatsapp.orchestration.messaging import serialize_message

    row = Message()
    row.id = 105284
    row.conversation_id = 17748
    return serialize_message(row, preview=preview)


def test_serialize_message_always_emits_link_preview_key():
    """Anahtar HER ZAMAN bulunur; `None` = onizleme yok/hazir degil."""
    payload = _serialized_message()
    assert "link_preview" in payload
    assert payload["link_preview"] is None


def test_response_model_preserves_link_preview():
    """ASIL REGRESYON (canli 2026-09-30).

    FastAPI `response_model`u uygularken tam olarak bunu yapar: sozlugu
    modele dogrular ve `model_dump()` ile disari verir. Alan modelde
    bildirilmemisse bu adimda sessizce kaybolur.
    """
    from backend.app.schemas.whatsapp import WhatsAppMessagesResponse

    preview = {
        "url": "https://youtu.be/PLXSVsDUisg?si=vS-3zTyni-kW0APB",
        "kind": "VIDEO",
        "title": "Ornek Video",
        "description": "Aciklama",
        "site_name": "YouTube",
        "image_url": "/api/v1/whatsapp/link-preview/image?u=8a312a527d97",
        "embed_url": "https://www.youtube-nocookie.com/embed/PLXSVsDUisg",
    }
    dumped = WhatsAppMessagesResponse(
        messages=[_serialized_message(preview=preview)]
    ).model_dump()

    survived = dumped["messages"][0]["link_preview"]
    assert survived is not None, (
        "link_preview yanit modelinden DUSTU: `WhatsAppMessageItem` alani "
        "bildirmiyor (Pydantic v2 `extra='ignore'`)."
    )
    assert survived["kind"] == "VIDEO"
    assert survived["site_name"] == "YouTube"
    assert survived["embed_url"].endswith("/embed/PLXSVsDUisg")
    # Istemciye HAM uzak gorsel adresi degil proxy yolu gider.
    assert survived["image_url"].startswith("/api/v1/whatsapp/link-preview/image?u=")


def test_every_serialized_key_is_declared_on_the_response_model():
    """Sinifin tamamini kapatan koruma.

    Tek tek alan eklemek yerine sozlesmeyi burada tutuyoruz: serilestiricinin
    urettigi bir anahtar modelde yoksa yanittan duser. `link_preview` ve
    `sync` bu sekilde kaybolmustu; bir daha kaybolmasin.
    """
    from backend.app.schemas.whatsapp import WhatsAppMessageItem

    produced = set(_serialized_message().keys())
    declared = set(WhatsAppMessageItem.model_fields.keys())
    missing = sorted(produced - declared)
    assert not missing, (
        f"`serialize_message` bu anahtarlari uretiyor ama `WhatsAppMessageItem` "
        f"bildirmiyor, yani yanittan DUSECEKLER: {missing}"
    )


# ---------------------------------------------------------------------------
# 9. ONAM (consent) ARA SAYFASI: yanlis baslik yerine DURUST basarisizlik
# ---------------------------------------------------------------------------

# Google, veri merkezi IP'lerine gercek icerik yerine bu ara sayfayi doner.
# Basligi gercek sanmak, kullaniciya paylasilan icerigin basligi diye
# "... devam etmeden once" gostermek olurdu.
_CONSENT_HTML = (
    "<html><head>"
    '<meta property="og:title" content="Google Haritalar&#39;a devam etmeden once" />'
    "<title>Google Haritalar'a devam etmeden once</title>"
    "</head><body></body></html>"
)


@pytest.mark.parametrize(
    "final_url,expected",
    [
        ("https://consent.google.com/m?continue=x", True),
        ("https://consent.youtube.com/m?continue=x", True),
        ("https://www.google.com/maps", False),
        ("https://maps.google.com/", False),
        # "consent" ile BASLAYAN baska bir alan adi da ara sayfa sayilir.
        ("https://consent.example.com/", True),
        # Ama icinde "consent" gecen mesru bir alan adi sayilmaz.
        ("https://myconsent.com/", False),
    ],
)
def test_consent_host_detection(final_url, expected):
    from backend.app.services.link_preview.unfurl import _is_consent_interstitial

    assert _is_consent_interstitial(final_url) is expected


@pytest.mark.asyncio
async def test_unfurl_rejects_consent_interstitial(monkeypatch):
    """Ara sayfa bir SONUC degil, BASARISIZLIK olmali."""
    from backend.app.services.link_preview import unfurl as unfurl_module

    async def fake_fetch(_url):
        return _CONSENT_HTML, "https://consent.google.com/m?continue=abc"

    monkeypatch.setattr(unfurl_module, "_fetch_html", fake_fetch)

    with pytest.raises(UnfurlError) as exc:
        await unfurl_module.unfurl("https://maps.app.goo.gl/qDxmw6vwCppGAixm8")

    # Teshis icin son ana makine hatada gorunur.
    assert "consent.google.com" in str(exc.value)


@pytest.mark.asyncio
async def test_unfurl_parses_normally_when_no_consent_redirect(monkeypatch):
    """Kontrol grubu: ara sayfa YOKSA normal ayristirma bozulmamis olmali."""
    from backend.app.services.link_preview import unfurl as unfurl_module

    async def fake_fetch(_url):
        return _OG_HTML, "https://example.com/haber/1"

    monkeypatch.setattr(unfurl_module, "_fetch_html", fake_fetch)

    parsed = await unfurl_module.unfurl("https://example.com/haber/1")
    assert parsed["title"] == "Baslik"
    assert parsed["site_name"] == "Ornek"
