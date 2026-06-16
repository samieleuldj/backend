import os
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from . import models
from .order_status import (
    counts_for_confirmation_rate,
    is_active_order,
    is_cancelled,
    is_confirmed,
    is_delivered,
    is_pending,
    is_returned,
    is_shipped,
)
from .product_cost_service import get_cogs_ratio_fallback, order_product_cost


def get_cogs_ratio() -> float:
    return get_cogs_ratio_fallback()


def _order_revenue(order: models.Order) -> float:
    return float(order.total_price or 0)


def _product_key(order: models.Order) -> str:
    return (order.product_id or order.product_name or "unknown").strip()


def _summarize_orders(orders: list[models.Order]) -> dict:
    all_orders = list(orders)
    active = [o for o in all_orders if is_active_order(o.status)]
    pending = [o for o in active if is_pending(o.status)]
    confirmed_phone = [o for o in active if is_confirmed(o.status)]
    confirmed_or_beyond = [o for o in active if counts_for_confirmation_rate(o.status)]
    shipped = [o for o in all_orders if is_shipped(o.status) and not is_delivered(o.status)]
    delivered = [o for o in all_orders if is_delivered(o.status)]
    cancelled = [o for o in all_orders if is_cancelled(o.status)]
    returned = [o for o in all_orders if is_returned(o.status)]

    total_revenue = sum(_order_revenue(o) for o in active)
    confirmed_revenue = sum(_order_revenue(o) for o in confirmed_or_beyond)
    delivered_revenue = sum(_order_revenue(o) for o in delivered)

    awaiting_contact = len(pending)
    confirmed_count = len(confirmed_or_beyond)
    confirmation_rate = (
        round((confirmed_count / (confirmed_count + awaiting_contact)) * 100, 2)
        if (confirmed_count + awaiting_contact)
        else 0
    )
    delivery_rate = round((len(delivered) / len(confirmed_or_beyond)) * 100, 2) if confirmed_or_beyond else 0

    return {
        "orders_total": len(all_orders),
        "orders_pending": len(pending),
        "orders_confirmed": len(confirmed_or_beyond),
        "orders_confirmed_phone": len(confirmed_phone),
        "orders_shipped": len(shipped),
        "orders_delivered": len(delivered),
        "orders_cancelled": len(cancelled),
        "orders_returned": len(returned),
        "revenue_total": round(total_revenue, 2),
        "revenue_confirmed": round(confirmed_revenue, 2),
        "revenue_delivered": round(delivered_revenue, 2),
        "confirmation_rate": confirmation_rate,
        "delivery_rate": delivery_rate,
    }


def _get_ad_spend_rows(db: Session, start: datetime, end: datetime) -> list[models.DailyAdSpend]:
    return (
        db.query(models.DailyAdSpend)
        .filter(
            models.DailyAdSpend.spend_date >= start.date(),
            models.DailyAdSpend.spend_date <= end.date(),
        )
        .order_by(models.DailyAdSpend.spend_date.desc())
        .all()
    )


def _accounting_summary(
    db: Session,
    orders: list[models.Order],
    ad_rows: list[models.DailyAdSpend],
) -> dict:
    cogs_ratio = get_cogs_ratio()
    order_stats = _summarize_orders(orders)
    delivered = [o for o in orders if is_delivered(o.status)]
    delivered_revenue = order_stats["revenue_delivered"]
    product_cost = round(sum(order_product_cost(db, order) for order in delivered), 2)
    gross_profit = round(delivered_revenue - product_cost, 2)
    ad_spend_total = round(sum(float(row.amount_dzd or 0) for row in ad_rows), 2)
    net_profit = round(gross_profit - ad_spend_total, 2)
    roas = round(delivered_revenue / ad_spend_total, 2) if ad_spend_total else 0

    return {
        **order_stats,
        "cogs_ratio": cogs_ratio,
        "product_cost": product_cost,
        "gross_profit": gross_profit,
        "ad_spend_total": ad_spend_total,
        "net_profit": net_profit,
        "roas": roas,
        "loss": round(abs(net_profit), 2) if net_profit < 0 else 0,
    }


