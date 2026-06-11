from pydantic import BaseModel
from typing import Optional
from datetime import datetime

class OrderBase(BaseModel):
    order_id: str
    customer_name: str
    phone: str
    wilaya: str
    commune: str
    product_name: str
    quantity: int
    total_price: float
    notes: Optional[str] = None

class OrderCreate(OrderBase):
    pass

class OrderResponse(OrderBase):
    id: int
    status: str
    risk_score: int
    created_at: datetime

    class Config:
        from_attributes = True
