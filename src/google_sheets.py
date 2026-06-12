import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

ALGIERS_TZ = timezone(timedelta(hours=1))


def get_webhook_url() -> Optional[str]:
    url = os.getenv("GOOGLE_SHEET_WEBHOOK_URL") or os.getenv("GOOGLE_SHEETS_WEBHOOK_URL")
    if not url or url.strip() in {"", "your_google_script_url_here"}:
        return None
    return url.strip()


def build_sheet_payload(order: dict) -> dict:
    return {
        "order_id": order["order_id"],
        "date": datetime.now(ALGIERS_TZ).strftime("%d/%m/%Y %H:%M:%S"),
        "customer_name": order["customer_name"],
        "phone": order["phone"],
        "wilaya": order["wilaya"],
        "commune": order["commune"],
        "product_name": order["product_name"],
        "quantity": order["quantity"],
        "total_price": order["total_price"],
        "status": "Pending",
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
