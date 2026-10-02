"""Excel export adapter driven entirely by config/mapping.yaml."""
from __future__ import annotations

import re
from email.utils import parseaddr
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from app.adapters.base import IngestReport, IngestResult, SourceAdapter
from app.adapters.dates import _is_blank, to_utc
from app.domain.models import (
    Direction, RawActivity, RawCase, RawCommunication, RawStatusChange,
)

SHEET_KEYS = ("cases", "emails", "activities", "status_history")


def _s(value: Any) -> str:
    if _is_blank(value):
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


class ExcelAdapter(SourceAdapter):
    def __init__(self, mapping: dict[str, Any]):
        self.mapping = mapping
        self.formats: list[str] = mapping.get("date_formats", [])
        self.default_tz: str = mapping.get("default_timezone", "UTC")
        values = mapping.get("values", {})
        self.sev_lookup = {
            str(alias).strip().lower(): int(sev)
            for sev, aliases in values.get("severity", {}).items() for alias in aliases
        }
        self.activity_lookup = {
            str(alias).strip().lower(): kind
            for kind, aliases in values.get("activity_type", {}).items() for alias in aliases
        }
        self.incoming_true = {str(v).lower() for v in values.get("incoming_true", [])}
        self.internal_vis = {str(v).lower() for v in values.get("internal_visibility", [])}
        self.call_dir = {
            str(alias).lower(): Direction(direction)
            for direction, aliases in values.get("call_direction", {}).items() for alias in aliases
        }
        self.closed_statuses = {str(v).lower() for v in values.get("closed_statuses", [])}
        self.history_fields = {str(v).lower() for v in values.get("history_status_field", ["Status"])}
        det = mapping.get("detection", {})
        self.support_domains = {d.lower() for d in det.get("support_email_domains", [])}
        auto = det.get("auto_ack", {})
        self.ack_locals = {s.lower() for s in auto.get("from_local_parts", [])}
        self.ack_subjects = [re.compile(p) for p in auto.get("subject_patterns", [])]

    # ------------------------------------------------------------------ helpers
    def _read(self, source: Any) -> dict[str, pd.DataFrame]:
        if isinstance(source, (str, Path)):
            return pd.read_excel(source, sheet_name=None, dtype=object, engine="openpyxl")
        return pd.read_excel(source, sheet_name=None, dtype=object, engine="openpyxl")

    def _resolve(self, frames: dict[str, pd.DataFrame], key: str, report: IngestReport):
        spec = self.mapping.get("sheets", {}).get(key)
        if not spec:
            return None, {}
        by_lower = {name.strip().lower(): name for name in frames}
        sheet = by_lower.get(str(spec["sheet"]).strip().lower())
        status: dict[str, str] = {}
        cols: dict[str, Optional[str]] = {}
        if sheet is None:
            for f in spec["columns"]:
                status[f] = "missing"
            report.mapping_status[key] = status
            return None, {}
        frame = frames[sheet]
        col_lower = {str(c).strip().lower(): c for c in frame.columns}
        for f, col in spec["columns"].items():
            actual = col_lower.get(str(col).strip().lower())
            cols[f] = actual
            status[f] = "found" if actual is not None else "missing"
        report.mapping_status[key] = status
        report.row_counts[key] = len(frame)
        return frame, cols

    def _date(self, value: Any, report: IngestReport):
        dt, failed = to_utc(value, self.formats, self.default_tz)
        if failed:
            report.unparsed_dates += 1
        return dt

    @staticmethod
    def _get(row: pd.Series, cols: dict[str, Optional[str]], field: str) -> Any:
        col = cols.get(field)
        return None if col is None else row.get(col)

    def _is_auto_ack(self, from_addr: str, subject: str) -> bool:
        local = parseaddr(from_addr)[1].split("@")[0].lower()
        if local in self.ack_locals:
            return True
        return any(p.search(subject or "") for p in self.ack_subjects)

    def _direction(self, incoming: Any, from_addr: str) -> tuple[Optional[Direction], bool]:
        flag = _s(incoming).lower()
        if flag:
            return (Direction.INBOUND if flag in self.incoming_true else Direction.OUTBOUND), False
        domain = parseaddr(from_addr)[1].split("@")[-1].lower()
        if not domain:
            return None, True
        return (Direction.OUTBOUND if domain in self.support_domains else Direction.INBOUND), True

    # ------------------------------------------------------------------ interface
    def inspect(self, source: Any) -> IngestReport:
        frames = self._read(source)
        report = IngestReport(sheets_found=list(frames))
        report.columns = {name: [str(c) for c in f.columns] for name, f in frames.items()}
        for key in SHEET_KEYS:
            self._resolve(frames, key, report)
        return report

    def load(self, source: Any) -> IngestResult:
        frames = self._read(source)
        report = IngestReport(sheets_found=list(frames))
        report.columns = {name: [str(c) for c in f.columns] for name, f in frames.items()}
        cases_df, ccols = self._resolve(frames, "cases", report)
        if cases_df is None or ccols.get("case_number") is None:
            raise ValueError("cases sheet or case number column not found per mapping")

        cases: dict[str, RawCase] = {}
        roster: set[str] = set()
        for _, row in cases_df.iterrows():
            number = _s(self._get(row, ccols, "case_number"))
            if not number:
                report.orphan_rows += 1
                continue
            sev_raw = _s(self._get(row, ccols, "severity"))
            severity = self.sev_lookup.get(sev_raw.lower()) if sev_raw else None
            if sev_raw and severity is None:
                report.unknown_severities += 1
            status = _s(self._get(row, ccols, "status"))
            owner = _s(self._get(row, ccols, "owner"))
            if owner:
                roster.add(owner)
            cases[number] = RawCase(
                case_number=number,
                subject=_s(self._get(row, ccols, "subject")),
                description=_s(self._get(row, ccols, "description")),
                severity=severity,
                status=status,
                is_closed=status.lower() in self.closed_statuses,
                opened_at=self._date(self._get(row, ccols, "opened_at"), report),
                closed_at=self._date(self._get(row, ccols, "closed_at"), report),
                owner=owner,
                account_name=_s(self._get(row, ccols, "account_name")),
                account_number=_s(self._get(row, ccols, "account_number")),
                contact_name=_s(self._get(row, ccols, "contact_name")),
                contact_email=_s(self._get(row, ccols, "contact_email")),
                contact_phone=_s(self._get(row, ccols, "contact_phone")),
                product=_s(self._get(row, ccols, "product")),
                resolution=_s(self._get(row, ccols, "resolution")),
            )

        emails_df, ecols = self._resolve(frames, "emails", report)
        if emails_df is not None:
            for _, row in emails_df.iterrows():
                case = cases.get(_s(self._get(row, ecols, "case_number")))
                if case is None:
                    report.orphan_rows += 1
                    continue
                from_addr = _s(self._get(row, ecols, "from_address"))
                subject = _s(self._get(row, ecols, "subject"))
                direction, inferred = self._direction(self._get(row, ecols, "incoming"), from_addr)
                name = parseaddr(from_addr)[0].strip()
                if direction == Direction.OUTBOUND and name:
                    roster.add(name)
                case.communications.append(RawCommunication(
                    kind="email",
                    direction=direction,
                    direction_inferred=inferred,
                    occurred_at=self._date(self._get(row, ecols, "sent_at"), report),
                    from_address=from_addr,
                    to_address=_s(self._get(row, ecols, "to_address")),
                    cc_address=_s(self._get(row, ecols, "cc_address")),
                    subject=subject,
                    body=_s(self._get(row, ecols, "body")),
                    is_auto_ack=direction == Direction.OUTBOUND and self._is_auto_ack(from_addr, subject),
                    author_name=name,
                ))

        acts_df, acols = self._resolve(frames, "activities", report)
        if acts_df is not None:
            for _, row in acts_df.iterrows():
                case = cases.get(_s(self._get(row, acols, "case_number")))
                if case is None:
                    report.orphan_rows += 1
                    continue
                kind = self.activity_lookup.get(_s(self._get(row, acols, "type")).lower(), "note")
                author = _s(self._get(row, acols, "assigned_to"))
                if author:
                    roster.add(author)
                when = self._date(self._get(row, acols, "occurred_at"), report)
                subject = _s(self._get(row, acols, "subject"))
                body = _s(self._get(row, acols, "body"))
                if kind == "call":
                    dir_raw = _s(self._get(row, acols, "call_direction")).lower()
                    direction = self.call_dir.get(dir_raw)
                    case.communications.append(RawCommunication(
                        kind="call",
                        direction=direction or Direction.OUTBOUND,
                        direction_inferred=direction is None,
                        occurred_at=when, subject=subject, body=body, author_name=author,
                    ))
                else:
                    vis = _s(self._get(row, acols, "visibility")).lower()
                    case.activities.append(RawActivity(
                        kind=kind,
                        internal=(vis in self.internal_vis) if vis else True,
                        occurred_at=when, subject=subject, body=body, author_name=author,
                    ))

        hist_df, hcols = self._resolve(frames, "status_history", report)
        if hist_df is not None:
            for _, row in hist_df.iterrows():
                case = cases.get(_s(self._get(row, hcols, "case_number")))
                if case is None:
                    report.orphan_rows += 1
                    continue
                if _s(self._get(row, hcols, "field")).lower() not in self.history_fields:
                    continue
                case.status_changes.append(RawStatusChange(
                    from_status=_s(self._get(row, hcols, "old_value")),
                    to_status=_s(self._get(row, hcols, "new_value")),
                    at=self._date(self._get(row, hcols, "changed_at"), report),
                ))

        return IngestResult(cases=list(cases.values()), roster=sorted(roster), report=report)
