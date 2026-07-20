import asyncio

from sqlalchemy import text

from db.database import engine


async def main():
    async with engine.connect() as conn:

        result = await conn.execute(text("SELECT 1"))

        print(result.scalar())

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())