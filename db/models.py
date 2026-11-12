from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, ForeignKeyConstraint, Index, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from db.database import Base


class Session(Base):
    __tablename__ = "sessions"

    user_id: Mapped[str] = mapped_column(Text, primary_key=True)
    mode: Mapped[str] = mapped_column(Text, primary_key=True)
    session_id: Mapped[str] = mapped_column(Text, nullable=False)
    last_active_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        ForeignKeyConstraint(
            ["user_id", "mode"],
            ["sessions.user_id", "sessions.mode"],
            ondelete="CASCADE",
        ),
        Index("ix_messages_user_id_mode_created_at", "user_id", "mode", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class TokenUsage(Base):
    __tablename__ = "token_usage"
    __table_args__ = (
        Index("ix_token_usage_user_id_created_at", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(Text, nullable=False)
    tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SlotState(Base):
    __tablename__ = "slot_states"

    user_id: Mapped[str] = mapped_column(Text, primary_key=True)
    slots_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    stages_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    thinnest: Mapped[str] = mapped_column(Text, nullable=False, default="")
    understood: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    vision: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class UnderstandingHistory(Base):
    __tablename__ = "understanding_history"
    __table_args__ = (
        Index("ix_understanding_history_user_id_created_at", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[str] = mapped_column(Text, nullable=False)
    understood: Mapped[float] = mapped_column(Float, nullable=False)
    vision: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
