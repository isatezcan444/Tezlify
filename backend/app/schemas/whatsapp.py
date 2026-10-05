"""API şemaları: WhatsApp gateway entegrasyonu (Aşama 2).

Kontratlar; whatsapp-gateway REST yanıtları ile frontend
`frontend/src/types/index.ts` WhatsApp tipleriyle uyumlu tutulur.
"""
from typing import Dict, List, Optional, Any
from datetime import datetime

from pydantic import BaseModel, Field


class WhatsAppSessionCreate(BaseModel):
    name: str = Field(default="WhatsApp Hatti", max_length=150)


class WhatsAppSessionResponse(BaseModel):
    id: int
    session_name: str
    status: str
    phone_number: Optional[str] = None
    is_active: bool = True
    is_phone_online: bool = False
    battery_level: Optional[int] = None
    qr_code: Optional[str] = None
    error_message: Optional[str] = None
    # A8: `_list_sessions_internal` computes d["sync"] per session; without this
    # field the list endpoint's response_model silently stripped it.
    sync: Optional[Dict[str, Any]] = None
    # Faz 14: hattin ilk senkronu tamamlandi mi (kalici). UI, QR sonrasi canli
    # sohbetleri bu alan `True` olana kadar kapali tutar — WhatsApp Web paritesi.
    # response_model bu alani listelemezse sessizce silinir (bkz. A8 notu).
    initial_sync_completed: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class WhatsAppSessionListResponse(BaseModel):
    sessions: List[WhatsAppSessionResponse] = Field(default_factory=list)


class WhatsAppQrResponse(BaseModel):
    status: str
    qr_code: Optional[str] = None
    phone: Optional[str] = None
    error_message: Optional[str] = None


class WhatsAppPairingStartRequest(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)


class WhatsAppPairingStartResponse(BaseModel):
    pair_token: str
    gateway_id: str
    session_name: str
    status: str
    qr_code: Optional[str] = None


class WhatsAppPairingQrResponse(BaseModel):
    status: str
    qr_code: Optional[str] = None
    phone: Optional[str] = None
    session_id: Optional[int] = None
    error_message: Optional[str] = None


class WhatsAppAvatarRefreshResponse(BaseModel):
    success: bool
    phone: str
    avatar_url: Optional[str] = None
    error: Optional[str] = None


class WhatsAppAvatarBackfillResponse(BaseModel):
    """Toplu avatar backfill tetikleyicisinin GERÇEK sonucu.

    `missing`: gateway belleğinde avatarı hâlâ olmayan sohbet sayısı.
    Gateway sweep'i eksik kalmayana dek backoff'lu turlarla çalıştırır.
    """

    success: bool = True
    missing: int = 0


class WhatsAppPairingCodeRequest(BaseModel):
    phone: str = Field(min_length=7, max_length=24, description="Ülke kodu dahil telefon (örn. +90 5XX XXX XX XX)")


class WhatsAppPairingCodeResponse(BaseModel):
    success: bool = True
    pairing_code: Optional[str] = None
    phone: Optional[str] = None
    error_message: Optional[str] = None


class WhatsAppContact(BaseModel):
    id: str
    phone: Optional[str] = None
    name: Optional[str] = None
    avatar_url: Optional[str] = None


class WhatsAppContactListResponse(BaseModel):
    contacts: List[WhatsAppContact] = Field(default_factory=list)


class WhatsAppReactionItem(BaseModel):
    """Bir mesaja birakilan tek bir ifade (kisi basina tek).

    `emoji` burada HER ZAMAN doludur; geri cekilmis satirlar istemciye hic
    gonderilmez (yokluk = ifade yok).
    """

    message_id: int
    emoji: str
    from_me: bool = False
    reactor_jid: Optional[str] = None
    updated_at: Optional[str] = None


class WhatsAppConversationItem(BaseModel):
    id: int
    # A contact may have one conversation per connected WhatsApp line.
    session_id: Optional[int] = None
    contact_id: Optional[int] = None
    lead_id: Optional[int] = None
    name: Optional[str] = None
    phone: Optional[str] = None
    is_group: bool = False
    is_self: bool = False
    # Sorun 4: WhatsApp arsiv durumu (gateway Baileys metadata'sindan kalici).
    is_archived: bool = False
    avatar_url: Optional[str] = None
    last_message_preview: Optional[str] = None
    last_message_at: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    # Faz 10 (P2): UI "mesaj yok" bilgisini yalnizca message_count==0 ve
    # last_message_state=="NO_MESSAGES" iken gosterir.
    message_count: int = 0
    last_message_state: Optional[str] = None
    # WhatsApp Web paritesi: liste satirinda SON MESAJIN en yeni ifadesi.
    # Eski bir mesaja birakilan ifade listede gorunmez (sunucu hesaplar).
    last_reaction: Optional[WhatsAppReactionItem] = None
    unread_count: int = 0
    status: str = "ACTIVE"
    identity_state: Optional[str] = None


