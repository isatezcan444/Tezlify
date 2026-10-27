#!/usr/bin/env python3
"""Adacik env dosyasindaki TUM `*DATABASE_URL` degiskenlerini izole kopyaya cevirir.

Neden ayri bir dosya
--------------------
"Adacik uretim DB'sine yazamaz" iddiasinin dayanaklarindan biri bu donusumdur.
Bash icinde gomulu bir `python3 - <<'PY'` blogu birim testiyle dogrulanamaz;
burada saf fonksiyon olarak durur ve `test_deploy_candidate_isolation.py`
tarafindan cagrilir.

Neden "TUM" — 2026-10-28'de ogrenilen ders
------------------------------------------
Ilk surum yalnizca tam adi `DATABASE_URL` olan satiri ceviriyordu. Canli env'de
IKINCI bir baglanti dizesi var: `GATEWAY_DATABASE_URL`. Yani adacik izole
kopyaya baglanirken gateway katmani uretim veritabanina bagli kaliyordu —
"izolasyon" tam olarak kapatmasi gereken deligi acik birakiyordu.

Daha kotusu, dogrulama grep'i `DATABASE_URL=.*/<db>` idi ve bu desen
`GATEWAY_DATABASE_URL=` satirini de eslestirdi (cunku o metin, adin ICINDE
geciyor). Sonuc: kontrol, gercekten cevrilmis satir yuzunden degil, cevrilmemis
IKINCI satir yuzunden patladi. Hata dogruydu, sebep yanlisti.

Bu yuzden kural artik ada gore: adi `DATABASE_URL` ile BITEN her degisken bir
baglanti dizesidir ve cevrilmelidir. Kontrol de "uretim adi geciyor mu"
(negatif) degil, "her baglanti dizesi BEKLENEN kopyaya mi bakiyor" (pozitif).

Sozlesme
--------
Yalnizca URL'in **path** kismi (veritabani adi) degisir. Kullanici, parola,
host, port, surucu oneki (`postgresql+asyncpg`), IPv6 koseli parantezleri ve
sorgu parametreleri AYNEN korunur — bunlardan biri bozulursa adacik yanlis
yere baglanir ve "izolasyon" sessizce calismaz.

Cikis kodlari
-------------
0  cevrildi ve her baglanti dizesi izole kopyaya bakiyor
2  dosyada hic `*DATABASE_URL` satiri yok (izolasyon kanitlanamaz)
3  gecersiz veritabani adi
4  cevrildikten SONRA hala baska bir veritabanina bakan degisken var
"""

from __future__ import annotations

import re
import sys
from urllib.parse import urlsplit, urlunsplit

# Postgres tanimlayicisi: harf/rakam/alt cizgi, harfle baslar, <=63 bayt.
_DB_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")

# Bir env satirinin degisken adi: `FOO_BAR_2=...`
_VAR_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Bir degisken "baglanti dizesi"dir ancak ve ancak adi bununla bitiyorsa.
# `DATABASE_URL` de, `GATEWAY_DATABASE_URL` de bu kurala uyar.
DB_URL_SUFFIX = "DATABASE_URL"


class InvalidDatabaseName(ValueError):
    """Hedef veritabani adi Postgres tanimlayicisi degil."""


def is_db_url_var(name: str) -> bool:
    """`name` bir baglanti dizesi degiskeni mi (adi `DATABASE_URL` ile bitiyor mu)?"""
    return name.endswith(DB_URL_SUFFIX)


def _unquote(value: str) -> str:
    return value.strip().strip('"').strip("'")


def _assignment(line: str) -> tuple[str, str] | None:
    """`NAME=value` satirini (ad, deger) olarak dondur; degilse None."""
    if "=" not in line:
        return None
    name, value = line.split("=", 1)
    if not _VAR_NAME_RE.match(name):
        return None
    return name, value


