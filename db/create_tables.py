import asyncio

from db.database import Base
from db.database import engine

from db import models


async def main():

    async with engine.begin() as conn:

        await conn.run_sync(Base.metadata.create_all)

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())