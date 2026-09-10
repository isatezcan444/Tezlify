"""
Domain State Machine for WhatsApp Message Status Progression.

Enforces monotonic forward progression of message statuses:
  PENDING -> SENT -> DELIVERED -> READ
  Any non-terminal status -> FAILED

Strictly rejects backward status transitions (e.g. READ -> DELIVERED or DELIVERED -> SENT)
to prevent out-of-order network/webhook delivery from corrupting message audit state.
"""
from typing import Dict, Set, Optional, Any
from datetime import datetime, timezone
from backend.app.models.message import ConversationMessageStatus


class InvalidMessageStatusTransitionError(ValueError):
    """Raised when an illegal status progression is attempted."""
    def __init__(self, current_status: Any, target_status: Any):
        curr_val = getattr(current_status, "value", str(current_status))
        target_val = getattr(target_status, "value", str(target_status))
        super().__init__(
            f"Invalid message status transition from '{curr_val}' to '{target_val}'. "
            "Status progression must be monotonic and forward-only."
        )
        self.current_status = current_status
        self.target_status = target_status


class MessageStateMachine:
    """State machine governing ConversationMessageStatus transitions."""

    # Explicit directed acyclic transition graph
    VALID_TRANSITIONS: Dict[ConversationMessageStatus, Set[ConversationMessageStatus]] = {
        ConversationMessageStatus.PENDING: {
            ConversationMessageStatus.SENT,
            ConversationMessageStatus.FAILED,
        },
        ConversationMessageStatus.SENT: {
            ConversationMessageStatus.DELIVERED,
            ConversationMessageStatus.READ,
            ConversationMessageStatus.FAILED,
        },
        ConversationMessageStatus.DELIVERED: {
            ConversationMessageStatus.READ,
            ConversationMessageStatus.FAILED,
        },
        ConversationMessageStatus.RECEIVED: {
            ConversationMessageStatus.READ,
        },
        ConversationMessageStatus.READ: set(),  # Terminal state: cannot transition to anything
        # FAILED -> PENDING is the single intentional re-queue edge: the unified
        # POST /messages/{id}/retry endpoint moves a FAILED outbox message back
        # to PENDING and enqueues a fresh OutboxMessage; the worker then performs
        # the normal PENDING -> SENT / FAILED progression. Direct FAILED -> SENT
        # remains forbidden so every dispatch passes through the outbox.
        ConversationMessageStatus.FAILED: {
            ConversationMessageStatus.PENDING,
        },
    }

    # Numeric rank for monotonic inequality checks
    STATUS_RANKS: Dict[ConversationMessageStatus, int] = {
        ConversationMessageStatus.PENDING: 1,
        ConversationMessageStatus.SENT: 2,
        ConversationMessageStatus.DELIVERED: 3,
        ConversationMessageStatus.READ: 4,
        ConversationMessageStatus.RECEIVED: 2,
        ConversationMessageStatus.FAILED: 99,
    }

    @classmethod
    def can_transition(
        cls,
        current_status: ConversationMessageStatus,
        target_status: ConversationMessageStatus,
    ) -> bool:
        """Returns True if the transition from current to target status is mathematically valid."""
        if current_status == target_status:
            return True  # Idempotent no-op
        valid_targets = cls.VALID_TRANSITIONS.get(current_status, set())
        return target_status in valid_targets

    @classmethod
    def transition(
        cls,
        target: Any,
        target_status: Optional[ConversationMessageStatus] = None,
        event_time: Optional[datetime] = None,
        error_code: Optional[int] = None,
        error_message: Optional[str] = None,
    ) -> Any:
        """
        Validates and applies status transition.
        Can accept:
        1. (msg: Message, target_status: ConversationMessageStatus, ...)
        2. (current_status: ConversationMessageStatus, target_status: ConversationMessageStatus)
        Raises InvalidMessageStatusTransitionError if backward or invalid.
        """
        if hasattr(target, "status"):
            # Target is a Message instance
            msg = target
            curr = msg.status
            if curr == target_status:
                return msg

            if not cls.can_transition(curr, target_status):
                raise InvalidMessageStatusTransitionError(curr, target_status)

            msg.status = target_status
            ts = event_time or datetime.now(timezone.utc)
            if target_status == ConversationMessageStatus.SENT:
                msg.sent_at = ts
            elif target_status == ConversationMessageStatus.DELIVERED:
                msg.delivered_at = ts
            elif target_status == ConversationMessageStatus.READ:
                msg.read_at = ts
            elif target_status == ConversationMessageStatus.FAILED:
                msg.failed_at = ts
                if error_code is not None:
                    msg.error_code = error_code
                if error_message is not None:
                    msg.error_message = error_message
            return msg

        # Target is a status enum
        curr = target
        if curr == target_status:
            return curr

        if not cls.can_transition(curr, target_status):
            raise InvalidMessageStatusTransitionError(curr, target_status)

        return target_status

    @classmethod
    def is_terminal(cls, status: ConversationMessageStatus) -> bool:
        """Returns True if the status represents a final, immutable message state."""
        return status in (ConversationMessageStatus.READ, ConversationMessageStatus.FAILED)
