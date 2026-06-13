import json
import logging
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx

logger = logging.getLogger(__name__)

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "commune_dhd_map.json"
DEFAULT_DHD_API_URL = "https://platform.dhd-dz.com"
LEGACY_DHD_API_URL = "https://dhd.ecotrack.dz"

COMMUNE_ALIASES = {
    "16|الجزائر الوسطى": "Alger Centre",
    "16|الجزائر الوسطي": "Alger Centre",
    "16|الدار البيضاء": "Dar El Beida",
    "16|باب الزوار": "Bab Ezzouar",
    "16|الحراش": "El Harrach",
    "16|بئر خادم": "Birkhadem",
    "16|برج الكيفان": "Bordj El Kiffan",
    "16|حسين داي": "Hussein Dey",
    "16|الروiba": "Rouiba",
    "16|الرويبة": "Rouiba",
    "16|القبة": "El Kouba",
    "16|الكاليتوس": "Kouba",
    "16|السحاولة": "Sehaoula",
    "5|باتنة": "Batna",
    "5|القصبات": "Gosbat",
    "5|الشمرة": "Chemora",
    "5|شمرة": "Chemora",
    "12|تبسة": "Tebessa",
    "4|فكرينة": "Fkirina",
    "6|افناين الماثن": "Fenaia Il Maten",
    "21|مجاز الدشيش": "Emjez Edchich",
}


def _get_dhd_config() -> tuple[str, str]:
    token = (os.getenv("DHD_API_TOKEN") or "").strip()
    base_url = (os.getenv("DHD_API_URL") or DEFAULT_DHD_API_URL).rstrip("/")
    if base_url.rstrip("/") == LEGACY_DHD_API_URL:
        base_url = DEFAULT_DHD_API_URL
    return token, base_url


@lru_cache(maxsize=1)
def _load_commune_map() -> dict[str, str]:
    if not DATA_PATH.exists():
        logger.warning("commune_dhd_map.json missing at %s", DATA_PATH)
        return {}
    with DATA_PATH.open(encoding="utf-8") as handle:
        data = json.load(handle)
    return {str(k): str(v) for k, v in data.items()}


def normalize_commune_key(text: str) -> str:
    value = (text or "").strip().lower()
    value = re.sub(r"[\u0640\u200c\u200d\u200e\u200f\ufeff]", "", value)
    value = (
        value.replace("أ", "ا")
        .replace("إ", "ا")
        .replace("آ", "ا")
        .replace("ة", "ه")
        .replace("ى", "ي")
        .replace("ڨ", "ق")
    )
    value = re.sub(r"^ال(?=[\u0600-\u06ff])", "", value)
    value = re.sub(r"[^\w\u0600-\u06ff ]", "", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def _parse_communes_response(data: dict | list) -> list[str]:
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        if isinstance(data.get("communes"), list):
            items = data["communes"]
        elif isinstance(data.get("data"), list):
            items = data["data"]
        else:
            items = []
    else:
        items = []

    names: list[str] = []
    for item in items:
        if isinstance(item, str):
            names.append(item)
        elif isinstance(item, dict):
            name = (
                item.get("commune_name")
                or item.get("nom")
                or item.get("name")
                or item.get("commune")
                or ""
            )
            if name:
                names.append(str(name))
    return names


def _dhd_get_json(path: str, params: dict | None = None) -> dict[str, Any] | list[Any] | None:
    token, base_url = _get_dhd_config()
    if not token:
        return None

    headers = {"Authorization": f"Bearer {token}"}
    url = f"{base_url}{path}"

    with httpx.Client(timeout=15.0) as client:
        response = None
        for _ in range(5):
            response = client.get(url, headers=headers, params=params, follow_redirects=False)
            if response.status_code not in {301, 302, 303, 307, 308}:
                break
            location = response.headers.get("location") or response.headers.get("Location")
            if not location:
                break
            url = urljoin(url, location).rstrip("/")

        if response is None or response.status_code >= 400:
            return None

        try:
            return response.json()
        except Exception:
            return None


@lru_cache(maxsize=64)
def fetch_dhd_communes(wilaya_code: int) -> tuple[str, ...]:
    paths = [
        ("/api/v1/get/communes", {"wilaya_id": wilaya_code}),
        (f"/api/v1/get/communes/{wilaya_code}", None),
    ]
    for path, params in paths:
        data = _dhd_get_json(path, params)
        if data is None:
            continue
        names = _parse_communes_response(data)
        if names:
            return tuple(names)
    return tuple()


def resolve_commune_for_dhd(commune_input: str, wilaya_code: int) -> str:
    raw = (commune_input or "").strip()
    if not raw:
        raise ValueError("البلدية مطلوبة")

    alias_key = f"{wilaya_code}|{raw}"
    normalized = normalize_commune_key(raw)
    wilaya_prefix = f"{wilaya_code}|"

    if COMMUNE_ALIASES.get(alias_key):
        return COMMUNE_ALIASES[alias_key]

    commune_map = _load_commune_map()
    if commune_map.get(alias_key):
        return commune_map[alias_key]

    for key, french in COMMUNE_ALIASES.items():
        if not key.startswith(wilaya_prefix):
            continue
        arabic = key.split("|", 1)[1]
        if normalize_commune_key(arabic) == normalized:
            return french

    for key, french in commune_map.items():
        if not key.startswith(wilaya_prefix):
            continue
        arabic = key.split("|", 1)[1]
        if normalize_commune_key(arabic) == normalized:
            return french

    communes = fetch_dhd_communes(wilaya_code)
    for name in communes:
        if normalize_commune_key(name) == normalized:
            return name

    for name in communes:
        nk = normalize_commune_key(name)
        if normalized in nk or nk in normalized:
            return name

    if re.search(r"[A-Za-z]", raw):
        return raw

    raise ValueError(
        f"Commune mal écrite: {raw} (wilaya {wilaya_code}) — غيّر الاسم أو أضف mapping"
    )
