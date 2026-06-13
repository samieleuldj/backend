import logging
import os
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from . import models
from .dhd import get_dhd_order_status, map_dhd_status
from .meta_ads_service import sync_meta_ad_spend
from .order_status import is_delivered, is_returned

logger = logging.getLogger(__name__)


def sync_order_from_sheet(
    db: Session,
    order_id: str,
    status: str | None = None,
    tracking_number: str | None = None,
) -> models.Order | None:
    order = (
        db.query(models.Order)
        .filter(models.Order.order_id == order_id.strip())
        .first()
    )
    if not order:
        return None

    if status and status.strip():
        order.status = status.strip()
    if tracking_number is not None:
        tracking = tracking_number.strip()
        if tracking:
            order.tracking_number = tracking

    order.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(order)
    return order


def sync_dhd_order_statuses(db: Session, limit: int = 200) -> dict:
    token = (os.getenv("DHD_API_TOKEN") or "").strip()
    if not token:
        return {"ok": False, "reason": "dhd_not_configured", "updated": 0}

    terminal_statuses = {"تم التسليم", "Delivered", "مرتجع", "Returned", "ملغى", "Cancelled"}
    orders = (
        db.query(models.Order)
        .filter(
            models.Order.tracking_number.isnot(None),
            models.Order.tracking_number != "",
        )
        .order_by(models.Order.updated_at.desc())
        .limit(limit)
        .all()
    )

    updated = 0
    checked = 0
    errors: list[str] = []

    for order in orders:
        if (order.status or "") in terminal_statuses:
            continue
        if is_delivered(order.status) or is_returned(order.status):
            continue

        tracking = (order.tracking_number or "").strip()
        if not tracking:
            continue

        checked += 1
        try:
            raw = get_dhd_order_status(tracking)
            new_status = map_dhd_status(raw)
            if new_status and new_status != order.status:
                order.status = new_status
                order.updated_at = datetime.now(timezone.utc)
                updated += 1
        except Exception as exc:
            errors.append(f"{order.order_id}: {exc}")
            logger.warning("DHD sync failed for %s: %s", order.order_id, exc)

    if updated:
        db.commit()

    return {
        "ok": True,
        "checked": checked,
        "updated": updated,
        "errors": errors[:5],
    }


def run_auto_sync(db: Session) -> dict:
    days_back = int(os.getenv("META_SYNC_DAYS", "7"))
    meta = sync_meta_ad_spend(db, days_back=days_back)
    dhd = sync_dhd_order_statuses(db)
    return {
        "meta": meta,
        "dhd": dhd,
        "ran_at": datetime.now(timezone.utc).isoformat(),
    }
