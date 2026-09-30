"""SSRF korumasi — urunun KULLANICI GIRDISIYLE dis istek yaptigi tek yer.

Tehdit modeli
-------------
Kullanici mesaja bir URL yazar; sunucu o URL'e istek atar. Saldirgan bu yolla
sunucuyu KENDI ic agina konusturabilir:

* `http://169.254.169.254/latest/meta-data/...` — bulut metadata servisi
  (kimlik bilgileri sizabilir),
* `http://127.0.0.1:8000/...` — backend'in kendi ic uclari,
* `http://10.0.0.5:5432/` — ic veritabani/servisler,
* `http://[::1]/`, `http://0.0.0.0/`,
* kodlanmis IPv4: `http://2130706433/` (=127.0.0.1), `http://0x7f000001/`,
  `http://0177.0.0.1/`.

Neden ANA MAKINE ADI degil, COZULEN IP kontrol edilir
-----------------------------------------------------
`localhost`u engellemek yetmez: `localtest.me` ve `*.nip.io` gibi genel alan
adlari dogrudan 127.0.0.1'e cozulur ve saldirgan kendi alan adini da
yonsa ayni sonucu alir. Kontrol her zaman cozumleme SONRASINDA, IP uzerinde
yapilir.

Kalan risk (durustce)
---------------------
Kontrol ile baglanti arasinda DNS yeniden cozulebilir ("DNS rebinding").
Buradaki koruma her YONLENDIRME adiminda yeniden cozumleyip dogrular, ama
tek bir adim icindeki kontrol-et-sonra-baglan araligi kapanmaz; kapatmak
baglanti katmaninda (httpcore network backend) IP sabitlemeyi gerektirir ve
bu tur kapsam disi birakildi. Bu yuzden yonlendirme SAYISI sinirlidir ve
yeniden dogrulama atlanmaz.
"""

import ipaddress
import re
import socket
from typing import List, Optional, Tuple
from urllib.parse import urlsplit

# Yonlendirme zinciri: her ek adim yeni bir kontrol gerektirir, bu yuzden
# zincir kisa tutulur. Mesru onizlemeler nadiren 2'den fazla atlar.
MAX_REDIRECTS = 3

# Akis halinde okunacak ust sinir. Onizleme icin gereken sey `<head>`dir;
# 200 KB fazlasiyla yeterlidir ve bir saldirganin sunucuyu buyuk bir dosyayla
# mesgul etmesini engeller.
MAX_BYTES = 200 * 1024

# Tek bir istek icin ust sinir. Onizleme, sohbet acilisini ASLA bekletmez
# (asenkron calisir), ama sonsuz bekleyen bir gorev kaynak sizdirir.
REQUEST_TIMEOUT_S = 6.0

_USER_AGENT = "TezlifyLinkPreview/1.0 (+https://tezlify.com)"


class UnsafeUrlError(Exception):
    """URL guvenli kabul edilmedi (sema, ana makine veya cozulen IP)."""


def _unwrap(ip: ipaddress._BaseAddress) -> ipaddress._BaseAddress:
    """IPv4-esli IPv6 adreslerini gercek IPv4'e indirir.

    `::ffff:127.0.0.1` bir IPv6 adresi gibi gorunur; IPv4 kurallariyla
    kontrol edilmezse dongu geri adresi kacagi kalir.
    """
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        return mapped
    return ip


def is_public_ip(ip: ipaddress._BaseAddress) -> bool:
    """Yalnizca genel yonlendirilebilir adresler icin True.

    `is_global` TEK basina yeterli olsa da acik liste ile birlikte kullanilir:
    bu yuklemin davranisi Python surumleri arasinda degisti ve tek bir
    yuklemin dogruluguna guvenmek, korumayi sessizce kaybetmenin en kolay
    yoludur. Listelenen her kategori ayri ayri reddedilir.
    """
    candidate = _unwrap(ip)
    if (
        candidate.is_loopback
        or candidate.is_private
        or candidate.is_link_local
        or candidate.is_multicast
        or candidate.is_reserved
        or candidate.is_unspecified
    ):
        return False
    # IPv6'ya ozgu, artik kullanilmayan site-local blok (fec0::/10).
    if getattr(candidate, "is_site_local", False):
        return False
    # CGNAT (100.64.0.0/10) bazi surumlerde `is_private` sayilmaz; acikca
    # reddedilir cunku tasiyici ic agidir.
    if candidate.version == 4 and candidate in ipaddress.ip_network("100.64.0.0/10"):
        return False
    return bool(candidate.is_global)