def _build_product_performance(
    db: Session,
    orders: list[models.Order],
    events: list[models.AnalyticsEvent],
    ad_spend_total: float,
) -> list[dict]:
    buckets: dict[str, dict] = {}

    def get_bucket(order: models.Order) -> dict:
        key = _product_key(order)
        if key not in buckets:
            buckets[key] = {
                "product_id": order.product_id or "",
                "product_name": order.product_name or key,
                "product_views": 0,
                "orders": 0,
                "confirmed": 0,
                "delivered": 0,
                "cancelled": 0,
                "returned": 0,
                "revenue": 0.0,
                "delivered_revenue": 0.0,
                "product_cost": 0.0,
            }
        return buckets[key]

    for event in events:
        if event.event_type != "product_view":
            continue
        key = (event.product_id or event.product_name or "").strip()
        if not key:
            continue
        bucket = buckets.setdefault(
            key,
            {
                "product_id": event.product_id or "",
                "product_name": event.product_name or key,
                "product_views": 0,
                "orders": 0,
                "confirmed": 0,
                "delivered": 0,
                "cancelled": 0,
                "returned": 0,
                "revenue": 0.0,
                "delivered_revenue": 0.0,
                "product_cost": 0.0,
            },
        )
        bucket["product_views"] += 1

    for order in orders:
        bucket = get_bucket(order)
        bucket["orders"] += 1
        bucket["revenue"] += _order_revenue(order)
        if counts_for_confirmation_rate(order.status):
            bucket["confirmed"] += 1
        if is_delivered(order.status):
            bucket["delivered"] += 1
            bucket["delivered_revenue"] += _order_revenue(order)
            bucket["product_cost"] += order_product_cost(db, order)
        if is_cancelled(order.status):
            bucket["cancelled"] += 1
        if is_returned(order.status):
            bucket["returned"] += 1

    total_orders = sum(item["orders"] for item in buckets.values()) or 1
    rows = []
    for item in buckets.values():
        views = item["product_views"]
        orders_count = item["orders"]
        confirmed = item["confirmed"]
        delivered = item["delivered"]
        delivered_revenue = round(item["delivered_revenue"], 2)
        product_cost = round(item["product_cost"], 2)
        gross_profit = round(delivered_revenue - product_cost, 2)
        ad_share = round(ad_spend_total * (orders_count / total_orders), 2)
        net_profit = round(gross_profit - ad_share, 2)
        active_orders = max(orders_count - item["cancelled"], 0)
        conversion_rate = round((orders_count / views) * 100, 2) if views else 0
        confirmation_rate = round((confirmed / active_orders) * 100, 2) if active_orders else 0
        delivery_rate = round((delivered / confirmed) * 100, 2) if confirmed else 0
        rows.append(
            {
                **item,
                "revenue": round(item["revenue"], 2),
                "delivered_revenue": delivered_revenue,
                "product_cost": product_cost,
                "gross_profit": gross_profit,
                "ad_spend": ad_share,
                "net_profit": net_profit,
                "loss": round(abs(net_profit), 2) if net_profit < 0 else 0,
                "conversion_rate": conversion_rate,
                "confirmation_rate": confirmation_rate,
                "delivery_rate": delivery_rate,
                "roas": round(delivered_revenue / ad_share, 2) if ad_share else 0,
            }
        )

    return sorted(rows, key=lambda row: row["orders"], reverse=True)


