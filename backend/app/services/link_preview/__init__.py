"""SSRF korumali sunucu tarafi link/media onizleme alt sistemi.

Katmanlar ve sorumluluklari:

* `urls.py`    — metinden URL cikarma, normalizasyon, tur siniflandirmasi.
* `ssrf.py`    — KULLANICI GIRDISIYLE DIS ISTEK yapan tek yerin korumasi.
* `unfurl.py`  — cekme + OpenGraph ayristirma (+ YouTube/Instagram ozel yollari).
* `service.py` — onbellek (link_previews) ve ASENKRON orkestrasyon.

Neden tek bir "preview" modulu degil: her katmanin testi farkli. SSRF ve URL
kurallari AG GEREKTIRMEZ ve saf birim testleriyle dogrulanir; bu ayrim
olmadan guvenlik testleri de ag bagimli hale gelirdi.
"""

from backend.app.services.link_preview.service import (
    ensure_preview,
    previews_by_message,
    refresh_preview,
    schedule_unfurl,
    serialize_preview,
)

__all__ = [
    "ensure_preview",
    "previews_by_message",
    "refresh_preview",
    "schedule_unfurl",
    "serialize_preview",
]
