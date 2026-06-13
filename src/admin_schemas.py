from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class AdminLoginRequest(BaseModel):
    username: str
    password: str


class AdminLoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in_hours: int


class OrderStatusUpdate(BaseModel):
    status: str = Field(min_length=2, max_length=50)


class AdminOrderSummary(BaseModel):
    id: int
    order_id: str
    customer_name: str
    phone: str
    wilaya: str
    commune: str
    product_name: str
    quantity: int
    total_price: float
    status: str
    risk_score: int
    is_valid_traffic: Optional[bool] = True
    created_at: datetime

    class Config:
        from_attributes = True


class AdminOrderDetail(AdminOrderSummary):
    delivery_type: str
    unit_price: Optional[float] = None
    notes: Optional[str] = None
    ip_address: Optional[str] = None
    country_code: Optional[str] = None
    city: Optional[str] = None
    isp: Optional[str] = None
    is_proxy: bool = False
    is_hosting: bool = False
    utm_source: Optional[str] = None
    utm_medium: Optional[str] = None
    utm_campaign: Optional[str] = None
    referrer: Optional[str] = None
    session_id: Optional[str] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True
