"""Result models for deterministic rules."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class SloResult(BaseModel):
    status: Literal["MET", "BREACHED", "INSUFFICIENT_DATA"]
    severity: Optional[int] = None
    clock: Optional[str] = None
    target_minutes: Optional[float] = None
    actual_minutes: Optional[float] = None
    opened_at: Optional[datetime] = None
    response_ref: Optional[str] = None
    response_at: Optional[datetime] = None
    deadline_at: Optional[datetime] = None
    reason: str = ""
    missing_data: bool = False        # INSUFFICIENT_DATA caused by missing source fields


class IdleWindow(BaseModel):
    start: datetime
    end: datetime
    duration_hours: float
    side: Literal["SUPPORT_SIDE", "CUSTOMER_SIDE"]
    start_ref: str
    end_ref: str              # "NOW" for open cases
    reason: str


class IdleResult(BaseModel):
    status: Literal["NO_SUPPORT_IDLE", "SUPPORT_IDLE", "INSUFFICIENT_DATA"]
    threshold_days: float
    windows: list[IdleWindow] = Field(default_factory=list)
    support_idle_hours: float = 0.0
    customer_idle_hours: float = 0.0
    reason: str = ""
    missing_data: bool = False


class Attempt(BaseModel):
    ref_id: str
    at: datetime
    kind: Literal["email", "call"]


class ClosureClassification(BaseModel):
    status: Literal["OK", "INSUFFICIENT_EVIDENCE", "FAILED"]
    reason: Optional[Literal["CUSTOMER_NON_RESPONSE", "CUSTOMER_CONFIRMED", "OTHER"]] = None
    evidence_refs: list[str] = Field(default_factory=list)
    explanation: str = ""


class ThreeStrikeResult(BaseModel):
    status: Literal["APPLIED_CORRECTLY", "APPLIED_INCORRECTLY", "NOT_APPLICABLE", "INSUFFICIENT_DATA"]
    required: int
    attempts: list[Attempt] = Field(default_factory=list)
    closure_reason: Optional[str] = None
    last_customer_ref: Optional[str] = None
    last_customer_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    reason: str = ""
    missing_data: bool = False
