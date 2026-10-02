"""Source adapter interface. Adapters are read-only toward source systems."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from app.domain.models import RawCase


@dataclass
class IngestReport:
    """Structural ingest diagnostics. Contains column names and counts only, never values."""
    sheets_found: list[str] = field(default_factory=list)
    columns: dict[str, list[str]] = field(default_factory=dict)
    mapping_status: dict[str, dict[str, str]] = field(default_factory=dict)  # sheet -> field -> found|missing
    row_counts: dict[str, int] = field(default_factory=dict)
    unparsed_dates: int = 0
    unknown_severities: int = 0
    orphan_rows: int = 0

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@dataclass
class IngestResult:
    cases: list[RawCase]
    roster: list[str]          # support staff names seen in the source (memory only)
    report: IngestReport


class SourceAdapter(ABC):
    @abstractmethod
    def inspect(self, source: Any) -> IngestReport:
        """Return structure (sheets, columns, mapping coverage) without reading values out."""

    @abstractmethod
    def load(self, source: Any) -> IngestResult:
        """Read cases into raw in-memory models."""
