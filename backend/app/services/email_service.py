"""
Email Outreach & SMTP Delivery Service.
Provides asynchronous, robust SMTP delivery for B2B lead generation,
template variable interpolation ({name}, {category}, {city}),
and fail-closed SMTP connection testing.
"""

import asyncio
import json
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Dict, Any, Optional

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.datetime_utils import utc_now_naive
from backend.app.models.system_settings import SystemSetting
from backend.app.models.lead import Lead, LeadStatus

logger = logging.getLogger(__name__)

SMTP_CONFIG_SETTING_KEY = "email_smtp_config"


class EmailService:
    """Manages SMTP configuration, validation, and lead outreach dispatch."""

    @classmethod
    async def get_smtp_config(cls, db: AsyncSession) -> Dict[str, Any]:
        """Retrieves persisted SMTP configuration from system settings."""
        stmt = select(SystemSetting).where(SystemSetting.key == SMTP_CONFIG_SETTING_KEY)
        res = await db.execute(stmt)
        setting = res.scalar_one_or_none()
        if not setting or not setting.value_json:
            return {
                "host": "",
                "port": 587,
                "username": "",
                "password": "",
                "sender_email": "",
                "sender_name": "Tezlify",
                "use_tls": True,
                "use_ssl": False,
                "is_configured": False,
            }

        try:
            data = json.loads(setting.value_json)
            data["is_configured"] = bool(data.get("host") and data.get("sender_email"))
            return data
        except Exception as exc:
            logger.warning("[EmailService] Failed to parse SMTP config JSON: %s", exc)
            return {
                "host": "",
                "port": 587,
                "username": "",
                "password": "",
                "sender_email": "",
                "sender_name": "Tezlify",
                "use_tls": True,
                "use_ssl": False,
                "is_configured": False,
            }

    @classmethod
    async def save_smtp_config(cls, db: AsyncSession, config_data: Dict[str, Any]) -> Dict[str, Any]:
        """Saves SMTP credentials to system settings."""
        stmt = select(SystemSetting).where(SystemSetting.key == SMTP_CONFIG_SETTING_KEY)
        res = await db.execute(stmt)
        setting = res.scalar_one_or_none()

        # If incoming password is empty or masked, retain existing password
        if setting and setting.value_json:
            try:
                old = json.loads(setting.value_json)
                if not config_data.get("password") or config_data.get("password") == "********":
                    config_data["password"] = old.get("password", "")
            except Exception:
                pass

        if not setting:
            setting = SystemSetting(
                key=SMTP_CONFIG_SETTING_KEY,
                value_json=json.dumps(config_data),
            )
            db.add(setting)
        else:
            setting.value_json = json.dumps(config_data)
            setting.updated_at = utc_now_naive()

        await db.commit()
        await db.refresh(setting)

        # Return sanitized copy with masked password
        sanitized = dict(config_data)
        sanitized["is_configured"] = bool(sanitized.get("host") and sanitized.get("sender_email"))
        if sanitized.get("password"):
            sanitized["password"] = "********"
        return sanitized

    @classmethod
    def _send_sync(cls, config: Dict[str, Any], to_email: str, subject: str, body_text: str, is_html: bool = False) -> None:
        """Synchronous SMTP worker invoked within an async threadpool."""
        host = config.get("host")
        port = int(config.get("port") or 587)
        username = config.get("username")
        password = config.get("password")
        sender_email = config.get("sender_email")
        sender_name = config.get("sender_name") or "Tezlify"
        use_ssl = bool(config.get("use_ssl", False))
        use_tls = bool(config.get("use_tls", True))

        if not host or not sender_email:
            raise ValueError("SMTP host ve gönderici e-posta adresi yapılandırılmalıdır.")

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{sender_name} <{sender_email}>"
        msg["To"] = to_email

        if is_html:
            # HTML with plain text fallback
            part_plain = MIMEText(body_text.replace("<br>", "\n").replace("<br/>", "\n").replace("<p>", "\n").replace("</p>", ""), "plain", "utf-8")
            part_html = MIMEText(body_text, "html", "utf-8")
            msg.attach(part_plain)
            msg.attach(part_html)
        else:
            part = MIMEText(body_text, "plain", "utf-8")
            msg.attach(part)

        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            server = smtplib.SMTP(host, port, timeout=15)

        try:
            if not use_ssl and use_tls:
                server.starttls()
            if username and password:
                server.login(username, password)
            server.sendmail(sender_email, [to_email], msg.as_string())
        finally:
            try:
                server.quit()
            except Exception:
                pass

    @classmethod
    async def test_smtp_connection(cls, config: Dict[str, Any], target_email: str) -> Dict[str, Any]:
        """Tests SMTP credentials by sending a test message to target_email."""
        subject = "Tezlify - SMTP Test Mesajı"
        body = "Bu e-posta Tezlify platformundan SMTP yapılandırmanızı doğrulamak amacıyla gönderilmiştir. Bağlantınız başarıyla kuruldu!"
        try:
            await asyncio.to_thread(cls._send_sync, config, target_email, subject, body, False)
            return {"success": True, "message": f"Test e-postası '{target_email}' adresine başarıyla gönderildi."}
        except Exception as exc:
            logger.error("[EmailService] SMTP test failure: %s", exc)
            return {"success": False, "error": str(exc)}

    @classmethod
    async def send_lead_email(
        cls,
        db: AsyncSession,
        lead_id: int,
        subject: str,
        body: str,
        is_html: bool = False,
    ) -> Dict[str, Any]:
        """
        Sends an outreach email to the specified lead.
        Interpolates template variables ({name}, {category}, {city}) and advances lead state.
        """
        lead = await db.get(Lead, lead_id)
        if not lead:
            raise HTTPException(status_code=404, detail="İşletme kaydı bulunamadı.")

        # Determine target recipient email
        target_email = lead.email
        if not target_email and lead.emails and isinstance(lead.emails, list) and len(lead.emails) > 0:
            target_email = lead.emails[0]

        if not target_email or "@" not in target_email:
            raise HTTPException(
                status_code=400,
                detail="Bu işletmenin geçerli bir e-posta adresi bulunmuyor. Lütfen önce iletişim bilgisini zenginleştirin veya ekleyin.",
            )

        config = await cls.get_smtp_config(db)
        if not config.get("is_configured"):
            raise HTTPException(
                status_code=400,
                detail="SMTP sunucu ayarları yapılandırılmamış. Lütfen Ayarlar sekmesinden SMTP bilgilerinizi kaydedin.",
            )

        # Template variable interpolation
        interp_subject = subject.replace("{name}", lead.name or "").replace("{category}", lead.category or "").replace("{city}", lead.city or "")
        interp_body = body.replace("{name}", lead.name or "").replace("{category}", lead.category or "").replace("{city}", lead.city or "")

        try:
            await asyncio.to_thread(cls._send_sync, config, target_email, interp_subject, interp_body, is_html)
        except Exception as exc:
            logger.error("[EmailService] Failed to send email to lead #%d (%s): %s", lead.id, target_email, exc)
            raise HTTPException(
                status_code=500,
                detail=f"E-posta gönderimi başarısız oldu: {exc}",
            )

        # Update lead state to CONTACTED if NEW
        now = utc_now_naive()
        if lead.status == LeadStatus.NEW:
            lead.status = LeadStatus.CONTACTED
        lead.last_contacted_at = now
        lead.updated_at = now
        await db.commit()
        await db.refresh(lead)

        return {
            "success": True,
            "message": f"'{lead.name}' yetkilisine ({target_email}) e-posta başarıyla iletildi.",
            "recipient_email": target_email,
            "subject": interp_subject,
            "sent_at": now.isoformat(),
        }