def enrich_metrics(
    db: Session,
    metrics: dict,
    start: datetime,
    end: datetime,
    orders: list[models.Order],
    events: Optional[list[models.AnalyticsEvent]] = None,
    orders_for_status: Optional[list[models.Order]] = None,
) -> dict:
    ad_rows = _get_ad_spend_rows(db, start, end)
    status_orders = orders_for_status or orders
    accounting = _accounting_summary(db, status_orders, ad_rows)
    event_rows = events or []

    daily_ad: dict[str, float] = {}
    for row in ad_rows:
        key = row.spend_date.isoformat()
        daily_ad[key] = daily_ad.get(key, 0) + float(row.amount_dzd or 0)

    daily_orders: dict[str, list] = {}
    for order in orders:
        key = order.created_at.date().isoformat()
        daily_orders.setdefault(key, []).append(order)

    daily_pnl = []
    all_days = sorted(set(list(daily_ad.keys()) + list(daily_orders.keys())))
    for day in all_days:
        day_orders = daily_orders.get(day, [])
        delivered_rev = sum(_order_revenue(o) for o in day_orders if is_delivered(o.status))
        total_rev = sum(_order_revenue(o) for o in day_orders)
        spend = round(daily_ad.get(day, 0), 2)
        cost = round(
            sum(order_product_cost(db, o) for o in day_orders if is_delivered(o.status)),
            2,
        )
        gross = round(delivered_rev - cost, 2)
        net = round(gross - spend, 2)
        daily_pnl.append(
            {
                "date": day,
                "orders": len(day_orders),
                "revenue_total": round(total_rev, 2),
                "revenue_delivered": round(delivered_rev, 2),
                "ad_spend": spend,
                "product_cost": cost,
                "gross_profit": gross,
                "net_profit": net,
                "loss": round(abs(net), 2) if net < 0 else 0,
            }
        )

    by_channel: dict[str, dict] = {}
    for order in status_orders:
        channel = (order.utm_source or "direct").strip() or "direct"
        item = by_channel.setdefault(
            channel,
            {"channel": channel, "orders": 0, "revenue": 0, "delivered_revenue": 0},
        )
        item["orders"] += 1
        item["revenue"] += _order_revenue(order)
        if is_delivered(order.status):
            item["delivered_revenue"] += _order_revenue(order)

    by_platform: dict[str, float] = {}
    for row in ad_rows:
        platform = row.platform or "other"
        by_platform[platform] = by_platform.get(platform, 0) + float(row.amount_dzd or 0)

    product_performance = _build_product_performance(
        db,
        orders,
        event_rows,
        accounting["ad_spend_total"],
    )

    metrics.update(
        {
            "clicks": metrics.get("product_views", 0),
            "confirmed_orders": accounting["orders_confirmed"],
            "delivered_orders": accounting["orders_delivered"],
            "revenue_confirmed": accounting["revenue_confirmed"],
            "revenue_delivered": accounting["revenue_delivered"],
            "confirmation_rate": accounting["confirmation_rate"],
            "delivery_rate": accounting["delivery_rate"],
            "checkout_cvr": metrics.get("checkout_conversion_rate", 0),
            "accounting": accounting,
            "product_performance": product_performance,
            "daily_pnl": daily_pnl,
            "by_channel": sorted(
                [
                    {
                        **item,
                        "revenue": round(item["revenue"], 2),
                        "delivered_revenue": round(item["delivered_revenue"], 2),
                    }
                    for item in by_channel.values()
                ],
                key=lambda row: row["revenue"],
                reverse=True,
            ),
            "ad_spend_entries": [
                {
                    "id": row.id,
                    "spend_date": row.spend_date.isoformat(),
                    "platform": row.platform,
                    "amount_dzd": float(row.amount_dzd or 0),
                    "notes": row.notes,
                    "source": row.source or "manual",
                }
                for row in ad_rows
            ],
            "ad_spend_by_platform": [
                {"platform": platform, "amount_dzd": round(amount, 2)}
                for platform, amount in sorted(by_platform.items(), key=lambda x: x[1], reverse=True)
            ],
        }
    )

    metrics["by_product"] = product_performance

    for day_row in metrics.get("daily", []):
        pnl = next((item for item in daily_pnl if item["date"] == day_row["date"]), None)
        if pnl:
            day_row["ad_spend"] = pnl["ad_spend"]
            day_row["net_profit"] = pnl["net_profit"]
            day_row["revenue_delivered"] = pnl["revenue_delivered"]

    return metrics
