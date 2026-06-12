from sqlalchemy import inspect, text

from .database import engine


def ensure_schema_updates() -> None:
    """Add new columns safely on existing MySQL databases."""
    inspector = inspect(engine)
    if "orders" not in inspector.get_table_names():
        return

    columns = {col["name"] for col in inspector.get_columns("orders")}
    if "delivery_type" not in columns:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "ALTER TABLE orders ADD COLUMN delivery_type VARCHAR(50) DEFAULT 'home'"
                )
            )
    if "unit_price" not in columns:
        with engine.begin() as conn:
            conn.execute(
                text("ALTER TABLE orders ADD COLUMN unit_price DOUBLE NULL")
            )
