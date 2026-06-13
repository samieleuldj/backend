from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from . import models
from .admin_auth import authenticate_admin, verify_admin_token
from .admin_schemas import (
    AdminLoginRequest,
    AdminLoginResponse,
    AdminOrderDetail,
    AdminOrderSummary,
    OrderStatusUpdate,
)
from .analytics_service import default_date_range, get_metrics, valid_order_filter
from .database import SessionLocal

router = APIRouter(prefix="/api/admin", tags=["admin"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/login", response_model=AdminLoginResponse)
def admin_login(payload: AdminLoginRequest):
    token = authenticate_admin(payload.username.strip(), payload.password)
    if not token:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    from .admin_auth import TOKEN_HOURS

    return AdminLoginResponse(
        access_token=token,
        expires_in_hours=TOKEN_HOURS,
    )


@router.get("/metrics")
def admin_metrics(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    db: Session = Depends(get_db),
    _: str = Depends(verify_admin_token),
):
    return get_metrics(db, date_from, date_to)


@router.get("/orders", response_model=list[AdminOrderSummary])
def admin_orders(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _: str = Depends(verify_admin_token),
):
    start, end = default_date_range(date_from, date_to)
    query = (
        db.query(models.Order)
        .filter(
            models.Order.created_at >= start,
            models.Order.created_at <= end,
            valid_order_filter(),
        )
        .order_by(models.Order.created_at.desc())
    )

    if status:
        query = query.filter(models.Order.status == status)

    if search:
        term = f"%{search.strip()}%"
        query = query.filter(
            (models.Order.customer_name.like(term))
            | (models.Order.phone.like(term))
            | (models.Order.order_id.like(term))
            | (models.Order.product_name.like(term))
        )

    return query.offset(offset).limit(limit).all()


@router.get("/orders/{order_id}", response_model=AdminOrderDetail)
def admin_order_detail(
    order_id: str,
    db: Session = Depends(get_db),
    _: str = Depends(verify_admin_token),
):
    order = (
        db.query(models.Order)
        .filter(models.Order.order_id == order_id)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


@router.patch("/orders/{order_id}", response_model=AdminOrderDetail)
def admin_update_order_status(
    order_id: str,
    payload: OrderStatusUpdate,
    db: Session = Depends(get_db),
    _: str = Depends(verify_admin_token),
):
    order = (
        db.query(models.Order)
        .filter(models.Order.order_id == order_id)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    order.status = payload.status.strip()
    db.commit()
    db.refresh(order)
    return order


@router.get("/statuses")
def admin_statuses(
    _: str = Depends(verify_admin_token),
):
    return [
        "Pending",
        "Confirmed",
        "Shipped",
        "Delivered",
        "Returned",
        "Cancelled",
    ]
