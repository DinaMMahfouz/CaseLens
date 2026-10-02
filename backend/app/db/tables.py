"""Persistent tables. Only redacted text is ever stored. No pseudonym mapping table exists."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.types import TypeDecorator
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator):
    """Stores UTC; always returns timezone-aware UTC datetimes (SQLite drops tzinfo)."""
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is not None:
            value = value.astimezone(timezone.utc)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value


class Upload(Base):
    __tablename__ = "uploads"
    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    stored_name: Mapped[str] = mapped_column(String(64))       # random name; original filename not kept
    structure: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)   # sheets/columns/mapping coverage


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    started_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    finished_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    status: Mapped[str] = mapped_column(String(16), default="queued")   # queued|running|done|failed
    source: Mapped[str] = mapped_column(String(16))                       # fixtures|upload
    upload_id: Mapped[Optional[int]] = mapped_column(ForeignKey("uploads.id"))
    synthetic: Mapped[bool] = mapped_column(Boolean, default=False)
    total: Mapped[int] = mapped_column(Integer, default=0)
    processed: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    error_kind: Mapped[str] = mapped_column(String(64), default="")
    as_of: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    config_hash: Mapped[str] = mapped_column(String(32), default="")
    provider: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(64), default="")
    temperature: Mapped[Optional[float]] = mapped_column(Float)
    prompt_versions: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    ingest_report: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class Case(Base):
    __tablename__ = "cases"
    __table_args__ = (UniqueConstraint("run_id", "case_number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    case_number: Mapped[str] = mapped_column(String(64), index=True)
    subject: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    severity: Mapped[Optional[int]] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(64), default="")
    is_closed: Mapped[bool] = mapped_column(Boolean, default=False)
    opened_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    closed_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    owner_label: Mapped[str] = mapped_column(String(128), default="")
    account_label: Mapped[str] = mapped_column(String(128), default="")
    product: Mapped[str] = mapped_column(String(128), default="")
    resolution: Mapped[str] = mapped_column(Text, default="")
    missing_fields: Mapped[list[str]] = mapped_column(JSON, default=list)
    state: Mapped[str] = mapped_column(String(24), default="OK")
    items: Mapped[list["Item"]] = relationship(back_populates="case", cascade="all, delete-orphan",
                                               order_by="Item.position")
    status_changes: Mapped[list["StatusChange"]] = relationship(cascade="all, delete-orphan")
    audit: Mapped[Optional["Audit"]] = relationship(back_populates="case", uselist=False, cascade="all, delete-orphan")


class Item(Base):
    """A Communication (email/call) or Activity (summary/handover/note) - redacted."""
    __tablename__ = "items"
    id: Mapped[int] = mapped_column(primary_key=True)
    case_id: Mapped[int] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    ref_id: Mapped[str] = mapped_column(String(16))
    item_type: Mapped[str] = mapped_column(String(16))
    direction: Mapped[Optional[str]] = mapped_column(String(16))
    internal: Mapped[bool] = mapped_column(Boolean, default=False)
    author_role: Mapped[str] = mapped_column(String(16))
    occurred_at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())
    subject: Mapped[str] = mapped_column(Text, default="")
    body: Mapped[str] = mapped_column(Text, default="")
    is_auto_ack: Mapped[bool] = mapped_column(Boolean, default=False)
    case: Mapped[Case] = relationship(back_populates="items")


class StatusChange(Base):
    __tablename__ = "status_changes"
    id: Mapped[int] = mapped_column(primary_key=True)
    case_id: Mapped[int] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    from_status: Mapped[str] = mapped_column(String(64), default="")
    to_status: Mapped[str] = mapped_column(String(64), default="")
    at: Mapped[Optional[datetime]] = mapped_column(UTCDateTime())


class Audit(Base):
    """Machine result. Never modified by reviewer actions."""
    __tablename__ = "audits"
    id: Mapped[int] = mapped_column(primary_key=True)
    case_id: Mapped[int] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), unique=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    state: Mapped[str] = mapped_column(String(24))
    overall: Mapped[Optional[float]] = mapped_column(Float)
    dimensions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    slo: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    idle: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    three_strike: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    closure: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    llm: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    temperature_value: Mapped[Optional[float]] = mapped_column(Float)
    trajectory: Mapped[Optional[str]] = mapped_column(String(16))
    confidence_score: Mapped[Optional[float]] = mapped_column(Float)
    confidence_level: Mapped[Optional[str]] = mapped_column(String(8))
    confidence_reasons: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    review_reasons: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    unsupported_count: Mapped[int] = mapped_column(Integer, default=0)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    provider: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(64), default="")
    temperature: Mapped[Optional[float]] = mapped_column(Float)
    prompt_versions: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    error_kind: Mapped[str] = mapped_column(String(64), default="")
    case: Mapped[Case] = relationship(back_populates="audit")
    findings: Mapped[list["Finding"]] = relationship(cascade="all, delete-orphan")
    review_actions: Mapped[list["ReviewAction"]] = relationship(cascade="all, delete-orphan",
                                                                order_by="ReviewAction.created_at")


class Finding(Base):
    __tablename__ = "findings"
    id: Mapped[int] = mapped_column(primary_key=True)
    audit_id: Mapped[int] = mapped_column(ForeignKey("audits.id", ondelete="CASCADE"), index=True)
    dimension: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(32))
    text: Mapped[str] = mapped_column(Text)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    run_index: Mapped[int] = mapped_column(Integer, default=0)


class ReviewAction(Base):
    """Append-only audit trail of reviewer actions."""
    __tablename__ = "review_actions"
    id: Mapped[int] = mapped_column(primary_key=True)
    audit_id: Mapped[int] = mapped_column(ForeignKey("audits.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    action: Mapped[str] = mapped_column(String(16))           # approve|override|comment
    reviewer_name: Mapped[str] = mapped_column(String(128))
    score_override: Mapped[Optional[float]] = mapped_column(Float)
    comment: Mapped[str] = mapped_column(Text, default="")
