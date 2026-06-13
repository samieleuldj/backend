import os
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from . import models
from .order_status import (
    is_active_order,
    is_cancelled,
    is_confirmed,
    is_delivered,
    is_pending,
)


def get_cogs_ratio() -> float:
    try:
        return float(os.getenv("DEFAULT_COGS_RATIO", "0.55"))
    except ValueError:
        return 0.55


def _order_revenue(order: models.Order) -> float:
    return float(order.total_price or 0)


def _summarize_orders(orders: list[models.Order]) -> dict:
    active = [o for o in orders if is_active_order(o.status)]
    pending = [o for o in active if is_pending(o.status)]
    confirmed = [o for o in active if is_confirmed(o.status)]
    delivered = [o for o in active if is_delivered(o.status)]

    total_revenue = sum(_order_revenue(o) for o in active)
    confirmed_revenue = sum(_order_revenue(o) for o in confirmed)
    delivered_revenue = sum(_order_revenue(o) for o in delivered)

    confirmation_base = len(active) - len([o for o in active if is_cancelled(o.status)])
    confirmation_rate = round((len(confirmed) / confirmation_base) * 100, 2) if confirmation_base else 0
    delivery_rate = round((len(delivered) / len(confirmed)) * 100, 2) if confirmed else 0

    return {
        "orders_total": len(active),
        "orders_pending": len(pending),
        "orders_confirmed": len(confirmed),
        "orders_delivered": len(delivered),
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
    orders: list[models.Order],
    ad_rows: list[models.DailyAdSpend],
) -> dict:
    cogs_ratio = get_cogs_ratio()
    order_stats = _summarize_orders(orders)
    delivered_revenue = order_stats["revenue_delivered"]
    product_cost = round(delivered_revenue * cogs_ratio, 2)
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
    }


def enrich_metrics(
    db: Session,
    metrics: dict,
    start: datetime,
    end: datetime,
    orders: list[models.Order],
) -> dict:
    ad_rows = _get_ad_spend_rows(db, start, end)
    accounting = _accounting_summary(orders, ad_rows)
    cogs_ratio = accounting["cogs_ratio"]

    daily_ad: dict[str, float] = {}
    for row in ad_rows:
        key = row.spend_date.isoformat()
        daily_ad[key] = daily_ad.get(key, 0) + float(row.amount_dzd or 0)

    daily_orders: dict[str, list] = {}
    for order in orders:
        if not is_active_order(order.status):
            continue
        key = order.created_at.date().isoformat()
        daily_orders.setdefault(key, []).append(order)

    daily_pnl = []
    all_days = sorted(set(list(daily_ad.keys()) + list(daily_orders.keys())))
    for day in all_days:
        day_orders = daily_orders.get(day, [])
        delivered_rev = sum(_order_revenue(o) for o in day_orders if is_delivered(o.status))
        total_rev = sum(_order_revenue(o) for o in day_orders)
        spend = round(daily_ad.get(day, 0), 2)
        cost = round(delivered_rev * cogs_ratio, 2)
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
            }
        )

    by_channel: dict[str, dict] = {}
    for order in orders:
        if not is_active_order(order.status):
            continue
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
                }
                for row in ad_rows
            ],
            "ad_spend_by_platform": [
                {"platform": platform, "amount_dzd": round(amount, 2)}
                for platform, amount in sorted(by_platform.items(), key=lambda x: x[1], reverse=True)
            ],
        }
    )

    for day_row in metrics.get("daily", []):
        pnl = next((item for item in daily_pnl if item["date"] == day_row["date"]), None)
        if pnl:
            day_row["ad_spend"] = pnl["ad_spend"]
            day_row["net_profit"] = pnl["net_profit"]
            day_row["revenue_delivered"] = pnl["revenue_delivered"]

    return metrics