class WhatsAppConversationListResponse(BaseModel):
    items: List[WhatsAppConversationItem] = Field(default_factory=list)
    total: int = 0
    has_more: bool = False
    next_offset: Optional[int] = None



class WhatsAppLinkPreviewItem(BaseModel):
    """Govdedeki link icin sunucu tarafinda cozulmus onizleme.

    Alan adlari `frontend/src/types/index.ts` icindeki `LinkPreview` ile
    BIREBIR ayni olmalidir; bu dosyanin basligi zaten "frontend tipleriyle
    uyumlu tutulur" diyor.

    `image_url` burada HAM uzak adres DEGIL, kimlik dogrulamali proxy yolu
    (`/api/v1/whatsapp/link-preview/image?u=<hash>`) olarak gelir; bkz.
    `link_preview.service._proxy_image_url`.
    """

    url: str
    kind: str = "LINK"
    title: Optional[str] = None
    description: Optional[str] = None
    site_name: Optional[str] = None
    image_url: Optional[str] = None
    embed_url: Optional[str] = None


class WhatsAppMessageItem(BaseModel):
    id: Optional[Any] = None
    conversation_id: Any = None
    direction: str = "INBOUND"
    message_type: str = "TEXT"
    status: str = "RECEIVED"
    body: Optional[str] = None
    media_id: Optional[str] = None
    media_mime_type: Optional[str] = None
    media_filename: Optional[str] = None
    media_caption: Optional[str] = None
    media_url: Optional[str] = None
    wa_message_id: Optional[str] = None
    client_message_id: Optional[str] = None
    sender_phone: Optional[str] = None
    sender_name: Optional[str] = None
    recipient_phone: Optional[str] = None
    error_message: Optional[str] = None
    reactions: List[WhatsAppReactionItem] = Field(default_factory=list)
    # `serialize_message` HER ZAMAN bu anahtari uretir (`preview or None`).
    # Alan burada bildirilmezse Pydantic v2 (varsayilan `extra="ignore"`)
    # degeri SESSIZCE duser ve onizleme uctan hic cikmaz — `sync` alaninda
    # yasanan A8 hatasinin birebir aynisi (bkz. WhatsAppSessionResponse).
    link_preview: Optional[WhatsAppLinkPreviewItem] = None
    quoted_message: Optional[Dict[str, Any]] = None
    created_at: Optional[str] = None


class WhatsAppHistoryEvidence(BaseModel):
    state: str = "NOT_CHECKED"
    provider_checked: bool = False
    provider_exhausted: bool = False
    provider_msgs_returned: int = 0


class WhatsAppMessagesResponse(BaseModel):
    messages: List[WhatsAppMessageItem] = Field(default_factory=list)
    has_more: bool = False
    oldest_message_id: Optional[Any] = None
    newest_message_id: Optional[Any] = None
    history_evidence: Optional[WhatsAppHistoryEvidence] = None


class WhatsAppSendTextRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)
    client_message_id: Optional[str] = None


class WhatsAppSendMediaRequest(BaseModel):
    media_type: str = Field(..., description="image|document|audio|video")
    media_url: Optional[str] = Field(None, description="authFetch uyumlu, kimlik doğrulamalı medya URL'si veya gateway URL")
    media_base64: Optional[str] = Field(None, description="Dosya yuklemesi icin base64 icerik (media_url ile en az biri)")
    mime_type: Optional[str] = Field(None, description="base64 yuklemede MIME tipi")
    caption: Optional[str] = None
    filename: Optional[str] = None
    client_message_id: Optional[str] = None


class WhatsAppSendReactionRequest(BaseModel):
    emoji: str = Field(
        default="",
        max_length=32,
        description="Reaksiyon ifadesi; bos string tepkiyi geri ceker",
    )


class WhatsAppReactionResult(BaseModel):
    """Tepki gonderme yaniti (mesaj gonderme sonucundan AYRI)."""

    success: bool = True
    conversation_id: Optional[int] = None
    message_id: Optional[int] = None
    wa_message_id: Optional[str] = None
    emoji: str = ""
    removed: bool = False
    from_me: bool = True
    reactor_jid: Optional[str] = None
    reaction: Optional[WhatsAppReactionItem] = None
    conversation_reaction: Optional[WhatsAppReactionItem] = None


class WhatsAppTypingRequest(BaseModel):
    typing: bool = Field(default=True, description="True='yazıyor', False='duraklat'")


class WhatsAppConversationStatusRequest(BaseModel):
    """Kullanicinin acik sohbet aksiyonu (ACTIVE / ARCHIVED / CLOSED).

    WhatsApp arsiv durumu (gateway metadata'sindan senkronlanan `is_archived`)
    ile karistirilmamalidir.
    """

    status: str = Field(..., description="ACTIVE | ARCHIVED | CLOSED")