def _is_ambiguous_numeric_host(host: str) -> bool:
    """Sayisal/kodlanmis bicimde yazilmis ana makine adlarini yakalar.

    NEDEN GEREKLI (canli olarak olculdu, 2026-09-30)
    -----------------------------------------------
    `http://0177.0.0.1/` korumadan GECIYORDU. Sebep, korumanin cozumleme
    sonucuna guvenmesiydi: bazi isletim sistemleri (macOS) bu sekizlik bicimi
    IP olarak YORUMLAMAZ ve bir alan adi gibi DNS'e sorar; DNS genel bir adres
    dondurdugunde kontrol "genel IP" diyerek izin verir. Baska bir sistemde
    (glibc) ayni dize 127.0.0.1'e cozulur. Ayni girdinin sistemden sisteme
    farkli anlam kazanmasi, korumanin tanimli olmadigi anlamina gelir.

    Cozum: bu bicimleri COZUMLEDEN ONCE reddetmek. Mesru bir alan adi asla
    `2130706433`, `0x7f000001`, `127.1` veya `0177.0.0.1` gibi gorunmez.
    """
    candidate = host.strip().strip("[]").lower()
    if not candidate:
        return True
    # IPv6 literali: `:` icerir; `ipaddress` ile dogrulanir, belirsiz degildir.
    if ":" in candidate:
        return False
    if re.fullmatch(r"0x[0-9a-f]+", candidate):
        return True
    if re.fullmatch(r"\d+", candidate):
        return True
    parts = candidate.split(".")
    if parts and all(part.isdigit() for part in parts):
        # `127.1` gibi kisa bicimler (inet_aton bunlari 127.0.0.1 sayar).
        if len(parts) < 4:
            return True
        # `0177.0.0.1` gibi basinda sifir olan parcalar sekizlik okunabilir.
        if any(len(part) > 1 and part[0] == "0" for part in parts):
            return True
    return False


def _looks_like_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip().strip("[]"))
        return True
    except ValueError:
        return False


def resolve_and_validate(host: str, port: Optional[int] = None) -> List[str]:
    """Ana makineyi cozer ve TUM cevaplari dogrular.

    Tek bir ozel adres bile reddi tetikler: bir alan adi hem genel hem ozel
    adrese cozulebiliyorsa (DNS rebinding'in tipik kurulumu), "hangisi once
    gelirse" ona gore davranmak korumayi sans isine cevirirdi.
    """
    if not host:
        raise UnsafeUrlError("Ana makine adi bos.")
    if _is_ambiguous_numeric_host(host):
        raise UnsafeUrlError(f"Belirsiz sayisal ana makine reddedildi: {host}")
    # Tek etiketli adlar (`localhost`, ic servis adlari) genel internette
    # bulunmaz; hepsi ic agi isaret eder. IP literalleri bu kuralin disindadir
    # ve asagida ayrica dogrulanir.
    if "." not in host and not _looks_like_ip_literal(host):
        raise UnsafeUrlError(f"Tek etiketli ana makine reddedildi: {host}")

    lookup_port = port or 443
    try:
        infos = socket.getaddrinfo(host, lookup_port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeUrlError(f"Ana makine cozulemedi: {host}") from exc

    addresses: List[str] = []
    for info in infos:
        sockaddr = info[4]
        addresses.append(sockaddr[0])

    if not addresses:
        raise UnsafeUrlError(f"Ana makine cozulemedi: {host}")

    for raw in addresses:
        try:
            parsed = ipaddress.ip_address(raw)
        except ValueError as exc:
            raise UnsafeUrlError(f"Gecersiz IP: {raw}") from exc
        if not is_public_ip(parsed):
            raise UnsafeUrlError(f"Ozel/ayrilmis adres reddedildi: {raw}")

    return addresses


def validate_url(url: str) -> Tuple[str, str, Optional[int]]:
    """URL'i sema + ana makine + cozulen IP acisindan dogrular.

    Basarili olursa `(scheme, host, port)` doner. Aksi halde `UnsafeUrlError`.
    """
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise UnsafeUrlError("URL ayristirilamadi.") from exc

    scheme = (parts.scheme or "").lower()
    # `file://`, `gopher://`, `ftp://` ve `data:` reddedilir: yalnizca bu ikisi
    # icin koruma tanimli.
    if scheme not in ("http", "https"):
        raise UnsafeUrlError(f"Desteklenmeyen sema: {scheme or '(yok)'}")

    host = parts.hostname
    if not host:
        raise UnsafeUrlError("Ana makine adi yok.")

    port = parts.port
    resolve_and_validate(host, port)
    return scheme, host, port
