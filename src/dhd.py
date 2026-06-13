import logging
import os
import re
from typing import Any
from urllib.parse import urljoin

import httpx

logger = logging.getLogger(__name__)

WILAYA_CODE_RE = re.compile(r"^(\d{1,2})")
DEFAULT_DHD_API_URL = "https://platform.dhd-dz.com"
LEGACY_DHD_API_URL = "https://dhd.ecotrack.dz"


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
    base_url = (os.getenv("DHD_API_URL") or DEFAULT_DHD_API_URL).rstrip("/")
    if base_url.rstrip("/") == LEGACY_DHD_API_URL:
        base_url = DEFAULT_DHD_API_URL
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


def _resolve_redirect_url(current_url: str, response: httpx.Response) -> str | None:
    location = response.headers.get("location") or response.headers.get("Location")
    if not location:
        return None
    return urljoin(current_url, location)


def _parse_json_response(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except Exception as exc:
        raise ValueError(f"رد DHD غير صالح: {response.text[:200]}") from exc
    if not isinstance(data, dict):
        return {"data": data}
    return data


def _dhd_request(
    method: str,
    path: str,
    *,
    json_payload: dict | None = None,
    params: dict | None = None,
) -> tuple[httpx.Response, dict[str, Any]]:
    token, base_url = get_dhd_config()
    if not token:
        raise ValueError("DHD_API_TOKEN غير مضبوط في EasyPanel")

    headers = {"Authorization": f"Bearer {token}"}
    if json_payload is not None:
        headers["Content-Type"] = "application/json"

    url = f"{base_url}{path}"
    with httpx.Client(timeout=30.0) as client:
        response = None
        for _ in range(5):
            if method == "POST":
                response = client.post(
                    url,
                    json=json_payload,
                    headers=headers,
                    params=params,
                    follow_redirects=False,
                )
            else:
                response = client.get(
                    url,
                    headers=headers,
                    params=params,
                    follow_redirects=False,
                )

            if response.status_code not in {301, 302, 303, 307, 308}:
                break

            next_url = _resolve_redirect_url(url, response)
            if not next_url or next_url == url:
                break
            logger.info("DHD redirect %s -> %s", url, next_url)
            url = next_url.rstrip("/")

        if response is None:
            raise ValueError("لا يوجد رد من DHD")

    data = _parse_json_response(response)
    return response, data


def create_dhd_parcel(order: dict[str, Any]) -> dict[str, Any]:
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

    response, data = _dhd_request("POST", "/api/v1/create/order", json_payload=payload)

    if response.status_code >= 400 or data.get("success") is False:
        message = data.get("message") or response.text[:200]
        raise ValueError(f"فشل إرسال DHD: {message}")

    tracking = extract_tracking(data)
    if not tracking:
        logger.warning("DHD parcel created without tracking for %s: %s", order.get("order_id"), data)

    return {"tracking": tracking, "response": data}


def get_dhd_order_status(tracking: str) -> dict[str, Any]:
    tracking = (tracking or "").strip()
    if not tracking:
        raise ValueError("رقم التتبع مطلوب")

    attempts = [
        ("/api/v1/get/order", {"tracking": tracking}),
        ("/api/v1/get/order", {"tracking_number": tracking}),
        (f"/api/v1/get/order/{tracking}", None),
        (f"/api/v1/order/{tracking}", None),
        ("/api/v1/get/orders", {"tracking": tracking}),
    ]

    last_error = "لا يوجد رد من DHD"
    for path, params in attempts:
        try:
            response, data = _dhd_request("GET", path, params=params)
            if response.status_code >= 400 or data.get("success") is False:
                last_error = str(data.get("message") or response.text[:200])
                continue
            payload = data.get("data") if isinstance(data.get("data"), dict) else data
            if payload:
                return payload
        except ValueError as exc:
            last_error = str(exc)

    raise ValueError(last_error)


def map_dhd_status(raw: dict[str, Any]) -> str | None:
    for key in ("status", "statut", "etat", "state", "situation", "last_status"):
        value = raw.get(key)
        if value is None and isinstance(raw.get("data"), dict):
            value = raw["data"].get(key)
        if value is None:
            continue

        text = str(value).strip().lower()
        if not text:
            continue

        if any(word in text for word in ("livré", "livre", "delivered", "تسليم")):
            return "تم التسليم"
        if any(word in text for word in ("retour", "return", "مرتج")):
            return "مرتجع"
        if any(word in text for word in ("annul", "cancel", "ملغ")):
            return "ملغى"
        if any(word in text for word in ("livraison", "transit", "expédi", "expedi", "shipp", "شحن")):
            return "تم الشحن"
        if any(word in text for word in ("confirm", "مؤك")):
            return "مؤكd"

    return None
