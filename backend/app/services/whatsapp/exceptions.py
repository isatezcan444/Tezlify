"""WhatsApp domain exceptions."""


class WhatsAppRelinkRequired(RuntimeError):
    """WhatsApp web oturumu koptu veya gecersiz (404/401); yeniden QR eslestirme gerekir."""
    pass


class NoWhatsAppSession(LookupError):
    """Kullanicinin bagli bir WhatsApp hatti yok."""
    pass


class EventOwnerUnresolved(Exception):
    """Gelen gateway olayi bir kullaniciya/oturuma eslenemedi."""
    pass


class PairingPromotionRefused(RuntimeError):
    """Eşleşme tamamlandı ancak kalıcı oturum güvenli biçimde bağlanamadı.

    `promote_ephemeral_pairing` None döndürdüğünde yükseltilir: sahip
    kanıtlanamadı, telefon başka bir kiracıya ait, ya da canlı bir oturum başka
    bir gateway'e bağlı. Bunların hiçbiri bir **gateway arızası değildir**, bu
    yüzden endpoint bunu 502 ("gateway'e ulaşılamadı") olarak DEĞİL, 409 olarak
    raporlamalıdır — bkz. `_no_session` ile aynı gerekçe.
    """
    pass


class WhatsAppHistoryTimeout(TimeoutError):
    """Provider history chunk istegi zaman asimina ugradi (gecici durum, cursor korunmali)."""
    pass

