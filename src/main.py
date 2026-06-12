from fastapi import FastAPI, Depends, HTTPException, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import os

from . import models, schemas, database
from .google_sheets import send_order_to_google_sheets
from .anti_fraud import validate_order_security
from .migrations import ensure_schema_updates
from .phone_utils import normalize_algerian_phone

models.Base.metadata.create_all(bind=database.engine)
ensure_schema_updates()

app = FastAPI(title="Confort DZ API")

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

@app.get("/")
def read_root():
    return {"status": "online", "message": "Confort DZ API is running"}

@app.post("/api/orders", response_model=schemas.OrderResponse)
def create_order(
    order: schemas.OrderCreate,
    request: Request,
    background_tasks: BackgroundTasks,
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

    delivery_label = "توصيل للمنزل" if delivery_type == "home" else "توصيل للمكتب"
    notes = order.notes or ""

    product_subtotal = order.unit_price * order.quantity
    shipping_cost = max(0.0, order.total_price - product_subtotal)

    db_order = models.Order(
        order_id=order.order_id,
        customer_name=customer_name,
        phone=clean_phone,
        wilaya=wilaya,
        commune=commune,
        delivery_type=delivery_type,
        product_name=order.product_name,
        quantity=order.quantity,
        total_price=order.total_price,
        notes=notes,
        risk_score=risk_score,
        ip_address=request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if request.headers.get("x-forwarded-for")
        else (request.client.host if request.client else None),
    )

    db.add(db_order)
    db.commit()
    db.refresh(db_order)

    background_tasks.add_task(
        send_order_to_google_sheets,
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
            "notes": notes,
        },
    )

    return db_order
