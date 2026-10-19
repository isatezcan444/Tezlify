#!/usr/bin/env python3
"""
E2E System Verification Script:
1. Anti-Ban Mechanism (Working hours gate, Gaussian jitter, Daily limit, Spintax)
2. Leads Validation (Strictly Isa [+905413749073] and Cevat Aydin [+905076382749])
3. Campaign Group Creation & Lead Association
4. Campaign Creation with Anti-Ban Settings
5. Live WhatsApp Campaign Launch & Anti-Ban Delay Verification
6. Final Audit: Verification that NO OTHER leads received messages
"""
import sys
import os
import asyncio
import json
from uuid import UUID
from datetime import datetime

# Add project root to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import select, update, func
from backend.app.core.database import AsyncSessionLocal
from backend.app.models.lead import Lead, LeadStatus
from backend.app.models.campaign import Campaign, CampaignStatus
from backend.app.models.campaign_group import CampaignGroup, campaign_group_leads
from backend.app.models.whatsapp_session import WhatsAppSession, SessionStatus
from backend.app.models.message_log import MessageLog, MessageStatus
from backend.app.models.message import Message
from backend.app.models.conversation import Conversation
from backend.app.models.contact import Contact
from backend.app.auth.application.session_service import SessionService
from backend.app.services.antiban_policy import AntibanPolicy, gaussian_jitter_seconds
from backend.app.services.outreach_guard import OutreachGuard
from backend.app.services.campaign_runner import CampaignRunner
from backend.app.services.spintax_service import SpintaxService

TARGET_PHONES = {"+905413749073", "+905076382749"}
USER_ID = UUID("f65642ab-4ae5-4d69-945c-8f30c8454bac")

report = {
    "started_at": datetime.now().isoformat(),
    "steps": {},
    "anti_ban_results": {},
    "leads_verified": [],
    "campaign_group": {},
    "campaign": {},
    "dispatch_results": [],
    "audit_guarantee": {},
    "success": False
}

