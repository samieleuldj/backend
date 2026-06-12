import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx

from .phone_utils import normalize_algerian_phone

logger = logging.getLogger(__name__)

ALGIERS_TZ = timezone(timedelta(hours=1))


def get_webhook_url() -> Optional[str]:
    url = os.getenv("GOOGLE_SHEET_WEBHOOK_URL") or os.getenv("GOOGLE_SHEETS_WEBHOOK_URL")
    if not url or url.strip() in {"", "your_google_script_url_here"}:
        return None
    return url.strip()


def _delivery_label(delivery_type: str) -> str:
    if delivery_type in {"home", "منزل"}:
        return "منزل"
    if delivery_type in {"office", "مكتب"}:
        return "مكتب"
    return delivery_type or ""


def build_sheet_payload(order: dict) -> dict:
    quantity = int(order.get("quantity") or 1)
    unit_price = float(order.get("unit_price") or 0)
    product_price = float(order.get("product_price") or (unit_price * quantity))
    total_price = float(order["total_price"])

    shipping_cost = order.get("shipping_cost")
    if shipping_cost is None:
        shipping_cost = max(0.0, total_price - product_price)
    else:
        shipping_cost = float(shipping_cost)

    delivery_type = order.get("delivery_type") or "home"

    return {
        "order_id": order["order_id"],
        "date": datetime.now(ALGIERS_TZ).strftime("%d/%m/%Y %H:%M:%S"),
        "customer_name": order["customer_name"],
        "phone": normalize_algerian_phone(order["phone"]),
        "wilaya": order["wilaya"],
        "commune": order["commune"],
        "product_name": order["product_name"],
        "quantity": quantity,
        "unit_price": unit_price,
        "product_price": product_price,
        "shipping_cost": shipping_cost,
        "total_price": total_price,
        "delivery_type": _delivery_label(str(delivery_type)),
        "status": "En attente",
        "tracking_number": "",
        "notes": order.get("notes") or "",
    }


def send_order_to_google_sheets(order: dict) -> None:
    url = get_webhook_url()
    if not url:
        return

    payload = build_sheet_payload(order)

    try:
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            response = client.post(url, json=payload)
            if response.status_code >= 400:
                logger.error(
                    "Google Sheets webhook failed: status=%s body=%s",
                    response.status_code,
                    response.text[:500],
                )
    except Exception:
        logger.exception("Google Sheets webhook error for order %s", order.get("order_id"))
