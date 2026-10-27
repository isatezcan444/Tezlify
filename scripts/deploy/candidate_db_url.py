#!/usr/bin/env python3
"""Adacik env dosyasindaki `DATABASE_URL`'i izole kopya veritabanina cevirir.

Neden ayri bir dosya
--------------------
"Adacik uretim DB'sine yazamaz" iddiasinin dayanaklarindan biri bu donusumdur.
Bash icinde gomulu bir `python3 - <<'PY'` blogu birim testiyle dogrulanamaz;
burada saf fonksiyon olarak durur ve `test_deploy_candidate_isolation.py`
tarafindan cagrilir.

Sozlesme
--------
Yalnizca URL'in **path** kismi (veritabani adi) degisir. Kullanici, parola,
host, port, surucu oneki (`postgresql+asyncpg`), IPv6 koseli parantezleri ve
sorgu parametreleri AYNEN korunur — bunlardan biri bozulursa adacik yanlis
yere baglanir ve "izolasyon" sessizce calismaz.

Cikis kodlari
-------------
0  cevrildi
2  dosyada `DATABASE_URL` satiri yok (izolasyon kanitlanamaz)
3  gecersiz veritabani adi
"""

from __future__ import annotations

import re
import sys
from urllib.parse import urlsplit, urlunsplit

# Postgres tanimlayicisi: harf/rakam/alt cizgi, harfle baslar, <=63 bayt.
_DB_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


class InvalidDatabaseName(ValueError):
    """Hedef veritabani adi Postgres tanimlayicisi degil."""


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


def rewrite_env_file(path: str, db: str) -> None:
    """`path` icindeki `DATABASE_URL=` satirini yerinde cevirir.

    Diger satirlara dokunulmaz. `DATABASE_URL` yoksa `KeyError` — cagiran
    taraf bunu "izolasyon kurulamadi" olarak yorumlamali, sessizce gecmemeli.
    """
    if not _DB_NAME_RE.match(db or ""):
        raise InvalidDatabaseName(f"gecersiz veritabani adi: {db!r}")
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    out: list[str] = []
    seen = False
    for line in lines:
        if line.startswith("DATABASE_URL="):
            raw = line.split("=", 1)[1].strip().strip('"').strip("'")
            out.append("DATABASE_URL=" + isolated_url(raw, db))
            seen = True
        else:
            out.append(line)
    if not seen:
        raise KeyError("DATABASE_URL")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out) + "\n")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("kullanim: candidate_db_url.py <env-dosyasi> <hedef-db>", file=sys.stderr)
        return 2
    try:
        rewrite_env_file(argv[1], argv[2])
    except KeyError:
        print("DATABASE_URL bulunamadi", file=sys.stderr)
        return 2
    except InvalidDatabaseName as exc:
        print(str(exc), file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
