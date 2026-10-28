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