def isolated_url(url: str, db: str) -> str:
    """`url`'in veritabani adini `db` yapar, geri kalan her seyi korur.

    Parola icinde `/` veya `@` gecmesi bu fonksiyonu sasirtmaz: parcalama
    `urlsplit` ile yapilir, regex ile degil. (Ilk denemede regex kullanilmisti;
    `p@ss/word` gibi bir parolada yanlis parcayi degistirebilirdi.)
    """
    if not _DB_NAME_RE.match(db or ""):
        raise InvalidDatabaseName(f"gecersiz veritabani adi: {db!r}")
    parts = urlsplit(url)
    if not parts.scheme:
        raise InvalidDatabaseName(f"URL semasi yok: {url!r}")
    return urlunsplit(parts._replace(path="/" + db))


def db_url_vars(path: str) -> dict[str, str]:
    """env dosyasindaki her `*DATABASE_URL` degiskeni -> ham URL degeri."""
    found: dict[str, str] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh.read().splitlines():
            parsed = _assignment(line)
            if parsed and is_db_url_var(parsed[0]):
                found[parsed[0]] = _unquote(parsed[1])
    return found


def unexpected_db_urls(path: str, expected_db: str) -> list[str]:
    """Izole kopyaya BAKMAYAN `*DATABASE_URL` degisken adlari.

    Pozitif iddia: her baglanti dizesi `/<expected_db>` yolunda olmali. Bos
    liste = izolasyon tam. (Negatif "uretim adi geciyor mu" kontrolu, adin
    icinde gecen bir alt dize yuzunden yanlis satiri isaret edebiliyordu.)
    """
    bad: list[str] = []
    for name, url in db_url_vars(path).items():
        try:
            parts = urlsplit(url)
        except ValueError:
            bad.append(name)
            continue
        if parts.path != "/" + expected_db:
            bad.append(name)
    return bad


def rewrite_env_file(path: str, db: str) -> list[str]:
    """`path` icindeki HER `*DATABASE_URL` satirini yerinde cevirir.

    Diger satirlara dokunulmaz. Hic baglanti dizesi yoksa `KeyError` — cagiran
    taraf bunu "izolasyon kurulamadi" olarak yorumlamali, sessizce gecmemeli.

    Donus: cevrilen degisken adlari (kanit olarak loglanir).
    """
    if not _DB_NAME_RE.match(db or ""):
        raise InvalidDatabaseName(f"gecersiz veritabani adi: {db!r}")
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    out: list[str] = []
    rewritten: list[str] = []
    for line in lines:
        parsed = _assignment(line)
        if parsed and is_db_url_var(parsed[0]):
            name, value = parsed
            try:
                out.append(name + "=" + isolated_url(_unquote(value), db))
                rewritten.append(name)
            except InvalidDatabaseName:
                # Cozemedigimiz bir baglanti dizesi (orn. libpq `host=... dbname=...`
                # formati). Sessizce OLDUGU GIBI birakilir; asagidaki pozitif
                # kontrol onu adiyla raporlar ve cikis 4 verir. Burada `die`
                # etmek teshisi zorlastirirdi: kullanici hangi degiskenin sorunlu
                # oldugunu degil, yalnizca "gecersiz URL" gorurdu.
                out.append(line)
        else:
            out.append(line)
    if not rewritten:
        raise KeyError(DB_URL_SUFFIX)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")
    return rewritten


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("kullanim: candidate_db_url.py <env-dosyasi> <hedef-db>", file=sys.stderr)
        return 2
    envfile, db = argv[1], argv[2]
    try:
        rewritten = rewrite_env_file(envfile, db)
    except KeyError:
        print("hicbir *DATABASE_URL degiskeni bulunamadi", file=sys.stderr)
        return 2
    except InvalidDatabaseName as exc:
        print(str(exc), file=sys.stderr)
        return 3

    bad = unexpected_db_urls(envfile, db)
    if bad:
        print(
            "izolasyon EKSIK; izole kopyaya bakmayan degisken(ler): "
            + ", ".join(sorted(bad)),
            file=sys.stderr,
        )
        return 4
    print("cevrildi: " + ", ".join(rewritten), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
