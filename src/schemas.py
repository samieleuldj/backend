from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum

class DeliveryType(str, Enum):
    home = "home"
    office = "office"

class OrderBase(BaseModel):
    order_id: str
    customer_name: str
    phone: str
    wilaya: str
    commune: str
    product_name: str
    quantity: int = Field(ge=1, le=4)
    unit_price: float = Field(gt=0)
    total_price: float
    delivery_type: DeliveryType
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
