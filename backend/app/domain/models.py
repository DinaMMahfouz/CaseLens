"""Internal domain models.

Raw* models hold source data in memory only. They are never persisted, logged,
serialized to the API or sent to an LLM. Everything downstream of redaction uses the
redacted models.
"""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class Direction(str, Enum):
    INBOUND = "inbound"
    OUTBOUND = "outbound"


ItemType = Literal["email", "call", "summary", "handover", "note"]
AuthorRole = Literal["customer", "support", "system"]


# ---------------------------------------------------------------- raw (memory only)
class RawCommunication(BaseModel):
    model_config = ConfigDict(frozen=False)
    kind: Literal["email", "call"]
    direction: Optional[Direction]
    occurred_at: Optional[datetime]
    from_address: str = ""
    to_address: str = ""
    cc_address: str = ""
    subject: str = ""
    body: str = ""
    is_auto_ack: bool = False
    author_name: str = ""
    direction_inferred: bool = False


class RawActivity(BaseModel):
    kind: Literal["summary", "handover", "note"]
    internal: bool
    occurred_at: Optional[datetime]
    subject: str = ""
    body: str = ""
    author_name: str = ""


class RawStatusChange(BaseModel):
    from_status: str = ""
    to_status: str = ""
    at: Optional[datetime] = None


class RawCase(BaseModel):
    case_number: str
    subject: str = ""
    description: str = ""
    severity: Optional[int] = None
    status: str = ""
    is_closed: bool = False
    opened_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    owner: str = ""
    account_name: str = ""
    account_number: str = ""
    contact_name: str = ""
    contact_email: str = ""
    contact_phone: str = ""
    product: str = ""
    resolution: str = ""
    communications: list[RawCommunication] = Field(default_factory=list)
    activities: list[RawActivity] = Field(default_factory=list)
    status_changes: list[RawStatusChange] = Field(default_factory=list)


# ---------------------------------------------------------------- redacted
class TimelineItem(BaseModel):
    ref_id: str
    item_type: ItemType
    direction: Optional[Direction] = None
    internal: bool = False
    author_role: AuthorRole
    occurred_at: Optional[datetime] = None
    subject: str = ""
    body: str = ""
    is_auto_ack: bool = False

    @property
    def customer_facing(self) -> bool:
        return self.item_type in ("email", "call") and not self.internal


class RedactedCase(BaseModel):
    case_number: str
    subject: str = ""
    description: str = ""
    severity: Optional[int] = None
    status: str = ""
    is_closed: bool = False
    opened_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    owner_label: str = ""
    account_label: str = ""
    product: str = ""
    resolution: str = ""
    items: list[TimelineItem] = Field(default_factory=list)
    status_changes: list[RawStatusChange] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)

    def item(self, ref_id: str) -> Optional[TimelineItem]:
        return next((i for i in self.items if i.ref_id == ref_id), None)

    def ref_timestamps(self) -> dict[str, Optional[datetime]]:
        refs: dict[str, Optional[datetime]] = {i.ref_id: i.occurred_at for i in self.items}
        if self.description:
            refs["DESC"] = self.opened_at
        if self.resolution:
            refs["RES"] = self.closed_at
        return refs