class WhatsAppConversationStatusResult(BaseModel):
    id: int
    status: str


class WhatsAppConversationDeleteResult(BaseModel):
    """Sohbet silme sonucu.

    `messages_deleted` SAYILIR ve dondurulur: "sildim" demek yetmez, kullanicinin
    geri donusu olmayan bir islemi onayladigi sey gercekten silinmis olmalidir.
    Sayi 0 ise sohbet zaten mesajsizdi; bu bir hata degil, ama sessiz de
    kalmamalidir (AGENTS.md §1.1 — yalan soylememek kadar, belirsiz de
    birakmamak).
    """

    id: int
    deleted: bool
    messages_deleted: int = 0
    reactions_deleted: int = 0
    # Uzaktan (WhatsApp hesabinin diger cihazlari) silme sonucu. `False` ise
    # sohbet YALNIZCA Tezlify'dan kaldirildi; arayuz bunu kullaniciya soylemek
    # zorundadir, yoksa "sildim" iddiasi telefonda dogru olmaz.
    # NOT: alan burada ACIKCA bildirilmelidir — Pydantic v2 varsayilan
    # `extra="ignore"` davranisi, bildirilmeyen bir alani sessizce DUSURUR
    # (`link_preview` hatasinin ayni sekli).
    remote_deleted: bool = False
    remote_error: Optional[str] = None


class WhatsAppSendResult(BaseModel):
    id: Optional[Any] = None
    wa_message_id: Optional[str] = None
    client_message_id: Optional[str] = None
    # §1.1 (truthfulness): REQUIRED, with no default. A default of "SENT" would
    # let any path that forgets to supply a status report a failed send as a
    # success. The persisted `Message.status` is NOT NULL, so the endpoint always
    # has a real value to forward.
    status: str
    body: Optional[str] = None
    # Sunucu zaman damgasi: optimistic satirin istemci saatiyle "simdi"
    # uydurmasini engeller (frontend sunucu verisini asla uydurmaz).
    created_at: Optional[str] = None
    message_type: Optional[str] = None
    media_id: Optional[str] = None
    media_url: Optional[str] = None


class WhatsAppStartConversationRequest(BaseModel):
    """WhatsApp Web paritesi: numara ile yeni sohbet baslatma.

    `phone` zorunlu (ülke kodu dahil); `name` opsiyonel rehber adi;
    `message` opsiyonel ilk mesaj — verilirse bagli hattan GERCEK olarak
    gönderilir (sahte basari yok: gönderim başarısızsa uç nokta başarısız olur).
    """

    phone: str = Field(..., min_length=5, max_length=32, description="Ülke kodu dahil telefon (örn. +90 5XX XXX XX XX)")
    name: Optional[str] = Field(None, max_length=150)
    message: Optional[str] = Field(None, max_length=4000)
    session_id: Optional[int] = Field(None, description="Hedef bağlı hat/oturum ID'si")


class WhatsAppReadResult(BaseModel):
    success: bool = True
    # Faz 13 (truthfulness): gateway'e ILETILEMEDIYSE neden'i tasinir. Alan
    # opsiyoneldir; `success=False` iken UI kullaniciya gercek nedeni
    # gosterebilir — sessiz yutma yok.
    error: Optional[str] = None


class WhatsAppStatusResult(BaseModel):
    success: bool = True
    message: Optional[str] = None
    status: Optional[str] = None
    error: Optional[str] = None


class WhatsAppSyncSessionStatus(BaseModel):
    id: int
    session_name: Optional[str] = None
    status: Optional[str] = None
    # Faz 7: gateway belleğindeki GERÇEK initial-sync durumu (sahte değil).
    sync: Dict[str, Any] = Field(default_factory=dict)


class WhatsAppSyncStatusResponse(BaseModel):
    """Oturum bazli gercek senkron durumu.

    Faz 13 (truthfulness): gateway'e ulasilamazsa `gateway_available=False`
    ve her oturumun `sync.phase`'i `unavailable` olur. Istemci bunu "senkron
    yok" (idle) ile karistirmamalidir — hata artik maskelenmiyor.
    """

    sessions: List[WhatsAppSyncSessionStatus] = Field(default_factory=list)
    gateway_available: bool = True
    gateway_error: Optional[str] = None