async def run_e2e_test():
    print("=" * 60)
    print("TEZLIFY E2E ANTI-BAN VE KAMPANYA CANLI DOĞRULAMA TESTİ")
    print("=" * 60)

    async with AsyncSessionLocal() as db:
        # ---------------------------------------------------------
        # ADIM 1: Aktif WhatsApp Oturumu Kontrolü
        # ---------------------------------------------------------
        print("\n[ADIM 1] Aktif WhatsApp Oturumu Doğrulanıyor...")
        sess_stmt = select(WhatsAppSession).where(
            WhatsAppSession.user_id == USER_ID,
            WhatsAppSession.status == SessionStatus.CONNECTED
        )
        res = await db.execute(sess_stmt)
        active_sess = res.scalars().first()
        if not active_sess:
            raise RuntimeError(f"Kullanıcı {USER_ID} için bağlı aktif WhatsApp oturumu bulunamadı!")
        print(f"  ✓ Aktif WhatsApp Oturumu: ID={active_sess.id}, Ad='{active_sess.session_name}', Tel={active_sess.phone_number}, Durum={active_sess.status.value}")
        report["steps"]["whatsapp_session"] = {
            "id": active_sess.id,
            "session_name": active_sess.session_name,
            "phone_number": active_sess.phone_number,
            "status": active_sess.status.value
        }

        # ---------------------------------------------------------
        # ADIM 2: Müşteri Adayları (Leads) Doğrulaması
        # ---------------------------------------------------------
        print("\n[ADIM 2] Hedef Müşteri Adayları Doğrulanıyor (Sadece İsa ve Cevat Aydın)...")
        leads_stmt = select(Lead).where(
            Lead.user_id == USER_ID,
            Lead.phone_e164.in_(list(TARGET_PHONES))
        ).order_by(Lead.id.asc())
        leads_res = await db.execute(leads_stmt)
        target_leads = leads_res.scalars().all()

        if len(target_leads) != 2:
            raise RuntimeError(f"Beklenen 2 hedef lead bulunamadı! Bulunan: {len(target_leads)}")

        for l in target_leads:
            print(f"  ✓ Lead #{l.id}: '{l.name}', Tel={l.phone_e164}, WhatsAppUyumlu={l.is_whatsapp_eligible}, Dogrulandi={l.is_verified}, Tip={l.entity_type}, MevcutDurum={l.status.value}")
            report["leads_verified"].append({
                "id": l.id,
                "name": l.name,
                "phone": l.phone_e164,
                "is_whatsapp_eligible": l.is_whatsapp_eligible,
                "is_verified": l.is_verified,
                "entity_type": l.entity_type,
                "initial_status": l.status.value
            })

        # Test öncesi lead'leri NEW durumuna resetle (temiz test başlangıcı)
        lead_ids = [l.id for l in target_leads]
        await db.execute(
            update(Lead).where(Lead.id.in_(lead_ids)).values(status=LeadStatus.NEW)
        )
        await db.commit()
        print(f"  ✓ Lead ID'leri {lead_ids} durumu temiz test için 'NEW' olarak güncellendi.")

        # ---------------------------------------------------------
        # ADIM 3: Anti-Ban Mekanizması Doğrulaması
        # ---------------------------------------------------------
        print("\n[ADIM 3] Anti-Ban Mekanizması Doğrulanıyor...")
        
        # 3.1 Gaussian Jitter Dağılım Testi
        jitter_samples = [gaussian_jitter_seconds(5, 10) for _ in range(20)]
        all_in_range = all(5 <= s <= 10 for s in jitter_samples)
        avg_jitter = sum(jitter_samples) / len(jitter_samples)
        print(f"  ✓ Gaussian Jitter (5-10s): Örnekler={jitter_samples[:8]}..., Aralık Doğru={all_in_range}, Ort={avg_jitter:.2f}s")
        report["anti_ban_results"]["jitter_distribution"] = {
            "min_delay": 5,
            "max_delay": 10,
            "all_in_range": all_in_range,
            "average": avg_jitter,
            "sample_values": jitter_samples[:10]
        }
        assert all_in_range, "Jitter değerleri belirlenen [5, 10] aralığı dışında!"

        # 3.2 Mesai Saatleri Kontrolü (Fail-Closed)
        # Şu anki saatle mesai saati testleri:
        mock_campaign_office = Campaign(
            name="Office Hours Campaign",
            message_template="test",
            working_hours_enabled=True,
            working_hours_start="09:00",
            working_hours_end="18:00"
        )
        policy_office = AntibanPolicy.from_campaign(mock_campaign_office)
        is_now_office = policy_office.is_within_working_hours()
        print(f"  ✓ Mesai Saati Kontrolü (09:00 - 18:00): Şu an geçerli mi? -> {is_now_office}")
        
        # Fail-closed simülasyonu: Gece saat 23:00 için False dönmeli, 14:00 için True dönmeli
        from datetime import time
        assert policy_office.is_within_working_hours(time(14, 0)) == True, "Mesai saati içi True dönmeli!"
        assert policy_office.is_within_working_hours(time(23, 0)) == False, "Mesai saati dışı False dönmeli!"
        print("  ✓ Mesai Saati Fail-Closed Simülasyonu: 14:00=True, 23:00=False (Kusursuz doğrulandı)")

        report["anti_ban_results"]["working_hours_gate"] = {
            "configured_hours": "09:00 - 18:00",
            "is_now_office": is_now_office,
            "simulated_noon_pass": True,
            "simulated_night_block": True
        }

        # 3.3 Günlük Limit Kontrolü
        mock_campaign_limit = Campaign(
            name="Daily Limit Campaign",
            message_template="test",
            daily_message_limit=2
        )
        policy_limit = AntibanPolicy.from_campaign(mock_campaign_limit)
        assert policy_limit.is_daily_limit_reached(1) == False
        assert policy_limit.is_daily_limit_reached(2) == True
        assert policy_limit.is_daily_limit_reached(3) == True
        print("  ✓ Günlük Limit Kontrolü: 1 gönderimde False, 2 ve üzerinde True (Otomatik Duraklatma Tetikleme Hazır)")
        report["anti_ban_results"]["daily_limit_gate"] = {
            "daily_limit": 2,
            "limit_reached_on_2": True
        }

        # 3.4 Spintax Şablon Permütasyon ve Render Doğrulaması
        template = "{Merhaba|Selamlar|İyi günler} {name}, Tezlify sistemi üzerinden {canlı|gerçek zamanlı} test mesajıdır."
        perms = SpintaxService.calculate_permutations(template)
        sample1 = SpintaxService.render_template(template, {"name": target_leads[0].name})
        sample2 = SpintaxService.render_template(template, {"name": target_leads[1].name})
        print(f"  ✓ Spintax Motoru: {perms} farklı permütasyon.")
        print(f"    - Lead 1 Render: '{sample1}'")
        print(f"    - Lead 2 Render: '{sample2}'")
        report["anti_ban_results"]["spintax"] = {
            "template": template,
            "permutations": perms,
            "sample_renders": [sample1, sample2]
        }

        # ---------------------------------------------------------
        # ADIM 4: Kampanya Grubu Oluşturma ve Lead İlişkilendirme
        # ---------------------------------------------------------
        print("\n[ADIM 4] Yeni Kampanya Grubu Oluşturuluyor...")
        group = CampaignGroup(
            user_id=USER_ID,
            name="E2E Doğrulama Grubu (İsa & Cevat)",
            description="Anti-ban ve WhatsApp canlı gönderim doğrulama grubu"
        )
        db.add(group)
        await db.flush()

        # SADECE 7627 ve 7628 lead'lerini bu gruba bağla
        for lid in lead_ids:
            await db.execute(
                campaign_group_leads.insert().values(group_id=group.id, lead_id=lid)
            )
        await db.commit()
        await db.refresh(group)
        print(f"  ✓ Kampanya Grubu Oluşturuldu: ID={group.id}, Ad='{group.name}'")
        
        # Gruptaki lead sayısını teyit et
        g_leads_res = await db.execute(
            select(campaign_group_leads.c.lead_id).where(campaign_group_leads.c.group_id == group.id)
        )
        associated_lead_ids = [r[0] for r in g_leads_res.fetchall()]
        print(f"  ✓ Gruptaki Lead ID'leri: {associated_lead_ids} (Tam olarak beklenen 2 lead)")
        assert set(associated_lead_ids) == set(lead_ids), "Gruptaki lead'ler hedef lead'lerle eşleşmiyor!"
        report["campaign_group"] = {
            "id": group.id,
            "name": group.name,
            "lead_ids": associated_lead_ids
        }

        # ---------------------------------------------------------
        # ADIM 5: Yeni Kampanya Oluşturma
        # ---------------------------------------------------------
        print("\n[ADIM 5] Yeni Kampanya Oluşturuluyor...")
        campaign = Campaign(
            user_id=USER_ID,
            group_id=group.id,
            whatsapp_session_id=active_sess.id,
            name="E2E Anti-Ban Doğrulama Kampanyası",
            description="İsa ve Cevat Aydın için kontrollü canlı doğrulama",
            message_template="{Merhaba|Selamlar} Sayın Yetkili, Tezlify B2B sistemi üzerinden Anti-Ban ve WhatsApp altyapı canlı testi mesajıdır. Lead: {name}",
            min_delay_seconds=5,
            max_delay_seconds=8,
            typing_delay_seconds=2,
            working_hours_enabled=False,  # Gece saatinde de testin sorunsuz ilerlemesi için
            daily_message_limit=50,
            status=CampaignStatus.DRAFT
        )
        db.add(campaign)
        await db.commit()
        await db.refresh(campaign)
        print(f"  ✓ Kampanya Oluşturuldu: ID={campaign.id}, Ad='{campaign.name}', Durum={campaign.status.value}")
        print(f"    - Anti-Ban Parametreleri: Min={campaign.min_delay_seconds}s, Max={campaign.max_delay_seconds}s, Typing={campaign.typing_delay_seconds}s")
        report["campaign"] = {
            "id": campaign.id,
            "name": campaign.name,
            "status": campaign.status.value,
            "min_delay": campaign.min_delay_seconds,
            "max_delay": campaign.max_delay_seconds,
            "typing_delay": campaign.typing_delay_seconds
        }

    # ---------------------------------------------------------
    # ADIM 6: Kampanyayı Başlatma & Canlı Gönderim Takibi
    # ---------------------------------------------------------
    print("\n[ADIM 6] WhatsApp Kampanyası Başlatılıyor...")
    print(f"  >>> HEDEF KAPSAMI: SADECE Lead ID'leri {lead_ids} ({list(TARGET_PHONES)})")
    
    started = await CampaignRunner.start_campaign(
        campaign_id=campaign.id,
        lead_ids=lead_ids,
        limit=2,
        session_id=active_sess.id
    )
    if not started:
        raise RuntimeError("Kampanya başlatılamadı!")
    print(f"  ✓ Kampanya worker görevi başarıyla başlatıldı. Arka plan akışı izleniyor...")

    # Worker'ın tamamlanmasını bekle (Anti-ban jitter gecikmeleri ile yaklaşık 10-25 saniye sürer)
    max_wait = 60
    waited = 0
    final_campaign = None
    while waited < max_wait:
        await asyncio.sleep(2)
        waited += 2
        async with AsyncSessionLocal() as db:
            c = await db.get(Campaign, campaign.id)
            print(f"    [T+{waited}s] Kampanya Durumu: {c.status.value} (Gönderilen: {c.sent_count}, Başarısız: {c.failed_count})")
            if c.status in (CampaignStatus.COMPLETED, CampaignStatus.PAUSED):
                final_campaign = c
                break

    if not final_campaign:
        raise TimeoutError(f"Kampanya {max_wait} saniye içinde tamamlanamadı!")

    print(f"\n  ✓ Kampanya Sonucu: Durum={final_campaign.status.value}, Gönderilen={final_campaign.sent_count}, Hatalı={final_campaign.failed_count}")

    # ---------------------------------------------------------
    # ADIM 7: Veritabanı ve Log Denetimi (Kesin Kanıtlar)
    # ---------------------------------------------------------
    print("\n[ADIM 7] Detaylı Veritabanı ve Mesaj Log Denetimi...")
    async with AsyncSessionLocal() as db:
        # 7.1 Message Logs
        logs_stmt = select(MessageLog).where(
            MessageLog.campaign_id == campaign.id
        ).order_by(MessageLog.id.asc())
        logs_res = await db.execute(logs_stmt)
        logs = logs_res.scalars().all()

        print(f"  ✓ Toplam MessageLog Kaydı: {len(logs)}")
        for ml in logs:
            print(f"    - Log #{ml.id}: Hedef={ml.target_phone}, LeadID={ml.lead_id}, Durum={ml.status.value}, Gecikme={ml.delay_applied_seconds}s")
            print(f"      Mesaj: '{ml.rendered_message}'")
            report["dispatch_results"].append({
                "log_id": ml.id,
                "lead_id": ml.lead_id,
                "target_phone": ml.target_phone,
                "status": ml.status.value,
                "delay_applied_seconds": ml.delay_applied_seconds,
                "rendered_message": ml.rendered_message,
                "sent_at": ml.sent_at.isoformat() if ml.sent_at else None
            })

        # 7.2 Lead Status Değişimleri
        chk_leads_res = await db.execute(
            select(Lead).where(Lead.id.in_(lead_ids))
        )
        chk_leads = chk_leads_res.scalars().all()
        for cl in chk_leads:
            print(f"  ✓ Lead #{cl.id} ({cl.name}): Durum={cl.status.value}, Son İletişim={cl.last_contacted_at}")
            assert cl.status == LeadStatus.CONTACTED, f"Lead #{cl.id} durumu CONTACTED olmalıydı!"

        # ---------------------------------------------------------
        # ADIM 8: KESİN GÜVENLİK VE İZOLASYON DENETİMİ (AUDIT)
        # ---------------------------------------------------------
        print("\n[ADIM 8] Kesin Güvenlik ve İzolasyon Denetimi...")
        # Kampanyada gönderilen TÜM numaraların sadece hedef 2 numara içinde olduğunu doğrula
        outreach_phones = {l.target_phone for l in logs}
        unexpected_phones = outreach_phones - TARGET_PHONES
        print(f"  ✓ Gönderilen Numaralar: {outreach_phones}")
        print(f"  ✓ Beklenmeyen / Yetkisiz Numaralar: {unexpected_phones}")
        assert len(unexpected_phones) == 0, f"KRİTİK HATA: İzin verilmeyen numaralara mesaj gitti! {unexpected_phones}"

        # Başka hiçbir lead'in status'unun değişmediğini teyit et
        other_contacted_count = (await db.scalar(
            select(func.count(Lead.id)).where(
                Lead.user_id == USER_ID,
                Lead.id.notin_(lead_ids),
                Lead.status == LeadStatus.CONTACTED,
                Lead.last_contacted_at >= campaign.created_at
            )
        )) or 0
        print(f"  ✓ Hedef dışındaki hiçbir lead'e temas edilmedi (Değişen diğer lead sayısı: {other_contacted_count})")
        assert other_contacted_count == 0, "Hedef dışı lead'lerde değişiklik tespit edildi!"

        report["audit_guarantee"] = {
            "target_phones_authorized": list(TARGET_PHONES),
            "phones_actually_dispatched": list(outreach_phones),
            "unauthorized_dispatches": 0,
            "isolation_verified": True
        }

    report["success"] = True
    report["finished_at"] = datetime.now().isoformat()
    print("\n" + "=" * 60)
    print("TEZLIFY E2E TESTİ BAŞARIYLA TAMAMLANDI! TÜM SİSTEM KUSURSUZ ÇALIŞIYOR.")
    print("=" * 60)

    # Raporu diske kaydet
    report_path = "/tmp/tezlify_e2e_verification_report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"Rapor dosyası kaydedildi: {report_path}")

if __name__ == "__main__":
    asyncio.run(run_e2e_test())
