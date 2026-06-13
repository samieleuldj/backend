import logging
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from . import models, schemas, database
from .admin_routes import router as admin_router
from .analytics_service import attach_ip_metadata_to_order, record_analytics_event
from .anti_fraud import validate_order_security
from .google_sheets import get_webhook_url, send_order_to_google_sheets
from .dhd import create_dhd_parcel
from .migrations import ensure_schema_updates
from .phone_utils import normalize_algerian_phone
from .product_cost_service import ensure_default_products
from .sync_service import run_auto_sync, sync_order_from_sheet

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

models.Base.metadata.create_all(bind=database.engine)
ensure_schema_updates()

app = FastAPI(title="Confort DZ API")
app.include_router(admin_router)

ADMIN_DIR = Path(__file__).resolve().parent.parent / "admin"

origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,https://confortdz.shop").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    db = database.SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _verify_internal_secret(request: Request) -> None:
    secret = (os.getenv("SHEETS_SHIP_SECRET") or "").strip()
    if not secret or request.headers.get("X-Ship-Secret") != secret:
        raise HTTPException(status_code=403, detail="Forbidden")


def _auto_sync_loop() -> None:
    interval_minutes = max(15, int(os.getenv("SYNC_INTERVAL_MINUTES", "60")))
    while True:
        time.sleep(interval_minutes * 60)
        db = database.SessionLocal()
        try:
            result = run_auto_sync(db)
            logger.info("Auto sync finished: %s", result)
        except Exception:
            logger.exception("Auto sync failed")
        finally:
            db.close()


@app.on_event("startup")
def log_startup_config():
    webhook = get_webhook_url()
    if webhook:
        logger.warning("SHEETS webhook configured: %s...", webhook[:60])
    else:
        logger.warning("SHEETS webhook NOT configured — set GOOGLE_SHEET_WEBHOOK_URL")

    db = database.SessionLocal()
    try:
        ensure_default_products(db)
    finally:
        db.close()

    if os.getenv("AUTO_SYNC_ENABLED", "true").lower() in {"1", "true", "yes"}:
        threading.Thread(target=_auto_sync_loop, daemon=True).start()
        logger.info("Auto sync scheduler started")


@app.get("/")
def read_root():
    return {"status": "online", "message": "Confort DZ API is running"}


@app.get("/api/health")
def health_check():
    webhook = get_webhook_url()
    dhd_token = bool((os.getenv("DHD_API_TOKEN") or "").strip())
    admin_ready = bool(
        (os.getenv("ADMIN_USERNAME") or "").strip()
        and (os.getenv("ADMIN_PASSWORD") or "").strip()
    )
    meta_ready = bool(
        (os.getenv("META_AD_ACCOUNT_ID") or "").strip()
        and (
            (os.getenv("META_ADS_ACCESS_TOKEN") or "").strip()
            or (os.getenv("META_ACCESS_TOKEN") or "").strip()
        )
    )
    return {
        "status": "ok",
        "sheets_webhook_configured": bool(webhook),
        "dhd_configured": dhd_token,
        "admin_configured": admin_ready,
        "meta_ads_configured": meta_ready,
        "auto_sync_enabled": os.getenv("AUTO_SYNC_ENABLED", "true").lower()
        in {"1", "true", "yes"},
    }


@app.get("/admin/app.js")
def admin_dashboard_js():
    js_path = ADMIN_DIR / "app.js"
    if not js_path.exists():
        raise HTTPException(status_code=404, detail="Admin assets not found")
    return FileResponse(js_path, media_type="application/javascript")


@app.get("/admin/styles.css")
def admin_dashboard_css():
    css_path = ADMIN_DIR / "styles.css"
    if not css_path.exists():
        raise HTTPException(status_code=404, detail="Admin assets not found")
    return FileResponse(css_path, media_type="text/css")


@app.get("/admin")
@app.get("/admin/")
def admin_dashboard():
    index_path = ADMIN_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Admin dashboard not found")
    return FileResponse(index_path)


