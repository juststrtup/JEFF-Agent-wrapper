"""Add startup understanding state and history.

Revision ID: 0002_understanding_state
Revises: 0001_g1_persistence
Create Date: 2026-11-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0002_understanding_state"
down_revision: Union[str, Sequence[str], None] = "0001_g1_persistence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "slot_states",
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("slots_json", sa.Text(), nullable=False),
        sa.Column("stages_json", sa.Text(), nullable=False),
        sa.Column("thinnest", sa.Text(), nullable=False),
        sa.Column("understood", sa.Float(), nullable=False),
        sa.Column("vision", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.create_table(
        "understanding_history",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("mode", sa.Text(), nullable=False),
        sa.Column("understood", sa.Float(), nullable=False),
        sa.Column("vision", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_understanding_history_user_id_created_at",
        "understanding_history",
        ["user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_understanding_history_user_id_created_at",
        table_name="understanding_history",
    )
    op.drop_table("understanding_history")
    op.drop_table("slot_states")
