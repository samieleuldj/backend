import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)

WILAYA_CODE_RE = re.compile(r"^(\d{1,2})")


def extract_wilaya_code(wilaya: str) -> int:
    match = WILAYA_CODE_RE.match((wilaya or "").strip())
    if not match:
        return 0
    return int(match.group(1))


def normalize_phone_for_dhd(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    if digits.startswith("213") and len(digits) >= 12:
        digits = "0" + digits[3:]
    if len(digits) == 9 and digits[0] in "567":
        digits = "0" + digits
    return digits


def get_dhd_config() -> tuple[str, str]:
    token = (os.getenv("DHD_API_TOKEN") or "").strip()
    base_url = (os.getenv("DHD_API_URL") or "https://dhd.ecotrack.dz").rstrip("/")
    return token, base_url


def extract_tracking(response: dict[str, Any]) -> str | None:
    for key in ("tracking", "num_tracking", "tracking_number", "code"):
        value = response.get(key)
        if value:
            return str(value)

    data = response.get("data")
    if isinstance(data, dict):
        for key in ("tracking", "num_tracking", "tracking_number", "code"):
            value = data.get(key)
            if value:
                return str(value)

    return None


def create_dhd_parcel(order: dict[str, Any]) -> dict[str, Any]:
    token, base_url = get_dhd_config()
    if not token:
        raise ValueError("DHD_API_TOKEN غير مضبوط في EasyPanel")

    wilaya_code = extract_wilaya_code(str(order.get("wilaya", "")))
    if wilaya_code < 1 or wilaya_code > 58:
        raise ValueError("كود الولاية غير صالح")

    delivery_type = str(order.get("delivery_type") or "home")
    stop_desk = 1 if delivery_type in {"office", "مكتب"} else 0

    phone = normalize_phone_for_dhd(str(order.get("phone", "")))
    if not phone:
        raise ValueError("رقم الهاتف مطلوب")

    payload = {
        "reference": str(order.get("order_id") or ""),
        "nom_client": str(order.get("customer_name") or ""),
        "telephone": phone,
        "adresse": f"{order.get('commune', '')}, {order.get('wilaya', '')}".strip(", "),
        "commune": str(order.get("commune") or ""),
        "code_wilaya": wilaya_code,
        "montant": int(float(order.get("total_price") or 0)),
        "produit": str(order.get("product_name") or ""),
        "type": 1,
        "stop_desk": stop_desk,
        "remarque": str(order.get("notes") or ""),
    }

    url = f"{base_url}/api/v1/create/order"
    with httpx.Client(timeout=30.0) as client:
        response = client.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )

    try:
        data = response.json()
    except Exception as exc:
        raise ValueError(f"رد DHD غير صالح: {response.text[:200]}") from exc

    if response.status_code >= 400 or data.get("success") is False:
        message = data.get("message") or response.text[:200]
        raise ValueError(f"فشل إرسال DHD: {message}")

    tracking = extract_tracking(data)
    if not tracking:
        logger.warning("DHD parcel created without tracking for %s: %s", order.get("order_id"), data)

    return {"tracking": tracking, "response": data}
