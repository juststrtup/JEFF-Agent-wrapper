from sqlalchemy.orm import Mapped, mapped_column

from db.database import Base


class HealthCheck(Base):
    __tablename__ = "healthcheck"

    id: Mapped[int] = mapped_column(primary_key=True)