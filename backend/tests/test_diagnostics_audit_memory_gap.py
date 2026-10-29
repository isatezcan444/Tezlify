"""`audit_memory_gap.py` — RAM/DB farkini KIMLIK uzerinden olcen betigin testleri.

Neden bu testler var: Asama 3.6'da "7080 RAM-only mesaj" raporlandi ve bu sayi
YANLISTI — gateway'e `perChatLimit=50` ile soruldugu icin sohbet basina yalnizca
son 50 mesaj gorunuyordu. Sayac tabanli olcum bu hatayi gizler; kimlik tabanli
siniflandirma gizlemez. Bu dosya siniflandirmanin her dali ayri ayri
dogruladigini ve "yanlis saymayi" reddettigini kanitlar.

Testler saf fonksiyonlari cagirir: DB yok, ag yok, gateway yok.
"""

import importlib.util
import pathlib

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_TOOL_PATH = _REPO_ROOT / "scripts" / "diagnostics" / "audit_memory_gap.py"


def _load_tool():
    spec = importlib.util.spec_from_file_location("diagnostics_audit_memory_gap", _TOOL_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tool = _load_tool()

PN = "905551110001@s.whatsapp.net"
PN2 = "905551110002@s.whatsapp.net"
LID = "144130562887745@lid"
GROUP = "905413749073-1589570212@g.us"


def msg(jid, wa_id, *, ts=True, sender=True, body="merhaba"):
    m = {"conversation_id": jid, "body": body}
    if wa_id is not None:
        m["wa_message_id"] = wa_id
    if ts:
        m["created_at"] = "2026-10-01T10:00:00Z"
    if sender:
        m["sender_phone"] = "+905551112233"
    return m


def run(ram, *, db_by_conv=None, db_by_wa=None, jid_map=None, conv_ids=None):
    db_by_conv = db_by_conv or {}
    db_by_wa = db_by_wa or {
        wa: {cid} for cid, ids in db_by_conv.items() for wa in ids
    }
    # `or` KULLANMA: bos sozluk ("hicbir sey eslenmiyor") mesru bir senaryodur.
    if jid_map is None:
        jid_map = {PN: 1, PN2: 2, LID: 3, GROUP: 4}
    conv_ids = conv_ids if conv_ids is not None else {1, 2, 3, 4}
    return tool.classify(
        ram=ram,
        db_ids_by_conv=db_by_conv,
        db_ids_any_conv=db_by_wa,
        jid_to_conv=jid_map,
        conv_ids=conv_ids,
    )


# ---------------------------------------------------------------------------
# Siniflandirma dallari
# ---------------------------------------------------------------------------
def test_present_under_correct_conversation():
    out = run([msg(PN, "A1")], db_by_conv={1: {"A1"}})
    assert out["CLASS_present_correct_conv"] == 1
    assert out["CLASS_genuinely_missing"] == 0


def test_present_under_another_conversation_is_not_missing():
    """Mesaj DB'de ama yanlis sohbette: 'eksik' SAYILMAZ, ayri sinif olur."""
    out = run([msg(PN, "A1")], db_by_conv={2: {"A1"}})
    assert out["CLASS_present_other_conv"] == 1
    assert out["CLASS_genuinely_missing"] == 0


def test_present_under_another_tenant_is_flagged():
    """Ayni wa_message_id baska tenant'in sohbetinde: kiracı sizintisi sinyali."""
    out = run(
        [msg(PN, "A1")],
        db_by_conv={999: {"A1"}},
        conv_ids={1, 2, 3, 4},
    )
    assert out["CLASS_present_other_conv"] == 1
    assert out["CLASS_present_other_tenant"] == 1


def test_genuinely_missing():
    out = run([msg(PN, "A1")], db_by_conv={})
    assert out["CLASS_genuinely_missing"] == 1
    assert out["missing_affected_conversations"] == 1
    assert out["missing_top_conversations"] == [{"conv": 1, "count": 1}]


def test_unmapped_jid_is_counted_separately():
    out = run([msg("999999999999@s.whatsapp.net", "A1")], db_by_conv={})
    assert out["CLASS_unmapped_jid"] == 1
    assert out["CLASS_genuinely_missing"] == 0
    assert out["CLASS_unmapped_by_kind"] == {"PN": 1}


def test_unmapped_kind_classification():
    out = run(
        [msg(LID, "A1"), msg(GROUP, "A2")],
        db_by_conv={},
        jid_map={},  # hicbir sey eslenmiyor
    )
    assert out["CLASS_unmapped_by_kind"] == {"LID": 1, "GROUP": 1}


def test_missing_rows_without_timestamp_or_sender_are_counted():
    out = run([msg(PN, "A1", ts=False, sender=False)], db_by_conv={})
    assert out["CLASS_genuinely_missing"] == 1
    assert out["missing_without_timestamp"] == 1
    assert out["missing_without_sender_meta"] == 1


# ---------------------------------------------------------------------------
# "Yanlis sayma" tuzaklari — Asama 3.6'da fiilen yasanan hata
# ---------------------------------------------------------------------------
def test_rows_without_wa_id_are_not_counted_as_missing():
    """Kimliksiz kayit siniflandirilamaz; 'eksik' diye saymak yanlis olurdu."""
    out = run([msg(PN, None), msg(PN, None)], db_by_conv={})
    assert out["CLASS_genuinely_missing"] == 0
    assert out["ram_rows_without_id"] == 2
    assert out["ram_with_valid_id"] == 0


def test_blank_wa_id_is_not_an_id():
    out = run([msg(PN, "   ")], db_by_conv={})
    assert out["ram_rows_without_id"] == 1
    assert out["ram_with_valid_id"] == 0


def test_duplicate_ids_in_ram_are_reported_not_hidden():
    out = run([msg(PN, "A1"), msg(PN, "A1")], db_by_conv={1: {"A1"}})
    assert out["ram_duplicate_id_rows"] == 1
    assert out["ram_distinct_ids"] == 1
    assert out["ram_total"] == 2


def test_lid_alias_maps_to_the_right_conversation():
    """LID anahtarli mesaj, PN sohbetine eslesmeli — aksi halde 'eksik' gorunur."""
    out = run(
        [msg(LID, "A1")],
        db_by_conv={3: {"A1"}},
        jid_map={PN: 3, LID: 3},
    )
    assert out["CLASS_present_correct_conv"] == 1
    assert out["CLASS_unmapped_jid"] == 0


def test_group_chat_is_classified_normally():
    out = run([msg(GROUP, "A1")], db_by_conv={4: {"A1"}})
    assert out["CLASS_present_correct_conv"] == 1


def test_non_mapping_entries_are_skipped_safely():
    out = run([None, "junk", 42, msg(PN, "A1")], db_by_conv={1: {"A1"}})
    assert out["CLASS_present_correct_conv"] == 1
    assert out["ram_total"] == 4  # ham uzunluk korunur, cokme yok


def test_phone_jid_normalisation():
    assert tool.norm_phone_jid("+90 555 111 00 01") == "905551110001@s.whatsapp.net"
    assert tool.norm_phone_jid("jid:905551110001@s.whatsapp.net") == "905551110001@s.whatsapp.net"
    assert tool.norm_phone_jid("") == ""
    assert tool.norm_phone_jid(None) == ""
    assert tool.norm_phone_jid("abc") == ""


# ---------------------------------------------------------------------------
# Once/sonra karsilastirmasi
# ---------------------------------------------------------------------------
def test_compare_accepts_improvement():
    assert tool.compare({"CLASS_genuinely_missing": 7337}, {"CLASS_genuinely_missing": 0}) == []


def test_compare_flags_regression():
    problems = tool.compare(
        {"CLASS_genuinely_missing": 10}, {"CLASS_genuinely_missing": 11}
    )
    assert problems and "ARTTI" in problems[0]


def test_compare_flags_cross_tenant_leak():
    problems = tool.compare(
        {"CLASS_genuinely_missing": 0, "CLASS_present_other_tenant": 1},
        {"CLASS_genuinely_missing": 0, "CLASS_present_other_tenant": 1},
    )
    assert any("baska tenant" in p for p in problems)


def test_compare_flags_duplicate_ids():
    problems = tool.compare(
        {"CLASS_genuinely_missing": 0, "ram_duplicate_id_rows": 2},
        {"CLASS_genuinely_missing": 0, "ram_duplicate_id_rows": 2},
    )
    assert any("birden fazla" in p for p in problems)


# ---------------------------------------------------------------------------
# Yapisal pin: betik yazmaz
# ---------------------------------------------------------------------------
def test_tool_contains_no_write_statements():
    src = _TOOL_PATH.read_text(encoding="utf-8")
    for forbidden in [
        "INSERT INTO",
        "UPDATE messages",
        "DELETE FROM",
        "db.commit()",
        "db.add(",
        "flush()",
        "execute(text(\"DROP",
    ]:
        assert forbidden not in src, f"betik yaziyor olabilir: {forbidden}"


# ---------------------------------------------------------------------------
# Faz 3.8.1 — adlandirilmis siniflar
# ---------------------------------------------------------------------------
def test_named_classes_are_aliases_of_the_same_counts():
    """Yeni adlar YENI bir hesap degil: ayni sayilarin okunur adi."""
    out = run([msg(PN, "W1")], db_by_conv={})
    assert out["IDENTITY_MATCH"] == out["CLASS_present_correct_conv"]
    assert out["RAM_ONLY"] == out["CLASS_genuinely_missing"]
    assert out["CHAT_MISMATCH"] == out["CLASS_present_other_conv"]
    assert out["TENANT_MISMATCH"] == out["CLASS_present_other_tenant"]
    assert out["DUPLICATE_IDENTITY"] == out["ram_duplicate_id_rows"]
    assert out["UNRESOLVED_IDENTITY"] == (
        out["CLASS_unmapped_jid"] + out["ram_rows_without_id"]
    )


def test_unresolved_splits_unmapped_from_idless():
    """Iki farkli 'eslenemedi' nedeni ayri raporlanmali."""
    out = run([msg("999999@lid", "W1"), msg(PN, None)], jid_map={PN: 1})
    assert out["UNRESOLVED_UNMAPPED_JID"] == 1
    assert out["UNRESOLVED_ROWS_WITHOUT_ID"] == 1
    assert out["UNRESOLVED_IDENTITY"] == 2


# ---------------------------------------------------------------------------
# Faz 3.8.1 — kimlik token'lari
# ---------------------------------------------------------------------------
def test_identity_token_is_stable_and_not_the_raw_id():
    a = tool.identity_token("WAMID-ABC")
    b = tool.identity_token("WAMID-ABC")
    assert a == b, "ayni kimlik iki snapshot'ta ayni token'i uretmeli"
    assert "WAMID-ABC" not in a, "ham kimlik diske yazilmamali"
    assert len(a) == 32


def test_identity_token_separates_different_ids():
    assert tool.identity_token("A") != tool.identity_token("B")


# ---------------------------------------------------------------------------
# Faz 3.8.1 — snapshot karsilastirmasi
# ---------------------------------------------------------------------------
def snap(ram=None, db=None, missing=0, **extra):
    payload = {
        "schema": 2,
        "ram": ram or {},
        "db": db or {},
        "CLASS_genuinely_missing": missing,
    }
    payload.update(extra)
    return payload


def test_compare_inconclusive_when_snapshot_has_no_identities():
    """Sayi tasiyan eski snapshot: 'eksik azaldi' BASARI SAYILMAZ."""
    verdict = tool.compare_snapshots({"CLASS_genuinely_missing": 7336}, {"CLASS_genuinely_missing": 0})
    assert verdict["verdict"] == "INCONCLUSIVE"
    assert verdict["reason"] == "snapshot_kimlik_kumesi_yok"
    assert tool.exit_code_for(verdict) == 4


def test_compare_aggregate_opt_in_keeps_legacy_behaviour():
    """Bilincli istisna: eski davranis hala mumkun, ama ADI konarak."""
    verdict = tool.compare_snapshots(
        {"CLASS_genuinely_missing": 10}, {"CLASS_genuinely_missing": 5}, allow_aggregate=True
    )
    assert verdict["verdict"] == "OK"
    assert verdict["reason"] == "aggregate_only_explicitly_allowed"


def test_compare_ok_when_identity_present_and_nothing_lost():
    verdict = tool.compare_snapshots(
        snap(ram={"1": ["aaa", "bbb"]}, db={"1": ["aaa"]}, missing=1),
        snap(ram={"1": ["aaa", "bbb"]}, db={"1": ["aaa", "bbb"]}, missing=0),
    )
    assert verdict["verdict"] == "OK", verdict
    assert tool.exit_code_for(verdict) == 0


def test_compare_flags_possible_eviction():
    """Onceki RAM'de olup simdi NE RAM'de NE DB'de olan kimlik = kayip."""
    verdict = tool.compare_snapshots(
        snap(ram={"1": ["aaa", "bbb"]}, db={"1": []}, missing=2),
        snap(ram={"1": ["bbb", "ccc"]}, db={"1": []}, missing=1),
    )
    assert verdict["verdict"] == "VIOLATION"
    assert verdict["possible_eviction"]["count"] == 1
    assert verdict["possible_eviction"]["by_conversation"][0]["conv"] == "1"
    assert tool.exit_code_for(verdict) == 3


def test_compare_does_not_call_persistence_an_eviction():
    """RAM'den cikip DB'ye GIREN kimlik kayip degildir."""
    verdict = tool.compare_snapshots(
        snap(ram={"1": ["aaa"]}, db={"1": []}, missing=1),
        snap(ram={"1": []}, db={"1": ["aaa"]}, missing=0),
    )
    assert verdict["verdict"] == "OK", verdict
    assert verdict["possible_eviction"] == {}


def test_idless_rows_do_not_cause_false_eviction():
    """Kimliksiz satirin token'i bos string'dir; kimlik sayilmamali.

    Sayilsaydi, iki farkli kimliksiz satir "ayni kimlik" gibi gorunur ve
    biri kayboldugunda sahte bir POSSIBLE_EVICTION uretirdi.
    """
    verdict = tool.compare_snapshots(
        snap(ram={"__noid__": [""], "1": ["aaa"]}),
        snap(ram={"1": ["aaa"]}),
    )
    assert verdict["verdict"] == "OK", verdict


def test_compare_flags_db_identity_loss():
    verdict = tool.compare_snapshots(
        snap(ram={"1": ["aaa"]}, db={"1": ["aaa", "zzz"]}),
        snap(ram={"1": ["aaa"]}, db={"1": ["aaa"]}),
    )
    assert verdict["verdict"] == "VIOLATION"
    assert verdict["db_identities_lost"] == 1


def test_compare_still_flags_tenant_leak_with_identity():
    verdict = tool.compare_snapshots(
        snap(ram={"1": ["aaa"]}),
        snap(ram={"1": ["aaa"]}, CLASS_present_other_tenant=1),
    )
    assert verdict["verdict"] == "VIOLATION"
    assert any("baska tenant" in p for p in verdict["problems"])


def test_compare_still_flags_duplicate_identity():
    verdict = tool.compare_snapshots(
        snap(ram={"1": ["aaa"]}),
        snap(ram={"1": ["aaa"]}, ram_duplicate_id_rows=2),
    )
    assert verdict["verdict"] == "VIOLATION"
    assert any("birden fazla" in p for p in verdict["problems"])


def test_compare_flags_increase_even_with_identity():
    verdict = tool.compare_snapshots(
        snap(ram={"1": ["aaa"]}, missing=1),
        snap(ram={"1": ["aaa", "bbb"]}, missing=2),
    )
    assert verdict["verdict"] == "VIOLATION"
    assert any("ARTTI" in p for p in verdict["problems"])


def test_legacy_compare_still_returns_a_list():
    """Eski cagiranlar kirilmasin: `compare` hala ihlal LISTESI dondurur."""
    assert tool.compare({"CLASS_genuinely_missing": 7337}, {"CLASS_genuinely_missing": 0}) == []
    problems = tool.compare({"CLASS_genuinely_missing": 1}, {"CLASS_genuinely_missing": 2})
    assert isinstance(problems, list) and "ARTTI" in problems[0]


# ---------------------------------------------------------------------------
# Faz 3.8.1 — snapshot dosyasi PII tasimaz
# ---------------------------------------------------------------------------
def test_write_snapshot_to_stdout_is_valid_json(capsys):
    """`--snapshot -`: stdout yalnizca JSON olmali (yoksa `> s.json` bozulur)."""
    import json

    identity = {"ram": {"1": [tool.identity_token("X")]}, "db": {}}
    tool.write_snapshot("-", {"captured_at": "t", "session_id": 1}, identity)
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["schema"] == tool.SNAPSHOT_SCHEMA
    assert payload["ram"]["1"] == identity["ram"]["1"]


def test_write_snapshot_stores_hashes_not_raw_ids(tmp_path):
    import json

    identity = {
        "ram": {"1": [tool.identity_token("RAW-WAMID-1")]},
        "db": {"1": [tool.identity_token("RAW-WAMID-2")]},
    }
    result = {"captured_at": "2026-10-29T00:00:00Z", "session_id": 201, "RAM_ONLY": 1}
    out = tmp_path / "snap.json"
    tool.write_snapshot(str(out), result, identity)
    text = out.read_text(encoding="utf-8")
    assert "RAW-WAMID" not in text, "ham mesaj kimligi diske yazilmamali"
    payload = json.loads(text)
    assert payload["schema"] == tool.SNAPSHOT_SCHEMA
    assert payload["ram"]["1"] == identity["ram"]["1"]