@app.post("/api/analytics/event")
def track_analytics_event(
    payload: schemas.AnalyticsEventCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    allowed = {"page_view", "product_view", "checkout_start"}
    if payload.event_type not in allowed:
        raise HTTPException(status_code=400, detail="Invalid event type")

    event = record_analytics_event(
        db=db,
        request=request,
        event_type=payload.event_type,
        session_id=payload.session_id,
        page_path=payload.page_path,
        product_id=payload.product_id,
        product_name=payload.product_name,
        referrer=payload.referrer,
        utm_source=payload.utm_source,
        utm_medium=payload.utm_medium,
        utm_campaign=payload.utm_campaign,
    )
    return {"ok": True, "valid": event.is_valid}


@app.post("/api/internal/ship-to-dhd")
def ship_to_dhd(
    payload: schemas.ShipToDhdRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    _verify_internal_secret(request)

    try:
        result = create_dhd_parcel(payload.model_dump())
        tracking = result.get("tracking")
        order = (
            db.query(models.Order)
            .filter(models.Order.order_id == payload.order_id)
            .first()
        )
        if order:
            if tracking:
                order.tracking_number = str(tracking)
            order.status = "تم الشحن"
            db.commit()
        return {"success": True, "tracking": tracking}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/internal/order-sync")
def sync_order_from_sheet_endpoint(
    payload: schemas.OrderSyncRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    _verify_internal_secret(request)

    order = sync_order_from_sheet(
        db,
        order_id=payload.order_id,
        status=payload.status,
        tracking_number=payload.tracking_number,
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return {"success": True, "order_id": order.order_id, "status": order.status}


@app.post("/api/internal/run-sync")
def run_sync_endpoint(request: Request, db: Session = Depends(get_db)):
    _verify_internal_secret(request)
    return run_auto_sync(db)


@app.post("/api/orders", response_model=schemas.OrderResponse)
def create_order(
    order: schemas.OrderCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    customer_name = order.customer_name.strip()
    wilaya = order.wilaya.strip()
    commune = order.commune.strip()
    delivery_type = order.delivery_type.value

    if len(customer_name) < 3:
        raise HTTPException(status_code=400, detail="الاسم واللقب مطلوب")
    if not wilaya:
        raise HTTPException(status_code=400, detail="الولاية مطلوبة")
    if len(commune) < 2:
        raise HTTPException(status_code=400, detail="البلدية مطلوبة")

    clean_phone = normalize_algerian_phone(order.phone)
    if not clean_phone.startswith(("05", "06", "07")) or len(clean_phone) != 10:
        raise HTTPException(status_code=400, detail="رقم الهاتف غير صالح")

    validate_order_security(
        request=request,
        db=db,
        phone=clean_phone,
        quantity=order.quantity,
        unit_price=order.unit_price,
        delivery_type=delivery_type,
    )

    risk_score = 0
    if len(set(clean_phone)) <= 3:
        risk_score += 50
    if len(customer_name) < 5:
        risk_score += 20

    notes = (order.notes or "").strip() or None

    product_subtotal = order.unit_price * order.quantity
    shipping_cost = max(0.0, order.total_price - product_subtotal)

    db_order = models.Order(
        order_id=order.order_id,
        customer_name=customer_name,
        phone=clean_phone,
        wilaya=wilaya,
        commune=commune,
        delivery_type=delivery_type,
        product_id=(order.product_id or "")[:120] or None,
        product_name=order.product_name,
        quantity=order.quantity,
        unit_price=order.unit_price,
        shipping_cost=shipping_cost if shipping_cost > 0 else None,
        total_price=order.total_price,
        notes=notes,
        risk_score=risk_score,
        utm_source=(order.utm_source or "")[:120] or None,
        utm_medium=(order.utm_medium or "")[:120] or None,
        utm_campaign=(order.utm_campaign or "")[:120] or None,
        referrer=(order.referrer or "")[:500] or None,
        session_id=(order.session_id or "")[:64] or None,
    )
    attach_ip_metadata_to_order(db_order, request)

    db.add(db_order)
    db.commit()
    db.refresh(db_order)

    # الشيت يتعبّى من Frontend (NEXT_PUBLIC_GOOGLE_SHEET_WEBHOOK_URL)
    # فعّل GOOGLE_SHEET_FROM_BACKEND=true فقط إذا بغيت الإرسال من الباك إند
    if os.getenv("GOOGLE_SHEET_FROM_BACKEND", "").lower() in {"1", "true", "yes"}:
        send_order_to_google_sheets(
            {
                "order_id": db_order.order_id,
                "customer_name": db_order.customer_name,
                "phone": db_order.phone,
                "wilaya": db_order.wilaya,
                "commune": db_order.commune,
                "product_name": db_order.product_name,
                "quantity": db_order.quantity,
                "unit_price": order.unit_price,
                "product_price": product_subtotal,
                "shipping_cost": shipping_cost,
                "total_price": db_order.total_price,
                "delivery_type": db_order.delivery_type,
                "notes": notes or "",
            },
        )

    return db_order
