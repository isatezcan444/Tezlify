"""
Domain Service for Meta WhatsApp 24-Hour Customer Service Window.

Enforces WhatsApp Business Platform policy:
- Freeform text & media messages are permitted within 24 hours of customer's last inbound message.
- Beyond 24 hours, outreach requires pre-approved Meta Business Templates.
- All calculations are strictly UTC-based to prevent timezone divergence.
"""
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any


class CustomerWindowPolicy:
    FREEFORM_ALLOWED = "FREEFORM_ALLOWED"
    TEMPLATE_REQUIRED = "TEMPLATE_REQUIRED"


# Alias for domain consistency
MessagingPolicy = CustomerWindowPolicy


class CustomerWindowService:
    """Calculates and evaluates Meta's 24-hour customer service window."""

    WINDOW_DURATION = timedelta(hours=24)

    @classmethod
    def calculate_expiration(cls, last_inbound_time: datetime) -> datetime:
        """Calculates exact expiration timestamp (last_inbound_time + 24 hours) in UTC."""
        # Ensure timezone-naive UTC representation consistent with SQLAlchemy DateTime
        if last_inbound_time.tzinfo is not None:
            last_inbound_time = last_inbound_time.astimezone(timezone.utc).replace(tzinfo=None)
        return last_inbound_time + cls.WINDOW_DURATION

    @classmethod
    def update_conversation_window(cls, conversation, customer_message_time: Optional[datetime] = None) -> None:
        """Updates last_customer_message_at and calculates customer_service_window_expires_at."""
        if customer_message_time is None:
            customer_message_time = datetime.now(timezone.utc).replace(tzinfo=None)
        elif customer_message_time.tzinfo is not None:
            customer_message_time = customer_message_time.astimezone(timezone.utc).replace(tzinfo=None)
        conversation.last_customer_message_at = customer_message_time
        conversation.customer_service_window_expires_at = cls.calculate_expiration(customer_message_time)

    @classmethod
    def is_window_open(
        cls,
        expires_at: Optional[datetime],
        now: Optional[datetime] = None,
    ) -> bool:
        """Returns True if the customer service window is active."""
        if not expires_at:
            return False
        if now is None:
            now = datetime.now(timezone.utc).replace(tzinfo=None)
        elif now.tzinfo is not None:
            now = now.astimezone(timezone.utc).replace(tzinfo=None)

        if expires_at.tzinfo is not None:
            expires_at = expires_at.astimezone(timezone.utc).replace(tzinfo=None)

        return now < expires_at

    @classmethod
    def is_within_24h_window(cls, conversation, reference_time: Optional[datetime] = None) -> bool:
        """Convenience method accepting a Conversation instance."""
        return cls.is_window_open(conversation.customer_service_window_expires_at, reference_time)

    @classmethod
    def seconds_remaining(
        cls,
        expires_at: Optional[datetime],
        now: Optional[datetime] = None,
    ) -> int:
        """Returns remaining seconds in window, or 0 if expired."""
        if not expires_at:
            return 0
        if now is None:
            now = datetime.now(timezone.utc).replace(tzinfo=None)
        elif now.tzinfo is not None:
            now = now.astimezone(timezone.utc).replace(tzinfo=None)

        if expires_at.tzinfo is not None:
            expires_at = expires_at.astimezone(timezone.utc).replace(tzinfo=None)

        diff = (expires_at - now).total_seconds()
        return max(0, int(diff))

    @classmethod
    def get_outreach_policy(
        cls,
        expires_at: Optional[datetime],
        now: Optional[datetime] = None,
    ) -> str:
        """
        Determines whether the agent/user is allowed to send freeform text
        or must select a pre-approved Meta Business Template.
        """
        if cls.is_window_open(expires_at, now):
            return CustomerWindowPolicy.FREEFORM_ALLOWED
        return CustomerWindowPolicy.TEMPLATE_REQUIRED

    @classmethod
    def evaluate_messaging_policy(cls, conversation, reference_time: Optional[datetime] = None) -> str:
        """Convenience method accepting a Conversation instance."""
        return cls.get_outreach_policy(conversation.customer_service_window_expires_at, reference_time)

    @classmethod
    def check_window(cls, conversation, reference_time: Optional[datetime] = None) -> Dict[str, Any]:
        """Returns window status dictionary for conversation."""
        exp = getattr(conversation, "customer_service_window_expires_at", None)
        is_open = cls.is_window_open(exp, reference_time)
        sec = cls.seconds_remaining(exp, reference_time)
        return {
            "is_open": is_open,
            "seconds_remaining": sec,
            "expires_at": exp,
            "policy": CustomerWindowPolicy.FREEFORM_ALLOWED if is_open else CustomerWindowPolicy.TEMPLATE_REQUIRED,
        }
