"""Salesforce adapter - interface stub only (out of scope for now).

When implemented it must:
  * be read-only (no write-back),
  * query Case, EmailMessage, Task/Event (calls, summaries, handovers) and CaseHistory,
  * return the same RawCase models as the ExcelAdapter so redaction, rules and
    evaluation are unchanged,
  * only contact the configured Salesforce instance.
"""
from __future__ import annotations

from typing import Any

from app.adapters.base import IngestReport, IngestResult, SourceAdapter


class SalesforceAdapter(SourceAdapter):
    def __init__(self, config: dict[str, Any]):
        self.config = config

    def inspect(self, source: Any) -> IngestReport:
        raise NotImplementedError("SalesforceAdapter is a stub; use the Excel adapter for now.")

    def load(self, source: Any) -> IngestResult:
        raise NotImplementedError("SalesforceAdapter is a stub; use the Excel adapter for now.")