class WhatsAppSyncJobResponse(BaseModel):
    """Arka plan initial-sync job'ının GERÇEK durumu (§16/§28).

    state: IDLE | SYNCING | COMPLETED | FAILED — sahte tamamlanma üretilmez.
    sync_id: job bazlı kimlik; frontend eski sync_id'li olayları yok sayar.
    """

    sync_id: Optional[str] = None
    state: str = "IDLE"
    stage: str = "idle"
    error: Optional[str] = None
    chats_total: int = 0
    chats_synced: int = 0
    contacts_synced: int = 0
    messages_total: int = 0
    messages_synced: int = 0
    # Bos sohbet geri doldurmasi (bkz. sync.py `_BACKFILL_*`): satiri olmayan
    # sohbetler icin saglayicidan gecmis cekilir. Bu alanlar `snapshot()`'ta
    # ZATEN uretiliyor; response_model'da listelenmezlerse API'den sessizce
    # silinirler (A8 tuzagi) — bu yuzden burada acikca bildirilirler.
    backfill_total: int = 0
    backfill_done: int = 0
    backfill_hydrated: int = 0
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    # Faz 6 (P0.1): faz bazinda gecen sure (sn, gercek olcum — time.monotonic
    # delta). Benchmark/raporlama icin; UI icin zorunlu degil.
    stage_timings: Dict[str, float] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Loading Gate — QR sonrası WhatsApp Web paritesi (Faz 0 kontrakt)
# ---------------------------------------------------------------------------
class WhatsAppLoadingGateCounts(BaseModel):
    """QR sonrasi yukleme kapisi icin sayaclar (tek-authority DTO).

    chats/messages : backend SyncJob + gateway sync'in birlesimi.
    avatars_*      : gateway bellegindeki eksik avatar sayisi (backfill ilerlemesi).
    """

    chats_total: int = 0
    chats_synced: int = 0
    messages_total: int = 0
    messages_synced: int = 0
    avatars_total: int = 0
    avatars_fetched: int = 0
    avatars_missing: int = 0


class WhatsAppLoadingGateResponse(BaseModel):
    """Tek-authority yukleme kapisi durumu (WhatsApp Web paritesi).

    phase: idle | qr | connecting | syncing_history | loading_profiles | ready | error
    stage: backend SyncJob stage'i ile eslesir (starting|chats|messages|finalizing...)
    progress: 0-100 deterministik yuzde (backend + gateway birlesimi)
    counts: yukaridaki sayaclar
    gateway_available/gateway_error: fail-closed sinyal (AGENTS.md §1.1)
    """

    session_id: Optional[int] = None
    phase: str = Field(default="idle", description="idle|qr|connecting|syncing_history|loading_profiles|ready|error")
    stage: str = "idle"
    progress: int = Field(default=0, ge=0, le=100)
    counts: WhatsAppLoadingGateCounts = Field(default_factory=WhatsAppLoadingGateCounts)
    gateway_available: bool = True
    gateway_error: Optional[str] = None
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# LID/telefon bölünmüş sohbet onarımı (yönetim ucu)
# ---------------------------------------------------------------------------
class WhatsAppLidSplitCandidate(BaseModel):
    """Birleştirilmeyi bekleyen BİR bölünmüş çift (kanıt alanlarıyla).

    `message_count` LID sohbetinde DURAN mesaj sayısıdır: operatör "bu işi
    birleştirirsem ne taşınır" sorusunun cevabını aksiyondan ÖNCE görür.
    """

    lid_jid: str
    phone_jid: str
    lid_conversation_id: int
    display_name: Optional[str] = None
    message_count: int = 0
    unread_count: int = 0


class WhatsAppLidSplitListResponse(BaseModel):
    items: List[WhatsAppLidSplitCandidate] = Field(default_factory=list)
    # Sınırlı sorgunun dürüstlüğü: kaç aday listelendi. `limit`e takılan daha
    # fazlası varsa burada yalan söylenmez, `truncated` ile bildirilir.
    total: int = 0
    truncated: bool = False


class WhatsAppLidSplitMergeRequest(BaseModel):
    """Tek istekte onarım: `lid_jid` verilirse yalnız o çift, yoksa bekleyenler.

    `limit` her istekte yapılabilecek birleştirme sayısını sınırlar; sınırsız
    bir yönetim işi yoktur (bkz. reconciliation.DEFAULT_REPAIR_LIMIT).
    """

    lid_jid: Optional[str] = Field(None, max_length=200)
    limit: int = Field(default=50, ge=1, le=200)


class WhatsAppLidSplitMergeItem(BaseModel):
    lid_jid: str
    phone_jid: str
    merged: bool
    reason: Optional[str] = None
    canonical_conversation_id: Optional[int] = None
    moved_unique: Optional[int] = None
    deduped_duplicates: Optional[int] = None
    stranded_after: Optional[int] = None
    canonical_unread_count: Optional[int] = None


class WhatsAppLidSplitMergeResponse(BaseModel):
    requested: int = 0
    merged: int = 0
    deferred: int = 0
    errors: int = 0
    results: List[WhatsAppLidSplitMergeItem] = Field(default_factory=list)
