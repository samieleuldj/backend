"""Normalize order statuses (Arabic sheet + English admin)."""

PENDING = {"pending", "في الانتظار", "en attente"}
CONFIRMED = {"confirmed", "مؤكd", "confirmé"}
SHIPPED = {"shipped", "تم الشحن", "expédié", "expedie"}
DELIVERED = {"delivered", "تم التسليم", "livré", "livre", "delivered"}
RETURNED = {"returned", "مرتجع", "retourné", "retourne"}
CANCELLED = {"cancelled", "canceled", "ملغى", "ملغي", "annulé", "annule"}


def _norm(status: str | None) -> str:
    return (status or "").strip().lower()


def is_pending(status: str | None) -> bool:
    s = _norm(status)
    return s in PENDING or (not s)


def is_confirmed(status: str | None) -> bool:
    s = _norm(status)
    if s in CONFIRMED:
        return True
    raw = (status or "").strip()
    return "مؤك" in raw or "confirm" in s


def is_shipped(status: str | None) -> bool:
    s = _norm(status)
    return s in SHIPPED or s in DELIVERED


def is_delivered(status: str | None) -> bool:
    s = _norm(status)
    if s in DELIVERED:
        return True
    raw = (status or "").strip()
    return "تسليم" in raw and "شحن" not in raw


def is_returned(status: str | None) -> bool:
    return _norm(status) in RETURNED


def is_cancelled(status: str | None) -> bool:
    return _norm(status) in CANCELLED


def is_active_order(status: str | None) -> bool:
    return not is_cancelled(status)


def counts_for_confirmation_rate(status: str | None) -> bool:
    """Confirmed by phone, shipped, or delivered — excludes pending/cancelled."""
    if is_cancelled(status):
        return False
    return is_confirmed(status) or is_shipped(status) or is_delivered(status)


ALL_STATUSES = [
    "Pending",
    "Confirmed",
    "Shipped",
    "Delivered",
    "Returned",
    "Cancelled",
    "في الانتظار",
    "مؤكd",
    "تم الشحن",
    "تم التسليم",
    "مرتجع",
    "ملغى",
]
