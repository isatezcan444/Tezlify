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
