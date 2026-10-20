"""phase_5_baseline

Revision ID: 32def94876ce
Revises: 
Create Date: 2026-10-21 00:16:50.485329

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '32def94876ce'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # 1. Campaigns whatsapp_session_id index
    existing_indexes = [idx["name"] for idx in insp.get_indexes("campaigns")] if "campaigns" in insp.get_table_names() else []
    with op.batch_alter_table('campaigns', schema=None) as batch_op:
        if 'ix_campaigns_whatsapp_session_id' not in existing_indexes:
            batch_op.create_index(batch_op.f('ix_campaigns_whatsapp_session_id'), ['whatsapp_session_id'], unique=False)

    # 2. Messages is_forwarded and is_pinned indexes
    if "messages" in insp.get_table_names():
        msg_indexes = [idx["name"] for idx in insp.get_indexes("messages")]
        with op.batch_alter_table('messages', schema=None) as batch_op:
            if 'ix_messages_is_forwarded' not in msg_indexes:
                batch_op.create_index(batch_op.f('ix_messages_is_forwarded'), ['is_forwarded'], unique=False)
            if 'ix_messages_is_pinned' not in msg_indexes:
                batch_op.create_index(batch_op.f('ix_messages_is_pinned'), ['is_pinned'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table('messages', schema=None) as batch_op:
        try:
            batch_op.drop_index(batch_op.f('ix_messages_is_pinned'))
        except Exception:
            pass
        try:
            batch_op.drop_index(batch_op.f('ix_messages_is_forwarded'))
        except Exception:
            pass

    with op.batch_alter_table('campaigns', schema=None) as batch_op:
        try:
            batch_op.drop_index(batch_op.f('ix_campaigns_whatsapp_session_id'))
        except Exception:
            pass
