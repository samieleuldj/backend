import os
from typing import Optional

from sqlalchemy.orm import Session

from . import models


DEFAULT_PRODUCTS = [
    {"product_id": "cellulite-device", "product_name": "جهاز إزالة السيلوليت والترهلات"},
    {"product_id": "lumbar-belt", "product_name": "حزام دعم قطني للظهر"},
    {"product_id": "car-cushion", "product_name": "وسادة مقعد السيارة"},
    {"product_id": "orthopedic-pillow", "product_name": "وسادة طبية"},
]


def get_cogs_ratio_fallback() -> float:
    try:
        return float(os.getenv("DEFAULT_COGS_RATIO", "0.55"))
    except ValueError:
        return 0.55


def ensure_default_products(db: Session) -> None:
    for item in DEFAULT_PRODUCTS:
        exists = (
            db.query(models.ProductCost)
            .filter(models.ProductCost.product_id == item["product_id"])
            .first()
        )
        if not exists:
            db.add(
                models.ProductCost(
                    product_id=item["product_id"],
                    product_name=item["product_name"],
                    purchase_cost_dzd=0,
                )
            )
    db.commit()


def get_product_cost_row(
    db: Session,
    product_id: Optional[str] = None,
    product_name: Optional[str] = None,
) -> Optional[models.ProductCost]:
    if product_id:
        row = (
            db.query(models.ProductCost)
            .filter(models.ProductCost.product_id == product_id.strip())
            .first()
        )
        if row:
            return row

    name = (product_name or "").strip()
    if not name:
        return None

    row = (
        db.query(models.ProductCost)
        .filter(models.ProductCost.product_name == name)
        .first()
    )
    if row:
        return row

    return (
        db.query(models.ProductCost)
        .filter(models.ProductCost.product_name.like(f"%{name[:40]}%"))
        .first()
    )


def order_product_cost(db: Session, order: models.Order) -> float:
    qty = max(1, int(order.quantity or 1))
    row = get_product_cost_row(db, order.product_id, order.product_name)
    if row and float(row.purchase_cost_dzd or 0) > 0:
        return round(float(row.purchase_cost_dzd) * qty, 2)

    unit = float(order.unit_price or 0)
    if unit > 0:
        return round(unit * qty * get_cogs_ratio_fallback(), 2)

    total = float(order.total_price or 0)
    return round(total * get_cogs_ratio_fallback(), 2)
