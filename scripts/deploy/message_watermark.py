#!/usr/bin/env python3
"""Mesaj KIMLIK filigrani — "eski kayit kayboldu mu?" sorusunun tek dogru olcusu.

Neden toplam sayim yetmez
-------------------------
Canli bir WhatsApp hattinda deploy penceresi boyunca yeni mesaj gelir. 9 mesaj
silinip 9 yeni mesaj gelirse `count(*)` **degismez**; toplam sayiya bakan bir
kapi kaybi gormez. 2026-10-27'de tam bu oldu: baz 729, dağıtim oncesi 753.

Filigran bunu kapatir: pencere basinda `max(id)` ve o ana kadarki mesaj sayisi
alinir; sonunda **"id'si bu esigin ALTINDA kalan kac mesaj duruyor"** sorulur.
Yeni mesajlar esigin ustunde dogar, sayima girmez. Silinen her eski mesaj ise
kesinlikle gorunur.

Sozlesme
--------
Girdi : `before` = "max_id|adet" (ya da "unavailable"), `after` = esigin
        altinda kalan mesaj sayisi (ya da "unavailable").
Cikti : kayip varsa tek satir `messages:<once>-><sonra> (id<=<esik>)`,
        yoksa bos.
Cikis : 0 = kayip yok / olcum yok (karar verilmez), 4 = kayip var, 2 = girdi
        bozuk.

"Olcum yok" karar uretmez: DB'ye erisilemediginde deploy'u kayip varmis gibi
durdurmak yanlis pozitif olurdu; bu yuzden `unavailable` sessizce gecilir.
"""

from __future__ import annotations

import sys


def parse_watermark(text: str) -> tuple[int, int] | None:
    """"max_id|adet" -> (max_id, adet). Olculemiyorsa None."""
    if not text:
        return None
    if "unavailable" in text:
        return None
    parts = text.strip().split("|")
    if len(parts) != 2:
        return None
    try:
        edge, count = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if edge < 0 or count < 0:
        return None
    return edge, count


def parse_count(text: str) -> int | None:
    if not text:
        return None
    if "unavailable" in text:
        return None
    try:
        value = int(text.strip())
    except ValueError:
        return None
    return value if value >= 0 else None


def loss_line(before: str, after: str) -> str | None:
    """Kayip varsa kanit satiri, yoksa None."""
    wm = parse_watermark(before)
    survivors = parse_count(after)
    if wm is None or survivors is None:
        return None
    edge, expected = wm
    if survivors < expected:
        return f"messages:{expected}->{survivors} (id<={edge})"
    return None


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("kullanim: message_watermark.py <before> <after>", file=sys.stderr)
        return 2
    before, after = argv[1], argv[2]
    # Bozuk girdi ile "olcum yok" ayri seylerdir: ikisi de karar uretmez ama
    # bozuk girdi sessizce gecilmemeli.
    if before and "unavailable" not in before and parse_watermark(before) is None:
        print(f"bozuk filigran: {before!r}", file=sys.stderr)
        return 2
    if after and "unavailable" not in after and parse_count(after) is None:
        print(f"bozuk sayim: {after!r}", file=sys.stderr)
        return 2
    line = loss_line(before, after)
    if line:
        print(line)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
