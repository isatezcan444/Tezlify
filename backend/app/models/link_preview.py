from datetime import datetime

from sqlalchemy import Column, DateTime, Index, Integer, String, Text

from backend.app.core.database import Base
from backend.app.core.datetime_utils import utc_now_naive


class LinkPreview(Base):
    """Bir URL icin sunucu tarafinda cozulmus onizleme (OpenGraph vb.).

    Neden tablo (bellek degil)
    --------------------------
    Onizleme, mesajin PARCASI degildir: ayni URL yuzlerce mesajda gecebilir ve
    sonuc aynidir. Bellekte tutmak iki seyi bozardi — (1) her backend restart'i
    tum onizlemeleri kaybeder ve sohbet yeniden acildiginda her link icin
    yeniden DIS ISLEM yapilir; (2) ayni linki 50 kisinin paylastigi bir kiracida
    ayni URL 50 kez cekilir. Tablo, hem restart'i hem N+1 dis istegini kapatir.

    `url_hash` neden var
    --------------------
    Tekillik `url` sutunu uzerinde kurulamaz: URL'ler TEXT'tir ve bazi lehcelerde
    (MySQL) uzun TEXT sutununa benzersiz indeks kurulamaz; ayrica 2000+
    karakterlik URL'lerde indeks sismesi olur. sha256 hex (64 karakter) sabit
    boyutludur ve normalize edilmis URL'in kimligidir.

    `status` neden OK/FAILED ayrimi tasir
    --------------------------------------
    BASARISIZLIK da onbelleklenir. Aksi halde olu bir link her sohbet
    acilisinda yeniden denenir ve kullanici her seferinde ayni gecikmeyi oder.
    Negatif kaydin TTL'i pozitiften KISADIR (bkz. service.py): site bir gun
    duzelirse onizleme de duzelmelidir.

    `kind` neden sutun
    ------------------
    Arayuzun hangi karti cizecegini belirler (link / video / gorsel / belge).
    Bunu istemcide URL deseninden tahmin etmek, sunucunun zaten bildigi bir
    bilgiyi ikinci bir yerde yeniden turetmek olurdu — ve iki kopya kacinilmaz
    olarak birbirinden sapar.
    """

    __tablename__ = "link_previews"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Normalize edilmis URL'in sha256'si (hex). Tekillik burada kurulur.
    url_hash = Column(String(64), nullable=False, unique=True, index=True)
    # Fiilen cekilen (normalize edilmis) URL. Teshis icin SAKLANIR: hash'ten
    # geri donulemez ve "hangi adrese gittik" sorusu log olmadan cevaplanamaz.
    url = Column(Text, nullable=False)
    # "OK" | "FAILED" — basarisizlik da bir SONUCTUR, yokluk degil.
    status = Column(String(16), nullable=False, default="OK", index=True)
    # "LINK" | "VIDEO" | "IMAGE" | "DOCUMENT"
    kind = Column(String(16), nullable=False, default="LINK")
    title = Column(String(512), nullable=True)
    description = Column(Text, nullable=True)
    site_name = Column(String(255), nullable=True)
    # Uzak gorsel adresi. Istemciye HAM verilmez; kimlik dogrulamali proxy
    # uzerinden sunulur (hotlink kullanicinin IP'sini sizdirir).
    image_url = Column(Text, nullable=True)
    # Yalnizca izin listesindeki saglayicilar icin (YouTube/Vimeo) doldurulur.
    embed_url = Column(Text, nullable=True)
    # Basarisizlik nedeni (kisa). Kullaniciya gosterilmez, teshis icin.
    error = Column(String(255), nullable=True)

    fetched_at = Column(DateTime, default=utc_now_naive, nullable=False)
    expires_at = Column(DateTime, nullable=True, index=True)

    __table_args__ = (
        # Sohbet acilisi "su URL'lerin onizlemesi var mi" diye toplu sorar; bu
        # indeks o sorguyu hash aramasina cevirir (tam tarama degil).
        Index("idx_link_preview_status_expires", "status", "expires_at"),
    )
