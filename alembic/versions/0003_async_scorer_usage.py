"""Track scorer checkpoints and internal token cost."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003_async_scorer_usage"
down_revision: Union[str, Sequence[str], None] = "0002_understanding_state"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "slot_states",
        sa.Column("last_scored_message_id", sa.BigInteger(), server_default="0", nullable=False),
    )
    op.create_index(
        "ix_messages_user_id_role_id",
        "messages",
        ["user_id", "role", "id"],
    )
    op.create_table(
        "scorer_usage",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("mode", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("first_message_id", sa.BigInteger(), nullable=False),
        sa.Column("last_message_id", sa.BigInteger(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("cached_input_tokens", sa.Integer(), nullable=True),
        sa.Column("cache_write_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("reasoning_tokens", sa.Integer(), nullable=True),
        sa.Column("provider_cost_usd", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_scorer_usage_user_id_created_at",
        "scorer_usage",
        ["user_id", "created_at"],
    )
    op.create_index("ix_scorer_usage_session_id", "scorer_usage", ["session_id"])


def downgrade() -> None:
    op.drop_index("ix_scorer_usage_session_id", table_name="scorer_usage")
    op.drop_index("ix_scorer_usage_user_id_created_at", table_name="scorer_usage")
    op.drop_table("scorer_usage")
    op.drop_index("ix_messages_user_id_role_id", table_name="messages")
    op.drop_column("slot_states", "last_scored_message_id")
