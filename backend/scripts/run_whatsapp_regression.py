"""Zorunlu WhatsApp backend regresyon seti — tek çalıştırılabilir kaynak.

NEDEN VAR
---------
5.3.6'da set yalnızca raporlarda ve aşama prompt'larında yazılıydı; hiçbir
çalıştırılabilir komut onu temsil etmiyordu. Bu yüzden 4.27 epoch-reset
korumasını kapsayan `test_whatsapp_pagination_contract.py` "tamamlayıcı kanıt"
olarak elle koşuldu ve sonraki koşularda **kendiliğinden çalışmadı**. Bir testi
koşan bir komut yoksa o test yoktur.

Bu dosya seti koda gömer: 4.27 artık setin parçasıdır.

GÜVENLİK
--------
- Her test dosyası KENDİ taze SQLite dosyasıyla koşar. Paylaşımlı DB, sabit
  JID/e-posta kullanan testlerde (`test_whatsapp_sync_job.py`) artık veri
  yüzünden SAHTE UNIQUE hatası üretir; bağımsızlık ölçümün ön koşuludur.
- `TEZLIFY_TEST_DB_REMOTE_OK` bu betik tarafından **silinir** ve set edilmez.
  `backend/tests/conftest.py` uzak bir DB URL'ini zaten RuntimeError ile
  reddeder; burada ikinci kez kapatılıyor.
- `PYTHONDONTWRITEBYTECODE=1` + `-p no:cacheprovider`: depoda `__pycache__` /
  `.pytest_cache` birikmez.
- Ağ, production DB, servis, Docker: hiçbiri kullanılmaz.

KULLANIM
--------
Bağımlılıkların bulunduğu bir yorumlayıcıyla çalıştırın; alt süreçler
`sys.executable`'ı kullandığı için ortam kendiliğinden devralınır:

    uv run --offline --python 3.13 \
        --with-requirements backend/requirements.txt \
        --with pytest --with pytest-asyncio \
        python backend/scripts/run_whatsapp_regression.py

    python backend/scripts/run_whatsapp_regression.py --list   # seti yazdır

Çıkış kodu: 0 = tümü geçti, 1 = en az bir dosya düştü, 2 = güvenlik reddi.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# ZORUNLU SET. Sıra bilinçli: 4.17/4.27/4.28 çekirdeği önce, 5.2 sözleşmesi
# ve parite sonra. Yeni bir koruma eklenirse buraya da eklenmelidir — aksi
# hâlde o koruma hiçbir otomatik koşuda yer almaz.
MANDATORY_TESTS: tuple[str, ...] = (
    "test_whatsapp_memory_persistence.py",
    "test_whatsapp_memory_persistence_hardening.py",
    "test_whatsapp_pagination_contract.py",       # 4.27 epoch reset (5.3.7'de eklendi)
    "test_whatsapp_sync_job.py",
    "test_memory_persist_fail_closed.py",
    "test_whatsapp_4_34_e2e_regressions.py",
    "test_whatsapp_event_contract_parity.py",
    "test_whatsapp_upsert_append.py",
    "test_whatsapp_message_update_semantics.py",  # 5.3.9 replace semantiği (5.3.11'de eklendi)
    "test_whatsapp_session_delete_lifecycle.py",  # 5.3.9 oturum silme yaşam döngüsü (5.3.11'de eklendi)
)


def _print_set() -> None:
    print(f"Zorunlu WhatsApp backend regresyon seti ({len(MANDATORY_TESTS)} dosya):")
    for i, name in enumerate(MANDATORY_TESTS, 1):
        print(f"  {i}. backend/tests/{name}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Zorunlu WhatsApp backend regresyon seti")
    parser.add_argument("--list", action="store_true", help="seti yazdır ve çık")
    parser.add_argument(
        "--keep-db",
        action="store_true",
        help="geçici DB dosyalarını silme (hata ayıklama)",
    )
    args = parser.parse_args(argv)

    if args.list:
        _print_set()
        return 0

    if os.environ.get("TEZLIFY_TEST_DB_REMOTE_OK") == "1":
        print(
            "RED: TEZLIFY_TEST_DB_REMOTE_OK=1 ayarlı. Bu betik uzak bir DB'ye karşı "
            "koşmayı kabul etmez; değişkeni kaldırıp yeniden deneyin.",
            file=sys.stderr,
        )
        return 2

    tmp_root = Path(tempfile.mkdtemp(prefix="tz-wa-regression-"))
    results: list[tuple[str, str, int, str]] = []
    try:
        for name in MANDATORY_TESTS:
            db_path = tmp_root / f"{name.removesuffix('.py')}.db"
            env = os.environ.copy()
            env.pop("TEZLIFY_TEST_DB_REMOTE_OK", None)
            env.update(
                {
                    "PYTHONPATH": str(REPO_ROOT),
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "TEST_DB_PATH": str(db_path),
                    "DATABASE_URL": f"sqlite+aiosqlite:///{db_path}",
                }
            )

            provision = subprocess.run(
                [sys.executable, "scripts/provision_test_db.py"],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
            )
            if provision.returncode != 0:
                results.append((name, "PROVISION-FAIL", provision.returncode, "sema uretilemedi"))
                continue

            run = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pytest",
                    f"backend/tests/{name}",
                    "-p",
                    "no:cacheprovider",
                    "-q",
                    "--no-header",
                ],
                cwd=REPO_ROOT,
                env=env,
                capture_output=True,
                text=True,
            )
            tail = ""
            for line in reversed(run.stdout.strip().splitlines()):
                if "passed" in line or "failed" in line or "error" in line:
                    tail = line.strip()
                    break
            verdict = "PASS" if run.returncode == 0 else "FAIL"
            results.append((name, verdict, run.returncode, tail))
            print(f"{verdict:4}  {name}  (exit={run.returncode})  {tail}", flush=True)
    finally:
        if args.keep_db:
            print(f"\nDB dosyaları korundu: {tmp_root}")
        else:
            shutil.rmtree(tmp_root, ignore_errors=True)

    failed = [r for r in results if r[1] != "PASS"]
    print("\n=== ÖZET ===")
    for name, verdict, code, tail in results:
        print(f"{verdict:14} exit={code:<3} {name}  {tail}")

    if failed:
        print(f"\n{len(failed)} dosya BAŞARISIZ, {len(results) - len(failed)} geçti.")
        return 1
    print(f"\nTümü geçti ({len(results)}/{len(MANDATORY_TESTS)}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
