from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from typing import List
import os

from . import models, schemas, database

# إنشاء الجداول في قاعدة البيانات
models.Base.metadata.create_all(bind=database.engine)

app = FastAPI(title="Confort DZ API")

# إعداد CORS للسماح للفرونت إند بالاتصال
origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,https://confortdz.shop").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Dependency لجلب جلسة قاعدة البيانات
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
def create_order(order: schemas.OrderCreate, request: Request, db: Session = Depends(get_db)):
    customer_name = order.customer_name.strip()
    wilaya = order.wilaya.strip()
    commune = order.commune.strip()

    # 1. التحقق من البيانات الأساسية
    if len(customer_name) < 3:
        raise HTTPException(status_code=400, detail="الاسم واللقب مطلوب")
    if not wilaya:
        raise HTTPException(status_code=400, detail="الولاية مطلوبة")
    if len(commune) < 2:
        raise HTTPException(status_code=400, detail="البلدية مطلوبة")

    # 2. التحقق من رقم الهاتف لمنع الطلبات الوهمية
    clean_phone = order.phone.replace(" ", "")
    if not clean_phone.startswith(("05", "06", "07")) or len(clean_phone) != 10:
        raise HTTPException(status_code=400, detail="رقم الهاتف غير صالح")

    # 3. حساب نقاط الخطر (Risk Score)
    risk_score = 0
    # إذا كان الرقم مكرر (مثال: 0555555555)
    if len(set(clean_phone)) <= 3:
        risk_score += 50
    # إذا كان الاسم قصير جداً
    if len(customer_name) < 5:
        risk_score += 20

    # 4. إنشاء الطلب في قاعدة البيانات
    db_order = models.Order(
        order_id=order.order_id,
        customer_name=customer_name,
        phone=clean_phone,
        wilaya=wilaya,
        commune=commune,
        product_name=order.product_name,
        quantity=order.quantity,
        total_price=order.total_price,
        notes=order.notes,
        risk_score=risk_score,
        ip_address=request.client.host if request.client else None
    )
    
    db.add(db_order)
    db.commit()
    db.refresh(db_order)
    
    return db_order
