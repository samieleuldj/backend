from sqlalchemy import Column, Integer, String, Float, DateTime, Text
from sqlalchemy.sql import func
from .database import Base

class Order(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True, index=True)
    order_id = Column(String(64), unique=True, index=True)
    customer_name = Column(String(255), index=True)
    phone = Column(String(20), index=True)
    wilaya = Column(String(100), index=True)
    commune = Column(String(150))
    delivery_type = Column(String(50), default="home")
    product_name = Column(String(255))
    quantity = Column(Integer, default=1)
    total_price = Column(Float)
    status = Column(String(50), default="Pending") # Pending, Confirmed, Shipped, Delivered, Returned
    notes = Column(Text, nullable=True)
    
    # أنظمة الحماية
    risk_score = Column(Integer, default=0)
    ip_address = Column(String(45), nullable=True)
    
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
